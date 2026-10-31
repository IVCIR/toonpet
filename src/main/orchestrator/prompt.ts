/**
 * 提示词装配（契约 §9.3，顺序固定不可调换）。
 *
 * | 段 | 内容 | 来源 |
 * |---|---|---|
 * | 1 | 输出格式约束（JSON schema + 枚举全集 + 语言硬约束） | 硬编码（本文件） |
 * | 2 | 角色卡 | data/character-card.md |
 * | 3 | 记忆片段（≤5 条纯文本） | memory.retrieve()（ADR 0020 D8） |
 * | 4 | 最近 6 轮对话 | 进程内环形缓冲 |
 * | 5 | 当前用户话语 | user_utterance |
 *
 * 1–3 合成 system 消息；4 展开成 user/assistant 交替消息；5 是最后一条 user 消息。
 *
 * 语言：本轮起角色只讲**日文**（ADR 0022）。段 1 里有一条硬约束，段 2 的角色卡
 * 也写了同一条——两层防线，因为小模型对 system 段尾部的指令更敏感。
 */
import { LLM_HISTORY_TURNS, MEMORY_FACT_MAX_CHARS, MEMORY_RETRIEVE_LIMIT } from '../../shared/constants';
import type { MemoryFact, MemoryKind } from '../../shared/memory-types';

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

/**
 * `MemoryFact[]` → 段 3 的纯文本行（ADR 0020 D8）。
 * 只输出 `MM-DD`：秒级时间戳会让同一句话的 prompt 每次都变，破坏可复现性。
 */
export function formatMemoryFacts(facts: MemoryFact[], limit: number = MEMORY_RETRIEVE_LIMIT): string[] {
  if (!Array.isArray(facts) || facts.length === 0) return [];
  const lines: string[] = [];
  for (const fact of facts.slice(0, Math.max(1, limit))) {
    if (!fact || typeof fact.at !== 'number' || !Number.isFinite(fact.at)) continue;
    const at = new Date(fact.at);
    const stamp = `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
    const label = KIND_LABEL[fact.kind] ?? KIND_LABEL.system;
    const text = formatFactText(fact);
    if (text === '') continue;
    lines.push(`[${stamp}] ${label}: ${text}`);
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
  const system = [
    OUTPUT_CONTRACT,
    '',
    '角色卡：',
    input.card.trim(),
    '',
    formatMemorySegment(input.memory),
  ].join('\n');

  const history = input.history.slice(-LLM_HISTORY_TURNS);
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.user });
    messages.push({ role: 'assistant', content: turn.assistant });
  }
  messages.push({ role: 'user', content: input.userText });
  return messages;
}
