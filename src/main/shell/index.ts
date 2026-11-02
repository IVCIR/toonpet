/**
 * shell 模块主进程侧。对外接口照抄契约 §7.2，不得增删方法。
 *
 * 职责：透明置顶窗口的生命周期（尺寸按模型包围盒校正，ADR 0009）、首帧就绪显示、
 * 单实例通知、缩放校验，以及全进程唯一的 16ms 指针轮询器（穿透状态机 + 拖拽位移）。
 *
 * 三个"唯一出口"集中在本文件：
 * - `applyPassthrough`：全进程唯一调用 `setIgnoreMouseEvents` 的地方（D-8）；
 * - `broadcastToRenderer`：`evt:broadcast` 的发出点（§3.5、§6.4 E-1）；
 * - 资产协议注册：`pet-asset:` 只读两路由（ADR 0009 D1）。
 */
import { app, globalShortcut, ipcMain, screen } from 'electron';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import path from 'node:path';
import {
  TRAY_STATS_REFRESH_MS,
  WINDOW_HEIGHT_PX,
  WINDOW_WIDTH_PX,
} from '../../shared/constants';
import { isEventName } from '../../shared/events';
import type { BroadcastEvent, EventName, EventPayloads, ModelReadyPayload } from '../../shared/events';
import { computeWindowSize } from '../../shared/model-frame';
import type { Rect } from '../../shared/geometry';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { PointerFact, ProbeResponse, WalkCommand } from '../../shared/ipc';
import { logError, logInfo, logWarn } from '../log';
import { appBus } from '../event-bus';
import { noteModelReady } from '../model-ready';
import { readProactiveStats } from '../proactive-stats';
import { registerAssetProtocol } from './asset-protocol';
import { resolveAssetConfig } from './asset-config';
import { readGlbBounds } from './glb-bounds';
import { createCursorSource } from './cursor-source';
import { createForegroundWindowReader } from './foreground-window';
import type { ForegroundWindowReader, PhysicalRect } from './foreground-window';
import { createMainWindow, loadMainRenderer } from './main-window';
import type { WindowSize } from './main-window';
import { createMotionController } from './motion';
import type { MotionController, MotionDiagnostics } from './motion';
import { createPointerPoller } from './pointer-poller';
import type { PointerPoller } from './pointer-poller';
import { createSnapController, resolveSnapConfig, SNAP_HOTKEY } from './snap';
import type { SnapController, SnapDiagnostics, SnapOutcome } from './snap';
import {
  INPUT_HOTKEY_DEFAULT,
  INPUT_HOTKEY_FALLBACK,
  registerInputHotkey,
} from './hotkey';
import type { HotkeyRegistration } from './hotkey';
import type { InputBarBounds } from './input-bar-geometry';
import { createInputWindow, loadInputBarRenderer, positionInputBar } from './input-window';
import { createShellTray } from './tray';
import type { ShellTray, TrayDiagnostics } from './tray';
import type { TrayStatsView } from './tray-menu';

export interface ShellStartOptions {
  hotkey?: string;
}

export interface ShellBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 输入条的只读诊断（内部，不跨进程暴露；供自检与日志使用）。 */
export interface InputBarDiagnostics {
  exists: boolean;
  visible: boolean;
  focused: boolean;
  bounds: ShellBounds | null;
}

export interface ShellModule {
  /** 契约 §7.2 */
  start(opts?: ShellStartOptions): Promise<void>;
  /** 契约 §7.2 */
  stop(): Promise<void>;
  /** 契约 §7.2 */
  getBounds(): ShellBounds;
  /**
   * 第二实例被拦截时的通知入口（ADR 0004 D9）。
   * 不是 §7.2 的对外契约，只由 main 的 single-instance 钩子调用。
   */
  notifySecondInstance(): void;
  /**
   * 内部（非契约 §7.2）：打开输入条并聚焦输入框。
   * 生产路径只有全局热键；自检需要一个不依赖真实按键的入口（ADR 0016 D4）。
   */
  openInputBar(): boolean;
  /** 内部（非契约）：收起输入条，不发任何事件（Esc / 失焦 / 提交后共用）。 */
  closeInputBar(reason: string): void;
  /** 内部诊断（非契约）：输入条窗口存在性/可见性/焦点/几何。 */
  inputBarDiagnostics(): InputBarDiagnostics;
  /** 内部诊断（非契约）：热键注册结果（默认/降级/失败）。 */
  hotkeySnapshot(): HotkeyRegistration | null;
  /** 内部诊断（非契约）：托盘存在性、菜单标签、图标尺寸（ADR 0018 D3）。 */
  traySnapshot(): TrayDiagnostics;
  /** 内部诊断（非契约）：窗口位移状态（walking / settling，ADR 0024）。 */
  motionSnapshot(): MotionDiagnostics | null;
  /** 内部（非契约）：输入条 BrowserWindow 句柄，只给自检截图/注入脚本用。 */
  getInputBarWindow(): BrowserWindow | null;
  /**
   * 内部（非契约）：触发一次"吸附到前台窗口"，与 Ctrl+Shift+S 同一个入口（ADR 0028 D4）。
   * 自检需要一条不依赖真实按键的路径（与 `openInputBar` 同理）。
   */
  snapToForeground(): SnapOutcome | null;
  /** 内部（非契约）：解除吸附（幂等），与托盘"离开窗口边缘"同一个入口。 */
  releaseSnap(): void;
  /** 内部诊断（非契约）：吸附状态、目标窗口、最近一次结果（ADR 0028）。 */
  snapSnapshot(): SnapDiagnostics | null;
  /**
   * 内部（非契约，标定用）：把窗口抬到地面上方 `heightPx` 后开始回弹。
   * 只用于落地冲击分级截图（ADR 0035 D4），不暴露给渲染侧。
   */
  debugDropFromHeight(heightPx: number): boolean;
}

