/**
 * 拖拽与摸头的**纯判定**：不碰 Electron、不碰 IPC、不碰定时器。
 *
 * 契约 §3.4 D-2～D-7、§6.3；ADR 0004 D1.5/D1.6/D2/D3/D6。
 *
 * 事实只有两个来源：
 * 1. `cmd:drag` 的原始指针事实（`{phase,x,y,t}`，不含位移/速度/判定结果）；
 * 2. 主进程 16ms 轮询器采到的光标位置（D-5）。
 *
 * 4px / 250ms / 800ms / 末速度 / D-7 钳制全部在这里完成，渲染侧不计算任何阈值。
 * 输入全部注入（时间、光标、窗口矩形、工作区），因此单测可以精确覆盖边界。
 */
import {
  DRAG_START_THRESHOLD_PX,
  DRAG_VELOCITY_WINDOW_MS,
  HEAD_PAT_COOLDOWN_MS,
  HEAD_PAT_MAX_DURATION_MS,
  HEAD_PROBE_MAX_AGE_MS,
  HEAD_PROBE_MAX_DISTANCE_PX,
} from '../../shared/constants';
import { clampRectToWorkAreas } from '../../shared/geometry';
import type { Rect } from '../../shared/geometry';

export interface ScreenPoint {
  x: number;
  y: number;
}

/** 主进程对最近一次 `cmd:interactive` 的内部缓存（掩膜不是公共接口，§7.3）。 */
export interface ProbeSnapshot {
  /** 内容区 CSS 坐标 */
  x: number;
  y: number;
  hit: boolean;
  /** false = 掩膜可用但不在头部区；null = 掩膜不可用（cold / stale） */
  head: boolean | null;
  /** 主进程收到回包的时刻（主进程 performance.now()） */
  at: number;
}

/** `cmd:drag` 的载荷（ADR 0004 D2）：只承载原始指针事实。 */
export interface PointerFact {
  x: number;
  y: number;
  /** 渲染进程的 performance.now() */
  t: number;
}

/** head 快照未被采信的原因（ADR 0004 D1.6 的四个保守丢弃分支）。 */
export type HeadRejection = 'none' | 'no-probe' | 'mask-unavailable' | 'stale' | 'far';

export interface DownResult {
  accepted: boolean;
  reason: 'ok' | 'not-interactive' | 'outside-content' | 'replaced-press';
  headAccepted: boolean;
  headRejectedBecause: HeadRejection;
}

export type DragEffect =
  | { kind: 'drag-started'; x: number; y: number }
  | { kind: 'drag-released'; x: number; y: number; vx: number; vy: number }
  | {
      kind: 'head-patted';
      patCount: number;
      /** 仅用于日志，不进事件载荷 */
      durationMs: number;
      /** 仅用于日志，不进事件载荷 */
      distancePx: number;
    };

export interface GestureStep {
  effects: DragEffect[];
  /** 需要写回的窗口内容区左上角；null = 本 tick 不移动 */
  moveTo: ScreenPoint | null;
  /** 仅用于日志的判定事实（冷却拦下 / head 快照丢弃），不进事件载荷 */
  note: { message: string; data: Record<string, unknown> } | null;
}

export interface DownInput {
  fact: PointerFact;
  /** 主进程收到该事实的时刻（主进程 performance.now()） */
  receivedAt: number;
  /** 按下时的窗口内容区屏幕矩形 */
  contentBounds: Rect;
  /** 按下瞬间穿透状态机是否处于交互态（D-2 的门槛） */
  interactive: boolean;
  /** 最近一次 cmd:interactive 的缓存 */
  probe: ProbeSnapshot | null;
}

export interface UpInput {
  fact: PointerFact;
  receivedAt: number;
  contentBounds: Rect;
  workAreas: readonly Rect[];
}

export interface TickInput {
  cursor: ScreenPoint;
  now: number;
  contentBounds: Rect;
  workAreas: readonly Rect[];
}

interface PressState {
  /** 按下点在内容区的 CSS 坐标 */
  downLocal: ScreenPoint;
  /** 渲染侧时基的按下时刻（ADR 0004 D2） */
  downT: number;
  /** 主进程时基的收到时刻（800ms 冷却用） */
  downAt: number;
  /** 按下点的屏幕坐标（内容区左上角 + 内容区局部坐标） */
  originScreen: ScreenPoint;
  /** 按下时的窗口内容区左上角 */
  originWindow: ScreenPoint;
  headAccepted: boolean;
  headRejectedBecause: HeadRejection;
  dragging: boolean;
  /** 拖拽期间的光标采样（屏幕坐标），用于末速度 */
  samples: Array<{ t: number; x: number; y: number }>;
}

const EMPTY_STEP: GestureStep = { effects: [], moveTo: null, note: null };

function distanceBetween(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointInsideContent(point: ScreenPoint, bounds: Rect): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  // 与 shared/mask.ts 的 isInsideContent 同一语义（左闭右开）
  return (
    point.x >= 0 && point.y >= 0 && point.x < bounds.width && point.y < bounds.height
  );
}

