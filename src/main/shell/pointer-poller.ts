/**
 * 指针轮询器：全进程唯一的 16ms 定时器（契约 §3.4 D-5、§12、ADR 0002）。
 * 同时服务穿透状态机与拖拽位移/判定——**不允许再开第二个定时器**。
 *
 * 唯一调用 `setIgnoreMouseEvents` 的地方在 shell/index.ts 的 applyPassthrough（D-8）；
 * 唯一写窗口位置的地方是这里（D-5 / D-7），经由 deps.setWindowPosition。
 *
 * `cmd:drag` 只入队原始指针事实，位移/速度/阈值判定全部交给 DragGesture（ADR 0004 D2）。
 */
import type { BrowserWindow } from 'electron';
import {
  PASSTHROUGH_SWITCH_COOLDOWN_MS,
  POINTER_POLL_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  REBOUND_SETTLE_MS,
} from '../../shared/constants';
import type { EventName, EventPayloads } from '../../shared/events';
import type { Rect } from '../../shared/geometry';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { PointerFact as IpcPointerFact, ProbeResponse } from '../../shared/ipc';
import type { CursorSource } from './cursor-source';
import { DragGesture } from './drag-gesture';
import type { GestureStep, ProbeSnapshot } from './drag-gesture';
import { PassthroughFsm } from './passthrough-fsm';
import type { ProbeOutcome } from './passthrough-fsm';

/** 每个 tick 最多消费的原始指针事实数量：防止异常情况把队列无限拉长。 */
const MAX_PENDING_FACTS = 16;

export interface PointerPollerDeps {
  getWindow(): BrowserWindow | null;
  cursor: CursorSource;
  /** 唯一改穿透的地方（D-8） */
  applyPassthrough(passthrough: boolean): void;
  /** D-7 钳制用：所有显示器的工作区（ADR 0004 D6.2，禁止 getDisplayNearestPoint） */
  getWorkAreas(): Rect[];
  /** D-5：唯一写回窗口位置的地方 */
  setWindowPosition(x: number, y: number): void;
  /** §3.5 evt:broadcast 的唯一出口（在 shell/index.ts 里落到 webContents） */
  emit<K extends EventName>(name: K, payload: EventPayloads[K]): void;
  /**
   * ADR 0024 D1：每个 tick 先推进窗口位移（walking / settling）。
   * 位移与穿透共用这**同一个** 16ms 定时器——§12 不允许再开第二个。
   */
  onTick?(now: number): void;
  /** ADR 0024 D3：回弹进行中（R-8：回弹期间同样保持非穿透） */
  isSettling?(): boolean;
  logInfo(message: string, data?: unknown): void;
  logWarn(message: string, data?: unknown): void;
}

export interface PointerPoller {
  start(): void;
  stop(): void;
  /** 渲染侧上行（cmd:drag）：只入队，下一个 tick 处理 */
  notePointerFact(fact: IpcPointerFact): void;
  handleProbeResponse(response: ProbeResponse): void;
}

