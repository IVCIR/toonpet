/**
 * 拖拽的纯数学层（ADR 0035；ADR 0041 D1 起收窄）：抓取分类、受迫单摆、绕支点补偿。
 *
 * 不引用 three / DOM / 时钟；所有输入由调用方注入，因此可以脱离 WebGL 单测。
 * 这里是"手感"的唯一出处：摆长、阻尼、限幅、挣扎频率都在 `shared/constants.ts`。
 *
 * **边界（ADR 0041 D1）**：抓取带只决定单摆的物理参数，**不决定播哪段官方片段**，
 * 也不再提供任何"按部位手写的骨骼姿态"。悬空姿态由官方片段 `Formation_Pickup`
 * 自己给出；这里只剩整身绕抓取点的旋转（θ）与它的位置补偿。
 *
 * 坐标约定：
 * - `angle` 是根骨骼绕世界 Z 轴的摆角（rad），正值 = 逆时针；
 * - `pivot` 是抓取点在 `animationRoot` 局部坐标中的位置（x 右、y 上）；
 * - 支撑加速度 `accelerationX/Y` 使用屏幕坐标（x 右、y 下），所以 y 向下为正。
 */
import {
  DRAG_FOOT_KICK_DURATION_MS,
  DRAG_FOOT_KICK_MAX_INTERVAL_MS,
  DRAG_FOOT_KICK_MIN_INTERVAL_MS,
  DRAG_GRAVITY_PX_PER_SEC2,
  DRAG_PENDULUM,
  DRAG_PENDULUM_SUBSTEP_SECONDS,
} from '../../shared/constants';

export type DragBand = 'head' | 'body' | 'foot';

export interface DragPendulumState {
  angle: number;
  angularVelocity: number;
}

export interface DragForcing {
  /** 窗口支撑点的水平加速度（px/s²，右为正） */
  accelerationX: number;
  /** 窗口支撑点的竖直加速度（px/s²，下为正） */
  accelerationY: number;
}

export interface DragStepInput {
  dtSeconds: number;
  /** 调用方已滤波、限幅、做过去死区的支撑加速度 */
  forcing: DragForcing;
  /** 单调时钟（ms），只用于抓脚的挣扎/踢腿相位 */
  nowMs: number;
}

export interface DragPendulumConfig {
  lengthPx: number;
  damping: number;
  angleLimitRad: number;
  struggleHz: number;
  struggleRad: number;
}

export function pendulumConfigFor(band: DragBand): DragPendulumConfig {
  return DRAG_PENDULUM[band];
}

export function createDragPendulum(): DragPendulumState {
  return { angle: 0, angularVelocity: 0 };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * 受迫单摆一步积分（半隐式欧拉 + 固定子步长）：
 *
 *   θ̈ = -(g_eff / L)·sinθ - c·θ̇ - (a_x / L)·cosθ
 *   g_eff = clamp(g + a_y, 0.35g, 2.2g)
 *
 * `a_x` 是支撑点的水平加速度：支撑向右加速时，身体因惯性向左摆（θ 为负）。
 */
export function stepDragPendulum(
  state: DragPendulumState,
  band: DragBand,
  input: DragStepInput,
): DragPendulumState {
  const config = pendulumConfigFor(band);
  const dt = finiteOrZero(input.dtSeconds);
  if (dt <= 0 || config.lengthPx <= 0) return { ...state };

  let angle = finiteOrZero(state.angle);
  let omega = finiteOrZero(state.angularVelocity);
  const ax = clamp(
    finiteOrZero(input.forcing.accelerationX),
    -DRAG_GRAVITY_PX_PER_SEC2 * 4,
    DRAG_GRAVITY_PX_PER_SEC2 * 4,
  );
  const ay = clamp(
    finiteOrZero(input.forcing.accelerationY),
    -DRAG_GRAVITY_PX_PER_SEC2 * 4,
    DRAG_GRAVITY_PX_PER_SEC2 * 4,
  );
  const gravity = DRAG_GRAVITY_PX_PER_SEC2;
  const gEff = clamp(gravity + ay, gravity * 0.35, gravity * 2.2);

  let remaining = Math.min(0.05, dt);
  while (remaining > 0) {
    const h = Math.min(DRAG_PENDULUM_SUBSTEP_SECONDS, remaining);
    const angularAcceleration =
      -(gEff / config.lengthPx) * Math.sin(angle) -
      config.damping * omega -
      (ax / config.lengthPx) * Math.cos(angle);
    omega += angularAcceleration * h;
    angle += omega * h;
    remaining -= h;
  }

  angle = clamp(angle, -config.angleLimitRad, config.angleLimitRad);
  omega = clamp(omega, -6, 6);
  return { angle, angularVelocity: omega };
}

/**
 * 抓脚时叠加的挣扎偏移（不再进积分状态，避免逐帧累积）。
 * 纯正弦 + 按周期出现的踢腿包络；`gain` 控制淡入淡出。
 *
 * ADR 0041 D1：它只作为**单摆角度**的一部分（整身绕抓取点摆），不再驱动任何骨骼。
 */
export function struggleOffset(band: DragBand, nowMs: number, gain = 1): number {
  const config = pendulumConfigFor(band);
  if (config.struggleHz <= 0 || config.struggleRad <= 0 || gain <= 0) return 0;
  const now = finiteOrZero(nowMs);
  const phase = (now / 1000) * config.struggleHz * Math.PI * 2;
  const wobble = Math.sin(phase) * config.struggleRad;

  const period = (DRAG_FOOT_KICK_MIN_INTERVAL_MS + DRAG_FOOT_KICK_MAX_INTERVAL_MS) / 2;
  const local = ((now % period) + period) % period;
  const kickEnvelope =
    local < DRAG_FOOT_KICK_DURATION_MS
      ? Math.sin((Math.PI * local) / DRAG_FOOT_KICK_DURATION_MS)
      : 0;
  // 踢腿方向按周期交替，看起来像"蹬两下"而不是规律抖动
  const kickDirection = Math.floor(now / period) % 2 === 0 ? 1 : -1;
  const kick = kickEnvelope * config.struggleRad * 1.8 * kickDirection;
  return (wobble + kick) * clamp(gain, 0, 1);
}

/**
 * 绕支点旋转时，为保持支点不动需要给根节点的位置补偿（二维向量）。
 *
 * `position = B + p - R(θ)·p`，其中 `B` 是调用方原有的基础偏移。
 * 返回 `p - R(θ)·p` 的 x/y，调用方直接加到基础偏移上。
 */
export function pivotCompensation(
  pivot: { x: number; y: number },
  angle: number,
): { x: number; y: number } {
  const px = finiteOrZero(pivot.x);
  const py = finiteOrZero(pivot.y);
  const theta = finiteOrZero(angle);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x: px - (px * cos - py * sin),
    y: py - (px * sin + py * cos),
  };
}
