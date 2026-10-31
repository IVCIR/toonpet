/**
 * 包络电平 → 嘴型图集帧（ADR 0015 D4）。
 *
 * 纯逻辑：不碰 AudioContext / DOM，可单测。
 *
 * 标定假设（写进 MODULE_STATUS 坑位）：图集 8×8=64 帧没有语义标注，本实现假定
 * 帧 `0..7` 是"闭口 → 逐步张口"，帧 0 = 闭嘴；`8+` 不用于口型。
 */
import {
  ENVELOPE_ATTACK,
  ENVELOPE_RELEASE,
  MOUTH_FRAME_CLOSED,
  MOUTH_LEVELS,
  MOUTH_UPDATE_MIN_INTERVAL_MS,
} from '../../shared/constants';

export interface MouthMapper {
  /** 按目标电平与时刻推进；未到刷新间隔时返回当前帧（changed=false） */
  update(level: number, at: number): { frame: number; changed: boolean; level: number };
  reset(): void;
  readonly frame: number;
  readonly level: number;
}

export function levelToFrame(level: number): number {
  const clamped = Math.min(1, Math.max(0, level));
  return Math.round(clamped * (MOUTH_LEVELS - 1));
}

export function createMouthMapper(): MouthMapper {
  let level = 0;
  let frame = MOUTH_FRAME_CLOSED;
  let lastUpdateAt = Number.NEGATIVE_INFINITY;

  return {
    update(target: number, at: number): { frame: number; changed: boolean; level: number } {
      const clamped = Math.min(1, Math.max(0, target));
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

      const nextFrame = levelToFrame(level);
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
