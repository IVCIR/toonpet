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
  DRAG_SWING_LIMIT_STEPS,
  DRAG_SWING_MIN_ANGLE_RAD,
  DRAG_SWING_SAFETY_PX,
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

// ---------------------------------------------------------------------------
// 摆角的视口约束（ADR 0058 D3）
// ---------------------------------------------------------------------------

/** 侧影采样点（animationRoot 局部 px：脚底中心为原点，x 右、y 上）。 */
export interface SwingPoint {
  x: number;
  y: number;
}

/** 视口（= 窗口内容区，世界单位 = CSS px，正交相机铺满整个内容区）。 */
export interface SwingViewport {
  /** 半宽：`|x|` 必须小于它 */
  halfWidthPx: number;
  /** 内容区高度：`y` 必须落在 [0, heightPx] */
  heightPx: number;
}

export interface SwingLimitInput {
  /** 侧影采样点（`measureSilhouette()` 的每一带的左右边缘） */
  points: readonly SwingPoint[];
  /** 抓取点（同一局部坐标） */
  pivot: SwingPoint;
  viewport: SwingViewport;
  /** 物理上限（`DRAG_PENDULUM[band].angleLimitRad`） */
  limitRad: number;
  /** 兜底下限：算不出可行角时用它，绝不返回 0 */
  minAngleRad?: number;
  /** 求解分辨率 */
  steps?: number;
  /** 安全余量（px）：按"可用半宽 − 它"来解 */
  safetyPx?: number;
}

/**
 * 绕 `pivot` 转 `angle` 之后，侧影是否还整个落在视口里。
 *
 * 变换与渲染完全一致：先绕支点旋转（`animationRoot.rotation.z`），
 * 再平移 `pivotCompensation()`（保持抓取点不动）—— 所以等价于"绕支点转"。
 */
export function swingFits(
  points: readonly SwingPoint[],
  pivot: SwingPoint,
  angle: number,
  viewport: SwingViewport,
  safetyPx = 0,
): boolean {
  const px = finiteOrZero(pivot.x);
  const py = finiteOrZero(pivot.y);
  const theta = finiteOrZero(angle);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const limitX = viewport.halfWidthPx - Math.max(0, finiteOrZero(safetyPx));
  const top = viewport.heightPx;
  for (const point of points) {
    const dx = finiteOrZero(point.x) - px;
    const dy = finiteOrZero(point.y) - py;
    const x = px + dx * cos - dy * sin;
    const y = py + dx * sin + dy * cos;
    if (Math.abs(x) > limitX) return false;
    // 竖直：脚底贴内容区底边（y=0），头顶不能超过内容区高度。
    // 容差 1px 是给取整用的：静止时脚底正好在 0，不能让浮点误差把它判成越界。
    if (y < -1 || y > top + 1) return false;
  }
  return true;
}

/**
 * **摆角的视口约束**：在物理上限 `limitRad` 之内，求出"侧影仍完整可见"的最大摆角。
 *
 * 为什么要它：`DRAG_PENDULUM` 的 `angleLimitRad`（抓头 0.35rad ≈ 20°）是**手感**上限，
 * 与窗口多大无关；而窗口只比模型宽一点点，甩到 20° 时整身绕抓取点转，头发/身体必然
 * 顶出内容区被裁掉（真机"边缘被切"）。视口边距（`MODEL_VIEW_PADDING_PX`）把可摆范围
 * 撑大之后，这条约束负责**收口**：越接近边缘角度越饱和，而不是让画面破掉。
 *
 * 纯函数、无分配；只在拖拽开始 / 窗口缩放时算一次（不是每帧）。
 */
export function maxSwingAngle(input: SwingLimitInput): number {
  const limit = Math.abs(finiteOrZero(input.limitRad));
  if (!(limit > 0)) return 0;
  const minAngle = clamp(
    Math.abs(finiteOrZero(input.minAngleRad ?? DRAG_SWING_MIN_ANGLE_RAD)),
    0,
    limit,
  );
  const points = input.points ?? [];
  if (points.length === 0) return minAngle;
  const viewport = input.viewport;
  if (!(viewport?.halfWidthPx > 0) || !(viewport?.heightPx > 0)) return minAngle;
  const steps = Math.max(2, Math.min(256, Math.round(input.steps ?? DRAG_SWING_LIMIT_STEPS)));
  const safety = Math.max(0, finiteOrZero(input.safetyPx ?? DRAG_SWING_SAFETY_PX));

  if (swingFits(points, input.pivot, limit, viewport, safety)) return limit;

  // 线性扫描找"第一个不行的步"，再在 [上一个可行, 这个不可行] 之间插值。
  // 不假设单调性（模型的侧影不是凸的），但每一步都重新判一次，所以不会跳过一个可行的尖峰。
  let lastGood = 0;
  for (let step = 1; step <= steps; step += 1) {
    const angle = (limit * step) / steps;
    if (swingFits(points, input.pivot, angle, viewport, safety)) {
      lastGood = angle;
      continue;
    }
    const stepSize = limit / steps;
    const previous = angle - stepSize;
    // 二分 3 次即可到 1/8 步（≤0.0014rad ≈0.08°），比线性插值更贴边界
    let low = previous;
    let high = angle;
    for (let i = 0; i < 3; i += 1) {
      const mid = (low + high) / 2;
      if (swingFits(points, input.pivot, mid, viewport, safety)) low = mid;
      else high = mid;
    }
    return Math.max(minAngle, low);
  }
  return limit;
}

