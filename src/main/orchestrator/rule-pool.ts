/**
 * 台词池与规则匹配（契约 §4.6、§9.1 ①、§9.3）。
 *
 * 规则条件只允许契约列出的四类：关键词 / 事件 / 状态 / 冷却。
 * 本轮落地的三类：
 * - `keywords`：用户话语的**字面**子串命中（大小写不敏感，不做分词、不做语义）；
 * - `on: 'head_patted'`：摸头事件（调用方保证在有效窗口内）；
 * - `on: 'idle'`：主动性引擎（ADR 0031 D3）的"空闲台词"，由 `idle-drive` 决定是否询问。
 *   它不是新事件——`idle` 是编排层自己的状态条件，不广播、不跨进程（§6.3 未改）。
 *
 * 选择策略是**数据顺序的第一个命中者**（不是随机）：确定性让"为什么说了这句"可复现，
 * 也让自检能断言。冷却未满足视为"未命中"，不排队、不补偿。
 */
import { RULE_DEFAULT_COOLDOWN_MS } from '../../shared/constants';
import type { Reply } from '../../shared/types';
import { assertValidReplyShape } from './reply-validator';

export type RuleEvent = 'head_patted' | 'idle';

/** `lines.json` 里 `match.on` 的合法取值（新增值必须同时改这里与 ADR）。 */
const RULE_EVENTS: readonly RuleEvent[] = ['head_patted', 'idle'];

export interface RuleMatchCondition {
  keywords?: string[];
  on?: RuleEvent;
}

export interface RuleEntry {
  id: string;
  match: RuleMatchCondition;
  reply: Reply;
  cooldownMs: number;
}

export interface FallbackEntry {
  id: string;
  reply: Reply;
}

export interface LinesFile {
  version: number;
  rules: RuleEntry[];
  fallbacks: FallbackEntry[];
}

