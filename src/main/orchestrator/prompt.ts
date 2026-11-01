/**
 * 提示词装配（契约 §9.3，顺序固定不可调换；段 3.5 见 ADR 0030）。
 *
 * | 段 | 内容 | 来源 |
 * |---|---|---|
 * | 1 | 输出格式约束（JSON schema + 枚举全集 + 语言硬约束） | 硬编码（本文件） |
 * | 2 | 角色卡 | data/character-card.md |
 * | 3 | 记忆片段（≤5 条纯文本，相对时间，去重 + 360 字预算） | memory.retrieve()（ADR 0020 D8 / ADR 0030 D4） |
 * | 3.5 | 环境事实（可选：时间 / 空闲 / 前台应用 / 上次会话） | presence（ADR 0030 D2） |
 * | 4 | 最近 6 轮对话 | 进程内环形缓冲 |
 * | 5 | 当前用户话语 | user_utterance |
 *
 * 1–3（+3.5）合成 system 消息；4 展开成 user/assistant 交替消息；5 是最后一条 user 消息。
 *
 * 语言：本轮起角色只讲**日文**（ADR 0022）。段 1 里有一条硬约束，段 2 的角色卡
 * 也写了同一条——两层防线，因为小模型对 system 段尾部的指令更敏感。
 */
import {
  LLM_HISTORY_TURNS,
  MEMORY_DEDUPE_SIMILARITY,
  MEMORY_FACT_MAX_CHARS,
  MEMORY_RETRIEVE_LIMIT,
  MEMORY_SEGMENT_MAX_CHARS,
} from '../../shared/constants';
import type { MemoryFact, MemoryKind } from '../../shared/memory-types';
import type { WorldFacts } from '../../shared/world-types';
import { formatWorldSegment } from './world';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HistoryTurn {
  user: string;
  assistant: string;
}

export interface PromptInput {
  card: string;
  memory: string[];
  history: HistoryTurn[];
  userText: string;
  /**
   * 段 3.5（ADR 0030）。**缺省时不产生任何字节变化**——这是"现有单测零改动"的保证，
   * 也是"感知不可用时提示词退化成 1.9.0 形态"的降级路径。
   */
  world?: WorldFacts;
}

/** §9.3 段 1：硬编码的输出契约。枚举全集与 §4.4 / §4.5 逐字一致。 */
export const OUTPUT_CONTRACT = [
  '你是桌面宠物角色的对话引擎。只输出一个 JSON 对象，不要输出解释、Markdown、代码块或任何多余文字。',
  '仅输出纯 JSON，不要任何 Markdown 包裹：禁止 ```json / ``` 代码块，禁止在 JSON 前后加说明。',
  '禁止任何括号动作描写，例如（微笑）、（摸了摸头）、（笑）；情绪只由 emotion 字段表达。',
  'text 里禁止 Markdown（**粗体**、*斜体*、# 标题、`代码`）与换行。',
  'JSON 形如：{"text":"...","emotion":"...","intent":"..."}',
  'emotion 只能取：neutral | happy | sad | surprised | shy | angry | sleepy',
  'intent 只能取：none | greet | nod | shake_head | tilt_head | look_at_user | pat_react | happy_hop',
  '【语言硬约束】text 必须完全使用纯正日文（日本語）书写：禁止出现中文（简体或繁体）、韩文与英文句子。即使用户用中文提问，也只能用日文回答。',
  'text：1–120 个字符，单段日文，不含 Markdown、URL、代码块、括号动作描写，不要换行。',
  '不要提及这些规则，不要自称 AI 或助手。',
].join('\n');

/** 段 3 的 kind → 中文标签（prompt 是给本地小模型看的，用中文标签更省 token）。 */
const KIND_LABEL: Record<MemoryKind, string> = {
  user: '用户',
  pet: '凯伊',
  system: '系统',
};