let mainWindow: BrowserWindow | null = null;
let inputWindow: BrowserWindow | null = null;
let hotkeyRegistration: HotkeyRegistration | null = null;
let pointerPoller: PointerPoller | null = null;
let motionController: MotionController | null = null;
let shellTray: ShellTray | null = null;
let snapController: SnapController | null = null;
let snapReader: ForegroundWindowReader | null = null;
let snapHotkeyRegistration: HotkeyRegistration | null = null;
/** ADR 0032 D4：托盘诊断项的上次刷新时刻（`performance.now()` 时基，节流用） */
let lastTrayStatsRefreshAt = Number.NEGATIVE_INFINITY;
/** ADR 0032 D4：上一次同步给托盘的读数（用于"变了就立刻刷"） */
let lastTrayStats: TrayStatsView | null = null;
/** 拖拽进行中（shell 侧镜像；`sitting` 时点/拖都要先解除吸附，ADR 0028 D9） */
let dragging = false;
let onProbeResponse: ((event: unknown, response: ProbeResponse) => void) | null = null;
let onPointerFact: ((event: IpcMainEvent, fact: PointerFact) => void) | null = null;
let onRendererEvent: ((event: IpcMainEvent, envelope: BroadcastEvent) => void) | null = null;
let onRespond: ((event: IpcMainEvent, text: unknown) => void) | null = null;
let onWalkCommand: ((event: IpcMainEvent, command: WalkCommand) => void) | null = null;
let offDragStarted: (() => void) | null = null;
let offDragReleased: (() => void) | null = null;
/** 输入条提交的最大长度（超过只记日志并丢弃；真正的 120 字约束在编排/语音侧） */
const MAX_UTTERANCE_CHARS = 500;
let utteranceSeq = 0;

/** §3.5 `evt:broadcast`：主进程 → 渲染侧的唯一信封出口（shell 注入，其他模块经 appBus 使用）。 */
function installRendererSink(window: BrowserWindow): void {
  appBus.setRendererSink({
    event: (name, payload) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(IPC_CHANNELS.eventBroadcast, { name, payload });
    },
    command: (channel, payload) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
      window.webContents.send(channel, payload);
      return true;
    },
  });
}

/** ADR 0004 D6.2：D-7 钳制逐个显示器求交，禁止 `getDisplayNearestPoint()`。 */
function getAllWorkAreas(): Rect[] {
  return screen.getAllDisplays().map((display) => display.workArea);
}

/** ADR 0028 D3：全屏判定用**完整 bounds**（工作区差一个任务栏，最大化窗口不是全屏）。 */
function getAllDisplayBounds(): Rect[] {
  return screen.getAllDisplays().map((display) => display.bounds);
}

/**
 * ADR 0028 D2：物理像素 → DIP。逐点换算（`screenToDipPoint`）而不是除以
 * `scaleFactor`：混合 DPI 的多显示器下，同一个窗口的两个角可能落在不同的缩放比上。
 */
