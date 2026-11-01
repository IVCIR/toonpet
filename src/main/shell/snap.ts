/**
 * 前台窗口吸附控制器（ADR 0028）。
 *
 * 一个状态机 + 一个节流的跟随轮询，**不碰 Electron 窗口对象**（依赖注入），
 * 因此可以在没有桌面的单测里跑完整路径：吸附、拒绝、跟随、四种解除。
 *
 * 分工（都是契约规定的唯一出口）：
 * - 窗口位置只有 `shell` 能写（§7.2）→ `setPetPosition` 由 shell 注入；
 * - `sitting` 的姿势归 `render` → 这里只发 `snap_applied` / `snap_released` 两条**事实**；
 * - 跟随轮询挂在既有 16ms 轮询器的 `onTick` 上（§12 不许开第二个定时器），内部节流。
 */
import {
  SNAP_EDGE_DRAG_THRESHOLD_PX,
  SNAP_FOLLOW_INTERVAL_MS,
  SNAP_HOTKEY_DEFAULT,
  SNAP_HOTKEY_FALLBACK,
  SNAP_MIN_TARGET_HEIGHT_PX,
  SNAP_MIN_TARGET_WIDTH_PX,
} from '../../shared/constants';
import type { Rect } from '../../shared/geometry';
import type { WindowInfo } from './foreground-window';
import {
  computeSnapTarget,
  findWorkAreaForBottomEdgeSnap,
  isFullscreenRect,
  isUsableTargetRect,
  pickWorkArea,
} from './snap-geometry';
import type { SnapEdge } from './snap-geometry';

export type { SnapEdge } from './snap-geometry';

/** 被拒绝的原因（日志与诊断用；`busy` / `disabled` 不打扰用户）。 */
export type SnapRefusalReason =
  | 'disabled'
  | 'busy'
  | 'no-foreground'
  | 'own-window'
  | 'shell-window'
  | 'hidden-window'
  | 'invalid-rect'
  | 'invalid-pet'
  | 'fullscreen'
  | 'geometry';

export type SnapOutcome =
  | {
      ok: true;
      edge: SnapEdge;
      source: 'foreground' | 'workarea';
      x: number;
      y: number;
      clamped: boolean;
      target: { handle: string | null; title: string; dip: Rect } | null;
    }
  | { ok: false; reason: SnapRefusalReason; hint: string | null; detail?: unknown };

export interface SnapConfig {
  /** `PET_SNAP_DISABLE=1` 时整条链路关闭（热键不注册、托盘项不生效） */
  enabled: boolean;
  edge: SnapEdge;
  /** `auto` = 有 koffi 就跟前台窗口，否则工作区贴边；`workarea` = 强制回退（自检/排查用） */
  mode: 'auto' | 'workarea';
  followIntervalMs: number;
}

/** 配置解析是纯函数，便于单测（与 `resolveAppConfig` 同一套 env 语义）。 */
export function resolveSnapConfig(env: NodeJS.ProcessEnv = process.env): SnapConfig {
  const rawEdge = (env['PET_SNAP_EDGE'] ?? '').trim().toLowerCase();
  const edge: SnapEdge = rawEdge === 'top' ? 'top' : 'bottom';
  const rawMode = (env['PET_SNAP_MODE'] ?? '').trim().toLowerCase();
  const mode: SnapConfig['mode'] = rawMode === 'workarea' ? 'workarea' : 'auto';
  const enabled = !['1', 'true', 'yes', 'on'].includes((env['PET_SNAP_DISABLE'] ?? '').trim().toLowerCase());
  const rawFollow = Number(env['PET_SNAP_FOLLOW_MS']);
  const followIntervalMs =
    Number.isFinite(rawFollow) && rawFollow >= 32
      ? Math.min(2000, Math.round(rawFollow))
      : SNAP_FOLLOW_INTERVAL_MS;
  return { enabled, edge, mode, followIntervalMs };
}

