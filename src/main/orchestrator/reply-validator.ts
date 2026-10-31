/**
 * LLM 结构化输出校验（契约 §9.2，ADR 0018 D2）。
 *
 * 顺序固定：
 * 1. **清洗**（只剥离装饰，不改写可朗读内容）：
 *    代码块围栏 → 括号动作描写 → Markdown 粗斜体/行内代码 → 标题/引用前缀；
 * 2. 解析（纯 JSON → 围栏内 JSON → 文本中第一个平衡的 JSON 对象）；
 * 3. 结构（必须同时有 text / emotion / intent 三个字段）；
 * 4. **一次**字段修复（未知 intent → none，未知 emotion → neutral），记录在 `repaired`；
 * 5. 文本约束（1–120 字、单段、无 Markdown / URL / 代码块 / 括号动作描写）；
 * 6. 修复后仍不合法 → `invalid_output`（由编排层降级到兜底）。
 *
 * 注意：清洗**不是**放宽校验。`validateReplyText` 仍然严格拒绝残留的
 * Markdown/括号/URL；台词池装配（`assertValidReplyShape`）根本不走清洗。
 * 清洗只处理"模型把情绪写成（微笑）、把 JSON 包进 ```json" 这类装饰性包裹。
 *
 * 不抛异常：调用方拿 `ok=false` 走 §11 的降级路径。
 *
 * 语言（ADR 0022 D3）：本校验器**不强制语言**——日文、中文、混排都按同一套
 * 结构/长度/装饰规则处理。原因：
 * - "必须说日文"是**内容策略**，由提示词（段 1 + 角色卡）与台词池保证；
 * - 在这里加"必须含假名"的硬判定，会把 `Ｋｅｉ`、纯数字、专有名词回复直接打成
 *   `invalid_output`，让兜底台词顶掉本来合法的回答（误判）。
 * 日文相关的处理只有两处：长度按**码点**计（`[...text].length`）；中日文之间的
 * 半角空格会被 `joinCjkWithoutSpace` 去掉。
 */
import { REPLY_TEXT_MAX_CHARS } from '../../shared/constants';
import { isEmotion } from '../../shared/emotions';
import { isIntent } from '../../shared/intents';
import type { Emotion, Intent, Reply } from '../../shared/types';

export type InvalidReason = 'unparseable' | 'structure' | 'text';

export interface ValidationOutcome {
  ok: boolean;
  reply: Reply | null;
  /** 做过的清洗/修复（用于日志；空数组表示原样合法） */
  repaired: string[];
  reason: InvalidReason | null;
  detail?: string;
}

