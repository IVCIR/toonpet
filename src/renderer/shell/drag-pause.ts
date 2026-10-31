/**
 * R-8 的渲染侧状态：把掩膜采集的暂停挂到拖拽状态上。
 *
 * 契约 §3.3 R-8；ADR 0004 D3（500ms 沉降窗口是**估计值**，不是观测值）。
 *
 * 为什么渲染侧也要算一次 500ms：R-8 的恢复时刻是"回弹结束 + 沉降窗口"，
 * 但契约不允许为"精确回弹对齐"新增事件或通道（ADR 0004 D3.3）。渲染侧只知道
 * `drag_started` / `drag_released` 两个事实，因此以**收到 `drag_released` 的时刻**
 * 起算 `REBOUND_SETTLE_MS`，与主进程侧的沉降窗口同源（同一个共享常量）。
 *
 * 纯逻辑、不碰 DOM：结算由既有的 50ms 掩膜 tick 驱动，不新增定时器。
 */
import { REBOUND_SETTLE_MS } from '../../shared/constants';

export type DragPauseTransition = 'none' | 'paused' | 'resumed';

export interface DragPause {
  /** R-8：`drag_started` → 立即暂停采集 */
  onDragStarted(now: number): DragPauseTransition;
  /** R-8：`drag_released` → 从此刻起再等 REBOUND_SETTLE_MS 才恢复（窗口内不叠加） */
  onDragReleased(now: number): DragPauseTransition;
  /** 在既有 50ms 掩膜 tick 上结算；返回本 tick 的状态迁移 */
  settle(now: number): DragPauseTransition;
  /** 当前是否应暂停采集（`setPaused` 的唯一输入） */
  readonly paused: boolean;
  /** 上一次"暂停 → 恢复"整段的毫秒数（验收用：必须 ≥ REBOUND_SETTLE_MS） */
  readonly pausedMs: number | null;
}

export function createDragPause(options: { settleMs?: number } = {}): DragPause {
  const settleMs = options.settleMs ?? REBOUND_SETTLE_MS;

  let dragging = false;
  let pausedSince: number | null = null;
  let resumeAt: number | null = null;
  let lastPausedMs: number | null = null;

  return {
    onDragStarted(now: number): DragPauseTransition {
      dragging = true;
      resumeAt = null;
      if (pausedSince !== null) return 'none';
      pausedSince = now;
      return 'paused';
    },

    onDragReleased(now: number): DragPauseTransition {
      dragging = false;
      // 没暂停过就没什么可恢复的（例如事件顺序异常）
      if (pausedSince === null) return 'none';
      resumeAt = now + settleMs;
      return 'none';
    },

    settle(now: number): DragPauseTransition {
      if (pausedSince === null) return 'none';
      if (dragging) return 'none';
      if (resumeAt === null) return 'none';
      // 边界：恰好等于沉降窗口结束时刻即恢复
      if (now < resumeAt) return 'none';
      lastPausedMs = now - pausedSince;
      pausedSince = null;
      resumeAt = null;
      return 'resumed';
    },

    get paused(): boolean {
      return pausedSince !== null;
    },

    get pausedMs(): number | null {
      return lastPausedMs;
    },
  };
}
