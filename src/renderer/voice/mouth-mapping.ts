/**
 * 包络电平 → 嘴型图集帧（ADR 0015 D4；ADR 0045 D4.2 改成四档元音）。
 *
 * 纯逻辑：不碰 AudioContext / DOM，可单测。
 *
 * 帧序来自 `Character_Mouth_High-BgFqI_9W.png`（8×8，本轮逐帧目视核对）：
 * `0` 极细横线 / `1` 大椭圆 / `2` 扁宽张口 / `3` 高圆张口 / `4` 中椭圆 /
 * `6` 扁小椭圆 / `7` 小弧线（闭） / `8` 下弯弧 / `9` 高圆张口 / `14` 扁小椭圆。
 *
 * 为什么不再用 `round(level·7)`：连续量化在**稳定电平**下只会停在同一帧
 * （本机 TTS 的 RMS 很平），真机表现就是"说话时永远只有一张嘴"。
 * 现在改成四档 + 档内轮换：
 *
 * | 电平 | 档 | 帧 | 观感 |
 * |---|---|---|---|
 * | < 0.12 | 闭 | 7 | 闭嘴弧线 |
 * | < 0.40 | 微张 | 6 / 14 交替 | 嘴唇刚分开 |
 * | < 0.72 | 中张 | 1 / 3 交替 | 元音 a/o 之间 |
 * | ≥ 0.72 | 大张 | 2 / 9 交替 | 明显张口 |
 *
 * 档内每 `MOUTH_VISEME_SLOT_MS`（180ms）换一张，读起来是"同一句话里嘴在动"，
 * 而不是"一张嘴开合"。档位边界取 0.12/0.40/0.72（而不是均分），是为了让轻声
 * 辅音更容易落在"微张"，不会一直闭着。
 */
import {
  ENVELOPE_ATTACK,
  ENVELOPE_RELEASE,
  MOUTH_FRAME_CLOSED,
  MOUTH_UPDATE_MIN_INTERVAL_MS,
  MOUTH_VISEME_SLOT_MS,
  MOUTH_VISEME_WIDE_ALTERNATE,
} from '../../shared/constants';

export interface MouthMapper {
  /** 按目标电平与时刻推进；未到刷新间隔时返回当前帧（changed=false） */
  update(level: number, at: number): { frame: number; changed: boolean; level: number };
  reset(): void;
  readonly frame: number;
  readonly level: number;
}

/**
 * 四档元音各自可用的图集帧（同一档内轮换 → 同一电平也能"嘴在动"）。
 * 每档至少一张；两张的档位按 slot 奇偶交替。
 */
const VISEME_BUCKETS: readonly (readonly number[])[] = [
  [MOUTH_FRAME_CLOSED],
  [6, 14],
  [1, 3],
  [2, MOUTH_VISEME_WIDE_ALTERNATE],
];

/** 电平 → 档位下标（0..3）。 */
export function visemeIndex(level: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  if (clamped < 0.12) return 0;
  if (clamped < 0.4) return 1;
  if (clamped < 0.72) return 2;
  return 3;
}

/**
 * 电平 + 时刻 → 图集帧（纯函数，带档内轮换）。
 * `at` 只用于选"档内第几张"，不参与电平；NaN/负值按 0 处理。
 */
export function visemeFrame(level: number, at: number): number {
  const bucket = VISEME_BUCKETS[visemeIndex(level)] ?? VISEME_BUCKETS[0];
  if (bucket.length === 1) return bucket[0] as number;
  const clock = Number.isFinite(at) ? Math.max(0, at) : 0;
  const slot = Math.floor(clock / MOUTH_VISEME_SLOT_MS);
  return bucket[Math.abs(slot) % bucket.length] as number;
}

/** 兼容旧调用（近似"不带轮换的静态映射"）：等价于 `visemeFrame(level, 0)`。 */
export function levelToFrame(level: number): number {
  return visemeFrame(level, 0);
}

export function createMouthMapper(): MouthMapper {
  let level = 0;
  let frame = MOUTH_FRAME_CLOSED;
  let lastUpdateAt = Number.NEGATIVE_INFINITY;

  return {
    update(target: number, at: number): { frame: number; changed: boolean; level: number } {
      const clamped = Math.min(1, Math.max(0, Number.isFinite(target) ? target : 0));
      if (at - lastUpdateAt < MOUTH_UPDATE_MIN_INTERVAL_MS) {
        return { frame, changed: false, level };
      }
      const elapsed = Math.max(1, at - lastUpdateAt);
      lastUpdateAt = at;
      // 上升更快（attack）、下降稍慢（release），避免嘴角抖动
      const coefficient = clamped > level ? ENVELOPE_ATTACK : ENVELOPE_RELEASE;
      // 以 16ms 为基准换算到本次间隔，间隔越长收敛越多
      const alpha = Math.min(1, coefficient * (elapsed / 16));
      level += (clamped - level) * alpha;
      if (level < 0.02) level = 0;

      const nextFrame = visemeFrame(level, at);
      const changed = nextFrame !== frame;
      frame = nextFrame;
      return { frame, changed, level };
    },

    reset(): void {
      level = 0;
      frame = MOUTH_FRAME_CLOSED;
      lastUpdateAt = Number.NEGATIVE_INFINITY;
    },

    get frame(): number {
      return frame;
    },

    get level(): number {
      return level;
    },
  };
}