/** §9.2：单段、无 Markdown、无 URL、无代码块、无括号动作描写。 */
const FORBIDDEN_MARKUP = /[（）()[\]{}`*#]/;
const URL_PATTERN = /(https?:\/\/|www\.)/i;

/**
 * 中日文里不需要空格的字符：汉字、平假名、片假名、全角标点（含 `，。！？、`）。
 * 用于把"模型在句中换行"造成的半角空格去掉——日文 `はい わかりました` 是错的
 * （ADR 0022 D3）；ASCII 与 CJK 之间（`OK 了解`）保留空格。
 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u;

/**
 * 去掉"两个中日文字符之间"的半角空格（单段拼接用）。
 *
 * 为什么单独提出来：日文/中文都不在字符之间用空格，模型换行后按 `\s+ → ' '`
 * 折成单段会留下非自然空格；TTS 会把它读成一个突兀的停顿，字幕也难看。
 */
export function joinCjkWithoutSpace(text: string): string {
  if (text.length < 3) return text;
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === ' ' && index > 0 && index < text.length - 1) {
      const previous = text[index - 1];
      const next = text[index + 1];
      if (previous !== undefined && next !== undefined && CJK_CHAR.test(previous) && CJK_CHAR.test(next)) {
        continue;
      }
    }
    out += char;
  }
  return out;
}

/** 整段或残留的代码围栏标记：```json / ``` / ```js */
const FENCE_MARKER = /```[a-zA-Z0-9_-]*/g;

/**
 * 括号动作描写：`（微笑）`、`(摸了摸头)`、`（笑）`、`【叹气】`、`[小声]`。
 * 只处理不超过 60 字的短括号组——长括号更可能是正文，留给 §9.2 拒绝而不是猜。
 */
const ACTION_GROUP = /[（(【\[][^（）()【】\[\]]{0,60}[）)】\]]/g;

export interface TextCheck {
  ok: boolean;
  text: string;
  detail?: string;
}

/**
 * 严格文本校验（§9.2）。**不做清洗**：台词池装配与清洗后的最终校验都走这里。
 */
export function validateReplyText(raw: unknown): TextCheck {
  if (typeof raw !== 'string') return { ok: false, text: '', detail: 'text 不是字符串' };
  // 换行/制表符折成单空格：单段是硬要求，但不做内容改写；中日文之间的空格再去掉
  const text = joinCjkWithoutSpace(raw.replace(/\s+/g, ' ').trim());
  if (text.length === 0) return { ok: false, text, detail: 'text 为空' };
  const length = [...text].length;
  if (length > REPLY_TEXT_MAX_CHARS) {
    return { ok: false, text, detail: `text 长度 ${length} > ${REPLY_TEXT_MAX_CHARS}` };
  }
  if (FORBIDDEN_MARKUP.test(text)) return { ok: false, text, detail: 'text 含 Markdown/括号动作描写' };
  if (URL_PATTERN.test(text)) return { ok: false, text, detail: 'text 含 URL' };
  return { ok: true, text };
}

export interface SanitizedText {
  text: string;
  /** 是否剥离过装饰（仅空白折叠不算） */
  changed: boolean;
  notes: string[];
}

/**
 * 剥离"装饰"而不是改写内容（ADR 0018 D2）：
 * - 代码围栏与行内反引号；
 * - 括号动作描写；
 * - `***粗斜体***` / `**粗体**` / `*斜体*` / `__粗体__`；
 * - Markdown 标题与引用前缀；
 * - 残留的裸 `*`。
 */
export function sanitizeReplyText(raw: string): SanitizedText {
  const notes: string[] = [];
  let text = raw;

  const withoutFence = text.replace(FENCE_MARKER, '');
  if (withoutFence !== text) {
    notes.push('fence');
    text = withoutFence;
  }

  const withoutActions = text.replace(ACTION_GROUP, '');
  if (withoutActions !== text) {
    notes.push('action');
    text = withoutActions;
  }

  const withoutEmphasis = text
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1');
  if (withoutEmphasis !== text) {
    notes.push('emphasis');
    text = withoutEmphasis;
  }

  const withoutCode = text.replace(/`+/g, '');
  if (withoutCode !== text) {
    notes.push('code');
    text = withoutCode;
  }

  const withoutBlockMarkers = text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  if (withoutBlockMarkers !== text) {
    notes.push('block');
    text = withoutBlockMarkers;
  }

  const withoutAsterisk = text.replace(/\*+/g, '');
  if (withoutAsterisk !== text) {
    notes.push('asterisk');
    text = withoutAsterisk;
  }

  text = text.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\s+([，。！？；：、])/g, '$1');
  // 只对全角标点去后续空格：英文句点后的空格是语义的一部分
  text = text.replace(/([，。！？；：、])\s+/g, '$1');
  // 括号被剥掉后可能留下孤零零的句首标点，例如 "（微笑）。" → "。"
  text = text.replace(/^[，。！？；：、,.;:!?\s]+/, '');
  text = text.replace(/[，、；：,;:]+$/, '');
  text = joinCjkWithoutSpace(text);
  text = text.trim();

  return { text, changed: notes.length > 0, notes };
}

