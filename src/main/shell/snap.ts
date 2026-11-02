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
import { approachDelta, planApproach, sampleApproach } from './approach';
import type { ApproachPlan } from './approach';
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
      /** ADR 0034：本次是接近开始（true）还是直接落座（false/缺省） */
      approaching?: boolean;
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
  emitApproach(payload: {
    edge: SnapEdge;
    source: 'foreground' | 'workarea';
    mode: 'walk' | 'leap';
    distancePx: number;
    durationMs: number;
  }): void;
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
  /** ADR 0034：是否在接近阶段 */
  approaching: boolean;
  /** 接近进度 0..1；不在接近为 null */
  approachProgress: number | null;
  approachMode: 'walk' | 'leap' | null;
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

  type ReleaseReason = 'dragged' | 'clicked' | 'command' | 'window-gone' | 'fullscreen';

  interface ApproachRuntime {
    plan: ApproachPlan;
    progress: number;
    lastTickAt: number | null;
    edge: SnapEdge;
    source: 'foreground' | 'workarea';
    target: { handle: string | null; title: string; className: string };
    anchor: Rect;
    /** ADR 0034 D4：非拖拽的解除延迟到到达之后再发 */
    deferredRelease: ReleaseReason | null;
  }

  let applied: Applied | null = null;
  let approach: ApproachRuntime | null = null;
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

  interface TargetPlan {
    edge: SnapEdge;
    source: 'foreground' | 'workarea';
    anchor: Rect;
    target: { handle: string | null; title: string; className: string };
    x: number;
    y: number;
    clamped: boolean;
    desired: { x: number; y: number };
  }

  type ResolvedTarget =
    | { ok: true; plan: TargetPlan }
    | { ok: false; outcome: SnapOutcome };

  function resolveTarget(
    edge: SnapEdge,
    source: 'foreground' | 'workarea',
    anchor: Rect,
    target: { handle: string | null; title: string; className: string },
  ): ResolvedTarget {
    const pet = deps.getPetBounds();
    const result = computeSnapTarget({
      edge,
      anchor,
      pet: { width: pet.width, height: pet.height },
      workAreas: deps.getWorkAreas(),
    });
    if (!result.ok) {
      return { ok: false, outcome: refuse(result.reason as SnapRefusalReason, result.detail) };
    }
    return {
      ok: true,
      plan: {
        edge,
        source,
        anchor,
        target,
        x: result.x,
        y: result.y,
        clamped: result.clamped,
        desired: result.desired,
      },
    };
  }

  /** 直接落座（瞬时距离 / 已在 sitting 时重吸附 / 拖到边缘松手）。 */
  function commit(plan: TargetPlan): SnapOutcome {
    const pet = deps.getPetBounds();
    const previous = applied;
    deps.setPetPosition(plan.x, plan.y);
    applied = {
      handle: plan.target.handle,
      title: plan.target.title,
      className: plan.target.className,
      edge: plan.edge,
      source: plan.source,
      rect: plan.anchor,
    };
    approach = null;
    lastFollowAt = null;
    lastOutcome = {
      ok: true,
      edge: plan.edge,
      source: plan.source,
      x: plan.x,
      y: plan.y,
      clamped: plan.clamped,
      approaching: false,
      target: { handle: plan.target.handle, title: plan.target.title, dip: plan.anchor },
    };

    if (plan.clamped) {
      deps.logWarn('吸附位置被 D-7 钳制（目标边缘贴不到，只保证可见）', {
        desired: plan.desired,
        actual: { x: plan.x, y: plan.y },
      });
    }
    deps.logInfo('吸附完成（ADR 0028）', {
      edge: plan.edge,
      source: plan.source,
      handle: plan.target.handle,
      title: plan.target.title,
      className: plan.target.className,
      from: { x: pet.x, y: pet.y },
      to: { x: plan.x, y: plan.y },
      anchor: plan.anchor,
      clamped: plan.clamped,
      repeated: previous !== null,
    });
    deps.emitApplied({ edge: plan.edge, source: plan.source });
    return lastOutcome;
  }

  /** ADR 0034 D1/D3：开始接近；距离在瞬时阈值内则直接 commit。 */
  function startPlan(plan: TargetPlan): SnapOutcome {
    // 已在 sitting 时再次吸附保持直接重定位（契约 X-12），不做"从窗沿再跳一次"
    if (applied) return commit(plan);

    const from = deps.getPetBounds();
    const approachPlan = planApproach(
      { x: from.x, y: from.y },
      { x: plan.x, y: plan.y },
    );
    if (!approachPlan) return commit(plan);

    approach = {
      plan: approachPlan,
      progress: 0,
      lastTickAt: null,
      edge: plan.edge,
      source: plan.source,
      target: plan.target,
      anchor: plan.anchor,
      deferredRelease: null,
    };
    lastOutcome = {
      ok: true,
      edge: plan.edge,
      source: plan.source,
      x: plan.x,
      y: plan.y,
      clamped: plan.clamped,
      approaching: true,
      target: { handle: plan.target.handle, title: plan.target.title, dip: plan.anchor },
    };
    deps.logInfo('吸附接近开始（ADR 0034）', {
      edge: plan.edge,
      source: plan.source,
      mode: approachPlan.mode,
      distancePx: Math.round(Math.hypot(plan.x - from.x, plan.y - from.y)),
      durationMs: Math.round(approachPlan.durationMs),
      from: { x: from.x, y: from.y },
      to: { x: plan.x, y: plan.y },
      handle: plan.target.handle,
      title: plan.target.title,
    });
    deps.emitApproach({
      edge: plan.edge,
      source: plan.source,
      mode: approachPlan.mode,
      distancePx: Math.round(Math.hypot(plan.x - from.x, plan.y - from.y)),
      durationMs: Math.round(approachPlan.durationMs),
    });
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

    const resolved = resolveTarget(config.edge, 'foreground', dip, {
      handle: info.handle,
      title: info.title,
      className: info.className,
    });
    return resolved.ok ? startPlan(resolved.plan) : resolved.outcome;
  }

  function workareaTarget(): SnapOutcome {
    const area = pickWorkArea(deps.getPetBounds(), deps.getWorkAreas());
    if (!area) return refuse('geometry', { reason: 'no-work-area' });
    const direct = resolveTarget(config.edge, 'workarea', area, {
      handle: null,
      title: '工作区',
      className: '',
    });
    if (direct.ok) {
      const outcome = startPlan(direct.plan);
      if (outcome.ok || config.edge === 'bottom' || outcome.reason !== 'geometry') return outcome;
    }
    // 上沿要 720px 的身体悬在屏幕之外：物理上放不下 → 退回下沿（她本来就站在那条线上）
    deps.logWarn('工作区上沿放不下坐姿，退回下沿贴边（ADR 0028 D7）', { area });
    const fallback = resolveTarget('bottom', 'workarea', area, {
      handle: null,
      title: '工作区下沿',
      className: '',
    });
    return fallback.ok ? startPlan(fallback.plan) : fallback.outcome;
  }

  /** 接近到达：精确落到目标并补发 snap_applied；若有延迟解除，紧接着释放。 */
  function commitApproach(): void {
    const runtime = approach;
    if (!runtime) return;
    const deferred = runtime.deferredRelease;
    commit({
      edge: runtime.edge,
      source: runtime.source,
      anchor: runtime.anchor,
      target: runtime.target,
      x: runtime.plan.to.x,
      y: runtime.plan.to.y,
      clamped: false,
      desired: runtime.plan.to,
    });
    deps.logInfo('吸附接近到达（ADR 0034）', {
      edge: runtime.edge,
      source: runtime.source,
      mode: runtime.plan.mode,
      durationMs: Math.round(runtime.plan.durationMs),
      x: runtime.plan.to.x,
      y: runtime.plan.to.y,
      deferredRelease: deferred,
    });
    if (deferred) releaseApplied(deferred);
  }

  /** 解除吸附的唯一出口（`release` 方法与跟随轮询共用）。 */
  function releaseApplied(reason: ReleaseReason): void {
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
      if (approach) return refuse('busy');
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
      if (approach) {
        // 拖拽是唯一能立即中断接近的解除；其余延迟到到达后再释放（ADR 0034 D4）
        if (reason === 'dragged') {
          const runtime = approach;
          approach = null;
          deps.logInfo('吸附接近被拖拽中断（ADR 0034 D4）', {
            edge: runtime.edge,
            source: runtime.source,
            progress: Number(runtime.progress.toFixed(3)),
          });
          deps.emitReleased({ reason });
          return;
        }
        if (!approach.deferredRelease) {
          approach.deferredRelease = reason;
          deps.logInfo('吸附接近中解除被延迟到到达（ADR 0034 D4）', { reason });
        }
        return;
      }
      releaseApplied(reason);
    },

    tick(now: number): void {
      if (!config.enabled) return;

      // ADR 0034 D3：接近倒计时挂在既有 16ms tick 上，不新建定时器
      if (approach) {
        if (approach.lastTickAt === null) {
          approach.lastTickAt = now;
          return;
        }
        const dt = now - approach.lastTickAt;
        approach.lastTickAt = now;
        const delta =
          dt > approach.plan.durationMs * 2
            ? 1
            : approachDelta(approach.plan, dt);
        approach.progress = Math.min(1, approach.progress + delta);
        if (approach.progress >= 1) {
          // 到达：由 commit 写精确目标，避免同一 tick 先写 sample 再写目标造成两次 setPosition
          commitApproach();
          return;
        }
        const sample = sampleApproach(approach.plan, approach.progress);
        deps.setPetPosition(Math.round(sample.x), Math.round(sample.y));
        return;
      }

      if (!applied) return;
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
      if (!config.enabled || applied || approach) return null;
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
      // 拖到边缘松手是"已经在边上"，直接落座，不走接近（ADR 0028 D7）
      const resolved = resolveTarget('bottom', 'workarea', area, {
        handle: null,
        title: '工作区下沿',
        className: '',
      });
      return resolved.ok ? commit(resolved.plan) : resolved.outcome;
    },

    get sitting(): boolean {
      // ADR 0034：sitting 是"吸附生命周期"，接近阶段也算
      return applied !== null || approach !== null;
    },

    diagnostics(): SnapDiagnostics {
      return {
        enabled: config.enabled,
        mode: config.mode === 'workarea' ? 'workarea' : 'foreground',
        configuredMode: config.mode,
        edge: config.edge,
        sitting: applied !== null || approach !== null,
        approaching: approach !== null,
        approachProgress: approach ? Number(approach.progress.toFixed(3)) : null,
        approachMode: approach ? approach.plan.mode : null,
        target: applied
          ? {
              handle: applied.handle ?? '',
              title: applied.title,
              className: applied.className,
              rect: applied.rect,
            }
          : approach
            ? {
                handle: approach.target.handle ?? '',
                title: approach.target.title,
                className: approach.target.className,
                rect: approach.anchor,
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
