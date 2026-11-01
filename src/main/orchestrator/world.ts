/**
 * 段 3.5「环境事实」（ADR 0030 D2/D3）。
 *
 * 一句话告诉模型**此刻是什么时候、谁在不在、在什么应用前面、上次说话是多久之前**。
 * 这是"时间感"的全部实现：不截图、不读剪贴板、不做 OCR，只用三个数字和两个短字符串。
 *
 * 为什么是自然语言而不是 JSON：这是给 `qwen3:4b` 这种小模型看的（与 Azalea 同源的做法）。
 * 小模型对"距上次行为过去 93 秒"这类句子比 `{"idleMs":93000}` 敏感得多。
 *
 * 纯函数：不读时钟（时间由调用方传）、不碰 Win32、不做 IO，可在 Node 里直接单测。
 */
import {
  WORLD_APP_TITLE_MAX_CHARS,
  WORLD_SEGMENT_MAX_CHARS,
  WORLD_TYPING_ACTIVE_MS,
} from '../../shared/constants';
import type { PresenceSnapshot, WorldFacts } from '../../shared/world-types';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD HH:mm`（本地时区，手工格式化以保证跨环境逐字一致）。 */
export function formatWorldStamp(now: number): string {
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) return '----/--/-- --:--';
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/**
 * 毫秒 → 日语时长短语（`90 秒` / `12 分` / `2 時間` / `3 日`）。
 * 向下取整到最粗的一档，避免"91.4 秒"这种噪声让同一句话每次都不一样。
 */
export function formatElapsedJa(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  // 2 分钟以内一律用秒：ADR 0030 的示例就是"90 秒前まで入力中"，
  // 把 90s 说成"1 分"会让"她注意到你刚停手"这件事变得模糊。
  if (safe < 120_000) return `${Math.max(1, Math.round(safe / 1000))} 秒`;
  if (safe < 3_600_000) return `${Math.floor(safe / 60_000)} 分`;
  if (safe < 86_400_000) return `${Math.floor(safe / 3_600_000)} 時間`;
  return `${Math.floor(safe / 86_400_000)} 日`;
}

function appPart(world: WorldFacts): string | null {
  const category = String(world.foregroundCategory ?? '').trim();
  if (category === '') return null;
  const clipped =
    category.length > WORLD_APP_TITLE_MAX_CHARS
      ? `${category.slice(0, WORLD_APP_TITLE_MAX_CHARS)}…`
      : category;
  return `前面のアプリ: ${clipped}`;
}

/**
 * ADR 0032 D2：`coding` 时额外给一句提示。
 *
 * 只有类别时小模型只知道"是 coding"，不知道"这意味着他在忙"；多这一句，她才会选择
 * "不打扰"或"轻声说一句"，而不是像接待员一样每 15 秒问一次。
 * 它不是独立分项，而是**第一个被丢弃**的分项（信息量最低，且 `前面のアプリ: coding` 已表达大意）。
 */
function codingHintPart(world: WorldFacts): string | null {
  if (world.foregroundCategory !== 'coding') return null;
  return '先生は今、プログラミングに集中している';
}

function idlePart(world: WorldFacts): string | null {
  if (world.userIdleMs === null) return null;
  if (world.userIdleMs < WORLD_TYPING_ACTIVE_MS) return '先生は今入力中';
  return `先生は ${formatElapsedJa(world.userIdleMs)}前まで入力中`;
}

function lastTalkPart(world: WorldFacts): string | null {
  if (world.lastInteractionAt === null) return null;
  const elapsed = world.now - world.lastInteractionAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return `前回の会話から ${formatElapsedJa(elapsed)}`;
}

/**
 * 拼段 3.5。缺哪一项就**整段省略**那一项（不写"未知"），因为小模型会把"未知"
 * 当成一个需要解释的事实，反而答非所问。
 *
 * 超长时按"先截应用类别 → 再丢上次会话 → 再丢输入状态"的顺序降级，时间戳永远保留
 * （ADR 0032 D2 在该顺序里插入"编程提示"，见下）。
 */
export function formatWorldSegment(world: WorldFacts): string {
  const head = `環境: ${formatWorldStamp(world.now)}`;
  // 分项顺序即 §9.3 的分项顺序。尾部优先丢弃时，被丢的次序是
  // "上次会话 → 编程提示 → 应用类别 → 输入状态"，正好是信息量从低到高（ADR 0032 D2）。
  const tail = [idlePart(world), appPart(world), codingHintPart(world), lastTalkPart(world)].filter(
    (part): part is string => part !== null,
  );

  const build = (parts: string[]): string => (parts.length === 0 ? head : `${head} / ${parts.join(' / ')}`);

  let text = build(tail);
  if (text.length <= WORLD_SEGMENT_MAX_CHARS) return text;

  // ① 先砍应用类别（`other: <长类名>` 是唯一可能超长的分项）
  const appIndex = tail.findIndex((part) => part.startsWith('前面のアプリ:'));
  if (appIndex >= 0) {
    const app = tail[appIndex] ?? '';
    const over = text.length - WORLD_SEGMENT_MAX_CHARS;
    const shrinkTo = Math.max(0, app.length - over - 1);
    if (shrinkTo > '前面のアプリ: '.length) {
      tail[appIndex] = `${app.slice(0, shrinkTo)}…`;
      text = build(tail);
      if (text.length <= WORLD_SEGMENT_MAX_CHARS) return text;
    }
  }

  // ② 再按"尾部优先"逐个丢弃：上次会话 → 编程提示 → 应用类别 → 输入状态。
  // 顺序固定，保证同样输入永远同样输出（段 3.5 必须可复现，否则提示词无法单测）。
  let remaining = [...tail];
  while (remaining.length > 0) {
    remaining = remaining.slice(0, -1);
    text = build(remaining);
    if (text.length <= WORLD_SEGMENT_MAX_CHARS) return text;
  }
  return head;
}

/** 把 presence 读数与编排内部状态拼成 `WorldFacts`（纯搬运，不做判断）。 */
export function buildWorldFacts(input: {
  now: number;
  presence: PresenceSnapshot | null;
  lastInteractionAt: number | null;
}): WorldFacts {
  return {
    now: input.now,
    userIdleMs: input.presence?.userIdleMs ?? null,
    // ADR 0032 D1：只搬归一化类别。原始标题/类名**不进** `WorldFacts`（类型上就没有这两个字段）
    foregroundCategory: input.presence?.foregroundCategory ?? '',
    lastInteractionAt: input.lastInteractionAt,
  };
}
