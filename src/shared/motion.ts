/**
 * 位移物理：**纯函数**，不碰 Electron / DOM / 时钟（ADR 0024 D2）。
 *
 * 三件事，全部按"输入状态 + dt → 新状态"求值，同一输入必然得到同一输出：
 * - `stepSpring`：弹簧-阻尼（半隐式欧拉 + 固定子步长），用于着地回弹；
 * - `stepWalk`：带加减速的定速行走（刹车曲线 v = √(2·a·d)），用于 `walking`；
 * - `stepSettle`：竖直弹簧 + 水平惯性衰减，用于 `settling` 整段回弹。
 *
 * 为什么坚持纯函数：主进程的窗口位移与单测必须用**同一份**实现，
 * 否则"手感"只能靠肉眼调，回归时无法断言。渲染侧不参与物理计算（ADR 0024 D4）。
 */
import type { Rect } from './geometry';

export interface SpringState {
  /** 当前坐标（px，屏幕坐标：y 向下为正） */
  position: number;
  /** 当前速度（px/s） */
  velocity: number;
}

export interface SpringConfig {
  /** 刚度 k（1/s²），越大回正越快 */
  stiffness: number;
  /** 阻尼 c（1/s），越小越"弹"；c = 2√k 为临界阻尼 */
  damping: number;
}

/** 单步最大积分步长：4ms 时 k=200 仍稳定（ω·h ≈ 0.06），再大就要抖。 */
const MAX_SUBSTEP_SECONDS = 0.004;
/** dt 上限：切后台/断点回来时不能一步跳过整段回弹。 */
const MAX_STEP_SECONDS = 0.05;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * 弹簧-阻尼一步积分（半隐式欧拉，固定子步长保证稳定性）。
 * `target` 是平衡位置；返回新状态，不修改入参。
 */
export function stepSpring(
  state: SpringState,
  target: number,
  config: SpringConfig,
  dtSeconds: number,
): SpringState {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return state;
  if (!Number.isFinite(state.position) || !Number.isFinite(state.velocity)) return state;

  let position = state.position;
  let velocity = state.velocity;
  let remaining = clamp(dtSeconds, 0, MAX_STEP_SECONDS);

  while (remaining > 0) {
    const h = Math.min(MAX_SUBSTEP_SECONDS, remaining);
    const acceleration = -config.stiffness * (position - target) - config.damping * velocity;
    velocity += acceleration * h;
    position += velocity * h;
    remaining -= h;
  }

  return { position, velocity };
}

/** 是否已静止（位置与速度都在阈值内）。 */
export function isAtRest(
  state: SpringState,
  target: number,
  positionEpsilon: number,
  velocityEpsilon: number,
): boolean {
  return Math.abs(state.position - target) <= positionEpsilon && Math.abs(state.velocity) <= velocityEpsilon;
}

export interface WalkConfig {
  /** 巡航速度（px/s） */
  speed: number;
  /** 加减速（px/s²） */
  acceleration: number;
}

export interface WalkState {
  /** 当前窗口左上角 x（屏幕坐标） */
  x: number;
  vx: number;
  /** 目标 x（屏幕坐标） */
  targetX: number;
}

export interface WalkStepResult {
  state: WalkState;
  /** 本次是否到达目标（调用方据此收步、发 motion_ended） */
  done: boolean;
}

/**
 * 行走一步：刹车曲线决定期望速度，再按加速度逼近。
 *
 * 期望速度取 `min(speed, √(2·a·d))`：距离远时按巡航速度走，接近目标时自然减速，
 * 不需要额外的"减速区"参数，也不会冲过头。
 */
