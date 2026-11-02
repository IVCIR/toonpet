/**
 * 吸附接近的纯数学（ADR 0034 D3）。主进程侧模块，不碰 Electron / 定时器。
 *
 * 形状刻意分成两种：
 * - `walk`：同一地面线，水平走过去（ease-in-out，起步/收步都不生硬）；
 * - `leap`：需要升高，先水平走到目标 x 下方，再短促弧线跳上去。
 *
 * 所有时间都是"计划的 0..1 进度"，真正的倒计时在 `snap.ts` 的既有 16ms tick 里：
 * `t += dt / durationMs`，`t >= 1` 才 commit。
 */
import {
  SNAP_APPROACH_ARC_MAX_PX,
  SNAP_APPROACH_ARC_MIN_PX,
  SNAP_APPROACH_ARC_RATIO,
  SNAP_APPROACH_INSTANT_PX,
  SNAP_APPROACH_LEAP_BASE_MS,
  SNAP_APPROACH_LEAP_DISTANCE_DIVISOR,
  SNAP_APPROACH_MAX_MS,
  SNAP_APPROACH_MIN_MS,
  SNAP_APPROACH_WALK_MAX_DY_PX,
  SNAP_APPROACH_WALK_SPEED_PX_PER_SEC,
} from '../../shared/constants';

export interface ApproachPoint {
  x: number;
  y: number;
}

export type ApproachMode = 'walk' | 'leap';

export interface ApproachPlan {
  mode: ApproachMode;
  from: ApproachPoint;
  to: ApproachPoint;
  durationMs: number;
  /** leap 的前半段（水平走）占比；walk 模式恒为 1 */
  walkFraction: number;
  /** leap 的弧高（px，向上为正）；walk 模式恒为 0 */
  arcHeightPx: number;
}

export interface ApproachSample {
  x: number;
  y: number;
  /** 0..1 的原始进度（未缓动），诊断用 */
  progress: number;
  done: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function easeInOutCubic(t: number): number {
  const p = clamp(t, 0, 1);
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

function easeOutCubic(t: number): number {
  const p = clamp(t, 0, 1);
  return 1 - (1 - p) ** 3;
}

/** 距离小于瞬时阈值时返回 null（调用方直接 commit，不做接近）。 */
export function planApproach(from: ApproachPoint, to: ApproachPoint): ApproachPlan | null {
  if (
    !Number.isFinite(from.x) ||
    !Number.isFinite(from.y) ||
    !Number.isFinite(to.x) ||
    !Number.isFinite(to.y)
  ) {
    return null;
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= SNAP_APPROACH_INSTANT_PX) return null;

  const sameGround = Math.abs(dy) <= SNAP_APPROACH_WALK_MAX_DY_PX;
  if (sameGround) {
    const durationMs = clamp(
      (Math.abs(dx) / SNAP_APPROACH_WALK_SPEED_PX_PER_SEC) * 1000,
      SNAP_APPROACH_MIN_MS,
      SNAP_APPROACH_MAX_MS,
    );
    return {
      mode: 'walk',
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      durationMs,
      walkFraction: 1,
      arcHeightPx: 0,
    };
  }

  // 先走到目标 x 下方，再用 220ms 左右的短弧升到目标 y
  const walkMs = (Math.abs(dx) / SNAP_APPROACH_WALK_SPEED_PX_PER_SEC) * 1000;
  const hopMs = 220;
  const rawDuration = walkMs + hopMs;
  const durationMs = clamp(rawDuration, 320, SNAP_APPROACH_MAX_MS);

  return {
    mode: 'leap',
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    durationMs,
    walkFraction: clamp(walkMs / Math.max(1, rawDuration), 0.05, 0.8),
    arcHeightPx: clamp(
      Math.abs(dx) * SNAP_APPROACH_ARC_RATIO + SNAP_APPROACH_ARC_MIN_PX,
      SNAP_APPROACH_ARC_MIN_PX,
      SNAP_APPROACH_ARC_MAX_PX,
    ),
  };
}

/** 按 0..1 进度采样窗口左上角位置。 */
export function sampleApproach(plan: ApproachPlan, progress: number): ApproachSample {
  const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const dx = plan.to.x - plan.from.x;
  const dy = plan.to.y - plan.from.y;

  if (plan.mode === 'walk') {
    const eased = easeInOutCubic(p);
    return {
      x: plan.from.x + dx * eased,
      // 同一地面线也可能有 ≤16px 的高度差：一起缓动，避免最后 1 帧竖直跳一下
      y: plan.from.y + dy * eased,
      progress: p,
      done: p >= 1,
    };
  }

  const wf = clamp(plan.walkFraction, 0.01, 0.99);
  if (p < wf) {
    const eased = easeInOutCubic(p / wf);
    return {
      x: plan.from.x + dx * eased,
      y: plan.from.y,
      progress: p,
      done: false,
    };
  }

  const q = clamp((p - wf) / (1 - wf), 0, 1);
  const y = plan.from.y + dy * easeOutCubic(q) - plan.arcHeightPx * 4 * q * (1 - q);
  return {
    x: plan.to.x,
    y,
    progress: p,
    done: p >= 1,
  };
}

/** 时长 → 本 tick 的进度增量（调用方持有 `lastTickAt`）。 */
export function approachDelta(plan: ApproachPlan, dtMs: number): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0 || plan.durationMs <= 0) return 0;
  return Math.min(0.25, dtMs / plan.durationMs);
}
