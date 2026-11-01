/**
 * 主动性诊断计数器（ADR 0032 D4）——**内存里的两条只读事实**，给托盘菜单看。
 *
 * 为什么要单独一个文件，而不是给 shell 加 setter、也不发事件：
 * - 契约 §6.3 的事件清单是封闭的，"她刚主动开口了"没有对应事件，**不得**为此新增（N-8 / E-6）；
 * - §7.7 I-2 禁止"多余的 setter"，所以不能给 shell 或 orchestrator 加 `setProactiveStats()`；
 * - 写方只有 `orchestrator`（它本来就有这两个计数器），读方只有 `shell/托盘`。
 *
 * 于是取本工程已有的、被验证过的做法：**进程内单例**（与 `src/main/event-bus.ts` 的 `appBus`
 * 同一手法）。它不是事件、不是 IPC、不是新接口方法，只是"一块两个字段的内存"。
 *
 * 生命周期：模块初始化即清零；`runtime.start()` 再显式 `reset()` 一次，
 * 所以同一进程内重装 runtime（自检/调试）也会从 0 开始。**不落盘**——重启即归零，
 * 因此托盘上的"今天"实际上是"本进程启动以来"（ADR 0032 D4.2 明确记下这个措辞差异）。
 */
import type { IdleDriveReason } from './orchestrator/idle-drive';

/**
 * 第二行诊断可以出现的全部取值：`idle-drive` 的九个判定原因，
 * 加两个"判定通过但她最终没开口"的诊断值（ADR 0032 D4）：
 *
 * - `no-lines`：空闲台词池没有可说的，且 LLM 路径不可用（未健康检查 / 已熔断）→ 保持沉默；
 * - `llm-failed`：主动推理打出去了，但超时 / 失败 / 输出不合法 → 按 D4.2 保持沉默。
 *
 * 为什么需要这两个值：判定结果是 `ok` 只说明"可以开口"，不等于"真的说了"。
 * 少了它们，托盘会在她**什么都没说**的时候显示"（上次已开口）"——一条会撒谎的诊断。
 * 它们**不是** `IdleDriveReason` 的成员（那不是判定器的输出，判定器不该知道自己有没有台词），
 * 只属于这块诊断内存。
 */
export type ProactiveSilenceReason = IdleDriveReason | 'no-lines' | 'llm-failed';

export interface ProactiveStatsSnapshot {
  /** 本进程内已成功主动开口的次数（规则 + LLM 合并计，ADR 0031 D5） */
  firedCount: number;
  /** 上一次判定/尝试的结果：`'ok'` = 上一次真的开口了；`null` = 还没有评估过 */
  lastReason: ProactiveSilenceReason | null;
  /** 最后一次更新的时刻（毫秒），仅诊断 */
  updatedAt: number;
}

const INITIAL: ProactiveStatsSnapshot = { firedCount: 0, lastReason: null, updatedAt: 0 };

let current: ProactiveStatsSnapshot = { ...INITIAL };

/** 清零（进程启动 / runtime.start；**不是**定时任务）。 */
export function resetProactiveStats(): void {
  current = { ...INITIAL };
}

/**
 * 写入一次读数。调用方是 `orchestrator` 的 idle-drive 节拍（每 15s 一次）
 * 与主动发布点（每次开口一次），因此写入频率极低，不需要去重。
 */
export function publishProactiveStats(
  input: { firedCount: number; lastReason: ProactiveSilenceReason | null },
  at: number,
): void {
  current = {
    firedCount: Math.max(0, Math.floor(input.firedCount)),
    lastReason: input.lastReason,
    updatedAt: Math.max(0, Math.floor(at)),
  };
}

/** 读取（托盘刷新时调用；返回快照副本，调用方改不动内部状态）。 */
export function readProactiveStats(): ProactiveStatsSnapshot {
  return { ...current };
}
