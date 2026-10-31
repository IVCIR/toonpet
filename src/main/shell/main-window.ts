/**
 * 主窗口的创建与装载。窗口规格逐条对齐契约 §3.2。
 * 尺寸按模型取景包围盒校正（ADR 0009 D4），其余属性不变；运行期禁止改 focusable（§3.6 P-3、ADR 0003）。
 */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { Rect } from '../../shared/geometry';

export interface WindowSize {
  width: number;
  height: number;
}

/** §1.2：窗口默认贴合屏幕工作区底边、水平居中。 */
export function computeInitialBounds(size: WindowSize): Rect {
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + (workArea.width - size.width) / 2);
  const y = Math.round(workArea.y + Math.max(0, workArea.height - size.height));
  return { x, y, width: size.width, height: size.height };
}

export function createMainWindow(size: WindowSize): BrowserWindow {
  const bounds = computeInitialBounds(size);

  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    title: '3D 桌宠',
    frame: false, // §3.2
    transparent: true, // §3.2
    backgroundColor: '#00000000', // §3.2：必须显式透明
    hasShadow: false, // §3.2：透明窗口阴影会画出矩形边
    resizable: false, // §3.2
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true, // §3.2
    alwaysOnTop: true, // §3.2
    focusable: false, // §3.2 + ADR 0003：恒为 false，运行期禁止修改
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'main.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  window.setAlwaysOnTop(true, 'screen-saver'); // §3.2 层级
  window.setMenuBarVisibility(false);
  // 初始即穿透：宁可第一下点击落空，也不吞掉桌面点击（§12；ADR 0004 D4 同一取向）。
  window.setIgnoreMouseEvents(true);

  return window;
}

/** 渲染侧通过 query 收到与主进程一致的取景规则与模型标识（ADR 0009 D3.3）。 */
export function loadMainRenderer(
  window: BrowserWindow,
  query: Record<string, string> = {},
): Promise<void> {
  return window.loadFile(path.join(__dirname, '..', 'renderer', 'render', 'index.html'), {
    query,
  });
}
