/**
 * `presence` / `WorldFacts` 的契约类型（ADR 0030；ADR 0032 增补归一化类别）。
 *
 * 放在 `shared/` 而不是 `main/presence.ts`：`orchestrator` 只允许 `import type`
 * 这个结构化端口，不许把 `koffi`（可选原生依赖）拖进它的依赖图——与
 * `shared/memory-types.ts` 对待 `better-sqlite3` 是同一手法（ADR 0020 D10）。
 */

/**
 * 标准应用类别（ADR 0032 D1）。**这是进提示词的唯一形态**：
 * 原始窗口标题留在 `PresenceSnapshot` 里只给诊断，绝不进段 3.5。
 */
export type KnownAppCategory = 'coding' | 'browser' | 'game' | 'meeting' | 'video';

/**
 * 归一化后的前台应用类别。
 *
 * - `''`：没有前台窗口（`GetForegroundWindow` 返回 0）→ 段 3.5 **整项省略**；
 * - `KnownAppCategory`：命中规则表；
 * - `` `other: ${string}` ``：未命中，降级为"类名"（类名不是用户内容，比标题安全得多）。
 */
export type AppCategory = '' | KnownAppCategory | `other: ${string}`;

/** 某一时刻的"用户在场感"读数。所有字段都是纯数据，可结构化克隆。 */
export interface PresenceSnapshot {
  /**
   * 系统级键鼠空闲毫秒数（`GetLastInputInfo` + `GetTickCount`）。
   * `null` = 读不到（koffi 未装 / 绑定失败 / 调用失败），调用方必须按"未知"处理，
   * **不得**退化成"用户一定在"或"用户一定不在"（ADR 0030 D5）。
   */
  userIdleMs: number | null;
  /**
   * 前台窗口标题（已去控制字符、已截断）；没有前台窗口时为 `''`。
   * **只进诊断与分类器，不得进提示词**（ADR 0032 D1：标题里可能有文档名/页面标题）。
   */
  foregroundTitle: string;
  /** 前台窗口类名；读不到时为 `''` */
  foregroundClass: string;
  /** 前台窗口的归一化类别（ADR 0032）；段 3.5 用它取代标题 */
  foregroundCategory: AppCategory;
  /** 这次读数的时间戳（毫秒），用于诊断"读数是否陈旧" */
  at: number;
}

/** 只读端口：`orchestrator` 通过它拿"用户在不在"，不认识 Win32。 */
export interface PresencePort {
  /** 同步返回最近一次采样（内部按 2s 节流重采）；永不抛异常 */
  getSnapshot(): PresenceSnapshot;
}

/**
 * 段 3.5「环境事实」的输入（ADR 0030 D2；ADR 0032 D2 改字段）。
 *
 * 全部字段都是数值或短字符串，纯函数即可拼出该段，因此能在 Node 里直接单测。
 *
 * **没有原始标题字段**是刻意设计：类型上不给"把用户文档名塞进模型"留口子。
 */
export interface WorldFacts {
  /** 当前时刻（毫秒时间戳），由调用方的 `now()` 注入 */
  now: number;
  /** 同 `PresenceSnapshot.userIdleMs`；`null` = 未知 */
  userIdleMs: number | null;
  /** 前台应用类别（ADR 0032）；`''` = 没有前台窗口 → 省略该分项 */
  foregroundCategory: AppCategory;
  /** 上一次"用户主动交互"的时刻（`user_utterance` 或 `head_patted`）；`null` = 本会话还没有过 */
  lastInteractionAt: number | null;
}
