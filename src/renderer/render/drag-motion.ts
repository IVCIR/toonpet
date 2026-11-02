/**
 * 拖拽的纯数学层（ADR 0035）：抓取部位、受迫单摆、绕支点补偿、三态骨骼姿态。
 *
 * 不引用 three / DOM / 时钟；所有输入由调用方注入，因此可以脱离 WebGL 单测。
 * 这里是"手感"的唯一出处：摆长、阻尼、限幅、挣扎频率都在 `shared/constants.ts`。
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
  liftPx: number;
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

export type DragBoneKey =
  | 'spine'
  | 'spine1'
  | 'neck'
  | 'head'
  | 'upperArmL'
  | 'upperArmR'
  | 'forearmL'
  | 'forearmR'
  | 'thighL'
  | 'thighR'
  | 'calfL'
  | 'calfR'
  | 'footL'
  | 'footR';

export interface DragBoneOffset {
  bone: DragBoneKey;
  yaw: number;
  pitch: number;
  roll: number;
}

/**
 * 三态悬挂姿态（ADR 0035 D2）。返回值是**未乘增益**的弧度，调用方统一乘 `gain`。
 *
 * 符号来自 2026-11-02 的实机标定（`dist/selftest/calib-*.png` + 骨骼世界坐标）：
 * - `pitch > 0`（绕世界 X 正转）：`spine`/`neck` **低头/前屈**；`upperArm`/`thigh`/`calf`
 *   是**向后摆**（世界 z 变小）。所以"腿往前抬/膝盖前屈"要用负 pitch。
 * - `roll < 0`（绕世界 Z 负转）：左右 `upperArm` **都抬手**（手的世界 y 变大）；
 *   `roll > 0` 是放下/内收。左右臂因此用同一个符号，而不是镜像。
 * - `yaw` 只用于轻微扭身，不做主要表达。
 *
 * 所有幅度都刻意保守：抓脚的上臂 roll 约 -1.4rad，窗口只有 422×720，
 * 实机若出现手臂被窗口裁切，优先降低 roll（见 ADR 0035 的"后果"）。
 */
export function dragBoneOffsets(band: DragBand, nowMs: number): DragBoneOffset[] {
  const struggle = band === 'foot' ? Math.sin((finiteOrZero(nowMs) / 1000) * Math.PI * 2 * 2.5) : 0;
  if (band === 'head') {
    return [
      // 抓头：普通站姿底 + 头/颈/脊柱前屈 + 腿微垂（真实悬挂感）
      { bone: 'spine', yaw: 0, pitch: 0.1, roll: 0 },
      { bone: 'spine1', yaw: 0, pitch: 0.05, roll: 0 },
      { bone: 'neck', yaw: 0, pitch: 0.12, roll: 0 },
      { bone: 'head', yaw: 0, pitch: 0.08, roll: 0 },
      // 手臂自然下垂：很小的前摆；不要用 roll 抬手，否则会变成"投降"
      { bone: 'upperArmL', yaw: 0, pitch: -0.04, roll: 0.02 },
      { bone: 'upperArmR', yaw: 0, pitch: -0.04, roll: 0.02 },
      { bone: 'forearmL', yaw: 0, pitch: -0.12, roll: 0 },
      { bone: 'forearmR', yaw: 0, pitch: -0.12, roll: 0 },
      // 腿微垂：大腿略前（-pitch）、小腿略后（+pitch）
      { bone: 'thighL', yaw: 0, pitch: -0.12, roll: 0 },
      { bone: 'thighR', yaw: 0, pitch: -0.12, roll: 0 },
      { bone: 'calfL', yaw: 0, pitch: 0.24, roll: 0 },
      { bone: 'calfR', yaw: 0, pitch: 0.24, roll: 0 },
    ];
  }
  if (band === 'body') {
    return [
      { bone: 'spine', yaw: 0, pitch: -0.04, roll: 0 },
      { bone: 'spine1', yaw: 0, pitch: -0.02, roll: 0 },
      { bone: 'neck', yaw: 0, pitch: -0.03, roll: 0 },
      { bone: 'head', yaw: 0, pitch: -0.02, roll: 0 },
      // 双臂略外张：负 roll 是抬手，幅度很小
      { bone: 'upperArmL', yaw: 0, pitch: -0.02, roll: -0.14 },
      { bone: 'upperArmR', yaw: 0, pitch: -0.02, roll: -0.14 },
      { bone: 'forearmL', yaw: 0, pitch: -0.1, roll: 0 },
      { bone: 'forearmR', yaw: 0, pitch: -0.1, roll: 0 },
      { bone: 'thighL', yaw: 0, pitch: 0.02, roll: 0 },
      { bone: 'thighR', yaw: 0, pitch: 0.02, roll: 0 },
      { bone: 'calfL', yaw: 0, pitch: 0.06, roll: 0 },
      { bone: 'calfR', yaw: 0, pitch: 0.06, roll: 0 },
    ];
  }
  // 抓脚：不真倒吊（窗口装不下），用"前折 + 举臂 + 屈膝"表达挣扎。
  // 举臂 = 负 roll（左右同号）；屈膝 = 大腿负 pitch + 小腿正 pitch。
  return [
    { bone: 'spine', yaw: 0, pitch: 0.22, roll: struggle * 0.012 },
    { bone: 'spine1', yaw: 0, pitch: 0.12, roll: 0 },
    { bone: 'neck', yaw: 0, pitch: 0.08, roll: struggle * 0.02 },
    { bone: 'head', yaw: 0, pitch: -0.12, roll: struggle * 0.025 },
    { bone: 'upperArmL', yaw: 0, pitch: -0.05, roll: -1.4 - struggle * 0.04 },
    { bone: 'upperArmR', yaw: 0, pitch: -0.05, roll: -1.4 + struggle * 0.04 },
    { bone: 'forearmL', yaw: 0, pitch: -0.3, roll: 0 },
    { bone: 'forearmR', yaw: 0, pitch: -0.3, roll: 0 },
    { bone: 'thighL', yaw: 0, pitch: -0.24, roll: 0 },
    { bone: 'thighR', yaw: 0, pitch: -0.24, roll: 0 },
    { bone: 'calfL', yaw: 0, pitch: 0.42, roll: 0 },
    { bone: 'calfR', yaw: 0, pitch: 0.42, roll: 0 },
  ];
}
