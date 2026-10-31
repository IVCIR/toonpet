/**
 * 系统托盘（ADR 0018 D3）。
 *
 * 硬约束：
 * - 托盘归 `shell`（契约 §3.1 / §7.2），只调 `shell` 内部入口，不碰其他模块；
 * - 不改变主窗口任何属性：`focusable` 恒为 `false`（§3.2，ADR 0003）；
 * - 托盘创建/销毁失败都不能拖垮桌宠：失败只记 WARN 并继续无托盘运行；
 * - 16×16 占位图标内嵌为 PNG data URL，不新增二进制资产、不联网。
 */
import { Menu, Tray, nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import { buildTrayMenuItems } from './tray-menu';
import type { TrayActions, TrayMenuItem } from './tray-menu';

export interface TrayDiagnostics {
  exists: boolean;
  menuLabels: string[];
  tooltip: string | null;
  iconSize: { width: number; height: number } | null;
}

export interface ShellTray {
  destroy(): void;
  diagnostics(): TrayDiagnostics;
}

export type TrayLog = (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

export const TRAY_TOOLTIP = '凯伊 · 3D 桌宠';

/**
 * 16×16 占位图标（浅蓝猫脸，4× 超采样后缩放）。
 * 由 `scripts` 之外的临时生成器绘制；这里只保留结果，避免运行时依赖图片文件/网络。
 */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA1ElEQVR42mNgoDbov/xfoP/y/wIs4gb9l/8HEGNAQf/l//9BGtAMvd9/+f96Ygy4DzXgPZRGZyvg0+yApBAXbsBnwHwiDLiPL/D+E4kDsBmQAFNQte3h//D29f87Tn4F8+Mm7Pyfs/gssgHzsRnQAFMA0ixvFQ82CMRXc8n8b53QjmzAfnzRB7YZphmEGw+8BmMkA9ZjM0AB3a9dZ77/bznyHlsYJOAKyPXICkGaK7c+wIgFUIDji4nzeEL/PXIKxWdIP1rq+w91nQKpGcsBigUYaAUARS6Z0aH6NdsAAAAASUVORK5CYII=';

export function createShellTray(actions: TrayActions, log: TrayLog): ShellTray | null {
  let tray: Tray | null = null;
  let items: TrayMenuItem[] = [];
  let iconSize: { width: number; height: number } | null = null;

  try {
    const icon: NativeImage = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    if (icon.isEmpty()) {
      log('warn', '托盘图标解码为空，跳过托盘（热键与桌宠本体不受影响）');
      return null;
    }
    iconSize = icon.getSize();

    tray = new Tray(icon);
    tray.setToolTip(TRAY_TOOLTIP);
    items = buildTrayMenuItems(actions);
    tray.setContextMenu(
      Menu.buildFromTemplate(
        items.map((item) => ({ id: item.id, label: item.label, click: item.click })),
      ),
    );

    log('info', '托盘已创建（16×16 占位图标）', {
      tooltip: TRAY_TOOLTIP,
      menu: items.map((item) => item.label),
      iconSize,
    });
  } catch (error) {
    log('warn', '托盘创建失败：继续无托盘运行（热键、输入条、桌宠均不受影响）', {
      error: String(error),
    });
    try {
      tray?.destroy();
    } catch {
      // 创建失败后的清理失败无需再处理
    }
    return null;
  }

  return {
    destroy(): void {
      const current = tray;
      tray = null;
      if (!current || current.isDestroyed()) return;
      try {
        current.destroy();
        log('info', '托盘已销毁');
      } catch (error) {
        log('warn', '托盘销毁失败（继续退出流程）', { error: String(error) });
      }
    },

    diagnostics(): TrayDiagnostics {
      const alive = tray !== null && !tray.isDestroyed();
      return {
        exists: alive,
        menuLabels: items.map((item) => item.label),
        tooltip: alive ? TRAY_TOOLTIP : null,
        iconSize,
      };
    },
  };
}
