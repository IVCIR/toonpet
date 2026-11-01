/**
 * 生命周期心跳（预热）总闸的解析（ADR 0033 D1.3）。
 *
 * 与 `proactive-config`（主动性开关）**完全独立**，这是本轮的核心：
 * `PET_PROACTIVE_DISABLE=1` 关掉的是"要不要打扰老师"，不是"把本地模型热好"。
 * 旧实现（ADR 0032 D3）把预热挂在 idle-drive 的节拍上，于是关掉主动性就顺带废掉了预热——
 * 这就是 ADR 0033 要修的那条硬约束。
 *
 * 单独成一个**不 import Electron** 的文件，理由与 `proactive-config` 相同：优先级是需求的一部分，
 * 必须能被断言，而不是靠读代码相信。
 *
 * 优先级（高 → 低）：
 * 1. `PET_WARMUP_DISABLE=1` → 关闭（用户逃生口：不想让任何后台请求碰本地 LLM 时用）；
 * 2. `PET_SELFTEST=1` → **硬关**：自检必须保持"零后台推理"（ADR 0031 D6 的同一理由——
 *    三套自检对时序与截图像素差有强断言，一个后台加载会随机改变它们的时序）；
 * 3. 其余情况 → 开。
 *
 * 这里**刻意不提供** `PET_SELFTEST_WARMUP=1` 这类开关：自检的"零后台推理"是硬保证，
 * 不是默认值。将来真要验收预热，应该像 `selftest-stubs` 那样起一个本地桩，
 * 而不是先给自检开一个可能被 `.env` 意外打开的口子。
 */
import { truthyFlag } from './env-flags';

export interface HeartbeatGate {
  enabled: boolean;
  /** 人类可读的原因，进启动日志与 `RuntimeSnapshot.warmup.reason`（排查"为什么不预热"的第一现场） */
  reason: string;
}

export function resolveHeartbeatGate(env: NodeJS.ProcessEnv = process.env): HeartbeatGate {
  if (truthyFlag(env['PET_WARMUP_DISABLE'])) {
    return { enabled: false, reason: 'PET_WARMUP_DISABLE=1' };
  }
  if (env['PET_SELFTEST'] === '1') {
    return { enabled: false, reason: 'PET_SELFTEST=1（自检零后台推理）' };
  }
  return { enabled: true, reason: 'default' };
}