export class DragGesture {
  private press: PressState | null = null;
  private lastHeadPatAt = Number.NEGATIVE_INFINITY;
  private patCount = 0;

  get pressed(): boolean {
    return this.press !== null;
  }

  get dragging(): boolean {
    return this.press?.dragging === true;
  }

  /** 进程内自增的摸头序号（G2 口径：只在实际发出事件时 +1）。 */
  get headPatCount(): number {
    return this.patCount;
  }

  /**
   * `cmd:drag{phase:'down'}`：只决定"这次按下是否被接受"与"head 快照是否采信"。
   * 位移阈值不在这里判定（要等 16ms 轮询器的光标采样）。
   */
  onPointerDown(input: DownInput): DownResult {
    const replaced = this.press !== null;
    // 任何一次新的按下都作废上一次按下：抬起的 up 可能已在别处丢失，不能让陈旧手势挂住。
    this.press = null;

    if (!input.interactive) {
      // D-2：必须先处于交互态（非穿透）才可能进入拖拽
      return {
        accepted: false,
        reason: 'not-interactive',
        headAccepted: false,
        headRejectedBecause: 'none',
      };
    }

    if (!pointInsideContent(input.fact, input.contentBounds)) {
      return {
        accepted: false,
        reason: 'outside-content',
        headAccepted: false,
        headRejectedBecause: 'none',
      };
    }

    const head = evaluateHeadSnapshot(input.probe, input.receivedAt, input.fact);

    this.press = {
      downLocal: { x: input.fact.x, y: input.fact.y },
      downT: input.fact.t,
      downAt: input.receivedAt,
      originScreen: {
        x: input.contentBounds.x + input.fact.x,
        y: input.contentBounds.y + input.fact.y,
      },
      originWindow: { x: input.contentBounds.x, y: input.contentBounds.y },
      headAccepted: head.accepted,
      headRejectedBecause: head.reason,
      dragging: false,
      samples: [],
    };

    return {
      accepted: true,
      reason: replaced ? 'replaced-press' : 'ok',
      headAccepted: head.accepted,
      headRejectedBecause: head.reason,
    };
  }

  /**
   * 每个 16ms tick 调用一次（D-5）：判定是否越过 4px 阈值、并把拖拽位移写回窗口。
   * 没有按下时是空操作。
   */
  tick(input: TickInput): GestureStep {
    const press = this.press;
    if (!press) return EMPTY_STEP;

    const distance = distanceBetween(input.cursor, press.originScreen);

    if (!press.dragging) {
      if (distance <= DRAG_START_THRESHOLD_PX) return EMPTY_STEP;

      // D-2：位移 > 4px → 进入拖拽，此后本次按下不再判摸头
      press.dragging = true;
      const local = {
        x: input.cursor.x - input.contentBounds.x,
        y: input.cursor.y - input.contentBounds.y,
      };
      const moveTo = moveWindowTo(press, input.cursor, input.contentBounds, input.workAreas);
      recordSample(press, input.now, input.cursor);
      return {
        effects: [{ kind: 'drag-started', x: local.x, y: local.y }],
        moveTo,
        note: null,
      };
    }

    const moveTo = moveWindowTo(press, input.cursor, input.contentBounds, input.workAreas);
    recordSample(press, input.now, input.cursor);
    return { effects: [], moveTo, note: null };
  }

  /**
   * `cmd:drag{phase:'up'}`：决定本次按下的收尾是 `drag_released` 还是 `head_patted`。
   * 若抬手时才发现位移已过阈值（一个 tick 都没跑到），仍然按 D-2 判为拖拽。
   */
  onPointerUp(input: UpInput): GestureStep {
    const press = this.press;
    if (!press) return EMPTY_STEP;

    // 无论走哪个分支，这次按下都到此结束（D-2："此后不再判摸头"）
    this.press = null;

    const local = { x: input.fact.x, y: input.fact.y };
    const screen = {
      x: input.contentBounds.x + local.x,
      y: input.contentBounds.y + local.y,
    };
    const distance = distanceBetween(screen, press.originScreen);

    if (!press.dragging && distance > DRAG_START_THRESHOLD_PX) {
      press.dragging = true;
      const moveTo = moveWindowTo(press, screen, input.contentBounds, input.workAreas);
      const velocity = computeVelocity(press, { t: input.receivedAt, x: screen.x, y: screen.y });
      return {
        effects: [
          { kind: 'drag-started', x: local.x, y: local.y },
          { kind: 'drag-released', x: local.x, y: local.y, ...velocity },
        ],
        moveTo,
        note: null,
      };
    }

    if (press.dragging) {
      const moveTo = moveWindowTo(press, screen, input.contentBounds, input.workAreas);
      const velocity = computeVelocity(press, { t: input.receivedAt, x: screen.x, y: screen.y });
      return {
        effects: [{ kind: 'drag-released', x: local.x, y: local.y, ...velocity }],
        moveTo,
        note: null,
      };
    }

    return this.finishShortPress(press, distance, input);
  }

  /** 释放按下状态（窗口销毁 / 轮询器停止时调用），不影响冷却与计数。 */
  reset(): void {
    this.press = null;
  }