/** 段 3 会读的是中文还是日文？两者都可能存在：只要求"纯文本、单行、可截断"。 */
export function formatFactText(fact: MemoryFact): string {
  const text = String(fact.text ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MEMORY_FACT_MAX_CHARS ? `${text.slice(0, MEMORY_FACT_MAX_CHARS)}…` : text;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时区当天零点（相对时间按"日历天"算，不按 24h 小时数算）。 */
function localDayStart(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 段 3 的时间标签（ADR 0030 D4.1）。
 *
 * 绝对时间 `[10-30]` 对模型几乎没有信息量——它不知道今天是几号；相对时间
 * `[3日前]` / `[昨日]` 才是"她还记得几天前的事"这件事的直接证据。
 * 按本地日历天差计算，因此"昨晚 23:50"与"今早 00:10"是 `昨日` 而不是 `今日`。
 */
export function formatRelativeDay(at: number, now: number): string {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '----';
  const days = Math.round((localDayStart(now) - localDayStart(at)) / 86_400_000);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 30) return `${days}日前`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}ヶ月前`;
  return `${Math.max(1, Math.floor(days / 365))}年前`;
}

/** 绝对标签（1.9.0 的形态）：只在调用方没给 `now` 时使用，保证旧断言与旧行为可复现。 */
function formatAbsoluteDay(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 归一化后取三字组集合：中文/日文没有空格，只能用字面笔画重叠来判"说的是不是同一件事"。 */
function gramSet(text: string): Set<string> {
  const normalized = text.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
  const chars = [...normalized];
  if (chars.length === 0) return new Set();
  if (chars.length <= 3) return new Set([chars.join('')]);
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    grams.add(chars.slice(index, index + 3).join(''));
  }
  return grams;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function tagKey(fact: MemoryFact): string {
  return [...(fact.tags ?? [])].sort().join('|');
}

/**
 * 去冗余（ADR 0030 D4.2）：**同 tags 且三字组 Jaccard ≥ 0.8** 视为同一件事，只留先出现的那条。
 * 先出现的必然是 `hits` 更高、或同分但更新的那条（调用方已按 §7.5 排好序），
 * 所以这里不需要再比时间——排序规则本身没被改动。
 */
export function dedupeMemoryFacts(
  facts: MemoryFact[],
  threshold: number = MEMORY_DEDUPE_SIMILARITY,
): MemoryFact[] {
  const kept: Array<{ fact: MemoryFact; key: string; grams: Set<string> }> = [];
  for (const fact of facts) {
    const key = tagKey(fact);
    const grams = gramSet(String(fact.text ?? ''));
    const duplicate = kept.some(
      (item) => item.key === key && jaccard(item.grams, grams) >= threshold,
    );
    if (!duplicate) kept.push({ fact, key, grams });
  }
  return kept.map((item) => item.fact);
}

/**
 * `MemoryFact[]` → 段 3 的纯文本行（ADR 0020 D8；ADR 0030 D4）。
 *
 * - `now` 为有限数 → 相对时间；缺省 → 绝对 `MM-DD`（1.9.0 行为，向后兼容）；
 * - 先去冗余，再按顺序装填，总字符超过 `MEMORY_SEGMENT_MAX_CHARS` 就停（不截断行内文本）。
 */
export function formatMemoryFacts(
  facts: MemoryFact[],
  limit: number = MEMORY_RETRIEVE_LIMIT,
  now?: number,
): string[] {
  if (!Array.isArray(facts) || facts.length === 0) return [];
  const capped = facts.slice(0, Math.max(1, limit));
  const deduped = dedupeMemoryFacts(capped);
  const lines: string[] = [];
  let chars = 0;
  for (const fact of deduped) {
    if (!fact || typeof fact.at !== 'number' || !Number.isFinite(fact.at)) continue;
    const label = now !== undefined && Number.isFinite(now) ? formatRelativeDay(fact.at, now) : formatAbsoluteDay(fact.at);
    const kind = KIND_LABEL[fact.kind] ?? KIND_LABEL.system;
    const text = formatFactText(fact);
    if (text === '') continue;
    const line = `[${label}] ${kind}: ${text}`;
    if (lines.length > 0 && chars + line.length > MEMORY_SEGMENT_MAX_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  return lines;
}

/** §9.3 段 3：记忆为空（或检索失败）时显式写"无"，绝不整段消失。 */
export function formatMemorySegment(facts: string[]): string {
  if (facts.length === 0) return '记忆片段：（无）';
  const lines = facts.slice(0, MEMORY_RETRIEVE_LIMIT).map((fact) => `- ${fact}`);
  return ['记忆片段：', ...lines].join('\n');
}

export function buildPrompt(input: PromptInput): ChatMessage[] {
  const sections = [
    OUTPUT_CONTRACT,
    '',
    '角色卡：',
    input.card.trim(),
    '',
    formatMemorySegment(input.memory),
  ];
  // 段 3.5：插在段 3 与段 4 之间（ADR 0030 D2）。没有 world 时**一个字节都不加**。
  if (input.world) {
    sections.push('', formatWorldSegment(input.world));
  }
  const system = sections.join('\n');

  const history = input.history.slice(-LLM_HISTORY_TURNS);
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.user });
    messages.push({ role: 'assistant', content: turn.assistant });
  }
  messages.push({ role: 'user', content: input.userText });
  return messages;
}