export function stepWalk(state: WalkState, config: WalkConfig, dtSeconds: number): WalkStepResult {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { state, done: false };
  const dt = clamp(dtSeconds, 0, MAX_STEP_SECONDS);

  const remaining = state.targetX - state.x;
  const direction = Math.sign(remaining);
  if (direction === 0) {
    return { state: { ...state, vx: 0 }, done: true };
  }

  const brakeSpeed = Math.sqrt(2 * config.acceleration * Math.abs(remaining));
  const desired = direction * Math.min(config.speed, brakeSpeed);
  const maxDelta = config.acceleration * dt;
  const vx = state.vx + clamp(desired - state.vx, -maxDelta, maxDelta);
  let x = state.x + vx * dt;

  // 越过目标就吸附，避免在目标附近来回抖
  if (Math.sign(state.targetX - x) !== direction) {
    return { state: { x: state.targetX, vx: 0, targetX: state.targetX }, done: true };
  }

  const done = Math.abs(state.targetX - x) < 0.5 && Math.abs(vx) < 1;
  if (done) {
    return { state: { x: state.targetX, vx: 0, targetX: state.targetX }, done: true };
  }
  return { state: { x, vx, targetX: state.targetX }, done: false };
}

export interface SettleConfig extends SpringConfig {
  /** 触地反弹的速度保留率（0 = 完全不弹，1 = 完全弹性） */
  restitution: number;
  /** 小于这个速度就不反弹了（防止无限微弹） */
  minBounceSpeed: number;
  /** 水平惯性衰减（1/s）：vx 按 e^(-k·dt) 衰减 */
  friction: number;
}

export interface SettleState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface SettleStepResult {
  state: SettleState;
  /** 本次 tick 刚触地（调用方据此触发一次落地缓冲） */
  landed: boolean;
  /** 整段回弹结束（位置与速度都静止） */
  done: boolean;
}

/**
 * 回弹一步：竖直方向用弹簧拉回地面，触地时按 `restitution` 反弹一次；
 * 水平方向只做惯性衰减，并夹在工作区内（D-7 的钳制不在这里，由调用方保证）。
 */
export function stepSettle(
  state: SettleState,
  groundY: number,
  config: SettleConfig,
  dtSeconds: number,
): SettleStepResult {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { state, landed: false, done: false };
  const dt = clamp(dtSeconds, 0, MAX_STEP_SECONDS);

  let { x, y, vx, vy } = state;

  // 水平：惯性 + 指数衰减
  x += vx * dt;
  vx *= Math.exp(-config.friction * dt);
  if (Math.abs(vx) < 1) vx = 0;

  // 竖直：弹簧拉向地面
  const spring = stepSpring({ position: y, velocity: vy }, groundY, config, dt);
  y = spring.position;
  vy = spring.velocity;

  let landed = false;
  // 触地：不许穿到地面以下；速度反向并按恢复系数衰减
  if (y >= groundY) {
    y = groundY;
    if (vy > 0) {
      landed = true;
      vy = -vy * clamp(config.restitution, 0, 1);
      if (Math.abs(vy) < config.minBounceSpeed) vy = 0;
    }
  }

  const done =
    Math.abs(y - groundY) <= 0.5 && Math.abs(vy) <= 8 && Math.abs(vx) <= 1;
  if (done) {
    y = groundY;
    vy = 0;
    vx = 0;
  }

  return { state: { x, y, vx, vy }, landed, done };
}

/** 把矩形夹进一组工作区（与 D-7 同口径：逐个求交，不用 getDisplayNearestPoint）。 */
export function clampRectToWorkAreas(rect: Rect, workAreas: readonly Rect[]): { x: number; y: number } {
  if (workAreas.length === 0) return { x: rect.x, y: rect.y };
  let best: Rect | null = null;
  let bestOverlap = -1;
  for (const area of workAreas) {
    const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
    const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
    const overlap = Math.max(0, width) * Math.max(0, height);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = area;
    }
  }
  if (!best) return { x: rect.x, y: rect.y };
  return {
    x: clamp(rect.x, best.x, Math.max(best.x, best.x + best.width - rect.width)),
    y: clamp(rect.y, best.y, Math.max(best.y, best.y + best.height - rect.height)),
  };
}

/** 窗口站在地面上时的 y（窗口底边贴工作区底边）。 */
export function groundYFor(workArea: Rect, windowHeight: number): number {
  return workArea.y + workArea.height - windowHeight;
}
