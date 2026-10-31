/**
 * 事实标签提取（ADR 0020 D6）。
 *
 * 目标很小：用户说"我喜欢 X / X が好き"，就把 X 记成标签，将来问 X 能命中。
 * 不做实体识别、不做情感分析、不联网、不猜词性——只认下面几条固定句式。
 *
 * 规则顺序很重要：**先否定后肯定**，否则"我不喜欢咖啡"会被记成 `like:咖啡`。
 * （实现上用的是"一个正则 + 按动词分类"，所以同一段文字里不会既算 like 又算 dislike。）
 */
import { MEMORY_TAG_MAX, MEMORY_TAG_MAX_CHARS } from '../../shared/constants';

export type FactTagKind = 'like' | 'dislike';

export const FACT_TAG_KINDS: readonly FactTagKind[] = ['like', 'dislike'];

/** 中文：可选主语 + 可选程度副词 + 动词 + X（1–12 字，遇标点停）。 */
const CN_FACT =
  /(?:我)?(?:很|最|超|特别|非常|太)?(不喜欢|不爱|不愛|讨厌|厌恶|喜欢|愛|爱)([^，。！？、,.!?~〜\s]{1,12})/gu;

/** 日文：X + 助词 + 嫌い/苦手（否定侧先跑）。 */
const JA_DISLIKE =
  /([^\s、。！？「」『』（）()]{1,12}?)(?:のことが|のこと|が|は|を)(?:嫌い|きらい|苦手)/gu;

/** 日文：X + 助词 + 好き（长词优先，避免 `大好き` 只吃到 `好き`）。 */
const JA_LIKE =
  /([^\s、。！？「」『』（）()]{1,12}?)(?:のことが|のこと|が|は)(?:大好き|好き|すき)/gu;

const CN_DISLIKE_VERBS = new Set(['不喜欢', '不爱', '不愛', '讨厌', '厌恶']);

/** 去掉主语/助词/句尾助动词，只留"那个东西"。 */
export function cleanFactSubject(raw: string): string {
  let value = raw.trim();
  // 主语（中日混排都可能出现在捕获里，因为 CJK 没有空格）
  value = value.replace(/^(?:私|僕|俺|わたし|ぼく|おれ|あなた|先生)(?:は|が|も)/u, '');
  value = value.replace(/^(?:我)(?:是|也)?/u, '');
  // 句尾助动词/终助词
  value = value.replace(/(?:です|でした|ます|ました|だ|だった|よ|ね|な|かな|から|けど|けれど|ので)$/u, '');
  // 中文语气词
  value = value.replace(/[的啊呀呢吧啦哦嘛]+$/u, '');
  return value.trim();
}

function pushTag(tags: string[], kind: FactTagKind, subject: string): void {
  const value = cleanFactSubject(subject);
  if (value === '' || value.length > MEMORY_TAG_MAX_CHARS) return;
  const tag = `${kind}:${value}`;
  if (!tags.includes(tag) && tags.length < MEMORY_TAG_MAX) tags.push(tag);
}

/**
 * 从一段文本里抽取事实标签。返回 `['like:咖啡', 'dislike:辣']` 这种形态。
 * 纯函数、确定性、无副作用；同一个 X 只留第一次出现的标签。
 */
export function extractFactTags(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const source = text.trim();
  if (source === '') return [];

  const tags: string[] = [];

  // 日文优先（`〜` 之外基本不与中文句式冲突；先跑否定侧）
  for (const match of source.matchAll(JA_DISLIKE)) {
    if (match[1] !== undefined) pushTag(tags, 'dislike', match[1]);
  }
  for (const match of source.matchAll(JA_LIKE)) {
    if (match[1] !== undefined) pushTag(tags, 'like', match[1]);
  }

  for (const match of source.matchAll(CN_FACT)) {
    const verb = match[1];
    const subject = match[2];
    if (verb === undefined || subject === undefined) continue;
    pushTag(tags, CN_DISLIKE_VERBS.has(verb) ? 'dislike' : 'like', subject);
  }

  return tags;
}
