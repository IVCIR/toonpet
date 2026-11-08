/**
 * 动态模型列表（ADR 0056）。
 *
 * 职责只有四件，全部在**主进程**：
 * 1. 校验面板发来的 `{type, baseUrl, apiKey?, providerId?}`；
 * 2. **安全地**决定用哪个 Key：用户刚输入的优先；留空时才尝试沿用已保存的 Key，
 *    且必须 `type` 与**归一化后的 baseUrl** 都与保存项一致——否则拒绝复用
 *    （防止把 OpenCode Go 的 Key 发到一个被改写的地址上）；
 * 3. 对同一个配置做 **2s 节流 + 单飞**，成功/失败结果短暂缓存；
 * 4. 把提供商客户端的 `fetchModels()` 结果整理成 `{ ok, models }` / `{ ok, error }`。
 *
 * 它**不**建 Electron 对象、不读 `config.json`、不写日志、不发事件；网络调用由注入的
 * `fetchModels` 完成，因此可以在 Node 单测里用假时钟与假客户端跑完整逻辑。
 */
import {
  LLM_MODEL_LIST_CACHE_TTL_MS,
  LLM_MODEL_LIST_LOCAL_TIMEOUT_MS,
  LLM_MODEL_LIST_MAX_OPTIONS,
  LLM_MODEL_LIST_REMOTE_TIMEOUT_MS,
  LLM_MODEL_LIST_THROTTLE_MS,
} from '../shared/constants';
import {
  LLM_PROVIDER_TYPES,
  LOCAL_OLLAMA_DEFAULT_MODEL,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DEFAULT_MODEL,
  isLoopbackHostForProvider,
  validateProviderApiKey,
  validateProviderBaseUrl,
  type LlmModelListResult,
  type LlmModelOption,
  type LlmProviderConfig,
  type LlmProviderType,
} from '../shared/llm-providers';
import type { PanelFetchModelsRequest, PanelFetchModelsResult } from '../shared/panel';

export interface ModelListDeps {
  /** 已保存的提供商（**含 Key**，只在主进程内存里）；用于"留空沿用旧 Key" */
  savedProviders: () => readonly LlmProviderConfig[];
  /** 用临时客户端拉取；`timeoutMs` 已按本地/远程选好 */
  fetchModels: (provider: LlmProviderConfig, timeoutMs: number) => Promise<LlmModelListResult>;
  /** 可注入时钟（单测）；缺省 `Date.now` */
  now?: () => number;
  /** 节流窗口（ms）；缺省契约常量 */
  throttleMs?: number;
}

export interface ModelListService {
  fetch(input: unknown): Promise<PanelFetchModelsResult>;
  /** 清空节流缓存（runtime.stop / 单测） */
  clear(): void;
}

