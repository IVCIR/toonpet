/**
 * 语音包络：从解码后的 PCM 计算短时 RMS（ADR 0015 D4）。
 *
 * 纯函数、不碰 Web Audio、不读时钟——可在 Node 里单测。
 * 输出只留在渲染进程（§7.4：帧级包络不跨进程）。
 */
import { ENVELOPE_NOISE_GATE, ENVELOPE_WINDOW_MS } from '../../shared/constants';

export interface Envelope {
  /** 0..1，已按峰值归一化并过噪声门 */
  values: Float32Array;
  /** 实际窗口长度（ms） */
  windowMs: number;
  /** 相邻窗口的间隔（ms）；50% 重叠 */
  hopMs: number;
  durationMs: number;
  /** 归一化用的 95 分位峰值（诊断用） */
  peak: number;
}

function percentile(sorted: Float32Array, ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index] ?? 0;
}

/**
 * @param channels 每个声道的 PCM（-1..1）；多声道按**能量平均**（各声道平方和一起平均），
 *                 同相双声道不会把归一化电平翻倍，也不做相位相消
 * @param sampleRate 采样率（Hz）
 */
export function computeEnvelope(
  channels: Float32Array[],
  sampleRate: number,
  windowMs: number = ENVELOPE_WINDOW_MS,
): Envelope {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || channels.length === 0) {
    return { values: new Float32Array(0), windowMs, hopMs: Math.max(1, windowMs / 2), durationMs: 0, peak: 0 };
  }

  let frames = Number.POSITIVE_INFINITY;
  for (const channel of channels) frames = Math.min(frames, channel.length);
  if (!Number.isFinite(frames) || frames <= 0) {
    return { values: new Float32Array(0), windowMs, hopMs: Math.max(1, windowMs / 2), durationMs: 0, peak: 0 };
  }

  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const hopSamples = Math.max(1, Math.floor(windowSamples / 2));
  const count = Math.max(1, Math.floor((frames - windowSamples) / hopSamples) + 1);

  const rms = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const start = index * hopSamples;
    const end = Math.min(frames, start + windowSamples);
    let sum = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i += 1) {
        const sample = channel[i] ?? 0;
        sum += sample * sample;
      }
    }
    const tapCount = Math.max(1, (end - start) * channels.length);
    rms[index] = Math.sqrt(sum / tapCount);
  }

  const sorted = Float32Array.from(rms).sort();
  const peak = percentile(sorted, 0.95);

  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const raw = peak > 1e-6 ? (rms[index] ?? 0) / peak : 0;
    const normalized = Math.min(1, Math.max(0, raw));
    values[index] = normalized < ENVELOPE_NOISE_GATE ? 0 : normalized;
  }

  return {
    values,
    windowMs: (windowSamples / sampleRate) * 1000,
    hopMs: (hopSamples / sampleRate) * 1000,
    durationMs: (frames / sampleRate) * 1000,
    peak,
  };
}

/** 按播放位置取样（ms）；越界钳到首/尾。 */
export function levelAt(envelope: Envelope, positionMs: number): number {
  if (envelope.values.length === 0) return 0;
  const index = Math.round(positionMs / envelope.hopMs);
  const clamped = Math.min(envelope.values.length - 1, Math.max(0, index));
  return envelope.values[clamped] ?? 0;
}
