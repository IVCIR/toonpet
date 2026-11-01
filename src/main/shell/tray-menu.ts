/**
 * 托盘菜单的纯规格（ADR 0018 D3、ADR 0028 D4、ADR 0032 D4）。
 *
 * 单独成文件的目的：菜单标签与点击分发是**唯一事实源**，可以在没有 Electron 的
 * 单测里断言（`tray-menu.test.ts`），避免"图标能不能起来"掩盖"菜单接错线"。
 *
 * 契约关联：
 * - §3.1 / §7.2 把托盘归 `shell`（主进程侧）；
 * - ADR 0004 D9：托盘"退出"必须先 `shell.stop()` 再退出，不得只调 `app.quit()`；
 * - ADR 0028 D4：吸附/离开是主进程内部行为，不新增事件或 IPC 通道；
 * - ADR 0032 D4：菜单**顶部两行只读诊断**（`enabled: false`），数据来自 `proactive-stats`
 *   单例，**不新增事件、不新增 IPC、不改 `RenderState`**。
 */
import type { ProactiveSilenceReason } from '../proactive-stats';

export type TrayActionId =
  | 'open-input-bar'
  | 'snap-foreground'
  | 'release-snap'
  | 'reload-pet'
  | 'quit';

/** 只读诊断项的 id（不是动作，点击无行为） */
export type TrayStatId = 'stat-proactive-count' | 'stat-proactive-skip';

export type TrayItemId = TrayActionId | TrayStatId;

export interface TrayActions {
  /** 呼出输入条：与全局热键共用同一个打开入口（ADR 0016 D4） */
  openInputBar(): void;
  /** 吸附到前台窗口的下/上边缘（与 Ctrl+Shift+S 同一个入口，ADR 0028 D4） */
  snapForeground(): void;
  /** 离开窗口边缘：解除吸附，回到站立（幂等） */
  releaseSnap(): void;
  /** 重新加载桌宠：重启渲染进程，仅用于调试 */
  reloadPet(): void;
  /** 退出：由调用方先 `shell.stop()`，再退出应用（ADR 0004 D9） */
  quit(): void;
}

/**
 * 顶部两行诊断的数据形态（与 `proactive-stats` 单例同构，只取要展示的两个字段）
 */
export interface TrayStatsView {
  /** 本进程内已成功主动开口次数 */
  firedCount: number;
  /** 上一次主动性的结果；`null` = 还没有评估过 */
  lastReason: ProactiveSilenceReason | null;
}

export const TRAY_ZERO_STATS: TrayStatsView = { firedCount: 0, lastReason: null };

export interface TrayMenuItem {
  id: TrayItemId;
  label: string;
  /** `false` = 只读诊断项（Electron 菜单的 `enabled: false`，灰显、点不动） */
  enabled: boolean;
  click(): void;
}

/** 动作项的顺序与标签是对外行为的一部分，测试与文档都以这张表为准。 */
export const TRAY_MENU: ReadonlyArray<{ id: TrayActionId; label: string }> = [
  { id: 'open-input-bar', label: '呼出输入条' },
  { id: 'snap-foreground', label: '吸附到前台窗口（Ctrl+Shift+S）' },
  { id: 'release-snap', label: '离开窗口边缘' },
  { id: 'reload-pet', label: '重新加载桌宠' },
  { id: 'quit', label: '退出' },
];

/** 只读诊断项在菜单里的顺序（顶部两行，ADR 0032 D4） */
export const TRAY_STAT_IDS: ReadonlyArray<TrayStatId> = [
  'stat-proactive-count',
  'stat-proactive-skip',
];

/**
 * `ProactiveSilenceReason` → 人话。
 *
 * 保留英文原词（`user-active` / `budget` …）是刻意的：用户/日志/`snapshot().lastProactiveSkip`
 * 三处看到的是同一个词，排查时不会出现"菜单说一套、日志说另一套"。
 * `Record` 是穷举的——新增一个取值而忘了这里，`tsc` 直接报错。
 */
const SKIP_REASON_LABEL: Record<ProactiveSilenceReason, string> = {
  ok: '（上次已开口）',
  disabled: 'disabled（主动性已关闭）',
  busy: 'busy（她在说话或思考）',
  'no-presence': 'no-presence（读不到在场感）',
  'user-active': 'user-active（先生正在操作）',
  'user-away': 'user-away（先生不在电脑前）',
  gap: 'gap（距上次交互不足 90 秒）',
  budget: 'budget（本次会话的打扰预算已用完）',
  cooldown: 'cooldown（距上次主动不足 10 分钟）',
  'no-lines': 'no-lines（没有空闲台词且 LLM 不可用）',
  'llm-failed': 'llm-failed（主动推理失败，按约定保持沉默）',
};

/** 未评估过 / 未知取值时的展示串 */
export function formatSkipReason(reason: ProactiveSilenceReason | null): string {
  if (reason === null) return '（尚未评估）';
  return SKIP_REASON_LABEL[reason] ?? String(reason);
}

/** 第一行：本进程内主动开口次数（**内存计数，重启清零**，ADR 0032 D4.2） */
export function formatProactiveCount(firedCount: number): string {
  const safe = Number.isFinite(firedCount) ? Math.max(0, Math.floor(firedCount)) : 0;
  return `今天主动交互: ${safe} 次`;
}

/** 第二行：上一次"没有主动开口"的原因 */
export function formatProactiveSkip(reason: ProactiveSilenceReason | null): string {
  return `上次未主动原因: ${formatSkipReason(reason)}`;
}

/** 顶部两行的完整标签（顺序固定，供 `tray-menu.test.ts` 与自检断言） */
export function buildTrayStatLabels(stats: TrayStatsView): [string, string] {
  return [formatProactiveCount(stats.firedCount), formatProactiveSkip(stats.lastReason)];
}

/** 顶部两行只读项：`enabled: false` + 空 `click`，保证"点了也没有副作用"。 */
export function buildTrayStatItems(stats: TrayStatsView): TrayMenuItem[] {
  const [count, skip] = buildTrayStatLabels(stats);
  return [
    { id: 'stat-proactive-count', label: count, enabled: false, click: () => undefined },
    { id: 'stat-proactive-skip', label: skip, enabled: false, click: () => undefined },
  ];
}

function buildActionItems(actions: TrayActions): TrayMenuItem[] {
  return TRAY_MENU.map(({ id, label }) => ({
    id,
    label,
    enabled: true,
    click: (): void => {
      switch (id) {
        case 'open-input-bar':
          actions.openInputBar();
          return;
        case 'snap-foreground':
          actions.snapForeground();
          return;
        case 'release-snap':
          actions.releaseSnap();
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

/**
 * 完整菜单：**顶部两行只读诊断 + 五个动作项**（ADR 0032 D4）。
 * `stats` 缺省为全零视图，便于"还没装配 orchestrator"时也能建出菜单。
 */
export function buildTrayMenuItems(
  actions: TrayActions,
  stats: TrayStatsView = TRAY_ZERO_STATS,
): TrayMenuItem[] {
  return [...buildTrayStatItems(stats), ...buildActionItems(actions)];
}