  private finishShortPress(press: PressState, distancePx: number, input: UpInput): GestureStep {
    const durationMs = durationBetween(press, input);

    if (distancePx > DRAG_START_THRESHOLD_PX || durationMs > HEAD_PAT_MAX_DURATION_MS) {
      return EMPTY_STEP;
    }

    if (!press.headAccepted) {
      // head === false（快照可信、只是这个点不在头部带）是正常点击，不记日志、不发事件；
      // 只有"快照本身不可采信"（ADR 0004 D1.6 的四个保守丢弃分支）才留诊断事实。
      if (press.headRejectedBecause === 'none') return EMPTY_STEP;
      return {
        effects: [],
        moveTo: null,
        note: {
          message: 'head_patted 未触发：head 快照未采信（ADR 0004 D1.6）',
          data: {
            because: press.headRejectedBecause,
            durationMs: Math.round(durationMs),
            distancePx: Number(distancePx.toFixed(2)),
          },
        },
      };
    }

    // D-4：冷却 800ms，冷却期内不重复发事件，也不重置冷却
    const sinceLastMs = input.receivedAt - this.lastHeadPatAt;
    if (sinceLastMs < HEAD_PAT_COOLDOWN_MS) {
      return {
        effects: [],
        moveTo: null,
        note: {
          message: 'head_patted 被冷却拦下（D-4）',
          data: {
            sinceLastMs: Math.round(sinceLastMs),
            cooldownMs: HEAD_PAT_COOLDOWN_MS,
          },
        },
      };
    }

    this.lastHeadPatAt = input.receivedAt;
    this.patCount += 1;

    return {
      effects: [
        {
          kind: 'head-patted',
          patCount: this.patCount,
          durationMs,
          distancePx,
        },
      ],
      moveTo: null,
      note: null,
    };
  }
}

/** ADR 0004 D1.6：按下时快照最近一次 cmd:interactive，仅当 ≤8 CSS px 且 ≤100ms 时才采信 head。 */
function evaluateHeadSnapshot(
  probe: ProbeSnapshot | null,
  receivedAt: number,
  fact: PointerFact,
): { accepted: boolean; reason: HeadRejection } {
  if (!probe) return { accepted: false, reason: 'no-probe' };
  if (probe.head === null) return { accepted: false, reason: 'mask-unavailable' };
  if (receivedAt - probe.at > HEAD_PROBE_MAX_AGE_MS) return { accepted: false, reason: 'stale' };
  if (distanceBetween(probe, fact) > HEAD_PROBE_MAX_DISTANCE_PX) {
    return { accepted: false, reason: 'far' };
  }
  return { accepted: probe.head === true, reason: 'none' };
}

function durationBetween(press: PressState, input: UpInput): number {
  // ADR 0004 D2：`t` 来自渲染进程 performance.now()，down/up 同一时基，
  // 因此 250ms 用渲染侧差值（不含 IPC 抖动）。异常值退回主进程收包时刻差。
  const rendererDuration = input.fact.t - press.downT;
  if (Number.isFinite(rendererDuration) && rendererDuration >= 0) return rendererDuration;
  return input.receivedAt - press.downAt;
}

/**
 * D-5 + D-7：窗口目标位置 = 按下时窗口原点 + 光标位移，然后用
 * `clampRectToWorkAreas`（ADR 0004 D6.2，已有单测）钳制，只改位置不改尺寸。
 */
function moveWindowTo(
  press: PressState,
  cursor: ScreenPoint,
  contentBounds: Rect,
  workAreas: readonly Rect[],
): ScreenPoint {
  const desired: Rect = {
    x: press.originWindow.x + (cursor.x - press.originScreen.x),
    y: press.originWindow.y + (cursor.y - press.originScreen.y),
    width: contentBounds.width,
    height: contentBounds.height,
  };
  const clamped = clampRectToWorkAreas(desired, workAreas);
  return { x: Math.round(clamped.x), y: Math.round(clamped.y) };
}

function recordSample(press: PressState, now: number, cursor: ScreenPoint): void {
  press.samples.push({ t: now, x: cursor.x, y: cursor.y });
  // 采样只需覆盖末速度窗口；多留一倍余量，避免长时间拖拽无限增长
  const cutoff = now - DRAG_VELOCITY_WINDOW_MS * 2;
  while (press.samples.length > 2 && (press.samples[0]?.t ?? 0) < cutoff) {
    press.samples.shift();
  }
}

/** D-6 的末速度：抬手前 ≤100ms 内最早与最晚两个采样的平均速度（px/s）。 */
function computeVelocity(press: PressState, release: { t: number; x: number; y: number }): {
  vx: number;
  vy: number;
} {
  const windowStart = release.t - DRAG_VELOCITY_WINDOW_MS;
  const samples = press.samples.filter((sample) => sample.t >= windowStart);
  samples.push(release);

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return { vx: 0, vy: 0 };

  const dt = last.t - first.t;
  if (!(dt > 0)) return { vx: 0, vy: 0 };

  return {
    vx: ((last.x - first.x) / dt) * 1000,
    vy: ((last.y - first.y) / dt) * 1000,
  };
}
