/**
 * voice 模块（契约 §7.4、§3.5、§6.3；ADR 0015 D3）。
 *
 * 职责边界：
 * - 主进程只做**合成**（GPT-SoVITS）+ 事件生产（`speech_started` / `speech_ended` 的唯一生产者）；
 * - 播放、解码、RMS 包络全在渲染进程，主进程只下发 WAV 字节（ADR 0015 D3.3）；
 * - 打断是单一序列：`stop`（命令，让渲染侧停）→ `speech_ended{interrupted}`（事实）；
 * - `speak()` 永不 reject，且在**终态**兑现（不是"开始播放"时）。
 */
import { SPEECH_TEXT_MAX_CHARS } from '../../shared/constants';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { SpeechReport } from '../../shared/ipc';
import type { EventBus } from '../event-bus';
import type { TtsClient } from './gpt-sovits-client';

export type SpeechOutcome = 'completed' | 'interrupted' | 'failed';
export type VoicePhase = 'idle' | 'synthesizing' | 'waiting-start' | 'playing';

export interface VoiceDeps {
  bus: EventBus;
  tts: TtsClient;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export interface Voice {
  speak(text: string, utteranceId: string): Promise<SpeechOutcome>;
  stopSpeaking(reason?: 'interrupt' | 'shutdown'): void;
  /** 内部：`cmd:speech` 的渲染侧上报入口 */
  handleSpeechReport(report: SpeechReport): void;
  snapshot(): VoiceSnapshot;
  dispose(): void;
}

export interface VoiceSnapshot {
  phase: VoicePhase;
  activeUtteranceId: string | null;
  enabled: boolean;
  disabledReason: string | null;
}

interface Session {
  utteranceId: string;
  text: string;
  phase: VoicePhase;
  resolve: (outcome: SpeechOutcome) => void;
  terminal: boolean;
  startedAt: number;
  playbackStartedAt: number | null;
  synthesis: AbortController | null;
}

export function createVoice(deps: VoiceDeps): Voice {
  const now = deps.now ?? Date.now;
  const log =
    deps.log ??
    ((level, message, data) => {
      const line = `[voice] ${message}`;
      if (level === 'warn') console.warn(line, data ?? '');
      else console.log(line, data ?? '');
    });

  let active: Session | null = null;

  function emitEnded(session: Session, outcome: SpeechOutcome): void {
    const durationMs =
      outcome === 'completed'
        ? Math.max(0, now() - (session.playbackStartedAt ?? now()))
        : outcome === 'interrupted'
          ? session.playbackStartedAt === null
            ? 0
            : Math.max(0, now() - session.playbackStartedAt)
          : Math.max(0, now() - session.startedAt);
    deps.bus.emit('speech_ended', {
      utteranceId: session.utteranceId,
      reason: outcome,
      durationMs: Math.round(durationMs),
    });
  }

  function finish(session: Session, outcome: SpeechOutcome): void {
    if (session.terminal) return;
    session.terminal = true;
    session.synthesis?.abort();
    session.synthesis = null;
    session.phase = 'idle';
    if (active === session) active = null;
    emitEnded(session, outcome);
    log(outcome === 'failed' ? 'warn' : 'info', `speech_ended ${outcome}`, {
      utteranceId: session.utteranceId,
    });
    session.resolve(outcome);
  }

  function synthesizeAndDispatch(session: Session): void {
    void (async () => {
      try {
        if (!deps.tts.enabled) {
          log('warn', 'TTS 未配置，本次回复只有字幕（§11 TTS 行）', {
            utteranceId: session.utteranceId,
            detail: deps.tts.disabledReason,
          });
          finish(session, 'failed');
          return;
        }

        const controller = new AbortController();
        session.synthesis = controller;
        session.phase = 'synthesizing';

        const result = await deps.tts.synthesize(session.text, { signal: controller.signal });
        if (session.terminal) return;

        if (!result.ok) {
          log('warn', 'TTS 合成失败（不重试本次，§11）', {
            utteranceId: session.utteranceId,
            reason: result.reason,
            detail: result.detail ?? null,
          });
          finish(session, 'failed');
          return;
        }

        session.phase = 'waiting-start';
        const delivered = deps.bus.sendCommand(IPC_CHANNELS.voice, {
          kind: 'speak',
          utteranceId: session.utteranceId,
          audio: result.audio,
          mime: result.mime,
        });
        if (!delivered) {
          log('warn', '没有可用的渲染窗口，语音无法播放（§11）', {
            utteranceId: session.utteranceId,
          });
          finish(session, 'failed');
          return;
        }
        log('info', '已下发音频，等待渲染侧首帧', {
          utteranceId: session.utteranceId,
          bytes: result.audio.byteLength,
        });
      } catch (error) {
        if (session.terminal) return;
        log('warn', '语音链路异常（speak 永不 reject，折算为 failed）', String(error));
        finish(session, 'failed');
      }
    })();
  }

  return {
    speak(text: string, utteranceId: string): Promise<SpeechOutcome> {
      const length = [...text].length;
      if (length > SPEECH_TEXT_MAX_CHARS) {
        // §7.4：>120 字直接 failed，不截断、不发 HTTP；且不影响在途语音
        log('warn', `文本 ${length} 字超过 ${SPEECH_TEXT_MAX_CHARS}，直接 failed（§7.4）`, { utteranceId });
        deps.bus.emit('speech_ended', { utteranceId, reason: 'failed', durationMs: 0 });
        return Promise.resolve('failed');
      }

      // 同一时刻只允许一个在途语音：新的 speak 先以 interrupted 结束旧的（§7.4）
      if (active) {
        const previous = active;
        deps.bus.sendCommand(IPC_CHANNELS.voice, {
          kind: 'stop',
          utteranceId: previous.utteranceId,
        });
        finish(previous, 'interrupted');
      }

      let resolveFn!: (outcome: SpeechOutcome) => void;
      const promise = new Promise<SpeechOutcome>((resolve) => {
        resolveFn = resolve;
      });
      const session: Session = {
        utteranceId,
        text,
        phase: 'idle',
        resolve: resolveFn,
        terminal: false,
        startedAt: now(),
        playbackStartedAt: null,
        synthesis: null,
      };
      active = session;
      synthesizeAndDispatch(session);
      return promise;
    },

    stopSpeaking(_reason: 'interrupt' | 'shutdown' = 'interrupt'): void {
      const session = active;
      if (!session || session.terminal) return; // 幂等：无在途语音时为空操作
      deps.bus.sendCommand(IPC_CHANNELS.voice, {
        kind: 'stop',
        utteranceId: session.utteranceId,
      });
      finish(session, 'interrupted');
    },

    handleSpeechReport(report: SpeechReport): void {
      const session = active;
      if (!session || session.terminal) return;
      if (!report || report.utteranceId !== session.utteranceId) return;

      if (report.phase === 'started') {
        if (session.playbackStartedAt !== null) return;
        session.playbackStartedAt = now();
        session.phase = 'playing';
        // §6.3：首帧开始播放的同一帧（上报到达即视为同一帧，ADR 0015 D3）
        deps.bus.emit('speech_started', {
          utteranceId: session.utteranceId,
          text: session.text,
        });
        log('info', 'speech_started', { utteranceId: session.utteranceId });
        return;
      }

      if (report.reason === 'completed') {
        finish(session, 'completed');
        return;
      }

      log('warn', '渲染侧播放失败', {
        utteranceId: session.utteranceId,
        durationMs: report.durationMs,
        detail: report.detail ?? null,
      });
      finish(session, 'failed');
    },

    snapshot(): VoiceSnapshot {
      return {
        phase: active?.phase ?? 'idle',
        activeUtteranceId: active?.utteranceId ?? null,
        enabled: deps.tts.enabled,
        disabledReason: deps.tts.disabledReason,
      };
    },

    dispose(): void {
      if (!active) return;
      finish(active, 'interrupted');
    },
  };
}
