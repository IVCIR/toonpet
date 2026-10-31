/**
 * Ollama 本地 LLM 客户端（ADR 0015 D1）。
 *
 * 只做三件事：健康检查（`/api/tags`，一次失败即本会话熔断）、单次对话（`/api/chat`，8s 硬超时）、
 * 把失败原因翻译成契约 §6.3 的 `llm_failed.reason` 四值。不做重试、不 pull 模型、不流式。
 */
import { LLM_MAX_PREDICT, LLM_TEMPERATURE } from '../../shared/constants';
import type { LlmConfig } from '../config';
import type { ChatMessage } from './prompt';

export type LlmFailureReason = 'unavailable' | 'timeout' | 'aborted' | 'error';

export interface LlmHealth {
  ok: boolean;
  model?: string;
  reason?: 'unavailable' | 'timeout';
  detail?: string;
  models?: string[];
}

export interface LlmChatRequest {
  messages: ChatMessage[];
  /** 本次调用的剩余预算（§12 thinking 上限 8s 扣掉健康检查耗时）；缺省用配置值 */
  timeoutMs?: number;
  /** 外部取消（orchestrator.cancel） */
  signal?: AbortSignal;
}

export type LlmChatResult =
  | { ok: true; content: string }
  | { ok: false; reason: LlmFailureReason; detail?: string };

export interface LlmClient {
  readonly model: string;
  readonly baseUrl: string;
  /** §9.1 硬超时（用于扣减 thinking 预算） */
  readonly requestTimeoutMs: number;
  health(): Promise<LlmHealth>;
  chat(request: LlmChatRequest): Promise<LlmChatResult>;
}

interface Deadline {
  signal: AbortSignal;
  cause(): 'timeout' | 'aborted' | null;
  cleanup(): void;
}

function withDeadline(timeoutMs: number, external?: AbortSignal): Deadline {
  const controller = new AbortController();
  let cause: 'timeout' | 'aborted' | null = null;
  const timer = setTimeout(() => {
    cause = 'timeout';
    controller.abort();
  }, Math.max(1, timeoutMs));

  const onAbort = (): void => {
    cause = 'aborted';
    controller.abort();
  };
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cause: () => cause,
    cleanup(): void {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 模型名匹配：只接受精确名，以及 `<name>:latest` 与裸名互相等价。
 * 不做前缀匹配——配置 `qwen3` 而本地只有 `qwen3:4b` 时，chat 会 404，宁可健康检查就判不可用。
 */
export function modelNameMatches(configured: string, installed: string): boolean {
  if (configured === installed) return true;
  if (installed === `${configured}:latest`) return true;
  if (configured === `${installed}:latest`) return true;
  return false;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function createLlmClient(config: LlmConfig): LlmClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');

  return {
    model: config.model,
    baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,

    async health(): Promise<LlmHealth> {
      const deadline = withDeadline(config.healthTimeoutMs);
      try {
        const response = await fetch(`${baseUrl}/api/tags`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: deadline.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          return { ok: false, reason: 'unavailable', detail: `HTTP ${response.status}` };
        }
        const data = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
        const models = (data.models ?? [])
          .map((entry) => (typeof entry.name === 'string' ? entry.name : entry.model))
          .filter((name): name is string => typeof name === 'string');
        if (!models.some((name) => modelNameMatches(config.model, name))) {
          return {
            ok: false,
            reason: 'unavailable',
            detail: `模型 ${config.model} 不在 /api/tags`,
            models,
          };
        }
        return { ok: true, model: config.model, models };
      } catch (error) {
        if (deadline.cause() === 'timeout') {
          return { ok: false, reason: 'timeout', detail: `健康检查超过 ${config.healthTimeoutMs}ms` };
        }
        return { ok: false, reason: 'unavailable', detail: describeError(error) };
      } finally {
        deadline.cleanup();
      }
    },

    async chat(request: LlmChatRequest): Promise<LlmChatResult> {
      const deadline = withDeadline(request.timeoutMs ?? config.requestTimeoutMs, request.signal);
      try {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          signal: deadline.signal,
          redirect: 'error',
          body: JSON.stringify({
            model: config.model,
            messages: request.messages,
            stream: false,
            format: 'json',
            // qwen3 是混合推理模型：不关思维链时 token 会被推理吃光，JSON 容易被截断
            think: false,
            options: {
              temperature: LLM_TEMPERATURE,
              num_predict: LLM_MAX_PREDICT,
            },
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return {
            ok: false,
            reason: 'error',
            detail: `HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`,
          };
        }

        const data = (await response.json()) as { message?: { content?: unknown } };
        const content = data.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          return { ok: false, reason: 'error', detail: 'message.content 为空或不是字符串' };
        }
        return { ok: true, content };
      } catch (error) {
        const cause = deadline.cause();
        if (cause === 'timeout') {
          return { ok: false, reason: 'timeout', detail: `超过 ${request.timeoutMs ?? config.requestTimeoutMs}ms` };
        }
        if (cause === 'aborted') {
          return { ok: false, reason: 'aborted', detail: '被 orchestrator.cancel() 中止' };
        }
        return { ok: false, reason: 'unavailable', detail: describeError(error) };
      } finally {
        deadline.cleanup();
      }
    },
  };
}