export interface SnapDeps {
  /** 桌宠窗口当前的内容区矩形（DIP） */
  getPetBounds(): Rect;
  /** 唯一写桌宠窗口位置的地方（DIP） */
  setPetPosition(x: number, y: number): void;
  /** 所有显示器的工作区（DIP；D-7 同口径） */
  getWorkAreas(): Rect[];
  /** 所有显示器的完整 bounds（DIP；全屏判定用） */
  getDisplays(): Rect[];
  /** 自己的窗口句柄（十进制字符串）：前台是它们自己时拒绝吸附 */
  getOwnHandles(): string[];
  /** 前台窗口（物理像素） */
  readForeground(): WindowInfo | null;
  /** 按句柄重读（跟随用） */
  readHandle(handle: string): WindowInfo | null;
  /** 物理像素 → DIP（实现里用 Electron 的 screen API） */
  toDip(physical: WindowInfo['physical']): Rect;
  /** 正在行走/回弹/拖拽（此时不抢窗口位置） */
  isBusy(): boolean;
  emitApplied(payload: { edge: SnapEdge; source: 'foreground' | 'workarea' }): void;
  emitReleased(payload: {
    reason: 'dragged' | 'clicked' | 'command' | 'window-gone' | 'fullscreen';
  }): void;
  /** 用户可见提示（托盘气泡）；没有托盘时 shell 传 null */
  notify(message: string): void;
  logInfo(message: string, data?: unknown): void;
  logWarn(message: string, data?: unknown): void;
}

export interface SnapDiagnostics {
  enabled: boolean;
  mode: 'foreground' | 'workarea';
  configuredMode: SnapConfig['mode'];
  edge: SnapEdge;
  sitting: boolean;
  target: { handle: string; title: string; className: string; rect: Rect } | null;
  lastOutcome: SnapOutcome | null;
  followChecks: number;
  lastFollowAt: number | null;
}

export interface SnapController {
  /** 触发一次吸附（热键 / 托盘）。已在吸附状态时允许改吸到当前前台窗口。 */
  snapNow(): SnapOutcome;
  /** 解除吸附（幂等）；`reason` 决定 render 的退出叙事 */
  release(reason: 'dragged' | 'clicked' | 'command' | 'window-gone' | 'fullscreen'): void;
  /** 每个 16ms tick 调一次：内部按 `followIntervalMs` 节流 */
  tick(now: number): void;
  /** 回退模式：拖到工作区下沿附近松手 → 坐在这条边上（ADR 0028 D7） */
  trySnapOnRelease(): SnapOutcome | null;
  readonly sitting: boolean;
  diagnostics(): SnapDiagnostics;
}

/** 桌面外壳窗口的类名：它们不是"应用窗口"，吸上去没有意义。 */
export const SHELL_WINDOW_CLASSES: readonly string[] = [
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'MultitaskingViewFrame',
  'ForegroundStaging',
];

const HINTS: Record<SnapRefusalReason, string | null> = {
  disabled: null,
  busy: null,
  'no-foreground': '找不到前台窗口：请先点一下要吸附的窗口再按热键',
  'own-window': '前台是桌宠自己的窗口：请先激活目标应用再按热键',
  'shell-window': '前台是桌面/任务栏：请先激活目标应用再按热键',
  'hidden-window': '前台窗口不可见或已最小化：请先把它显示出来',
  'invalid-rect': `前台窗口太小或坐标异常（至少 ${SNAP_MIN_TARGET_WIDTH_PX}×${SNAP_MIN_TARGET_HEIGHT_PX}）`,
  'invalid-pet': '桌宠窗口尺寸异常，无法计算吸附位置',
  fullscreen: '前台窗口是全屏（游戏/视频），吸附会挡住它：已取消',
  geometry: '吸附后的位置会完全落到屏幕外：已取消',
};