function toDipRect(physical: PhysicalRect): Rect {
  const topLeft = screen.screenToDipPoint({ x: physical.left, y: physical.top });
  const bottomRight = screen.screenToDipPoint({ x: physical.right, y: physical.bottom });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

/** ADR 0028 D3：前台是桌宠自己的窗口（主窗口/输入条）时拒绝吸附。 */
function ownWindowHandles(): string[] {
  const handles: string[] = [];
  for (const target of [mainWindow, inputWindow]) {
    if (!target || target.isDestroyed()) continue;
    try {
      const buffer = target.getNativeWindowHandle();
      if (buffer.length >= 8) handles.push(buffer.readBigUInt64LE(0).toString());
      else if (buffer.length >= 4) handles.push(String(buffer.readUInt32LE(0)));
    } catch (error) {
      // 拿不到句柄只是少了"别吸自己"这一层过滤，不影响其它判定
      logWarn('shell', '读取窗口句柄失败（吸附的自我过滤会退化）', { error: String(error) });
    }
  }
  return handles;
}

/** 用户可见提示：优先托盘气泡，没有托盘时只写日志（ADR 0028 D3）。 */
function notifyUser(message: string): void {
  if (shellTray) {
    shellTray.notify(message);
    return;
  }
  logWarn('shell', '吸附提示（无托盘，只写日志）', { message });
}

// ---------------------------------------------------------------------------
// 输入条（ADR 0003 落地；ADR 0016 决定"谁负责关闭"与"热键怎么降级"）
// ---------------------------------------------------------------------------

/**
 * 收起输入条。只做窗口动作：**不发事件、不聚焦主窗口**（ADR 0003 §4）。
 * 隐藏本身会触发一次 `blur`，因此这里先判可见性，避免 blur → hide → blur 的重复日志。
 */
function closeInputBar(reason: string): void {
  const window = inputWindow;
  if (!window || window.isDestroyed() || !window.isVisible()) return;
  window.hide();
  logInfo('shell', '输入条已收起（不发任何事件，也不碰主窗口焦点）', { reason });
}

/**
 * 创建输入条窗口并装上主进程侧的行为（Esc / 失焦 / 崩溃自愈）。
 * 只在 `start()` 和"渲染进程崩溃后重建"这两条路径调用。
 */
function createAndInstallInputBar(): BrowserWindow {
  const window = createInputWindow();
  inputWindow = window;
  installInputBarWindow(window);
  return window;
}

/**
 * 打开输入条并聚焦输入框（需求：热键唤起 + 聚焦；主窗口 `focusable` 保持 false）。
 * 顺序固定：先定位 → show → focus：先定位可避免窗口在旧位置闪一帧。
 */
function openInputBar(): boolean {
  const main = mainWindow;
  if (!main || main.isDestroyed()) {
    logWarn('shell', '主窗口不可用，忽略本次打开请求');
    return false;
  }

  let window = inputWindow;
  if (!window || window.isDestroyed()) {
    // 渲染进程崩溃后窗口已被销毁：这里重建，避免"热键从此失效"（ADR 0016 D3 的稳健性要求）
    window = createAndInstallInputBar();
    logWarn('shell', '输入条窗口已丢失，按需重建');
    void loadInputBarRenderer(window).catch((error: unknown) => {
      logWarn('shell', '输入条页面重建失败：本次打开会显示空白窗', { error: String(error) });
    });
  }

  const bounds: InputBarBounds = positionInputBar(window, main);
  window.show();
  window.focus();
  window.webContents.focus();
  logInfo('shell', '输入条已打开（主窗口 focusable 保持 false）', {
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    placement: bounds.placement,
    clampedX: bounds.clampedX,
    clampedY: bounds.clampedY,
    mainFocusable: main.isFocusable(),
    mainFocused: main.isFocused(),
  });
  return true;
}

/**
 * Esc 与失焦都在**主进程**处理（ADR 0016 D3）：
 * - 不新增 `cmd:input-cancel` 之类的通道（契约 §3.5 的通道表不得私自扩充）；
 * - `before-input-event` 在渲染页之前截到 Escape，渲染页崩溃也能收窗；
 * - `blur`（点桌面/切应用）即收起，不做未提交内容保留（ADR 0003 约束）。
 */
function installInputBarWindow(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.key ?? '') !== 'Escape' && (input.code ?? '') !== 'Escape') return;
    event.preventDefault();
    closeInputBar('escape');
  });

  window.on('blur', () => {
    closeInputBar('blur');
  });

  window.on('closed', () => {
    if (inputWindow === window) inputWindow = null;
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    logError('shell', '输入条渲染进程退出：销毁窗口，下次打开时重建（不新增看门狗）', details);
    if (!window.isDestroyed()) window.destroy();
  });
}

/** 全局热键：默认 Ctrl+Shift+B，被占用降级 Ctrl+Alt+B，仍失败只记 ERROR（ADR 0016 D4）。 */
function registerHotkey(): void {
  hotkeyRegistration = registerInputHotkey(
    {
      register: (accelerator) =>
        globalShortcut.register(accelerator, () => {
          // 再按一次收起：与 Spotlight 类交互一致；不新增"toggle"事件
          if (inputWindow?.isVisible()) closeInputBar('hotkey-toggle');
          else openInputBar();
        }),
      log: (level, message, data) => {
        if (level === 'error') logError('shell', message, data);
        else if (level === 'warn') logWarn('shell', message, data);
        else logInfo('shell', message, data);
      },
    },
    INPUT_HOTKEY_DEFAULT,
    INPUT_HOTKEY_FALLBACK,
  );

  logInfo('shell', '输入条热键状态', {
    accelerator: hotkeyRegistration.accelerator,
    fallbackUsed: hotkeyRegistration.fallbackUsed,
    defaultFailed: hotkeyRegistration.defaultFailed,
  });
}

function inputBarDiagnostics(): InputBarDiagnostics {
  const window = inputWindow;
  if (!window || window.isDestroyed()) {
    return { exists: false, visible: false, focused: false, bounds: null };
  }
  const bounds = window.getBounds();
  return {
    exists: true,
    visible: window.isVisible(),
    focused: window.isFocused(),
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
  };
}

// ---------------------------------------------------------------------------
// 托盘（ADR 0018 D3；契约 §3.1 / §7.2 把托盘归 shell）
// ---------------------------------------------------------------------------

/** 托盘"重新加载桌宠"：重启渲染进程，仅用于调试；不重建窗口、不改窗口属性。 */
function reloadRenderer(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    logWarn('shell', '托盘：主窗口不可用，忽略重新加载请求');
    return;
  }
  logInfo('shell', '托盘：重新加载渲染进程（调试用）', { windowId: window.id });
  window.webContents.reload();
}

/**
 * 托盘"退出"：ADR 0004 D9 要求**先 stop() 再退出**，由 stop() 统一释放
 * 轮询器、热键、托盘、输入条与主窗口；不得只调 `app.quit()`。
 */
async function quitFromTray(): Promise<void> {
  logInfo('shell', '托盘：退出应用（先 stop() 再 quit，ADR 0004 D9）');
  try {
    await shell.stop();
  } catch (error) {
    // stop 的清理是幂等的；即使某一步抛错也必须让应用退出，不能把托盘点成"假死"
    logWarn('shell', '托盘退出：stop() 抛错，仍继续 quit', { error: String(error) });
  } finally {
    app.quit();
  }
}

