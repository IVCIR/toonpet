/**
 * GPT-SoVITS `api_v2.py` 的本机客户端（ADR 0015 D2）。
 *
 * 只发一次 POST /tts，取 `audio/wav` 字节；三种超时语义：
 * - 首字节（响应头）超时 → `timeout`；
 * - 整段（响应体读完）超时 → `timeout`；
 * - 外部取消（打断）→ `aborted`。
 *
 * **不做重试**（§11：TTS 失败不重试本次）；不解析 PCM、不计算包络（§7.4：包络只在渲染进程）。
 */
import { existsSync } from 'node:fs';
import {
  TTS_SPEED_FACTOR,
  TTS_TEXT_SPLIT_METHOD,
} from '../../shared/constants';
import type { TtsConfig } from '../config';

export type TtsFailureReason = 'disabled' | 'unavailable' | 'timeout' | 'http' | 'invalid_audio' | 'aborted';

export type TtsResult =
  | { ok: true; audio: ArrayBuffer; mime: 'audio/wav' }
  | { ok: false; reason: TtsFailureReason; detail?: string };

export interface TtsClient {
  readonly baseUrl: string;
  /** 参考音频与提示文本是否齐备（缺一即不可用，不发起 HTTP） */
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  synthesize(text: string, options?: { signal?: AbortSignal }): Promise<TtsResult>;
}

export interface TtsClientOptions {
  /** 测试可注入：默认 `existsSync` */
  exists?: (path: string) => boolean;
}

function isWav(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 44) return false;
  const view = new DataView(bytes);
  const tag = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * `custom:` 段未写 v2ProPlus 时 api_v2 会静默回退到 v2 底座（ADR 0015 D2.2）。
 * 客户端无法从 HTTP 层识别"音色对不对"，只能把已知的部署前提写进启动日志。
 */
export function createTtsClient(config: TtsConfig, options: TtsClientOptions = {}): TtsClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const exists = options.exists ?? existsSync;
  const refAudioExists = config.refAudioPath !== '' && exists(config.refAudioPath);
  const missing: string[] = [];
  if (!refAudioExists) missing.push(`参考音频不存在：${config.refAudioPath}`);
  if (config.promptText.trim() === '') missing.push('PET_TTS_PROMPT_TEXT 为空');
  const enabled = missing.length === 0;

  return {
    baseUrl,
    enabled,
    disabledReason: enabled ? null : missing.join('；'),

    async synthesize(text: string, options?: { signal?: AbortSignal }): Promise<TtsResult> {
      if (!enabled) {
        return { ok: false, reason: 'disabled', detail: missing.join('；') };
      }

      const controller = new AbortController();
      let cause: 'first-byte' | 'total' | 'aborted' | null = null;

      const firstByteTimer = setTimeout(() => {
        cause = 'first-byte';
        controller.abort();
      }, config.firstByteTimeoutMs);
      const totalTimer = setTimeout(() => {
        cause = 'total';
        controller.abort();
      }, config.totalTimeoutMs);

      const external = options?.signal;
      const onExternalAbort = (): void => {
        cause = 'aborted';
        controller.abort();
      };
      if (external) {
        if (external.aborted) onExternalAbort();
        else external.addEventListener('abort', onExternalAbort, { once: true });
      }

      try {
        const response = await fetch(`${baseUrl}/tts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'audio/wav' },
          signal: controller.signal,
          redirect: 'error',
          // 语种必须来自 TtsConfig（ADR 0019）：
          // - prompt_lang = 参考音频/参考文本的语种（本机凯伊音频是日文 → ja）
          // - text_lang   = 要合成的回复文本语种（角色说中文 → zh）
          // v2ProPlus 支持跨语种（日文参考 + 中文合成），这里不得写死 zh。
          body: JSON.stringify({
            text,
            text_lang: config.textLang,
            ref_audio_path: config.refAudioPath,
            prompt_text: config.promptText,
            prompt_lang: config.promptLang,
            text_split_method: TTS_TEXT_SPLIT_METHOD,
            batch_size: 1,
            speed_factor: TTS_SPEED_FACTOR,
            temperature: 1,
            top_k: 15,
            top_p: 1,
            repetition_penalty: 1.35,
            streaming_mode: false,
            media_type: 'wav',
          }),
        });

        // 响应头已到：首字节预算到此为止
        clearTimeout(firstByteTimer);

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            ok: false,
            reason: 'http',
            detail: `HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ''}`,
          };
        }

        const audio = await response.arrayBuffer();
        clearTimeout(totalTimer);
        if (!isWav(audio)) {
          return { ok: false, reason: 'invalid_audio', detail: `返回 ${audio.byteLength} 字节，但不是 RIFF/WAVE` };
        }
        return { ok: true, audio, mime: 'audio/wav' };
      } catch (error) {
        if (cause === 'aborted') return { ok: false, reason: 'aborted', detail: '被 stopSpeaking 中止' };
        if (cause === 'first-byte') {
          return {
            ok: false,
            reason: 'timeout',
            detail: `首字节超过 ${config.firstByteTimeoutMs}ms`,
          };
        }
        if (cause === 'total') {
          return { ok: false, reason: 'timeout', detail: `整段超过 ${config.totalTimeoutMs}ms` };
        }
        return { ok: false, reason: 'unavailable', detail: describeError(error) };
      } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        external?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}