export class LinesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinesError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LinesError(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

export function parseLinesFile(raw: unknown): LinesFile {
  if (!isPlainObject(raw)) throw new LinesError('lines.json 顶层必须是对象');
  if (raw['version'] !== 1) throw new LinesError(`lines.json version 必须为 1，收到 ${String(raw['version'])}`);

  const rulesRaw = raw['rules'];
  if (!Array.isArray(rulesRaw)) throw new LinesError('lines.json rules 必须是数组');
  const fallbacksRaw = raw['fallbacks'];
  if (!Array.isArray(fallbacksRaw)) throw new LinesError('lines.json fallbacks 必须是数组');
  // 契约 §9.1 ③：兜底集合为空属于装配错误，启动时校验并拒绝启动
  if (fallbacksRaw.length === 0) throw new LinesError('lines.json fallbacks 为空：§9.1 ③ 要求启动时拒绝');

  const ids = new Set<string>();
  const rules: RuleEntry[] = rulesRaw.map((entry, index) => {
    const label = `rules[${index}]`;
    if (!isPlainObject(entry)) throw new LinesError(`${label} 必须是对象`);
    const id = asNonEmptyString(entry['id'], `${label}.id`);
    if (ids.has(id)) throw new LinesError(`id 重复：${id}`);
    ids.add(id);

    const matchRaw = entry['match'];
    if (!isPlainObject(matchRaw)) throw new LinesError(`${label}.match 必须是对象`);
    const match: RuleMatchCondition = {};
    if (matchRaw['keywords'] !== undefined) {
      if (!Array.isArray(matchRaw['keywords']) || matchRaw['keywords'].length === 0) {
        throw new LinesError(`${label}.match.keywords 必须是非空字符串数组`);
      }
      match.keywords = matchRaw['keywords'].map((keyword, keywordIndex) =>
        asNonEmptyString(keyword, `${label}.match.keywords[${keywordIndex}]`),
      );
    }
    if (matchRaw['on'] !== undefined) {
      if (typeof matchRaw['on'] !== 'string' || !RULE_EVENTS.includes(matchRaw['on'] as RuleEvent)) {
        throw new LinesError(
          `${label}.match.on 只支持 ${RULE_EVENTS.map((value) => `"${value}"`).join(' / ')}，收到 ${String(matchRaw['on'])}`,
        );
      }
      match.on = matchRaw['on'] as RuleEvent;
    }
    if (!match.keywords && !match.on) {
      throw new LinesError(`${label}.match 至少要有关键词或事件条件`);
    }

    const reply = assertValidReplyShape(entry['reply'], `${label}.reply`);

    let cooldownMs = RULE_DEFAULT_COOLDOWN_MS;
    if (entry['cooldownMs'] !== undefined) {
      if (typeof entry['cooldownMs'] !== 'number' || !Number.isFinite(entry['cooldownMs']) || entry['cooldownMs'] < 0) {
        throw new LinesError(`${label}.cooldownMs 必须是非负有限数`);
      }
      cooldownMs = entry['cooldownMs'];
    }

    return { id, match, reply, cooldownMs };
  });

  const fallbacks: FallbackEntry[] = fallbacksRaw.map((entry, index) => {
    const label = `fallbacks[${index}]`;
    if (!isPlainObject(entry)) throw new LinesError(`${label} 必须是对象`);
    const id = asNonEmptyString(entry['id'], `${label}.id`);
    if (ids.has(id)) throw new LinesError(`id 重复：${id}`);
    ids.add(id);
    return { id, reply: assertValidReplyShape(entry['reply'], `${label}.reply`) };
  });

  return { version: 1, rules, fallbacks };
}

export interface RulePool {
  /** 用户话语的规则命中（§9.1 ①）；不命中返回 null */
  matchText(text: string, now: number): RuleEntry | null;
  /** 摸头事件的规则命中；不命中返回 null */
  matchPat(now: number): RuleEntry | null;
  /**
   * 空闲台词的规则命中（ADR 0031 D3）；不命中返回 null。
   * "该不该问"由 `idle-drive.evaluateIdleDrive()` 决定，这里只负责"有没有这句词"。
   */
  matchIdle(now: number): RuleEntry | null;
  /** 兜底台词（§9.1 ③）：轮转取，避免连续两次同一句 */
  fallback(): FallbackEntry;
  readonly rules: readonly RuleEntry[];
  readonly fallbacks: readonly FallbackEntry[];
  /** 自检/测试用：清空冷却记忆 */
  resetCooldowns(): void;
}

export function createRulePool(lines: LinesFile): RulePool {
  const lastFiredAt = new Map<string, number>();
  let fallbackCursor = -1;

  function ready(entry: RuleEntry, at: number): boolean {
    const last = lastFiredAt.get(entry.id);
    return last === undefined || at - last >= entry.cooldownMs;
  }

  function take(entry: RuleEntry, at: number): RuleEntry {
    lastFiredAt.set(entry.id, at);
    return entry;
  }

  function normalize(text: string): string {
    return text.trim().toLowerCase();
  }

  return {
    matchText(text: string, at: number): RuleEntry | null {
      const haystack = normalize(text);
      if (haystack === '') return null;
      for (const entry of lines.rules) {
        if (!entry.match.keywords) continue;
        const hit = entry.match.keywords.some((keyword) => haystack.includes(normalize(keyword)));
        if (!hit) continue;
        if (!ready(entry, at)) continue;
        return take(entry, at);
      }
      return null;
    },

    matchPat(at: number): RuleEntry | null {
      for (const entry of lines.rules) {
        if (entry.match.on !== 'head_patted') continue;
        if (!ready(entry, at)) continue;
        return take(entry, at);
      }
      return null;
    },

    matchIdle(at: number): RuleEntry | null {
      for (const entry of lines.rules) {
        if (entry.match.on !== 'idle') continue;
        if (!ready(entry, at)) continue;
        return take(entry, at);
      }
      return null;
    },

    fallback(): FallbackEntry {
      const count = lines.fallbacks.length;
      fallbackCursor = (fallbackCursor + 1) % count;
      // count > 0 由 parseLinesFile 保证
      const entry = lines.fallbacks[fallbackCursor];
      if (!entry) throw new LinesError('fallbacks 索引越界（不应发生）');
      return entry;
    },

    rules: lines.rules,
    fallbacks: lines.fallbacks,

    resetCooldowns(): void {
      lastFiredAt.clear();
      fallbackCursor = -1;
    },
  };
}
