/**
 * 渲染侧语音播放器（契约 §3.1、§7.4；ADR 0015 D3/D4）。
 *
 * - 用 Web Audio `decodeAudioData` 解 WAV（主进程只发字节）；
 * - 播放位置驱动包络取样 → 8 级嘴型帧 → `onFrame` → `MouthChannel.setFrame`；
 * - 首帧上报 `started`、自然结束上报 `ended{completed}`、解码/设备失败上报 `ended{failed}`；
 * - 被打断时**不**上报 ended（`speech_ended{interrupted}` 由主进程发）。
 *
 * 不持有 HFSM：`speaking` 状态仍由 `speech_started` / `speech_ended` 事件驱动（H-4）。
 */
import type { VoiceCommand } from '../../shared/ipc';
import { computeEnvelope, levelAt } from './envelope';
import type { Envelope } from './envelope';
import { createMouthMapper } from './mouth-mapping';

type SpeakCommand = Extract<VoiceCommand, { kind: 'speak' }>;

export interface SpeechPlayerDeps {
  onStarted(utteranceId: string): void;
  onEnded(utteranceId: string, reason: 'completed' | 'failed', durationMs: number, detail?: string): void;
  onFrame(frame: number): void;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export interface SpeechPlayerDiagnostics {
  speaking: boolean;
  utteranceId: string | null;
  level: number;
  frame: number;
  contextState: string | null;
  envelopeMs: number | null;
  windowCount: number;
}

export interface SpeechPlayer {
  play(command: SpeakCommand): Promise<void>;
  stop(utteranceId: string): void;
  dispose(): void;
  getDiagnostics(): SpeechPlayerDiagnostics;
}

interface Playback {
  utteranceId: string;
  source: AudioBufferSourceNode;
  startAt: number;
  durationMs: number;
  envelope: Envelope;
  started: boolean;
  ended: boolean;
  raf: number | null;
  startedAtWall: number;
}

export function createSpeechPlayer(deps: SpeechPlayerDeps): SpeechPlayer {
  const log =
    deps.log ??
    ((level, message, data) => {
      if (level === 'warn') console.warn(`[voice] ${message}`, data ?? '');
      else console.log(`[voice] ${message}`, data ?? '');
    });

  const mapper = createMouthMapper();
  let context: AudioContext | null = null;
  let playback: Playback | null = null;

  function ensureContext(): AudioContext | null {
    if (context) return context;
    try {
      const Ctor = window.AudioContext;
      context = new Ctor();
      log('info', 'AudioContext 已创建', { state: context.state, sampleRate: context.sampleRate });
      return context;
    } catch (error) {
      log('warn', 'AudioContext 创建失败（播放设备不可用）', String(error));
      return null;
    }
  }

  function detach(next: Playback | null): void {
    const current = playback;
    if (!current) {
      playback = next;
      return;
    }
    current.ended = true;
    if (current.raf !== null) cancelAnimationFrame(current.raf);
    try {
      current.source.stop();
    } catch {
      // 已经自然结束
    }
    try {
      current.source.disconnect();
    } catch {
      // 已断开
    }
    mapper.reset();
    deps.onFrame(0);
    playback = next;
  }

  function finish(reason: 'completed' | 'failed', detail?: string): void {
    const current = playback;
    if (!current || current.ended) return;
    current.ended = true;
    if (current.raf !== null) cancelAnimationFrame(current.raf);
    try {
      current.source.stop();
    } catch {
      // 已结束
    }
    try {
      current.source.disconnect();
    } catch {
      // 已断开
    }
    playback = null;
    mapper.reset();
    deps.onFrame(0);
    const durationMs = Math.max(0, Math.round(performance.now() - current.startedAtWall));
    if (reason === 'failed') log('warn', '播放失败', { utteranceId: current.utteranceId, detail });
    deps.onEnded(current.utteranceId, reason, durationMs, detail);
  }

  function tick(): void {
    const current = playback;
    const ctx = context;
    if (!current || current.ended || !ctx) return;

    const positionMs = (ctx.currentTime - current.startAt) * 1000;
    if (!current.started && positionMs >= 0) {
      current.started = true;
      current.startedAtWall = performance.now();
      deps.onStarted(current.utteranceId);
    }

    const mapped = mapper.update(levelAt(current.envelope, Math.max(0, positionMs)), performance.now());
    if (mapped.changed) deps.onFrame(mapped.frame);

    if (positionMs >= current.durationMs + 20) {
      finish('completed');
      return;
    }
    current.raf = requestAnimationFrame(tick);
  }

  return {
    async play(command: SpeakCommand): Promise<void> {
      if (playback) detach(null);

      const ctx = ensureContext();
      if (!ctx) {
        deps.onEnded(command.utteranceId, 'failed', 0, 'AudioContext 不可用');
        return;
      }

      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch (error) {
          log('warn', 'AudioContext.resume() 失败', String(error));
        }
      }
      if (ctx.state !== 'running') {
        // 没有用户手势且未开 autoplay 开关时的典型症状（ADR 0015 D5）
        deps.onEnded(command.utteranceId, 'failed', 0, `AudioContext 状态 ${ctx.state}`);
        return;
      }

      let buffer: AudioBuffer;
      try {
        // decodeAudioData 会 detach 入参，先复制一份，避免影响调用方
        buffer = await ctx.decodeAudioData(command.audio.slice(0));
      } catch (error) {
        log('warn', 'WAV 解码失败', String(error));
        deps.onEnded(command.utteranceId, 'failed', 0, `decodeAudioData: ${String(error)}`);
        return;
      }

      const channels: Float32Array[] = [];
      for (let index = 0; index < buffer.numberOfChannels; index += 1) {
        channels.push(buffer.getChannelData(index));
      }
      const envelope = computeEnvelope(channels, buffer.sampleRate);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      const startAt = ctx.currentTime + 0.03;
      source.start(startAt);
      mapper.reset();

      const entry: Playback = {
        utteranceId: command.utteranceId,
        source,
        startAt,
        durationMs: buffer.duration * 1000,
        envelope,
        started: false,
        ended: false,
        raf: null,
        startedAtWall: performance.now(),
      };
      playback = entry;
      log('info', '开始播放', {
        utteranceId: command.utteranceId,
        durationMs: Math.round(entry.durationMs),
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        envelopeWindows: envelope.values.length,
        peak: Number(envelope.peak.toFixed(4)),
      });
      entry.raf = requestAnimationFrame(tick);
    },

    stop(utteranceId: string): void {
      if (!playback || playback.utteranceId !== utteranceId) return;
      // 打断：只停，不上报 ended（主进程已经决定 interrupted）
      detach(null);
      log('info', '播放被 stop 中止', { utteranceId });
    },

    dispose(): void {
      detach(null);
      void context?.close().catch(() => undefined);
      context = null;
    },

    getDiagnostics(): SpeechPlayerDiagnostics {
      return {
        speaking: playback !== null,
        utteranceId: playback?.utteranceId ?? null,
        level: mapper.level,
        frame: mapper.frame,
        contextState: context?.state ?? null,
        envelopeMs: playback ? Math.round(playback.durationMs) : null,
        windowCount: playback?.envelope.values.length ?? 0,
      };
    },
  };
}