export function createPointerPoller(deps: PointerPollerDeps): PointerPoller {
  const fsm = new PassthroughFsm();
  const gesture = new DragGesture();

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let sentAt = 0;
  let pending: ProbeOutcome = null;
  let settling = false;
  let settleUntil = 0;
  let lastMaskAvailable: boolean | null = null;
  let probeCache: ProbeSnapshot | null = null;
  let timeoutWarned = false;
  const pendingFacts: IpcPointerFact[] = [];

  function tick(): void {
    const window = deps.getWindow();
    if (!window || window.isDestroyed()) return;

    const now = performance.now();

    // 0) 窗口位移（walking / settling）：必须在读窗口矩形之前跑，
    //    否则本 tick 的穿透判定会用到上一帧的位置（ADR 0024 D1）。
    deps.onTick?.(now);

    if (settling && now >= settleUntil) {
      settling = false;
      deps.logInfo('沉降窗口结束（ADR 0004 D3）', { settleMs: REBOUND_SETTLE_MS });
    }

    const cursor = deps.cursor.point();

    // 1) 上一 tick 之后到达的原始指针事实（cmd:drag）。按到达顺序处理，
    //    否则"按下-抬起"发生在同一 16ms 内的快速点击会丢掉按下。
    while (pendingFacts.length > 0) {
      const fact = pendingFacts.shift();
      if (fact) processPointerFact(window, fact, now);
    }

    // 2) D-5：拖拽位移与 4px 阈值判定（与穿透状态机共用这同一个定时器）
    if (gesture.pressed) {
      const bounds = window.getContentBounds();
      const step = gesture.tick({
        cursor,
        now,
        contentBounds: bounds,
        workAreas: deps.getWorkAreas(),
      });
      applyGestureStep(step, bounds, now);
    }

    // 3) 穿透状态机
    let outcome: ProbeOutcome = null;
    if (inFlight && now - sentAt > PROBE_TIMEOUT_MS) {
      // ADR 0004 D4：超时按未命中处理，绝不沿用上一次判定
      inFlight = false;
      if (!timeoutWarned) {
        timeoutWarned = true;
        deps.logWarn('探针超时，按未命中处理（ADR 0004 D4）', { timeoutMs: PROBE_TIMEOUT_MS });
      }
      outcome = { kind: 'timeout' };
    } else if (pending !== null) {
      outcome = pending;
      pending = null;
    }

    const out = fsm.step({
      cursor,
      windowRect: window.getContentBounds(),
      probe: outcome,
      probeInFlight: inFlight,
      dragging: gesture.dragging,
      settling: settling || (deps.isSettling?.() ?? false),
      // D-2：按下（未越过 4px 阈值）期间不得切穿透
      pressed: gesture.pressed,
      now,
    });

    if (out.probePoint) {
      window.webContents.send(IPC_CHANNELS.probe, out.probePoint);
      inFlight = true;
      sentAt = now;
    }

    if (out.changed) {
      deps.applyPassthrough(out.target === 'passthrough');
      deps.logInfo('穿透切换', {
        target: out.target,
        reason: out.reason,
        maskAvailable: lastMaskAvailable,
      });
    } else if (out.cooled) {
      deps.logInfo('穿透切换被冷却拦下（R-7）', {
        desired: out.target,
        reason: out.reason,
        cooldownMs: PASSTHROUGH_SWITCH_COOLDOWN_MS,
      });
    }
  }

  function processPointerFact(window: BrowserWindow, fact: IpcPointerFact, now: number): void {
    const bounds = window.getContentBounds();

    if (fact.phase === 'down') {
      const down = gesture.onPointerDown({
        fact,
        receivedAt: now,
        contentBounds: bounds,
        // D-2：必须先处于交互态（非穿透）才可能进入拖拽
        interactive: fsm.current === 'interactive',
        probe: probeCache,
      });

      if (!down.accepted) {
        deps.logInfo('按下被忽略（D-2 门槛未满足）', {
          reason: down.reason,
          x: Math.round(fact.x),
          y: Math.round(fact.y),
          target: fsm.current,
        });
        return;
      }

      // ADR 0004 D3.2：沉降窗口内收到新的按下 → 立即被新手势重置，不叠加不排队
      if (settling) {
        settling = false;
        settleUntil = 0;
        deps.logInfo('新手势重置沉降窗口（ADR 0004 D3.2）', {});
      }

      deps.logInfo('按下（cmd:drag down）', {
        x: Math.round(fact.x),
        y: Math.round(fact.y),
        headAccepted: down.headAccepted,
        headRejectedBecause: down.headRejectedBecause,
        maskAvailable: lastMaskAvailable === true,
        note: down.reason,
      });
      return;
    }

    const step = gesture.onPointerUp({
      fact,
      receivedAt: now,
      contentBounds: bounds,
      workAreas: deps.getWorkAreas(),
    });
    applyGestureStep(step, bounds, now);
  }

  function applyGestureStep(step: GestureStep, bounds: Rect, now: number): void {
    if (step.note) deps.logInfo(step.note.message, step.note.data);

    if (step.moveTo && (step.moveTo.x !== bounds.x || step.moveTo.y !== bounds.y)) {
      deps.setWindowPosition(step.moveTo.x, step.moveTo.y);
    }

    for (const effect of step.effects) {
      switch (effect.kind) {
        case 'drag-started':
          deps.emit('drag_started', { x: effect.x, y: effect.y });
          deps.logInfo('拖拽开始（D-2）', {
            x: Math.round(effect.x),
            y: Math.round(effect.y),
            maskAvailable: lastMaskAvailable === true,
          });
          break;

        case 'drag-released':
          deps.emit('drag_released', {
            x: effect.x,
            y: effect.y,
            vx: effect.vx,
            vy: effect.vy,
          });
          deps.logInfo('拖拽松手（D-6）', {
            x: Math.round(effect.x),
            y: Math.round(effect.y),
            vx: Math.round(effect.vx),
            vy: Math.round(effect.vy),
          });
          // ADR 0004 D3：松手后进入 500ms 沉降窗口，窗口计时复用同一个 16ms 轮询器
          settling = true;
          settleUntil = now + REBOUND_SETTLE_MS;
          deps.logInfo('进入沉降窗口（ADR 0004 D3）', { settleMs: REBOUND_SETTLE_MS });
          break;

        case 'head-patted':
          deps.emit('head_patted', { patCount: effect.patCount });
          deps.logInfo('head_patted 发出（D-3/D-4）', {
            patCount: effect.patCount,
            durationMs: Math.round(effect.durationMs),
            distancePx: Number(effect.distancePx.toFixed(2)),
            maskAvailable: lastMaskAvailable === true,
          });
          break;
      }
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(tick, POINTER_POLL_INTERVAL_MS);
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      inFlight = false;
      pending = null;
      pendingFacts.length = 0;
      probeCache = null;
      gesture.reset();
      settling = false;
      settleUntil = 0;
    },

    notePointerFact(fact: IpcPointerFact): void {
      if (!fact || (fact.phase !== 'down' && fact.phase !== 'up')) {
        deps.logWarn('cmd:drag 载荷非法（phase），已丢弃', fact);
        return;
      }
      if (
        !Number.isFinite(fact.x) ||
        !Number.isFinite(fact.y) ||
        !Number.isFinite(fact.t)
      ) {
        deps.logWarn('cmd:drag 载荷非法（坐标/时刻非有限数），已丢弃', fact);
        return;
      }
      if (pendingFacts.length >= MAX_PENDING_FACTS) {
        deps.logWarn('cmd:drag 队列已满，丢弃最旧的一条', { max: MAX_PENDING_FACTS });
        pendingFacts.shift();
      }
      pendingFacts.push(fact);
    },

    handleProbeResponse(response: ProbeResponse): void {
      inFlight = false;
      timeoutWarned = false;
      pending = { kind: 'hit', hit: response.hit };
      // 掩膜不是公共接口：这里只保留判定所需的最小事实（head 二值 + 坐标 + 时刻）
      probeCache = {
        x: response.x,
        y: response.y,
        hit: response.hit,
        head: response.head,
        at: performance.now(),
      };
      // head === null 表示掩膜不可用（cold/stale），主进程只记录这个二值事实
      lastMaskAvailable = response.head !== null;
    },
  };
}
