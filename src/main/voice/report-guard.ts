/**
 * `cmd:speech` 的运行时载荷守卫（ADR 0015 D3.2）。
 * 渲染侧不是可信边界：形状不对就丢弃并记一条日志，绝不把脏数据塞进 voice 状态机。
 */
import type { SpeechReport } from '../../shared/ipc';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSpeechReport(value: unknown): value is SpeechReport {
  if (!isPlainObject(value)) return false;
  const utteranceId = value['utteranceId'];
  if (typeof utteranceId !== 'string' || utteranceId === '') return false;

  const phase = value['phase'];
  if (phase === 'started') return true;

  if (phase === 'ended') {
    const reason = value['reason'];
    if (reason !== 'completed' && reason !== 'failed') return false;
    const durationMs = value['durationMs'];
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return false;
    const detail = value['detail'];
    if (detail !== undefined && typeof detail !== 'string') return false;
    return true;
  }

  return false;
}