/**
 * ADR 0032 D4：把 `orchestrator` 写进 `proactive-stats` 单例的读数同步到托盘顶部两行。
 *
 * 挂在既有 16ms 指针轮询器的 `onTick` 上，**不新开定时器**（与 ADR 0028 D6 的吸附跟随同一手法）。
 * 节流语义是"**没有变化时**每 `TRAY_STATS_REFRESH_MS` 复查一次"：一旦读数真的变了
 * （例如启动后 orchestrator 写下第一条 `disabled`/`user-active`），下一拍（≤16ms）就刷新，
 * 不让用户对着一个"5 秒前的旧原因"看菜单。托盘不存在（创建失败）时直接返回。
 */
function refreshTrayStats(now: number): void {
  const tray = shellTray;
  if (!tray) return;
  const stats = readProactiveStats();
  const changed =
    lastTrayStats === null ||
    lastTrayStats.firedCount !== stats.firedCount ||
    lastTrayStats.lastReason !== stats.lastReason;
  if (!changed && now - lastTrayStatsRefreshAt < TRAY_STATS_REFRESH_MS) return;
  lastTrayStatsRefreshAt = now;
  lastTrayStats = { firedCount: stats.firedCount, lastReason: stats.lastReason };
  tray.setStats(lastTrayStats);
}

function createTray(): void {
  const stats = readProactiveStats();
  shellTray = createShellTray(
    {
      openInputBar: () => {
        openInputBar();
      },
      // ADR 0028 D4：托盘项与 Ctrl+Shift+S 共用同一个入口（不复制逻辑）
      snapForeground: () => {
        const outcome = snapController?.snapNow() ?? null;
        logInfo('shell', '托盘：吸附到前台窗口', {
          ok: outcome?.ok ?? false,
          reason: outcome && !outcome.ok ? outcome.reason : null,
        });
      },
      releaseSnap: () => {
        snapController?.release('command');
      },
      reloadPet: () => {
        reloadRenderer();
      },
      quit: () => {
        void quitFromTray();
      },
    },
    (level, message, data) => {
      if (level === 'error') logError('shell', message, data);
      else if (level === 'warn') logWarn('shell', message, data);
      else logInfo('shell', message, data);
    },
    // ADR 0032 D4：顶部两行用启动时的读数（多半是全零：orchestrator 还没跑过一拍）
    { firedCount: stats.firedCount, lastReason: stats.lastReason },
  );
  lastTrayStatsRefreshAt = Number.NEGATIVE_INFINITY;
  lastTrayStats = { firedCount: stats.firedCount, lastReason: stats.lastReason };
  logInfo('shell', '托盘诊断项初值', {
    firedCount: stats.firedCount,
    lastReason: stats.lastReason,
  });
}

/**
 * 吸附热键（ADR 0028 D4）：与输入条热键同一套三级降级。
 * 失败不阻断启动：托盘菜单项仍然可用。
 */
function registerSnapHotkey(): void {
  if (!snapController) return;
  snapHotkeyRegistration = registerInputHotkey(
    {
      register: (accelerator) =>
        globalShortcut.register(accelerator, () => {
          const outcome = snapController?.snapNow() ?? null;
          logInfo('shell', '热键：吸附到前台窗口', {
            accelerator,
            ok: outcome?.ok ?? false,
            reason: outcome && !outcome.ok ? outcome.reason : null,
          });
        }),
      log: (level, message, data) => {
        if (level === 'error') logError('shell', message, data);
        else if (level === 'warn') logWarn('shell', message, data);
        else logInfo('shell', message, data);
      },
    },
    SNAP_HOTKEY.preferred,
    SNAP_HOTKEY.fallback,
  );
  logInfo('shell', '吸附热键状态', {
    accelerator: snapHotkeyRegistration.accelerator,
    fallbackUsed: snapHotkeyRegistration.fallbackUsed,
    defaultFailed: snapHotkeyRegistration.defaultFailed,
  });
}


function roundBounds(bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
} {
  const round = (value: number): number => Number(value.toFixed(6));
  return {
    minX: round(bounds.minX),
    maxX: round(bounds.maxX),
    minY: round(bounds.minY),
    maxY: round(bounds.maxY),
    minZ: round(bounds.minZ),
    maxZ: round(bounds.maxZ),
  };
}

/**
 * ADR 0009 D2/D4：模型包围盒 → 窗口尺寸。解析在渲染进程加载之前完成，
 * 因此窗口不会出现"先 480×720 再跳尺寸"的闪烁。
 */