export function createSnapController(deps: SnapDeps, config: SnapConfig): SnapController {
  interface Applied {
    handle: string | null;
    title: string;
    className: string;
    edge: SnapEdge;
    source: 'foreground' | 'workarea';
    /** 目标的 DIP 矩形（跟随重算用） */
    rect: Rect;
  }

  let applied: Applied | null = null;
  let lastOutcome: SnapOutcome | null = null;
  let followChecks = 0;
  let lastFollowAt: number | null = null;

  function refuse(reason: SnapRefusalReason, detail?: unknown): SnapOutcome {
    const hint = HINTS[reason] ?? null;
    lastOutcome = { ok: false, reason, hint, detail };
    if (reason === 'busy' || reason === 'disabled') {
      deps.logInfo('吸附被跳过', { reason, detail });
    } else {
      deps.logWarn('吸附被拒绝', { reason, detail, hint });
      if (hint) deps.notify(hint);
    }
    return lastOutcome;
  }

  function apply(
    edge: SnapEdge,
    source: 'foreground' | 'workarea',
    anchor: Rect,
    target: { handle: string | null; title: string; className: string },
  ): SnapOutcome {
    const pet = deps.getPetBounds();
    const result = computeSnapTarget({
      edge,
      anchor,
      pet: { width: pet.width, height: pet.height },
      workAreas: deps.getWorkAreas(),
    });

    if (!result.ok) return refuse(result.reason as SnapRefusalReason, result.detail);

    const previous = applied;
    deps.setPetPosition(result.x, result.y);
    applied = {
      handle: target.handle,
      title: target.title,
      className: target.className,
      edge,
      source,
      rect: anchor,
    };
    lastFollowAt = null;
    lastOutcome = {
      ok: true,
      edge,
      source,
      x: result.x,
      y: result.y,
      clamped: result.clamped,
      target: { handle: target.handle, title: target.title, dip: anchor },
    };

    if (result.clamped) {
      deps.logWarn('吸附位置被 D-7 钳制（目标边缘贴不到，只保证可见）', {
        desired: result.desired,
        actual: { x: result.x, y: result.y },
      });
    }
    deps.logInfo('吸附完成（ADR 0028）', {
      edge,
      source,
      handle: target.handle,
      title: target.title,
      className: target.className,
      from: { x: pet.x, y: pet.y },
      to: { x: result.x, y: result.y },
      anchor,
      clamped: result.clamped,
      repeated: previous !== null,
    });
    deps.emitApplied({ edge, source });
    return lastOutcome;
  }

  function foregroundTarget(): SnapOutcome {
    const info = deps.readForeground();
    if (!info) return refuse('no-foreground');

    const own = new Set(deps.getOwnHandles());
    if (own.has(info.handle)) return refuse('own-window', { handle: info.handle });
    if (SHELL_WINDOW_CLASSES.includes(info.className)) {
      return refuse('shell-window', { handle: info.handle, className: info.className });
    }
    if (!info.visible || info.minimized) {
      return refuse('hidden-window', {
        handle: info.handle,
        visible: info.visible,
        minimized: info.minimized,
      });
    }

    const dip = deps.toDip(info.physical);
    if (!isUsableTargetRect(dip)) return refuse('invalid-rect', { physical: info.physical, dip });
    if (isFullscreenRect(dip, deps.getDisplays())) {
      return refuse('fullscreen', { dip, displays: deps.getDisplays() });
    }

    return apply(config.edge, 'foreground', dip, {
      handle: info.handle,
      title: info.title,
      className: info.className,
    });
  }

  function workareaTarget(): SnapOutcome {
    const area = pickWorkArea(deps.getPetBounds(), deps.getWorkAreas());
    if (!area) return refuse('geometry', { reason: 'no-work-area' });
    const direct = apply(config.edge, 'workarea', area, {
      handle: null,
      title: '工作区',
      className: '',
    });
    if (direct.ok || config.edge === 'bottom' || direct.reason !== 'geometry') return direct;
    // 上沿要 720px 的身体悬在屏幕之外：物理上放不下 → 退回下沿（她本来就站在那条线上）
    deps.logWarn('工作区上沿放不下坐姿，退回下沿贴边（ADR 0028 D7）', { area });
    return apply('bottom', 'workarea', area, {
      handle: null,
      title: '工作区下沿',
      className: '',
    });
  }

  /** 解除吸附的唯一出口（`release` 方法与跟随轮询共用）。 */
  function releaseApplied(
    reason: 'dragged' | 'clicked' | 'command' | 'window-gone' | 'fullscreen',
  ): void {
    if (!applied) return;
    const previous = applied;
    applied = null;
    lastFollowAt = null;
    deps.logInfo('吸附解除（ADR 0028 D9）', {
      reason,
      handle: previous.handle,
      title: previous.title,
      edge: previous.edge,
      source: previous.source,
    });
    deps.emitReleased({ reason });
  }

  return {
    snapNow(): SnapOutcome {
      if (!config.enabled) return refuse('disabled');
      if (deps.isBusy()) return refuse('busy');
      const useForeground = config.mode === 'auto';
      if (!useForeground) return workareaTarget();
      // `auto` 模式下若 Win32 不可用（koffi 加载失败），退回工作区贴边（ADR 0028 D7）
      const outcome = foregroundTarget();
      if (!outcome.ok && outcome.reason === 'no-foreground') {
        deps.logWarn('拿不到前台窗口：尝试工作区贴边回退');
        const fallback = workareaTarget();
        return fallback.ok ? fallback : outcome;
      }
      return outcome;
    },

    release(reason): void {
      releaseApplied(reason);
    },

    tick(now: number): void {
      if (!applied || !config.enabled) return;
      // 刚吸附完的第一个 tick 只校准节流起点，不做窗口查询
      if (lastFollowAt === null) {
        lastFollowAt = now;
        return;
      }
      if (now - lastFollowAt < config.followIntervalMs) return;
      lastFollowAt = now;
      followChecks += 1;

      // 工作区贴边没有"目标窗口"可跟随：屏幕变化由 display-metrics-changed 处理（未实现）
      if (applied.source === 'workarea' || applied.handle === null) return;

      const info = deps.readHandle(applied.handle);
      if (!info || !info.visible || info.minimized) {
        deps.logInfo('吸附目标已消失/最小化 → 解除吸附', {
          handle: applied.handle,
          found: info !== null,
          visible: info?.visible ?? null,
          minimized: info?.minimized ?? null,
        });
        releaseApplied('window-gone');
        return;
      }

      const dip = deps.toDip(info.physical);
      if (!isUsableTargetRect(dip)) {
        deps.logWarn('吸附目标尺寸异常 → 解除吸附', { dip });
        releaseApplied('window-gone');
        return;
      }
      if (isFullscreenRect(dip, deps.getDisplays())) {
        deps.logInfo('吸附目标变成全屏 → 解除吸附', { dip });
        releaseApplied('fullscreen');
        return;
      }

      const before = applied.rect;
      if (
        Math.abs(before.x - dip.x) < 1 &&
        Math.abs(before.y - dip.y) < 1 &&
        Math.abs(before.width - dip.width) < 1 &&
        Math.abs(before.height - dip.height) < 1
      ) {
        return;
      }

      const pet = deps.getPetBounds();
      const result = computeSnapTarget({
        edge: applied.edge,
        anchor: dip,
        pet: { width: pet.width, height: pet.height },
        workAreas: deps.getWorkAreas(),
      });
      if (!result.ok) {
        deps.logWarn('吸附目标移动后无法重算位置 → 解除吸附', { reason: result.reason });
        releaseApplied('window-gone');
        return;
      }
      applied.rect = dip;
      deps.setPetPosition(result.x, result.y);
      deps.logInfo('吸附跟随目标窗口（ADR 0028 D6）', {
        handle: applied.handle,
        from: { x: before.x, y: before.y, width: before.width, height: before.height },
        to: { x: dip.x, y: dip.y, width: dip.width, height: dip.height },
        window: { x: result.x, y: result.y },
        clamped: result.clamped,
      });
    },

    trySnapOnRelease(): SnapOutcome | null {
      if (!config.enabled || applied) return null;
      if (config.mode !== 'workarea') return null;
      if (deps.isBusy()) return null;
      const bounds = deps.getPetBounds();
      const area = findWorkAreaForBottomEdgeSnap(
        bounds,
        deps.getWorkAreas(),
        SNAP_EDGE_DRAG_THRESHOLD_PX,
      );
      if (!area) return null;
      deps.logInfo('拖到工作区下沿附近，按物理贴边法吸附（ADR 0028 D7）', {
        pet: bounds,
        area,
        thresholdPx: SNAP_EDGE_DRAG_THRESHOLD_PX,
      });
      return apply('bottom', 'workarea', area, { handle: null, title: '工作区下沿', className: '' });
    },

    get sitting(): boolean {
      return applied !== null;
    },

    diagnostics(): SnapDiagnostics {
      return {
        enabled: config.enabled,
        mode: config.mode === 'workarea' ? 'workarea' : 'foreground',
        configuredMode: config.mode,
        edge: config.edge,
        sitting: applied !== null,
        target: applied
          ? {
              handle: applied.handle ?? '',
              title: applied.title,
              className: applied.className,
              rect: applied.rect,
            }
          : null,
        lastOutcome,
        followChecks,
        lastFollowAt,
      };
    },
  };
}

/** 热键默认值（与输入条热键同一套降级，ADR 0028 D4） */
export const SNAP_HOTKEY = {
  preferred: SNAP_HOTKEY_DEFAULT,
  fallback: SNAP_HOTKEY_FALLBACK,
} as const;
