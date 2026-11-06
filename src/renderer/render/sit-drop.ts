/**
 * 坐姿**下坐弹簧**（ADR 0051）。
 *
 * 替代 ADR 0042 的 240ms 线性半蹲。需求给定的模型与参数：
 *
 * ```
 * v += (-k·(x - 1) - c·v)·dt
 * x += v·dt
 * k = 180, c = 26.8（≈ 2√k，ζ=1 临界阻尼）
 * ```
 *
 * 为什么用弹簧而不是缓动曲线：线性/`easeOut` 的"速度曲线"是写死的，落座读起来像
 * "被按下去"；临界阻尼弹簧是"重量落在座面上"——起步有加速度、到底不弹回来。
 *
 * 纯数值、不读时钟。积分用**固定子步长**（`SIT_DROP_SUBSTEP_SECONDS`），所以 30/60/144Hz
 * 下的解一致；整帧 dt 另夹到 `SIT_DROP_MAX_DT_SECONDS`，切后台回来不会一步跨完。
 */
import {
  SIT_DROP_DAMPING,
  SIT_DROP_MAX_DT_SECONDS,
  SIT_DROP_STIFFNESS,
  SIT_DROP_SUBSTEP_SECONDS,
} from '../../shared/constants';

export interface SitDropState {
  /** 0 = 还在座面上方，1 = 完全坐好 */
  value: number;
  /** 变化速度（1/s） */
  velocity: number;
}

export interface SitDropOptions {
  stiffness?: number;
  damping?: number;
  maxDtSeconds?: number;
  substepSeconds?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 推进一帧（纯函数，返回新状态）。
 *
 * @param state 当前状态
 * @param dtSeconds 距上一帧的秒数（NaN/负值按 0；超过上限按上限）
 * @param target 目标值（默认 1）
 */
export function stepSitDrop(
  state: SitDropState,
  dtSeconds: number,
  target = 1,
  options: SitDropOptions = {},
): SitDropState {
  const k = Number.isFinite(options.stiffness) ? (options.stiffness as number) : SIT_DROP_STIFFNESS;
  const c = Number.isFinite(options.damping) ? (options.damping as number) : SIT_DROP_DAMPING;
  const maxDt = Number.isFinite(options.maxDtSeconds)
    ? Math.max(0, options.maxDtSeconds as number)
    : SIT_DROP_MAX_DT_SECONDS;
  const substep = Number.isFinite(options.substepSeconds)
    ? Math.max(1e-4, options.substepSeconds as number)
    : SIT_DROP_SUBSTEP_SECONDS;
  const goal = Number.isFinite(target) ? target : 1;

  let value = Number.isFinite(state.value) ? state.value : 0;
  let velocity = Number.isFinite(state.velocity) ? state.velocity : 0;
  let remaining = Number.isFinite(dtSeconds) ? clamp(dtSeconds, 0, maxDt) : 0;

  while (remaining > 0) {
    const h = Math.min(remaining, substep);
    // 半隐式欧拉：先更新速度、再用新速度更新位置（显式欧拉在 k=180 下会发散）
    velocity += (-k * (value - goal) - c * velocity) * h;
    value += velocity * h;
    remaining -= h;
  }

  // 临界阻尼理论上不过冲；这里只做数值安全钳制（真过冲说明参数被改坏了）
  if (value > 1) {
    value = 1;
    velocity = 0;
  }
  if (value < 0) {
    value = 0;
    velocity = 0;
  }
  return { value, velocity };
}

export interface SitDropSpring {
  /** 推进一帧，返回当前值 */
  update(dtSeconds: number, target?: number): number;
  value(): number;
  velocity(): number;
  state(): SitDropState;
  reset(): void;
}

/** 有状态的弹簧（render 每帧调用一次）。 */
export function createSitDrop(): SitDropSpring {
  let state: SitDropState = { value: 0, velocity: 0 };
  return {
    update(dtSeconds: number, target = 1): number {
      state = stepSitDrop(state, dtSeconds, target);
      return state.value;
    },
    value(): number {
      return state.value;
    },
    velocity(): number {
      return state.velocity;
    },
    state(): SitDropState {
      return { ...state };
    },
    reset(): void {
      state = { value: 0, velocity: 0 };
    },
  };
}
