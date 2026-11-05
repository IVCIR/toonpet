/**
 * 空闲小动作的**调度**（ADR 0041 D4；ADR 0045 D1 删除了"原地转圈"）。
 *
 * 历史：这一层原来有两件事——
 * 1. `shy`：官方片段（`clip-bank` 的 `fidget.shy`，`Cafe_Reaction` 3.2–4.9s 的掩面缩身）；
 * 2. `spin`：**纯根节点偏航**原地转 2π（程序化）。
 *
 * ADR 0045 D1：**`spin` 整体删除**。真机反馈很明确——"3D 角色原地平移转圈会像陀螺，非常出戏"。
 * 一个没有位移的角色原地偏航 360°，既没有重心转移也没有脚步，读起来就是贴图在转。
 * 所有者要求：在有合适片段之前**直接关掉**，不做"歪头/手部微调"之类的新程序化动作
 * （同一理由：ADR 0039 D2 已经因为"手写骨骼"删掉程序化摸头）。
 *
 * 于是本文件只剩"下一次小动作什么时候到"：
 * - `nextFidgetDelayMs()`：纯随机间隔；
 * - `nextFidgetAtMs()`：再加一道"启动后冷却"的硬闸（ADR 0043 D1 的"一打开就转一圈"）。
 *
 * 纯函数、不引用 three、不读时钟，可脱离 WebGL 单测。
 */
import { IDLE_FIDGET_MAX_MS, IDLE_FIDGET_MIN_MS } from '../../shared/constants';

/**
 * 下一次小动作的时刻（相对现在的毫秒延迟）。
 * `random` 注入以便单测断言边界，缺省 `Math.random`。
 */
export function nextFidgetDelayMs(random: () => number = Math.random): number {
  const sample = random();
  const r = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return Math.round(IDLE_FIDGET_MIN_MS + r * (IDLE_FIDGET_MAX_MS - IDLE_FIDGET_MIN_MS));
}

/**
 * 排下一次小动作的**绝对时刻**（ADR 0043 D1：冷启动前 45 秒绝对不许触发）。
 *
 * 两道闸：
 * 1. `now + delay`（delay ∈ [45s, 95s]）；
 * 2. **`startedAt + IDLE_FIDGET_MIN_MS`** —— 以"渲染模块的构造时刻"为基准的强制冷却。
 *
 * 为什么需要第 2 道：第 1 道的基准是"第一次排期"的时刻。模型加载慢 / 首帧晚 /
 * 或者某条路径**漏排期**（`fidgetAt` 还停在初值时）都可能让 `now` 已经很大，
 * 单靠第 1 道闸挡不住"启动即到期"。取两者最大值 = 启动后至少 45 秒的冷却。
 */
export function nextFidgetAtMs(
  now: number,
  startedAt: number,
  random: () => number = Math.random,
): number {
  const base = Number.isFinite(now) ? now : 0;
  const birth = Number.isFinite(startedAt) ? startedAt : base;
  return Math.max(base + nextFidgetDelayMs(random), birth + IDLE_FIDGET_MIN_MS);
}
