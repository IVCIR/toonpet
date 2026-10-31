/**
 * 托盘菜单的纯规格（ADR 0018 D3）。
 *
 * 单独成文件的目的：菜单标签与点击分发是**唯一事实源**，可以在没有 Electron 的
 * 单测里断言（`tray-menu.test.ts`），避免"图标能不能起来"掩盖"菜单接错线"。
 *
 * 契约关联：
 * - §3.1 / §7.2 把托盘归 `shell`（主进程侧）；
 * - ADR 0004 D9：托盘"退出"必须先 `shell.stop()` 再退出，不得只调 `app.quit()`。
 */

export type TrayActionId = 'open-input-bar' | 'reload-pet' | 'quit';

export interface TrayActions {
  /** 呼出输入条：与全局热键共用同一个打开入口（ADR 0016 D4） */
  openInputBar(): void;
  /** 重新加载桌宠：重启渲染进程，仅用于调试 */
  reloadPet(): void;
  /** 退出：由调用方先 `shell.stop()`，再退出应用（ADR 0004 D9） */
  quit(): void;
}

export interface TrayMenuItem {
  id: TrayActionId;
  label: string;
  click(): void;
}

/** 菜单顺序与标签是对外行为的一部分，测试与文档都以这张表为准。 */
export const TRAY_MENU: ReadonlyArray<{ id: TrayActionId; label: string }> = [
  { id: 'open-input-bar', label: '呼出输入条' },
  { id: 'reload-pet', label: '重新加载桌宠' },
  { id: 'quit', label: '退出' },
];

export function buildTrayMenuItems(actions: TrayActions): TrayMenuItem[] {
  return TRAY_MENU.map(({ id, label }) => ({
    id,
    label,
    click: (): void => {
      switch (id) {
        case 'open-input-bar':
          actions.openInputBar();
          return;
        case 'reload-pet':
          actions.reloadPet();
          return;
        case 'quit':
          actions.quit();
          return;
      }
    },
  }));
}
