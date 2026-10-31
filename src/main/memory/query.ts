/**
 * 查询侧的纯函数（ADR 0020 D3/D4）：切词、LIKE/FTS 转义、命中打分。
 *
 * 不碰数据库、不读时钟——这样"短词走 LIKE、长词走 FTS、CJK 用三字滑窗"这些规则
 * 可以独立单测，不需要造一个真库。
 */
import { MEMORY_QUERY_MAX_TERMS, MEMORY_TERM_MAX_CHARS } from '../../shared/constants';

/** 汉字 / 平假名 / 片假名（含半角片假名的兼容区）——这些文字没有空格分词。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
/** 词条分隔：字母、数字、汉字、假名之外一律算分隔符。 */
const TERM_SEPARATOR = /[^\p{L}\p{N}]+/u;

function chars(value: string): string[] {
  return [...value];
}

export function hasCjk(value: string): boolean {
  return CJK.test(value);
}

/**
 * 把一个 CJK 长串切成"三字滑窗"：`喜欢什么咖啡吗` → `喜欢什 / 欢什么 / 什么咖 / 么咖啡 / 咖啡吗`。
 *
 * 为什么不用整串：`trigram` 的 MATCH 是**子串**匹配，整串要求一字不差；
 * 滑窗让"换了说法但共享三字片段"的问题也能命中。纯 ASCII 长词保持整词，
 * 免得 `coffee` 变成 `coff/offe/ffee` 这种噪声（ADR 0020 D4）。
 */
export function splitRun(run: string): string[] {
  const list = chars(run);
  if (list.length <= 3) return [run];
  if (!hasCjk(run)) return [run];
  const windows: string[] = [];
  for (let index = 0; index + 3 <= list.length; index += 1) {
    windows.push(list.slice(index, index + 3).join(''));
  }
  return windows;
}

/** 查询 → 词条（去重、保序、上限 `MEMORY_QUERY_MAX_TERMS`）。 */
export function extractTerms(query: unknown): string[] {
  if (typeof query !== 'string') return [];
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const run of trimmed.split(TERM_SEPARATOR)) {
    if (run === '' || run === undefined) continue;
    const runChars = chars(run);
    const bounded = runChars.length > MEMORY_TERM_MAX_CHARS ? runChars.slice(0, MEMORY_TERM_MAX_CHARS).join('') : run;
    for (const term of splitRun(bounded)) {
      if (seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
      if (terms.length >= MEMORY_QUERY_MAX_TERMS) return terms;
    }
  }
  return terms;
}

/** LIKE 里 `%` `_` `\` 都要转义（模板里写 `ESCAPE '\\'`）。 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function likePattern(term: string): string {
  return `%${escapeLike(term)}%`;
}

/** 只有 ≥3 字符的词条才能交给 FTS5 `trigram`；没有就返回 null（调用方只走 LIKE）。 */
export function buildFtsExpression(terms: string[]): string | null {
  const usable = terms.filter((term) => chars(term).length >= 3);
  if (usable.length === 0) return null;
  // 只拼"已转义的短语字面量"，值仍然是参数化的：用户输入不可能变成 SQL
  return usable.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

/** 命中词条数：`text` 与 `tags` 一起算，大小写不敏感（SQLite 之外再算一遍，语义一致）。 */
export function countHits(terms: string[], text: string, tags: string): number {
  if (terms.length === 0) return 0;
  const haystack = `${text}\n${tags}`.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (haystack.includes(term.toLowerCase())) hits += 1;
  }
  return hits;
}