interface CachedResult {
  at: number;
  result: PanelFetchModelsResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderType(value: unknown): value is LlmProviderType {
  return typeof value === 'string' && (LLM_PROVIDER_TYPES as readonly string[]).includes(value);
}

/** 面板没给 type 时按地址推断：OpenCode Go 预设 → opencode-go；回环 → ollama；其余 → openai。 */
export function inferProviderType(baseUrl: string): LlmProviderType {
  const value = baseUrl.trim().replace(/\/+$/, '');
  if (value === OPENCODE_GO_BASE_URL) return 'opencode-go';
  try {
    const url = new URL(value);
    return isLoopbackHostForProvider(url.hostname) ? 'ollama' : 'openai';
  } catch {
    return 'openai';
  }
}

/** 默认模型只用于构造临时客户端（`fetchModels` 不会读它）。 */
function defaultModelFor(type: LlmProviderType): string {
  if (type === 'ollama') return LOCAL_OLLAMA_DEFAULT_MODEL;
  if (type === 'opencode-go') return OPENCODE_GO_DEFAULT_MODEL;
  return 'gpt-4o-mini';
}

/**
 * Key 指纹：只用于节流键，**不是**哈希也不是脱敏展示。
 * 长度 + 末 4 位足以区分"用户换了 Key"，又不会把明文带进任何日志/缓存键。
 */
export function modelListKeyFingerprint(apiKey: string): string {
  if (apiKey === '') return 'none';
  return `${apiKey.length}:${apiKey.slice(-4)}`;
}

function normalizeModels(models: readonly LlmModelOption[]): LlmModelOption[] {
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

interface ResolvedTarget {
  provider: LlmProviderConfig;
  timeoutMs: number;
  throttleKey: string;
}

type ResolveResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; error: string };

/**
 * 纯解析：把不可信请求变成"要请求谁、用哪个 Key、节流键是什么"。
 * 导出只为单测（不跨进程暴露）。
 */
export function resolveModelListTarget(
  input: unknown,
  savedProviders: readonly LlmProviderConfig[],
): ResolveResult {
  if (!isRecord(input)) return { ok: false, error: '请求格式非法' };
  const rawBaseUrl = input['baseUrl'];
  if (typeof rawBaseUrl !== 'string' || rawBaseUrl.trim() === '') {
    return { ok: false, error: 'Base URL 不能为空' };
  }
  const rawType = input['type'];
  const type = isProviderType(rawType) ? rawType : inferProviderType(rawBaseUrl);

  const baseUrl = validateProviderBaseUrl(type, rawBaseUrl);
  if (!baseUrl.ok || baseUrl.value === null) {
    return { ok: false, error: baseUrl.error ?? 'Base URL 不合法' };
  }

  const key = validateProviderApiKey(input['apiKey'] ?? '');
  if (!key.ok) return { ok: false, error: key.error ?? 'API Key 不合法' };
  let apiKey = key.value ?? '';

  const rawProviderId = input['providerId'];
  const providerId = typeof rawProviderId === 'string' ? rawProviderId : '';
  const saved =
    providerId === '' ? null : (savedProviders.find((entry) => entry.id === providerId) ?? null);

  // 留空沿用旧 Key 的三重条件：同一提供商、同一类型、同一（归一化后的）地址。
  // 少任何一条都不复用：地址被改写时继续带旧 Key 等于把 Key 发给新地址。
  if (apiKey === '' && saved !== null && saved.type === type && saved.baseUrl === baseUrl.value) {
    apiKey = saved.apiKey;
  }

  const model =
    saved !== null && saved.model.trim() !== '' ? saved.model.trim() : defaultModelFor(type);
  const timeoutMs =
    type === 'ollama' ? LLM_MODEL_LIST_LOCAL_TIMEOUT_MS : LLM_MODEL_LIST_REMOTE_TIMEOUT_MS;
  const throttleKey = `${type}|${baseUrl.value}|${providerId}|${modelListKeyFingerprint(apiKey)}`;

  return {
    ok: true,
    target: {
      provider: {
        id: providerId === '' ? 'model-list-temp' : providerId,
        type,
        name: saved?.name ?? '模型列表',
        baseUrl: baseUrl.value,
        apiKey,
        model,
      },
      timeoutMs,
      throttleKey,
    },
  };
}

export function createModelListService(deps: ModelListDeps): ModelListService {
  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? LLM_MODEL_LIST_THROTTLE_MS;
  const cache = new Map<string, CachedResult>();
  const inflight = new Map<string, Promise<PanelFetchModelsResult>>();

  function prune(at: number): void {
    for (const [key, entry] of cache) {
      if (at - entry.at > LLM_MODEL_LIST_CACHE_TTL_MS) cache.delete(key);
    }
  }

  async function run(
    target: ResolvedTarget,
    throttleKey: string,
  ): Promise<PanelFetchModelsResult> {
    let result: PanelFetchModelsResult;
    try {
      const raw = await deps.fetchModels(target.provider, target.timeoutMs);
      if (!raw.ok) {
        result = { ok: false, error: raw.error };
      } else {
        const models = normalizeModels(raw.models);
        result =
          models.length === 0
            ? { ok: false, error: '端点返回了空的模型列表' }
            : { ok: true, models };
      }
    } catch (error) {
      result = { ok: false, error: `模型列表请求失败：${String(error)}` };
    }
    cache.set(throttleKey, { at: now(), result });
    return result;
  }

  return {
    async fetch(input: unknown): Promise<PanelFetchModelsResult> {
      const resolved = resolveModelListTarget(input, deps.savedProviders());
      if (!resolved.ok) return { ok: false, error: resolved.error };

      const at = now();
      prune(at);
      const cached = cache.get(resolved.target.throttleKey);
      if (cached && at - cached.at < throttleMs) return cached.result;

      const running = inflight.get(resolved.target.throttleKey);
      if (running) return running;

      const promise = run(resolved.target, resolved.target.throttleKey);
      inflight.set(resolved.target.throttleKey, promise);
      try {
        return await promise;
      } finally {
        inflight.delete(resolved.target.throttleKey);
      }
    },

    clear(): void {
      cache.clear();
      inflight.clear();
    },
  };
}

/** 只给类型检查/调用方用：请求与应答的别名（避免两处定义漂移）。 */
export type { PanelFetchModelsRequest, PanelFetchModelsResult };