function resolveWindowSize(): {
  size: WindowSize;
  frameExclude: string;
  hideAttachments: string;
  modelId: string;
} {
  const appRoot = app.getAppPath();
  const config = resolveAssetConfig(appRoot);
  registerAssetProtocol(config);

  const fallback: WindowSize = { width: WINDOW_WIDTH_PX, height: WINDOW_HEIGHT_PX };
  const modelId = path.basename(config.modelPath);

  logInfo('shell', '资产配置', {
    appRoot,
    modelPath: config.modelPath,
    modelExists: config.modelExists,
    modelSource: config.modelSource,
    mouthPath: config.mouthPath,
    mouthExists: config.mouthExists,
    frameExclude: config.frameExclude,
    hideAttachments: config.hideAttachments,
    hideSource: config.hideSource,
  });

  // ADR 0014 D5：隐藏集合与取景排除默认同源；显式改成不同正则时窗口尺寸只按取景算。
  if (config.hideAttachments !== config.frameExclude) {
    logWarn('shell', 'HIDE_ATTACHMENTS 与 FRAME_EXCLUDE 不同：窗口尺寸仍只按取景排除计算', {
      frameExclude: config.frameExclude,
      hideAttachments: config.hideAttachments,
    });
  }

  if (!config.modelExists) {
    logWarn('shell', '模型文件不存在，窗口使用默认尺寸并回退占位胶囊体（ADR 0009 D6）', {
      modelPath: config.modelPath,
    });
    return {
      size: fallback,
      frameExclude: config.frameExclude,
      hideAttachments: config.hideAttachments,
      modelId,
    };
  }

  const startedAt = performance.now();
  const bounds = readGlbBounds(config.modelPath, { excludePattern: config.frameExclude });
  const parseMs = performance.now() - startedAt;

  if (!bounds.ok || !bounds.frameBounds) {
    logWarn('shell', '模型包围盒解析失败，窗口使用默认尺寸并回退占位胶囊体（ADR 0009 D2）', {
      modelPath: config.modelPath,
      error: bounds.error,
      parseMs: Number(parseMs.toFixed(1)),
    });
    return {
      size: fallback,
      frameExclude: config.frameExclude,
      hideAttachments: config.hideAttachments,
      modelId,
    };
  }

  const size = computeWindowSize(bounds.frameBounds, WINDOW_HEIGHT_PX);
  const usable = size.pixelsPerUnit > 0 ? size : { ...size, width: fallback.width, height: fallback.height };

  logInfo('shell', '模型包围盒', {
    scene: bounds.sceneBounds ? roundBounds(bounds.sceneBounds) : null,
    frame: roundBounds(bounds.frameBounds),
    frameSize: {
      width: Number((bounds.frameBounds.maxX - bounds.frameBounds.minX).toFixed(6)),
      height: Number((bounds.frameBounds.maxY - bounds.frameBounds.minY).toFixed(6)),
    },
    meshes: bounds.meshes.map((mesh) => mesh.name),
    excluded: bounds.excludedMeshes,
    hasMorphTargets: bounds.hasMorphTargets,
    extensionsRequired: bounds.extensionsRequired,
    nodeCount: bounds.nodeCount,
    parseMs: Number(parseMs.toFixed(1)),
  });

  logInfo('shell', '窗口尺寸已按包围盒校正（ADR 0009 D4）', {
    width: usable.width,
    height: usable.height,
    pixelsPerUnit: Math.round(size.pixelsPerUnit),
    clampedWidth: size.clampedWidth,
    padding: 1.15,
  });

  if (size.clampedWidth) {
    logWarn('shell', '模型宽高比超出窗口宽度护栏，已夹到 [240, 960]', {
      rawWidth: Math.round(size.width),
      width: size.width,
    });
  }

  return {
    size: { width: usable.width, height: usable.height },
    frameExclude: config.frameExclude,
    hideAttachments: config.hideAttachments,
    modelId,
  };
}

/**
 * 启动唯一的 16ms 轮询器。`applyPassthrough` 是全进程唯一调用
 * `setIgnoreMouseEvents` 的地方（契约 §7.2、§3.4 D-8）。
 */