/** 严格保留原文、只做"提取"的尝试顺序（纯文本 → 围栏内容 → 第一个平衡对象）。 */
function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== '' && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  add(text);

  const fenceMatch = /```[a-zA-Z0-9_-]*/.exec(text);
  if (fenceMatch) {
    const start = fenceMatch.index + fenceMatch[0].length;
    const end = text.indexOf('```', start);
    if (end > start) add(text.slice(start, end));
  }

  // 扫描并提取最多 3 个平衡的 {...}（正确处理字符串里的花括号与转义）
  let searchFrom = 0;
  let found = 0;
  while (found < 3) {
    const start = text.indexOf('{', searchFrom);
    if (start < 0) break;
    const end = findMatchingBrace(text, start);
    if (end < 0) break;
    add(text.slice(start, end + 1));
    found += 1;
    searchFrom = end + 1;
  }

  return candidates;
}

/** 从 `start`（必须是 `{`）开始找配对的 `}`；找不到返回 -1。字符串内的花括号不计入。 */
export function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

interface PreparedOutput {
  parsed: unknown;
  repaired: string[];
}

function prepareOutput(raw: string): PreparedOutput {
  const repaired: string[] = [];
  const normalized = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '') : '';

  let candidate = normalized.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/.exec(candidate);
  if (fence?.[1] !== undefined) {
    candidate = fence[1].trim();
    repaired.push('output:fence-stripped');
  }

  for (const attempt of collectJsonCandidates(candidate)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(attempt);
    } catch {
      continue;
    }

    if (attempt !== candidate) repaired.push('output:json-extracted');
    if (!isPlainObject(parsed)) return { parsed, repaired };

    const rawText = parsed['text'];
    if (typeof rawText === 'string') {
      const sanitized = sanitizeReplyText(rawText);
      if (sanitized.changed) {
        repaired.push('text:decorations-stripped');
        return { parsed: { ...parsed, text: sanitized.text }, repaired };
      }
    }
    return { parsed, repaired };
  }

  return { parsed: undefined, repaired };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAndValidateReply(raw: string): ValidationOutcome {
  const prepared = prepareOutput(raw);
  if (prepared.parsed === undefined) {
    return { ok: false, reply: null, repaired: prepared.repaired, reason: 'unparseable' };
  }
  if (!isPlainObject(prepared.parsed)) {
    return {
      ok: false,
      reply: null,
      repaired: prepared.repaired,
      reason: 'structure',
      detail: '顶层不是对象',
    };
  }

  const parsed = prepared.parsed;
  const repaired = prepared.repaired;
  for (const key of ['text', 'emotion', 'intent'] as const) {
    if (!(key in parsed)) {
      return { ok: false, reply: null, repaired, reason: 'structure', detail: `缺少字段 ${key}` };
    }
  }

  let emotion: Emotion;
  if (isEmotion(parsed['emotion'])) {
    emotion = parsed['emotion'];
  } else {
    // §9.2 的"仅修复字段"：未知枚举值不猜近义词，直接落到中性值
    emotion = 'neutral';
    repaired.push('emotion->neutral');
  }

  let intent: Intent;
  if (isIntent(parsed['intent'])) {
    intent = parsed['intent'];
  } else {
    intent = 'none';
    repaired.push('intent->none');
  }

  const text = validateReplyText(parsed['text']);
  if (!text.ok) {
    return { ok: false, reply: null, repaired, reason: 'text', detail: text.detail };
  }

  return {
    ok: true,
    reply: { text: text.text, emotion, intent },
    repaired,
    reason: null,
  };
}

/** 台词池装配期的严格校验：不做修复，不合法直接抛（§9.1 ③：兜底为空/非法属装配错误）。 */
export function assertValidReplyShape(value: unknown, label: string): Reply {
  if (!isPlainObject(value)) throw new Error(`${label} 不是对象`);
  const text = validateReplyText(value['text']);
  if (!text.ok) throw new Error(`${label}.text 不合法：${String(text.detail)}`);
  if (!isEmotion(value['emotion'])) {
    throw new Error(`${label}.emotion 不在 §4.5 集合内：${String(value['emotion'])}`);
  }
  if (!isIntent(value['intent'])) {
    throw new Error(`${label}.intent 不在 §4.4 集合内：${String(value['intent'])}`);
  }
  return { text: text.text, emotion: value['emotion'], intent: value['intent'] };
}
