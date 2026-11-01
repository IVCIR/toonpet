/**
 * `model_ready` 的一次性闩锁 + 观察者（ADR 0033 D2.2）。
 *
 * 为什么需要它：`model_ready` 是渲染侧上行的事件（§6.3），而它**可能早于 `runtime.start()` 完成**
 * ——启动顺序是 `shell.start()`（建窗、装页面）→ `runtime.start()`（读配置、开库、装配编排），
 * 渲染进程完全可能在后者跑完之前就把模型加载完（实测启动早期就会发生，自检里也踩过，
 * 见 `selftest.ts` 的 `baselineLineCount` 注释）。只在 runtime 里订阅的话，
 * 早到的那一次就会被彻底丢掉，"模型一出现就预热"在最关键的那一轮不成立。
 *
 * 所以取本工程已有的手法（与 `proactive-stats`、`appBus` 相同）：**进程内单例**。
 * 它不是事件、不是 IPC、不是新接口方法、不加 `RenderState` 字段：
 * - 写方只有 `shell`——它本来就是 `model_ready` 的唯一消费者（§6.3），收到就落一个闩锁；
 * - 读方只有 `runtime`——装配完心跳后 ①注册观察者（在线补发）②读一次闩锁（早到补发）。
 *
 * **为什么不用 `appBus.emit('model_ready')`**：`appBus.emit` 会把事件同时转发回渲染侧
 * （`evt:broadcast`），等于让渲染进程收到自己刚发出的事件（回环）；而 `model_ready`
 * 本来就是从渲染侧上行、由 shell 收口的那一个，绕总线一圈只会制造噪音。
 * 这里要的不是"广播"，是"一个事实 + 一个想知道它的组件"。
 *
 * 只记第一次：`model_ready` 在正常会话里只发一次（托盘"重新加载桌宠"会再发），
 * 而预热是"一次就够"的事（`llmWarmedUp` 在心跳里已经挡住重复请求）。
 */

let readyAt: number | null = null;
const observers = new Set<(at: number) => void>();

/** 记录"模型已经就绪"这一事实；第一次写入生效，后续调用是空操作。 */
export function noteModelReady(at: number = Date.now()): void {
  if (readyAt !== null) return;
  readyAt = Number.isFinite(at) ? at : Date.now();
  const stamped = readyAt;
  for (const observer of [...observers]) {
    try {
      observer(stamped);
    } catch {
      // 观察者抛错不得影响事件源头（与 §6.4 E-4 同一取舍）
    }
  }
}

/**
 * 注册"模型就绪"的观察者；返回退订函数。
 * 只回调一次（事实只发生一次），注册时若已经就绪则不补调——早到的场景由 `readModelReadyAt()` 处理，
 * 这样"补发"与"在线"两条路各只有一处触发点，不会重复。
 */
export function onModelReady(observer: (at: number) => void): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/** 读取模型就绪时刻；`null` = 本次进程内还没有就绪过。 */
export function readModelReadyAt(): number | null {
  return readyAt;
}

/** 清零（`runtime.stop()` 调用；同一进程内重装 runtime / 重载渲染页时从头再来）。 */
export function resetModelReady(): void {
  readyAt = null;
  observers.clear();
}