function startPointerPoller(window: BrowserWindow): void {
  // ADR 0024：窗口位移控制器。物理是纯函数（shared/motion.ts），这里只接窗口与日志。
  const motion = createMotionController({
    getBounds: () => {
      const target = mainWindow;
      if (!target || target.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
      const bounds = target.getContentBounds();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    },
    setPosition: (x, y) => {
      const target = mainWindow;
      if (!target || target.isDestroyed()) return;
      target.setPosition(Math.round(x), Math.round(y), false);
    },
    getWorkAreas: getAllWorkAreas,
    emitMotionEnded: (kind, reason) => appBus.emit('motion_ended', { kind, reason }),
    logInfo: (message, data) => logInfo('shell', message, data),
    logWarn: (message, data) => logWarn('shell', message, data),
  });
  motionController = motion;

  // ADR 0028：前台窗口吸附。koffi 不可用 → 有效模式退回 workarea（物理贴边）。
  const snapConfig = resolveSnapConfig();
  const reader = createForegroundWindowReader();
  snapReader = reader;
  const effectiveMode: 'auto' | 'workarea' =
    snapConfig.mode === 'workarea' || !reader.supported ? 'workarea' : 'auto';
  if (!reader.supported) {
    logWarn('shell', '前台窗口 API 不可用，吸附退回工作区贴边（ADR 0028 D7）', {
      error: reader.error,
      mode: effectiveMode,
    });
  } else {
    logInfo('shell', '前台窗口 API 可用（koffi）', { readerSupported: true });
  }
  logInfo('shell', '吸附配置（ADR 0028）', {
    ...snapConfig,
    effectiveMode,
    supported: reader.supported,
  });

  const snap = createSnapController(
    {
      getPetBounds: () => {
        const target = mainWindow;
        if (!target || target.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
        const bounds = target.getContentBounds();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      },
      setPetPosition: (x, y) => {
        const target = mainWindow;
        if (!target || target.isDestroyed()) return;
        target.setPosition(Math.round(x), Math.round(y), false);
      },
      getWorkAreas: getAllWorkAreas,
      getDisplays: getAllDisplayBounds,
      getOwnHandles: ownWindowHandles,
      readForeground: () => reader.readForeground(),
      readHandle: (handle) => reader.readHandle(handle),
      toDip: toDipRect,
      isBusy: () => motion.kind !== 'idle' || dragging,
      emitApproach: (payload) => appBus.emit('snap_approach_started', payload),
      emitApplied: (payload) => appBus.emit('snap_applied', payload),
      emitReleased: (payload) => appBus.emit('snap_released', payload),
      notify: notifyUser,
      logInfo: (message, data) => logInfo('shell', message, data),
      logWarn: (message, data) => logWarn('shell', message, data),
    },
    { ...snapConfig, mode: effectiveMode },
  );
  snapController = snap;

  const poller = createPointerPoller({
    getWindow: () => mainWindow,
    cursor: createCursorSource(),
    applyPassthrough: (passthrough) => {
      const target = mainWindow;
      if (!target || target.isDestroyed()) return;
      target.setIgnoreMouseEvents(passthrough);
    },
    getWorkAreas: getAllWorkAreas,
    setWindowPosition: (x, y) => {
      const target = mainWindow;
      if (!target || target.isDestroyed()) return;
      // frame:false 且 hasShadow:false → 外层矩形与内容区矩形同源（D-7 只改位置，不改尺寸）
      target.setPosition(x, y, false);
    },
    emit: (name, payload) => appBus.emit(name, payload),
    // §12：位移与吸附跟随复用**同一个** 16ms 定时器（先推进位移，再算跟随）
    onTick: (now) => {
      motion.tick(now);
      snap.tick(now);
      // ADR 0032 D4：托盘只读诊断也挂在这同一个定时器上（内部节流，不新开定时器）
      refreshTrayStats(now);
    },
    isSettling: () => motion.settling,
    logInfo: (message, data) => logInfo('shell', message, data),
    logWarn: (message, data) => logWarn('shell', message, data),
  });

  // 拖拽立即接管位移：走路被拖 → 打断；回弹被拖 → 静默取消（render 由 drag_started 收状态）
  offDragStarted = appBus.subscribe('drag_started', () => {
    dragging = true;
    motion.cancel('interrupted');
    // ADR 0028 D9：拖走她就解除吸附（正常路径在指针按下时已经解除，这里是兜底）
    snap.release('dragged');
  });
  offDragReleased = appBus.subscribe('drag_released', (payload) => {
    dragging = false;
    // ADR 0028 D7：回退模式下拖到工作区下沿附近松手 → 直接坐在那条边上，不再走回弹
    if (snap.trySnapOnRelease()) return;
    motion.startSettle({ vx: payload.vx, vy: payload.vy });
  });

  onWalkCommand = (event, command) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (!command || typeof command !== 'object') return;
    if (command.phase === 'stop') {
      motion.cancel('interrupted');
      return;
    }
    if (command.phase !== 'start') return;
    if (command.direction !== 'left' && command.direction !== 'right') {
      logWarn('shell', 'cmd:walk 载荷非法（direction），已丢弃', command);
      return;
    }
    if (!Number.isFinite(command.distancePx) || command.distancePx <= 0) {
      logWarn('shell', 'cmd:walk 载荷非法（distancePx），已丢弃', command);
      return;
    }
    motion.startWalk(command.direction, Math.min(command.distancePx, 2000));
  };
  ipcMain.on(IPC_CHANNELS.walk, onWalkCommand);

  onProbeResponse = (_event, response) => {
    poller.handleProbeResponse(response);
  };
  ipcMain.on(IPC_CHANNELS.interactive, onProbeResponse);

  onPointerFact = (event, fact) => {
    // 只接受主窗口渲染页的原始指针事实；别的 sender 一律丢弃
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    // ADR 0028 D9：点她一下就离开窗口边缘。必须在把手势交给 poller 之前解除，
    // 否则 drag_started 会先把状态改成 dragged，多一次 "sitting → idle → dragged" 的闪回。
    if (fact && typeof fact === 'object' && fact.phase === 'down') snap.release('clicked');
    poller.notePointerFact(fact);
  };
  ipcMain.on(IPC_CHANNELS.drag, onPointerFact);

  // §6.3：`model_ready` 是本轮唯一从渲染侧上行的事件；只记日志并走幂等显示路径。
  onRendererEvent = (event, envelope) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (!envelope || typeof envelope !== 'object' || !isEventName(envelope.name)) return;
    if (envelope.name === 'model_ready') {
      const payload = envelope.payload as ModelReadyPayload;
      // ADR 0033 D2：这个事实对 runtime 的预热有意义，而 `model_ready` 可能早于 runtime 装配完成，
      // 所以由收到事件的 shell 落一个一次性闩锁（进程内单例，不是事件、不是 IPC、不是 setter）。
      noteModelReady();
      logInfo('shell', '收到 model_ready', payload);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.showInactive();
      return;
    }
    logInfo('shell', '收到渲染侧事件', { name: envelope.name });
  };
  ipcMain.on(IPC_CHANNELS.eventBroadcast, onRendererEvent);

  // §6.3：`user_utterance` 的唯一生产者是 shell。`cmd:respond` 只接受两个合法来源：
  // 输入条窗口（第 6 步起的唯一文本入口）与主窗口渲染页（既有出口，保持兼容）。
  // 收到后：先收起输入条（需求：回车 → 关闭输入条），再构造事件注入 event-bus（§6.3）。
  onRespond = (event, text) => {
    const fromInputBar = Boolean(
      inputWindow && !inputWindow.isDestroyed() && event.sender === inputWindow.webContents,
    );
    const fromMainWindow = Boolean(
      mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents,
    );
    if (!fromInputBar && !fromMainWindow) {
      logWarn('shell', 'cmd:respond 来自未知页面，已丢弃');
      return;
    }

    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (trimmed === '') return;
    if ([...trimmed].length > MAX_UTTERANCE_CHARS) {
      logWarn('shell', 'user_utterance 过长，已丢弃', { chars: [...trimmed].length });
      return;
    }

    if (fromInputBar) closeInputBar('submitted');

    utteranceSeq += 1;
    const utteranceId = `u-${Date.now().toString(36)}-${utteranceSeq}`;
    appBus.emit('user_utterance', { utteranceId, text: trimmed, input: 'hotkey' });
    logInfo('shell', 'user_utterance 发出（§6.3）', {
      utteranceId,
      chars: [...trimmed].length,
      input: 'hotkey',
      source: fromInputBar ? 'input-bar' : 'renderer',
    });
  };
  ipcMain.on(IPC_CHANNELS.respond, onRespond);

  poller.start();
  pointerPoller = poller;
  logInfo('shell', '指针轮询器已启动（16ms，单一定时器：穿透状态机 + 拖拽位移）', {
    windowId: window.id,
  });
}

