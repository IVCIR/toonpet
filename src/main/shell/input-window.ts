/**
 * 输入条独立窗口（ADR 0003 的落地，参数逐条对齐契约 §3.2 的"输入条"行）。
 *
 * 为什么必须是独立窗口：主窗口 `focusable` 恒为 false（§3.6 P-3），运行期改成 true 会
 * 闪烁、丢置顶、输入法异常；且独立窗口让输入法候选框与焦点行为回到正常应用语义。
 *
 * 本文件只负责"窗口本身"：创建、定位、装载。打开/关闭的**归属判定**（Esc、失焦、
 * 提交后收起）在 `shell/index.ts`，因为它们必须与 `cmd:respond` 的发送方校验共用同一处状态。
 */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { Rect } from '../../shared/geometry';
import { computeInputBarBounds } from './input-bar-geometry';
import type { InputBarBounds } from './input-bar-geometry';

export const INPUT_BAR_TITLE = 'ToonPet · 输入条';

/**
 * 契约 §3.2 / ADR 0003 §2：
 * 260 × 44、frame:false、**非透明**、alwaysOnTop、skipTaskbar、show:false 复用。
 * 不给 parent（ADR 0003 §5），不做命中穿透（§6：它是一个正常小窗）。
 */
export function createInputWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 260,
    height: 44,
    show: false,
    frame: false,
    transparent: false, // ADR 0003：非透明，避免透明合成与焦点冲突
    backgroundColor: '#12151c',
    resizable: false,
    movable: false, // 位置由主进程跟随主窗口（ADR 0003 §2）；禁止被拖离角色
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: INPUT_BAR_TITLE,
    webPreferences: {
      // 独立最小 preload：只暴露 submit(text) → cmd:respond，不复用角色页 preload
      preload: path.join(__dirname, '..', 'preload', 'input.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  window.setAlwaysOnTop(true, 'screen-saver');
  window.setMenuBarVisibility(false);
  // 输入条页面不允许开新窗口（零出站/零外链的最小防线）
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
}

/**
 * 定位：ADR 0004 D8.2 + ADR 0003 §2。
 * 用 `getContentBounds()`（不是 `getBounds()`）取主窗口内容区，工作区用
 * `getDisplayMatching()`（这里按窗口矩形判断显示器，不涉及 D-7 的缝隙场景，
 * 那条禁令针对的是拖拽钳制时的 `getDisplayNearestPoint()`）。
 */
export function positionInputBar(window: BrowserWindow, mainWindow: BrowserWindow): InputBarBounds {
  const content: Rect = mainWindow.getContentBounds();
  const workArea: Rect = screen.getDisplayMatching(content).workArea;
  const bounds = computeInputBarBounds(content, workArea);
  window.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  return bounds;
}

export function loadInputBarRenderer(window: BrowserWindow): Promise<void> {
  return window.loadFile(path.join(__dirname, '..', 'renderer', 'input', 'index.html'));
}
