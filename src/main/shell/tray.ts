/**
 * 系统托盘（ADR 0018 D3；ADR 0032 D4 增补顶部两行只读诊断）。
 *
 * 硬约束：
 * - 托盘归 `shell`（契约 §3.1 / §7.2），只调 `shell` 内部入口，不碰其他模块；
 * - 不改变主窗口任何属性：`focusable` 恒为 `false`（§3.2，ADR 0003）；
 * - 托盘创建/销毁/刷新失败都不能拖垮桌宠：失败只记 WARN 并继续无托盘运行；
 * - 16×16 占位图标内嵌为 PNG data URL，不新增二进制资产、不联网；
 * - **诊断项是只读的**：`enabled: false`，点不动、也不产生任何副作用（ADR 0032 D4）。
 */
import { Menu, Tray, nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import { buildTrayMenuItems, TRAY_ZERO_STATS } from './tray-menu';
import type {
  TrayActions,
  TrayMenuItem,
  TrayStatsView,
} from './tray-menu';

export interface TrayDiagnostics {
  exists: boolean;
  menuLabels: string[];
  tooltip: string | null;
  iconSize: { width: number; height: number } | null;
  /** ADR 0032 D4：顶部两行只读诊断的当前文本（自检据此断言格式） */
  statLabels: string[];
  /** 顶部两行背后的原始读数 */
  stats: TrayStatsView;
}

export interface ShellTray {
  destroy(): void;
  diagnostics(): TrayDiagnostics;
  /**
   * 用户可见提示（ADR 0028 D3：吸附被拒绝时说清楚原因）。
   * Windows 上是通知区域气泡；托盘不可用/调用失败时只记 WARN，绝不抛。
   */
  notify(message: string): void;
  /**
   * 刷新顶部两行只读诊断（ADR 0032 D4）。
   * **只在文本真的变了时才重建原生菜单**，返回是否发生了重建。
   * 调用方（`shell`）把它挂在既有 16ms 轮询器的 `onTick` 上并节流，不新开定时器。
   */
  setStats(stats: TrayStatsView): boolean;
}

export type TrayLog = (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

export const TRAY_TOOLTIP = '凯伊 · 3D 桌宠';

/**
 * 16×16 占位图标（浅蓝猫脸，4× 超采样后缩放）。
 * 由 `scripts` 之外的临时生成器绘制；这里只保留结果，避免运行时依赖图片文件/网络。
 */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA1ElEQVR42mNgoDbov/xfoP/y/wIs4gb9l/8HEGNAQf/l//9BGtAMvd9/+f96Ygy4DzXgPZRGZyvg0+yApBAXbsBnwHwiDLiPL/D+E4kDsBmQAFNQte3h//D29f87Tn4F8+Mm7Pyfs/gssgHzsRnQAFMA0ixvFQ82CMRXc8n8b53QjmzAfnzRB7YZphmEGw+8BmMkA9ZjM0AB3a9dZ77/bznyHlsYJOAKyPXICkGaK7c+wIgFUIDji4nzeEL/PXIKxWdIP1rq+w91nQKpGcsBigUYaAUARS6Z0aH6NdsAAAAASUVORK5CYII=';

/** 菜单项 → Electron 模板项（`enabled:false` 就是"灰显点不动"）。 */
function toTemplate(items: TrayMenuItem[]): Array<{
  id: string;
  label: string;
  enabled: boolean;
  click: () => void;
}> {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    enabled: item.enabled,
    click: item.click,
  }));
}

function sameLabels(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function createShellTray(
  actions: TrayActions,
  log: TrayLog,
  initialStats: TrayStatsView = TRAY_ZERO_STATS,
  onDoubleClick?: () => void,
): ShellTray | null {
  let tray: Tray | null = null;
  let stats: TrayStatsView = { ...initialStats };
  /** 当前原生菜单上的标签（用于"文本没变就不重建"，也是诊断的唯一口径） */
  let labels: string[] = [];
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
    // ADR 0052 D1：双击托盘图标打开控制面板（菜单项是另一条等价入口）
    if (onDoubleClick) {
      tray.on('double-click', () => {
        try {
          onDoubleClick();
        } catch (error) {
          log('warn', '托盘双击回调抛错（已忽略）', { error: String(error) });
        }
      });
    }
    const initialItems = buildTrayMenuItems(actions, stats);
    labels = initialItems.map((item) => item.label);
    tray.setContextMenu(Menu.buildFromTemplate(toTemplate(initialItems)));

    log('info', '托盘已创建（16×16 占位图标，顶部两行只读诊断）', {
      tooltip: TRAY_TOOLTIP,
      menu: labels,
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
        menuLabels: [...labels],
        tooltip: alive ? TRAY_TOOLTIP : null,
        iconSize,
        statLabels: labels.slice(0, 2),
        stats: { ...stats },
      };
    },

    setStats(next: TrayStatsView): boolean {
      const current = tray;
      if (!current || current.isDestroyed()) return false;
      stats = {
        firedCount: Number.isFinite(next.firedCount) ? Math.max(0, Math.floor(next.firedCount)) : 0,
        lastReason: next.lastReason,
      };
      try {
        const nextItems = buildTrayMenuItems(actions, stats);
        const nextLabels = nextItems.map((item) => item.label);
        // 只有文本真的变了才重建原生菜单：重建会短暂替换句柄，没必要每 5s 都做
        if (sameLabels(nextLabels, labels)) return false;
        current.setContextMenu(Menu.buildFromTemplate(toTemplate(nextItems)));
        labels = nextLabels;
        log('info', '托盘诊断项已刷新', { statLabels: labels.slice(0, 2) });
        return true;
      } catch (error) {
        log('warn', '托盘诊断项刷新失败（继续运行，等下个节拍再试）', { error: String(error) });
        return false;
      }
    },

    notify(message: string): void {
      const current = tray;
      if (!current || current.isDestroyed()) {
        log('warn', '托盘不可用，提示只写日志（ADR 0028 D3）', { message });
        return;
      }
      try {
        // Windows：通知区域气泡（Electron 在 Win11 上会走系统通知）
        current.displayBalloon({ title: TRAY_TOOLTIP, content: message });
        log('info', '托盘提示已发出', { message });
      } catch (error) {
        log('warn', '托盘提示发送失败（继续运行）', { message, error: String(error) });
      }
    },
  };
}