function stopPointerPoller(): void {
  pointerPoller?.stop();
  pointerPoller = null;
  motionController = null;
  snapController = null;
  snapReader?.dispose();
  snapReader = null;
  dragging = false;
  offDragStarted?.();
  offDragStarted = null;
  offDragReleased?.();
  offDragReleased = null;
  if (onWalkCommand) {
    ipcMain.removeListener(IPC_CHANNELS.walk, onWalkCommand);
    onWalkCommand = null;
  }
  if (onProbeResponse) {
    ipcMain.removeListener(IPC_CHANNELS.interactive, onProbeResponse);
    onProbeResponse = null;
  }
  if (onPointerFact) {
    ipcMain.removeListener(IPC_CHANNELS.drag, onPointerFact);
    onPointerFact = null;
  }
  if (onRendererEvent) {
    ipcMain.removeListener(IPC_CHANNELS.eventBroadcast, onRendererEvent);
    onRendererEvent = null;
  }
  if (onRespond) {
    ipcMain.removeListener(IPC_CHANNELS.respond, onRespond);
    onRespond = null;
  }
}

/** ADR 0004 D1.2：CSS px 与 DIP 的换算只在缩放 1 倍时成立。 */
function enforceZoomFactorOne(window: BrowserWindow): void {
  const zoomFactor = window.webContents.getZoomFactor();
  if (zoomFactor === 1) return;
  logWarn('shell', `页面缩放因子为 ${zoomFactor}，按 ADR 0004 D1.2 重置为 1`);
  window.webContents.setZoomFactor(1);
}

/**
 * ADR 0004 D8.1：无 VRM 时 render 不发 model_ready（§11），
 * 因此用 webContents 的 did-finish-load（Electron 内部信号，不是事件总线事件）作为首帧就绪。
 * model_ready 到达时走同一条显示路径，二者幂等。
 */
function revealWhenRendererReady(window: BrowserWindow): void {
  // 渲染进程的 console 在终端不可见，转发到主进程日志，否则告警（如未知 intent 降级）会丢。
  window.webContents.on('console-message', (_event, level, message) => {
    // 渲染侧自带 "[render] " 前缀，避免日志里出现双重标记
    const text = message.startsWith('[render] ') ? message.slice('[render] '.length) : message;
    if (level >= 2) logWarn('render', text);
    else logInfo('render', text);
  });

  window.webContents.once('did-finish-load', () => {
    if (window.isDestroyed()) return;
    enforceZoomFactorOne(window);
    window.showInactive();
    logInfo(
      'shell',
      `主窗口已显示 bounds=${JSON.stringify(window.getBounds())} focusable=${String(window.isFocusable())}`,
    );
  });
}

