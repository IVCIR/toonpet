/**
 * Ollama 本地 LLM 客户端（ADR 0015 D1；ADR 0032 D3 增补 `warmup`）。
 *
 * 只做四件事：健康检查（`/api/tags`，一次失败即本会话熔断）、单次对话（`/api/chat`，8s 硬超时）、
 * 冷启动预热（`/api/generate`，1 token，不参与任何预算与熔断）、
 * 把失败原因翻译成契约 §6.3 的 `llm_failed.reason` 四值。不做重试、不 pull 模型、不流式。
 */
import {
  LLM_MAX_PREDICT,
  LLM_TEMPERATURE,
  LLM_WARMUP_NUM_PREDICT,
  LLM_WARMUP_TIMEOUT_MS,
} from '../../shared/constants';
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

/**
 * 预热结果（ADR 0032 D3）。与 `LlmHealth` 分开是刻意的：
 * 预热**不是**健康检查，它的成功/失败都不得改变 §11 的熔断状态（ADR 0031 D4.1）。
 */
export type LlmWarmupResult =
  | { ok: true; loadMs: number }
  | { ok: false; reason: 'unavailable' | 'timeout' | 'error'; detail?: string };

export interface LlmChatRequest {
  messages: ChatMessage[];
  /** 本次调用的剩余预算（§12 thinking 上限 8s 扣掉健康检查耗时）；缺省用配置值 */
  timeoutMs?: number;
  /** 外部取消（orchestrator.cancel） */
  signal?: AbortSignal;
}

export interface LlmWarmupRequest {
  /** 覆盖默认的 `LLM_WARMUP_TIMEOUT_MS`（单测压时用；生产路径不传） */
  timeoutMs?: number;
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
  /**
   * 冷启动预热（ADR 0032 D3）：让本地模型把权重读进内存，**不**产生回复、**不**改熔断状态、
   * **不**占用 thinking/预算。可选方法：测试桩不实现它时，orchestrator 自然跳过预热。
   */
  warmup?(request?: LlmWarmupRequest): Promise<LlmWarmupResult>;
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

    /**
     * 冷启动预热（ADR 0032 D3）：`/api/generate` 只生成 1 个 token。
     *
     * 为什么不用 `/api/tags` 做预热：它只列出模型，**不加载权重**，预热等于没做。
     * 为什么不用 `/api/chat`：那条路径会走 §9.2 校验与 §6.3 的 `llm_failed`，而预热
     * 既不该发事件、也不该被当成"用户触发的对话"。
     *
     * 不设 `keep_alive`：模型常驻时长交给 Ollama 自己的默认值（当前 5 分钟），
     * 由用户在 `OLLAMA_KEEP_ALIVE` 里决定要不要更长——应用不偷偷改外部服务的资源策略。
     */
    async warmup(request: LlmWarmupRequest = {}): Promise<LlmWarmupResult> {
      const timeoutMs = request.timeoutMs ?? LLM_WARMUP_TIMEOUT_MS;
      const startedAt = Date.now();
      const deadline = withDeadline(timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          signal: deadline.signal,
          redirect: 'error',
          body: JSON.stringify({
            model: config.model,
            prompt: 'hi',
            stream: false,
            think: false,
            options: { num_predict: LLM_WARMUP_NUM_PREDICT },
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

        // 必须把 body 读完：权重是在这段 body 到达前才真正加载完的
        await response.json().catch(() => undefined);
        return { ok: true, loadMs: Date.now() - startedAt };
      } catch (error) {
        if (deadline.cause() === 'timeout') {
          return { ok: false, reason: 'timeout', detail: `预热超过 ${timeoutMs}ms` };
        }
        return { ok: false, reason: 'unavailable', detail: describeError(error) };
      } finally {
        deadline.cleanup();
      }
    },

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
