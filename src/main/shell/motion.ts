/**
 * 窗口位移控制器（ADR 0024）：`walking` 的水平位移与 `settling` 的回弹。
 *
 * 分工：
 * - **物理在这里**（主进程）——它是唯一能动 `BrowserWindow` 的进程，渲染侧不参与积分；
 * - **状态在 render**（§4.1 的 `walking` / `settling` 归 render 持有），
 *   所以每段位移结束都要发一次 `motion_ended` 事实（ADR 0024 D5）。
 *
 * 硬约束（用户红线 + 契约）：
 * - 不使用动画里的 root motion：位移完全由 `stepWalk` / `stepSettle` 决定；
 * - 不引入物理引擎：只有 `shared/motion.ts` 的三个纯函数；
 * - 不新开定时器：`tick(now)` 由唯一的 16ms 指针轮询器驱动（§12）。
 */
import {
  SETTLE_DAMPING,
  SETTLE_FRICTION,
  SETTLE_MAX_MS,
  SETTLE_MIN_BOUNCE_SPEED,
  SETTLE_RESTITUTION,
  SETTLE_STIFFNESS,
  WALK_ACCEL_PX_PER_SEC2,
  WALK_SPEED_PX_PER_SEC,
} from '../../shared/constants';
import type { Rect } from '../../shared/geometry';
import {
  clampRectToWorkAreas,
  groundYFor,
  stepSettle,
  stepWalk,
} from '../../shared/motion';
import type { SettleState, WalkState } from '../../shared/motion';

export type MotionKind = 'idle' | 'walking' | 'settling';
export type MotionEndReason = 'arrived' | 'edge' | 'interrupted' | 'rest';

export interface MotionDeps {
  /** 窗口内容区矩形（屏幕坐标） */
  getBounds(): Rect;
  /** 唯一写窗口位置的地方（与拖拽共用，D-5） */
  setPosition(x: number, y: number): void;
  getWorkAreas(): Rect[];
  emitMotionEnded(kind: 'walk' | 'settle', reason: MotionEndReason): void;
  logInfo(message: string, data?: unknown): void;
  logWarn(message: string, data?: unknown): void;
}

export interface MotionDiagnostics {
  kind: MotionKind;
  /** 行走目标（屏幕坐标）；非行走时为 null */
  walkTargetX: number | null;
  /** 回弹地面线；非回弹时为 null */
  groundY: number | null;
  /** 本段位移已持续时长（ms） */
  elapsedMs: number;
  /** 最近一次结束原因（诊断用） */
  lastEnd: { kind: 'walk' | 'settle'; reason: MotionEndReason } | null;
}

export interface MotionController {
  /** 请求一次行走；返回 false 表示两侧都没有空间（调用方应立即回 idle） */
  startWalk(direction: 'left' | 'right', distancePx: number): boolean;
  /** 松手后开始回弹：`velocity` 是 D-6 的末速度（px/s） */
  startSettle(velocity: { vx: number; vy: number }): void;
  /** 打断当前位移（拖拽接管 / 停机）；不发 motion_ended 的调用方自己负责收状态 */
  cancel(reason: MotionEndReason): void;
  /** 每个 16ms tick 调用一次；`now` 是 performance.now() */
  tick(now: number): void;
  readonly kind: MotionKind;
  /** 回弹进行中（供 R-8 把穿透保持在交互态） */
  readonly settling: boolean;
  diagnostics(): MotionDiagnostics;
}

interface WalkRuntime {
  state: WalkState;
  startedAt: number;
  /** 行走期间不变的窗口 y（行走只改 x） */
  y: number;
  /** 目标方向的边界（工作区左/右） */
  minX: number;
  maxX: number;
  /** 目标距离被工作区边界截短（结束原因是 edge 而不是 arrived） */
  edgeLimited: boolean;
}

interface SettleRuntime {
  state: SettleState;
  startedAt: number;
  groundY: number;
  minX: number;
  maxX: number;
}

