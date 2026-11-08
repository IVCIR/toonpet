/**
 * LLM 提供商客户端（ADR 0015 D1；ADR 0055 提供商抽象）。
 *
 * 三种实现共用同一份 `LlmClient` 端口（orchestrator / heartbeat 只认这个端口）：
 * - `OllamaProvider`：本地 `/api/tags` + `/api/chat` + `/api/generate`（保持 ADR 0015/0032 行为）；
 * - `OpenAIProvider`：任意 OpenAI 兼容端点（`/chat/completions` + `/models`）；
 * - `OpenCodeGoProvider`：`OpenAIProvider` 的预设（固定 `https://opencode.ai/inference/go/openai/v1`）。
 *
 * 不做重试、不流式、不 pull 模型；失败原因仍翻译成契约 §6.3 的四值。
 */
import { randomUUID } from 'node:crypto';
import {
  LLM_MAX_PREDICT,
  LLM_MODEL_LIST_LOCAL_TIMEOUT_MS,
  LLM_MODEL_LIST_MAX_OPTIONS,
  LLM_MODEL_LIST_REMOTE_TIMEOUT_MS,
  LLM_TEMPERATURE,
  LLM_WARMUP_NUM_PREDICT,
  LLM_WARMUP_TIMEOUT_MS,
} from '../../shared/constants';
import {
  OPENCODE_GO_BASE_URL,
  type LlmModelListResult,
  type LlmModelOption,
  type LlmProviderConfig,
  type LlmProviderType,
} from '../../shared/llm-providers';
import type { LlmConfig } from '../config';
import type { ChatMessage } from './prompt';

export type LlmFailureReason = 'unavailable' | 'timeout' | 'aborted' | 'error';

