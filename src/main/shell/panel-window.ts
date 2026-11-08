/**
 * 控制面板窗口（ADR 0052 D1）。
 *
 * 规格（需求给定，硬约束）：
 * - **独立 BrowserWindow**，800 × 600，**带原生边框**（`frame: true`：可拖动、可双击最大化、
 *   有系统关闭按钮——这恰好是"参数调校"需要的窗口语义）；
 * - **不进任务栏隐藏**（与桌宠相反）：用户要能在任务栏里找到它；
 * - **不是 alwaysOnTop**：它不该盖住桌宠或其它应用；
 * - 关闭**不退出应用**，也不销毁状态：`close` 被折成 `hide`（行为在 `panel.ts` 里，
 *   这里只负责"怎么建、装哪个页面"）；
 * - **不引入任何本地 Web Server**：与主窗口、输入条一样走 `loadFile`（`file://`）。
 *
 * 与主窗口的关系：它**不**修改主窗口任何属性（`focusable` 恒为 false，§3.2 / ADR 0003），
 * 也不给主窗口 `parent`（避免子窗口的模态语义影响桌宠的置顶层级）。
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';

export const PANEL_TITLE = '桌宠控制面板';

/** ADR 0052 D1：800 × 600（需求建议尺寸），最小 720 × 520 保证四个 Tab 不挤。 */
export const PANEL_WIDTH = 800;
export const PANEL_HEIGHT = 600;
export const PANEL_MIN_WIDTH = 720;
export const PANEL_MIN_HEIGHT = 520;

export function createPanelWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    minWidth: PANEL_MIN_WIDTH,
    minHeight: PANEL_MIN_HEIGHT,
    show: false,
    title: PANEL_TITLE,
    frame: true, // 需求：原生边框
    transparent: false,
    backgroundColor: '#0d1016',
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: false, // 与桌宠相反：面板要能在任务栏里被找回
    alwaysOnTop: false,
    hasShadow: true,
    autoHideMenuBar: true,
    webPreferences: {
      // 独立最小 preload：只暴露 invoke(cmd:panel) 与 onState(cmd:panel-state)
      preload: path.join(__dirname, '..', 'preload', 'panel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  window.setMenuBarVisibility(false);
  window.center();
  // 面板页面不允许开新窗口（零出站/零外链的最小防线，与输入条同一手法）
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return window;
}

export function loadPanelRenderer(window: BrowserWindow): Promise<void> {
  return window.loadFile(path.join(__dirname, '..', 'renderer', 'panel', 'index.html'));
}