export const shell: ShellModule = {
  async start(opts: ShellStartOptions = {}): Promise<void> {
    if (mainWindow) return;

    const { size, frameExclude, hideAttachments, modelId } = resolveWindowSize();

    const window = createMainWindow(size);
    mainWindow = window;
    installRendererSink(window);
    revealWhenRendererReady(window);
    startPointerPoller(window);
    await loadMainRenderer(window, {
      frameExclude,
      hideAttachments,
      modelId,
      // 自检模式：渲染侧忽略真实鼠标事件，避免用户/桌面输入污染脚本化场景
      ...(process.env['PET_SELFTEST'] === '1' ? { selftest: '1' } : {}),
    });

    // 输入条：创建一次、`show:false` 复用（ADR 0003 §2）；装载失败不阻断启动。
    const bar = createAndInstallInputBar();
    try {
      await loadInputBarRenderer(bar);
    } catch (error) {
      logWarn('shell', '输入条页面装载失败：热键仍注册，但打开会显示空白窗', {
        error: String(error),
      });
    }

    // 托盘：启动时创建（ADR 0018 D3）。创建失败只记 WARN，热键与桌宠本体继续可用。
    createTray();

    // 跟随主窗口移动（ADR 0003 §2）：只在输入条可见时重新定位，不新增定时器。
    window.on('move', () => {
      if (inputWindow?.isVisible() && mainWindow && !mainWindow.isDestroyed()) {
        positionInputBar(inputWindow, mainWindow);
      }
    });

    registerHotkey();

    // ADR 0028 D4：吸附热键与输入条热键各自独立降级，互不影响。
    if (snapController?.diagnostics().enabled) registerSnapHotkey();
    else logInfo('shell', '吸附已由 PET_SNAP_DISABLE 关闭：热键与托盘项都不生效');

    logInfo('shell', `start 完成 hotkey=${hotkeyRegistration?.accelerator ?? '(未注册)'}`, {
      contentSize: { width: size.width, height: size.height },
      hotkeyFallbackUsed: hotkeyRegistration?.fallbackUsed ?? null,
      snapHotkey: snapHotkeyRegistration?.accelerator ?? null,
      requestedHotkey: opts.hotkey ?? null,
    });
  },

  async stop(): Promise<void> {
    // 托盘先销毁：它持有原生句柄，必须在窗口与 app 退出前释放（ADR 0018 D3）。
    shellTray?.destroy();
    shellTray = null;
    lastTrayStats = null;
    lastTrayStatsRefreshAt = Number.NEGATIVE_INFINITY;
    stopPointerPoller();

    if (hotkeyRegistration?.accelerator) {
      try {
        globalShortcut.unregister(hotkeyRegistration.accelerator);
      } catch (error) {
        logWarn('shell', '热键注销失败（继续清理）', { error: String(error) });
      }
    }
    hotkeyRegistration = null;

    if (snapHotkeyRegistration?.accelerator) {
      try {
        globalShortcut.unregister(snapHotkeyRegistration.accelerator);
      } catch (error) {
        logWarn('shell', '吸附热键注销失败（继续清理）', { error: String(error) });
      }
    }
    snapHotkeyRegistration = null;

    const bar = inputWindow;
    inputWindow = null;
    if (bar && !bar.isDestroyed()) bar.destroy();

    appBus.setRendererSink(null);
    const window = mainWindow;
    mainWindow = null;
    // 幂等：selftest 与 before-quit 都会调用，无窗口时不重复打日志
    if (!window || window.isDestroyed()) return;
    window.destroy();
    logInfo('shell', 'stop 完成：主窗口已销毁');
  },

  getBounds(): ShellBounds {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
    const bounds = window.getBounds();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  },

  openInputBar(): boolean {
    return openInputBar();
  },

  closeInputBar(reason: string): void {
    closeInputBar(reason);
  },

  inputBarDiagnostics(): InputBarDiagnostics {
    return inputBarDiagnostics();
  },

  hotkeySnapshot(): HotkeyRegistration | null {
    return hotkeyRegistration;
  },

  traySnapshot(): TrayDiagnostics {
    return (
      shellTray?.diagnostics() ?? {
        exists: false,
        menuLabels: [],
        tooltip: null,
        iconSize: null,
        statLabels: [],
        stats: { firedCount: 0, lastReason: null },
      }
    );
  },

  motionSnapshot(): MotionDiagnostics | null {
    return motionController?.diagnostics() ?? null;
  },

  getInputBarWindow(): BrowserWindow | null {
    const window = inputWindow;
    return window && !window.isDestroyed() ? window : null;
  },

  snapToForeground(): SnapOutcome | null {
    const outcome = snapController?.snapNow() ?? null;
    logInfo('shell', '手动触发吸附（内部入口，与热键同一路径）', {
      ok: outcome?.ok ?? false,
      reason: outcome && !outcome.ok ? outcome.reason : null,
    });
    return outcome;
  },

  releaseSnap(): void {
    snapController?.release('command');
  },

  snapSnapshot(): SnapDiagnostics | null {
    return snapController?.diagnostics() ?? null;
  },

  debugDropFromHeight(heightPx: number): boolean {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return false;
    const bounds = window.getContentBounds();
    const areas = getAllWorkAreas();
    if (areas.length === 0) return false;
    let best = areas[0];
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
    const groundY = best.y + best.height - bounds.height;
    const dropHeight = Math.max(0, Math.min(2000, heightPx));
    window.setPosition(Math.round(bounds.x), Math.round(groundY - dropHeight), false);
    // 走与真实松手相同的事件链：render 进入 settling 才能记录向下峰值；
    // shell 的 drag_released 订阅者会启动 settle（不再直接调 motion，避免双重启动）。
    appBus.emit('drag_released', { x: 0, y: 0, vx: 0, vy: 0 });
    logInfo('shell', '标定：从指定高度回弹（ADR 0035 D4）', { heightPx: dropHeight, groundY });
    return true;
  },

  notifySecondInstance(): void {
    const window = mainWindow;
    logWarn(
      'shell',
      '第二实例已被单实例锁拦截；主窗口 focusable=false 无法聚焦，改用 showInactive（ADR 0004 D9）',
    );
    if (!window || window.isDestroyed()) return;
    window.showInactive();
    window.setAlwaysOnTop(true, 'screen-saver');
  },
};