const SETTLE_CONFIG = {
  stiffness: SETTLE_STIFFNESS,
  damping: SETTLE_DAMPING,
  restitution: SETTLE_RESTITUTION,
  minBounceSpeed: SETTLE_MIN_BOUNCE_SPEED,
  friction: SETTLE_FRICTION,
};

export function createMotionController(deps: MotionDeps): MotionController {
  let kind: MotionKind = 'idle';
  let walk: WalkRuntime | null = null;
  let settle: SettleRuntime | null = null;
  /** ADR 0039 排查：本次回弹里窗口自己反跳了几次（诊断用，不进状态） */
  let settleBounces = 0;
  let lastTickAt = 0;
  let lastEnd: MotionDiagnostics['lastEnd'] = null;

  function bestWorkArea(bounds: Rect): Rect | null {
    const areas = deps.getWorkAreas();
    if (areas.length === 0) return null;
    let best: Rect | null = null;
    let bestOverlap = -1;
    for (const area of areas) {
      const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
      const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
      const overlap = Math.max(0, width) * Math.max(0, height);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = area;
      }
    }
    return best;
  }

  function finishWalk(reason: MotionEndReason): void {
    walk = null;
    kind = 'idle';
    lastEnd = { kind: 'walk', reason };
    deps.logInfo('行走结束（ADR 0024 D1）', { reason });
    deps.emitMotionEnded('walk', reason);
  }

  function finishSettle(reason: MotionEndReason): void {
    settle = null;
    kind = 'idle';
    lastEnd = { kind: 'settle', reason };
    // bounces：窗口自己弹了几下（ADR 0024 D2 的恢复系数 0.28 允许一次轻弹）
    deps.logInfo('回弹结束（ADR 0024 D3）', { reason, bounces: settleBounces });
    deps.emitMotionEnded('settle', reason);
  }

  return {
    get kind(): MotionKind {
      return kind;
    },

    get settling(): boolean {
      return kind === 'settling';
    },

    startWalk(direction, distancePx): boolean {
      if (kind !== 'idle') {
        deps.logWarn('已有位移在进行，忽略本次行走请求', { kind, direction, distancePx });
        return false;
      }
      const bounds = deps.getBounds();
      const area = bestWorkArea(bounds);
      if (!area) {
        deps.logWarn('没有可用工作区，行走请求被丢弃');
        return false;
      }
      const minX = area.x;
      const maxX = Math.max(area.x, area.x + area.width - bounds.width);
      const distance = Math.max(1, Math.abs(distancePx));
      const dir = direction === 'left' ? -1 : 1;

      let targetX = Math.min(maxX, Math.max(minX, bounds.x + dir * distance));
      let flipped = false;
      if (Math.abs(targetX - bounds.x) < 1) {
        // 这一侧已经贴边：掉头（用户要求"撞边自动掉头或停下"）
        const reversed = Math.min(maxX, Math.max(minX, bounds.x - dir * distance));
        if (Math.abs(reversed - bounds.x) < 1) {
          deps.logInfo('两侧都没有行走空间，本次不行走', { bounds, area });
          lastEnd = { kind: 'walk', reason: 'edge' };
          deps.emitMotionEnded('walk', 'edge');
          return false;
        }
        deps.logInfo('行走方向已掉头（撞到工作区边缘）', { from: bounds.x, to: reversed });
        targetX = reversed;
        flipped = true;
      }
      const requested = bounds.x + dir * distance;
      const edgeLimited = flipped || Math.abs(targetX - requested) > 1;

      walk = {
        state: { x: bounds.x, vx: 0, targetX },
        startedAt: lastTickAt > 0 ? lastTickAt : performance.now(),
        y: bounds.y,
        minX,
        maxX,
        edgeLimited,
      };
      kind = 'walking';
      deps.logInfo('开始行走（ADR 0024 D1）', {
        direction: flipped ? (direction === 'left' ? 'right' : 'left') : direction,
        distancePx: Math.round(Math.abs(targetX - bounds.x)),
        from: bounds.x,
        to: Math.round(targetX),
        flipped,
        edgeLimited,
      });
      return true;
    },

    startSettle(velocity): void {
      const bounds = deps.getBounds();
      const area = bestWorkArea(bounds);
      const groundY = area ? groundYFor(area, bounds.height) : bounds.y;
      const clamped = area
        ? clampRectToWorkAreas(bounds, [area])
        : { x: bounds.x, y: bounds.y };
      settle = {
        state: {
          x: bounds.x,
          y: bounds.y,
          vx: Number.isFinite(velocity.vx) ? velocity.vx : 0,
          vy: Number.isFinite(velocity.vy) ? velocity.vy : 0,
        },
        startedAt: lastTickAt > 0 ? lastTickAt : performance.now(),
        groundY,
        minX: area ? area.x : clamped.x,
        maxX: area ? Math.max(area.x, area.x + area.width - bounds.width) : clamped.x,
      };
      kind = 'settling';
      settleBounces = 0;
      deps.logInfo('开始回弹（D-6 / ADR 0024 D3）', {
        from: { x: bounds.x, y: bounds.y },
        velocity: { vx: Math.round(settle.state.vx), vy: Math.round(settle.state.vy) },
        groundY,
      });
    },

    cancel(reason): void {
      if (kind === 'walking') {
        finishWalk(reason);
        return;
      }
      if (kind === 'settling') {
        // 被新拖拽接管：不发 motion_ended，`render` 会从 drag_started 自行离开 settling
        settle = null;
        kind = 'idle';
        lastEnd = { kind: 'settle', reason };
        deps.logInfo('回弹被接管（不发 motion_ended，由 drag_started 收状态）', { reason });
      }
    },

    tick(now): void {
      const previous = lastTickAt;
      lastTickAt = now;
      if (kind === 'idle') return;
      const dtSeconds = previous === 0 ? 0 : (now - previous) / 1000;
      if (dtSeconds <= 0) return;

      if (kind === 'walking' && walk) {
        const result = stepWalk(walk.state, { speed: WALK_SPEED_PX_PER_SEC, acceleration: WALK_ACCEL_PX_PER_SEC2 }, dtSeconds);
        walk.state = result.state;
        const x = Math.min(walk.maxX, Math.max(walk.minX, Math.round(result.state.x)));
        deps.setPosition(x, walk.y);
        if (result.done) {
          finishWalk(walk.edgeLimited ? 'edge' : 'arrived');
        }
        return;
      }

      if (kind === 'settling' && settle) {
        const previousVy = settle.state.vy;
        const result = stepSettle(settle.state, settle.groundY, SETTLE_CONFIG, dtSeconds);
        settle.state = result.state;
        // ADR 0039 排查打点（只读）：窗口自己有没有"弹一下"——落地后 vy 由下翻转向上就算一次。
        if (previousVy > 40 && result.state.vy < 0) {
          settleBounces += 1;
          deps.logInfo('回弹触地反跳（ADR 0024 D2 的恢复系数）', {
            bounce: settleBounces,
            vyBefore: Math.round(previousVy),
            vyAfter: Math.round(result.state.vy),
            y: Math.round(result.state.y),
            groundY: Math.round(settle.groundY),
          });
        }
        const x = Math.min(settle.maxX, Math.max(settle.minX, Math.round(result.state.x)));
        const y = Math.round(result.state.y);
        deps.setPosition(x, y);
        const elapsed = now - settle.startedAt;
        if (result.done) {
          finishSettle('rest');
          return;
        }
        if (elapsed > SETTLE_MAX_MS) {
          deps.logWarn('回弹超过兜底时长，强制静止（ADR 0024 D3）', { elapsedMs: Math.round(elapsed) });
          deps.setPosition(x, settle.groundY);
          finishSettle('rest');
        }
      }
    },

    diagnostics(): MotionDiagnostics {
      return {
        kind,
        walkTargetX: walk ? Math.round(walk.state.targetX) : null,
        groundY: settle ? Math.round(settle.groundY) : null,
        elapsedMs:
          kind === 'idle'
            ? 0
            : Math.round(lastTickAt - (walk?.startedAt ?? settle?.startedAt ?? lastTickAt)),
        lastEnd,
      };
    },
  };
}