export interface LlmHealth {
  ok: boolean;
  model?: string;
  reason?: 'unavailable' | 'timeout';
  detail?: string;
  models?: string[];
  /** 服务本身可达（即使模型不在清单里也是 true）；用于把"没起来"与"缺模型"分开 */
  reachable?: boolean;
  /** 模型是否出现在服务端清单里（端点不提供清单时为 `null`） */
  modelPresent?: boolean | null;
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

/** `fetchModels` 的可选预算；缺省由各提供商给默认值（本地 3s / 远程 8s）。 */
export interface LlmModelListRequest {
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

/**
 * 提供商 = `LlmClient` + 身份（ADR 0055 D1）。
 *
 * orchestrator / heartbeat 仍然只依赖 `LlmClient`；面板与日志靠多出来的三个字段
 * 说清"现在用的是谁"，而不必去猜 baseUrl。
 */
export interface LLMProvider extends LlmClient {
  readonly providerId: string;
  readonly providerType: LlmProviderType;
  readonly providerName: string;
  /**
   * 拉取服务端可用模型清单（ADR 0056）。
   *
   * - Ollama：`GET /api/tags`（与健康检查同一端点，但不要求当前模型在清单里）；
   * - OpenAI 兼容：`GET {base}/models`；
   * - OpenCode Go：固定端点 `GET {预设}/models`，带 `Authorization: Bearer <Key>`
   *   与 `x-opencode-session`。
   *
   * **只读**：不改熔断、不发事件、不写盘、不重试；失败只回一句人话。
   */
  fetchModels(request?: LlmModelListRequest): Promise<LlmModelListResult>;
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

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ollama `/api/tags` 的模型名清单（ADR 0056 复用 ADR 0015 的解析口径）。
 * `name` 优先，旧版 Ollama 只有 `model`；空值/重复项跳过。
 */
export function readOllamaModelNames(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const models = payload['models'];
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const raw = typeof entry['name'] === 'string' ? entry['name'] : entry['model'];
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name === '' || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * OpenAI 兼容 `/models` 的清单（ADR 0056）。
 *
 * 兼容三种常见形态：`{data:[{id,name,display_name}]}`、`{models:[...]}`、以及纯字符串数组。
 * `id` 是发给端点的模型名，`name` 是展示名；缺展示名时等于 id。
 */
export function readOpenAiModelOptions(payload: unknown): LlmModelOption[] {
  const entries = isRecord(payload)
    ? Array.isArray(payload['data'])
      ? payload['data']
      : Array.isArray(payload['models'])
        ? payload['models']
        : []
    : [];
  const options: LlmModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let id: string | null = null;
    let name: string | null = null;
    if (typeof entry === 'string') {
      id = entry;
      name = entry;
    } else if (isRecord(entry)) {
      if (typeof entry['id'] === 'string') id = entry['id'];
      if (typeof entry['display_name'] === 'string') name = entry['display_name'];
      else if (typeof entry['name'] === 'string') name = entry['name'];
      if (id === null && name !== null) id = name;
    }
    if (id === null) continue;
    const trimmedId = id.trim();
    if (trimmedId === '' || seen.has(trimmedId)) continue;
    seen.add(trimmedId);
    const display = name === null ? '' : name.trim();
    options.push({ id: trimmedId, name: display === '' ? trimmedId : display });
  }
  return options;
}

/** 把模型清单限制在契约上限内；空 id 跳过。 */
export function limitModelOptions(models: readonly LlmModelOption[]): LlmModelOption[] {
  const out: LlmModelOption[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = model.id.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const name = model.name.trim() === '' ? id : model.name.trim();
    out.push({ id, name });
    if (out.length >= LLM_MODEL_LIST_MAX_OPTIONS) break;
  }
  return out;
}

/** 统一的超时/取消映射，三种提供商共用（Ollama 沿用）。 */
function mapFailure(
  deadline: Deadline,
  error: unknown,
  timeoutMs: number,
  abortDetail = '被 orchestrator.cancel() 中止',
): { ok: false; reason: LlmFailureReason; detail: string } {
  const cause = deadline.cause();
  if (cause === 'timeout') return { ok: false, reason: 'timeout', detail: `超过 ${timeoutMs}ms` };
  if (cause === 'aborted') return { ok: false, reason: 'aborted', detail: abortDetail };
  return { ok: false, reason: 'unavailable', detail: describeError(error) };
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

/** Ollama 的 `LlmConfig`（沿用 ADR 0015 的字段名）。 */
export interface OllamaProviderOptions {
  id?: string;
  name?: string;
  healthTimeoutMs?: number;
}

export function createOllamaProvider(
  config: LlmConfig,
  options: OllamaProviderOptions = {},
): LLMProvider {
  const baseUrl = trimBaseUrl(config.baseUrl);

  return {
    providerId: options.id ?? 'local-ollama',
    providerType: 'ollama',
    providerName: options.name ?? '本地 Ollama',
    model: config.model,
    baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,

    /**
     * 冷启动预热（ADR 0032 D3）：`/api/generate` 只生成 1 个 token。
     *
     * 为什么不用 `/api/tags` 做预热：它只列出模型，**不加载权重**，预热等于没做。
     * 为什么不用 `/api/chat`：那条路径会走 §9.2 校验与 §6.3 的 `llm_failed`，而预热
     * 既不该发事件、也不该被当成"用户触发的对话"。
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

    /**
     * 拉取本地模型清单（ADR 0056）：`GET /api/tags`。
     *
     * 与 `health()` 的区别：不要求当前配置的模型在清单里——用户正要换模型时，
     * "当前模型不存在"不该阻止他看到有哪些模型可选。
     */
    async fetchModels(request: LlmModelListRequest = {}): Promise<LlmModelListResult> {
      const timeoutMs = request.timeoutMs ?? LLM_MODEL_LIST_LOCAL_TIMEOUT_MS;
      const deadline = withDeadline(timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/api/tags`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: deadline.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          return { ok: false, error: `HTTP ${response.status}` };
        }
        const payload = (await response.json().catch(() => null)) as unknown;
        const names = readOllamaModelNames(payload);
        return {
          ok: true,
          models: limitModelOptions(names.map((name) => ({ id: name, name }))),
        };
      } catch (error) {
        if (deadline.cause() === 'timeout') {
          return { ok: false, error: `请求超时（>${timeoutMs}ms）` };
        }
        return { ok: false, error: describeError(error) };
      } finally {
        deadline.cleanup();
      }
    },

    async health(): Promise<LlmHealth> {
      const healthTimeoutMs = options.healthTimeoutMs ?? config.healthTimeoutMs;
      const deadline = withDeadline(healthTimeoutMs);
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
        const present = models.some((name) => modelNameMatches(config.model, name));
        if (!present) {
          return {
            ok: false,
            reason: 'unavailable',
            detail: `模型 ${config.model} 不在 /api/tags`,
            models,
            reachable: true,
            modelPresent: false,
          };
        }
        return { ok: true, model: config.model, models, reachable: true, modelPresent: true };
      } catch (error) {
        if (deadline.cause() === 'timeout') {
          return {
            ok: false,
            reason: 'timeout',
            detail: `健康检查超过 ${healthTimeoutMs}ms`,
            reachable: false,
            modelPresent: false,
          };
        }
        return {
          ok: false,
          reason: 'unavailable',
          detail: describeError(error),
          reachable: false,
          modelPresent: false,
        };
      } finally {
        deadline.cleanup();
      }
    },

    async chat(request: LlmChatRequest): Promise<LlmChatResult> {
      const timeoutMs = request.timeoutMs ?? config.requestTimeoutMs;
      const deadline = withDeadline(timeoutMs, request.signal);
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
        return mapFailure(deadline, error, timeoutMs) as LlmChatResult;
      } finally {
        deadline.cleanup();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI 兼容 / OpenCode Go
// ---------------------------------------------------------------------------

export interface OpenAiProviderOptions {
  healthTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** OpenAI 的 `message.content` 可能是字符串，也可能是分段数组。 */
function readOpenAiContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message === 'object' && message !== null) {
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (typeof part === 'string') parts.push(part);
        else if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>)['text'];
          if (typeof text === 'string') parts.push(text);
        }
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }
  }
  // 少数兼容实现把文本放在 choices[0].text
  const text = (first as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : null;
}

function openAiHeaders(
  apiKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'KaiyiDesktopPet/3.0.0',
    ...extra,
  };
  if (apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`;
  return headers;
}

export function createOpenAiProvider(
  provider: LlmProviderConfig,
  options: OpenAiProviderOptions = {},
): LLMProvider {
  const baseUrl = trimBaseUrl(
    provider.type === 'opencode-go' ? OPENCODE_GO_BASE_URL : provider.baseUrl,
  );
  const healthTimeoutMs = options.healthTimeoutMs ?? 1500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15000;
  // OpenCode Go 要求每次请求带稳定会话 id（控制台按会话路由/复用 prompt cache）。
  const extraHeaders: Record<string, string> =
    provider.type === 'opencode-go'
      ? { 'x-opencode-session': `ses_${randomUUID().replace(/-/g, '')}` }
      : {};

  async function chatOnce(request: LlmChatRequest): Promise<LlmChatResult> {
    const timeoutMs = request.timeoutMs ?? requestTimeoutMs;
    const deadline = withDeadline(timeoutMs, request.signal);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: openAiHeaders(provider.apiKey, extraHeaders),
        signal: deadline.signal,
        redirect: 'error',
        body: JSON.stringify({
          model: provider.model,
          messages: request.messages,
          stream: false,
          temperature: LLM_TEMPERATURE,
          max_tokens: LLM_MAX_PREDICT,
          response_format: { type: 'json_object' },
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

      const payload = (await response.json()) as unknown;
      const content = readOpenAiContent(payload);
      if (content === null || content.trim() === '') {
        return { ok: false, reason: 'error', detail: 'choices[0].message.content 为空' };
      }
      return { ok: true, content };
    } catch (error) {
      return mapFailure(deadline, error, timeoutMs) as LlmChatResult;
    } finally {
      deadline.cleanup();
    }
  }

  return {
    providerId: provider.id,
    providerType: provider.type,
    providerName: provider.name,
    model: provider.model,
    baseUrl,
    requestTimeoutMs,

    async health(): Promise<LlmHealth> {
      const deadline = withDeadline(healthTimeoutMs);
      try {
        const response = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: openAiHeaders(provider.apiKey, extraHeaders),
          signal: deadline.signal,
          redirect: 'error',
        });
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            reason: 'unavailable',
            detail: `HTTP ${response.status}（API Key 可能无效）`,
            reachable: true,
            modelPresent: false,
          };
        }
        if (response.status === 404 || response.status === 405) {
          // 有些兼容端点不提供 /models：退化为一次 1-token 对话，验证 Key 与网络
          const probe = await chatOnce({
            messages: [{ role: 'user', content: 'ping' }],
            timeoutMs: healthTimeoutMs,
          });
          if (probe.ok) {
            return {
              ok: true,
              model: provider.model,
              reachable: true,
              modelPresent: null,
              detail: '端点可达（无 /models）',
            };
          }
          return {
            ok: false,
            reason: probe.reason === 'timeout' ? 'timeout' : 'unavailable',
            detail: probe.detail,
            reachable: false,
            modelPresent: null,
          };
        }
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return {
            ok: false,
            reason: 'unavailable',
            detail: `HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`,
            reachable: true,
            modelPresent: false,
          };
        }
        const payload = (await response.json().catch(() => null)) as unknown;
        const data =
          typeof payload === 'object' && payload !== null
            ? ((payload as Record<string, unknown>)['data'] as unknown)
            : null;
        const models = Array.isArray(data)
          ? data
              .map((entry) =>
                typeof entry === 'object' && entry !== null
                  ? (entry as Record<string, unknown>)['id']
                  : null,
              )
              .filter((id): id is string => typeof id === 'string')
          : [];
        const present = models.length === 0 ? null : models.includes(provider.model);
        return {
          ok: true,
          model: provider.model,
          models,
          reachable: true,
          modelPresent: present,
        };
      } catch (error) {
        if (deadline.cause() === 'timeout') {
          return {
            ok: false,
            reason: 'timeout',
            detail: `健康检查超过 ${healthTimeoutMs}ms`,
            reachable: false,
            modelPresent: false,
          };
        }
        return {
          ok: false,
          reason: 'unavailable',
          detail: describeError(error),
          reachable: false,
          modelPresent: false,
        };
      } finally {
        deadline.cleanup();
      }
    },

    /**
     * 拉取模型清单（ADR 0056）：`GET {base}/models`。
     *
     * OpenCode Go 走同一实现（baseUrl 已被构造器钉死为预设），额外带
     * `x-opencode-session`；Bearer 由 `openAiHeaders` 统一注入。
     */
    async fetchModels(request: LlmModelListRequest = {}): Promise<LlmModelListResult> {
      const timeoutMs = request.timeoutMs ?? LLM_MODEL_LIST_REMOTE_TIMEOUT_MS;
      const deadline = withDeadline(timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: openAiHeaders(provider.apiKey, extraHeaders),
          signal: deadline.signal,
          redirect: 'error',
        });
        if (response.status === 401 || response.status === 403) {
          return { ok: false, error: `HTTP ${response.status}（API Key 可能无效）` };
        }
        if (response.status === 404 || response.status === 405) {
          return { ok: false, error: `HTTP ${response.status}（端点不提供 /models）` };
        }
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return {
            ok: false,
            error: `HTTP ${response.status}${text ? ` ${text.slice(0, 160)}` : ''}`,
          };
        }
        const payload = (await response.json().catch(() => null)) as unknown;
        return { ok: true, models: limitModelOptions(readOpenAiModelOptions(payload)) };
      } catch (error) {
        if (deadline.cause() === 'timeout') {
          return { ok: false, error: `请求超时（>${timeoutMs}ms）` };
        }
        return { ok: false, error: describeError(error) };
      } finally {
        deadline.cleanup();
      }
    },

    chat: chatOnce,
  };
}

/** 按类型创建提供商客户端（ADR 0055 的唯一分发点）。 */
export function createLlmProvider(
  provider: LlmProviderConfig,
  options: OpenAiProviderOptions & { ollama?: OllamaProviderOptions } = {},
): LLMProvider {
  if (provider.type === 'ollama') {
    return createOllamaProvider(
      {
        baseUrl: provider.baseUrl,
        model: provider.model,
        healthTimeoutMs: options.healthTimeoutMs ?? 1500,
        requestTimeoutMs: options.requestTimeoutMs ?? 8000,
      },
      { ...options.ollama, id: provider.id, name: provider.name },
    );
  }
  return createOpenAiProvider(provider, options);
}

/**
 * 兼容旧调用点（ADR 0015/0032/0053）：默认就是本地 Ollama。
 * 新代码请用 `createLlmProvider`。
 */
export function createLlmClient(config: LlmConfig): LlmClient {
  return createOllamaProvider(config);
}
