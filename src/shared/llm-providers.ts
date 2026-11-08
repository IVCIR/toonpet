/**
 * LLM 提供商的共享契约（ADR 0055）。
 *
 * 这个文件只放**纯数据与纯校验**，不 import Electron、不 import 主进程配置：
 * - 主进程用它解析 `config.json.llm.providers`；
 * - 面板用它渲染类型下拉、预设地址与错误提示。
 *
 * 安全口径（ADR 0055 D2）：
 * - 默认仍是本地 Ollama（回环 http）；远程只允许用户**显式添加**的提供商；
 * - 远程地址必须是 https（回环除外），禁止 URL 内嵌账号密码与查询串；
 * - API Key 只存在 `config.json`，**不进日志、不进状态快照**，面板只拿到 `hasApiKey`。
 */

export type LlmProviderType = 'ollama' | 'openai' | 'opencode-go';

export const LLM_PROVIDER_TYPES: readonly LlmProviderType[] = ['ollama', 'openai', 'opencode-go'];

export const LLM_PROVIDER_TYPE_LABELS: Record<LlmProviderType, string> = {
  ollama: 'Ollama（本地）',
  openai: 'OpenAI 兼容',
  'opencode-go': 'OpenCode Go',
};

/** OpenCode Go 的固定端点（ADR 0055 D3）：UI 只读，类型即预设。 */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
/** 占位模型名：真实可用的模型清单会变化，必须允许手动输入。 */
export const OPENCODE_GO_DEFAULT_MODEL = 'glm-5.3-flash';

export const LOCAL_OLLAMA_PROVIDER_ID = 'local-ollama';
export const LOCAL_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const LOCAL_OLLAMA_DEFAULT_MODEL = 'qwen3:4b';

export const LLM_PROVIDER_MAX_COUNT = 10;
/** 远程健康检查预算：云端点 800ms 太短，Ollama 仍沿用 `PET_LLM_HEALTH_TIMEOUT_MS`。 */
export const REMOTE_LLM_HEALTH_TIMEOUT_MS = 5000;
export const LLM_PROVIDER_ID_MAX_CHARS = 64;
export const LLM_PROVIDER_NAME_MAX_CHARS = 40;
export const LLM_PROVIDER_MODEL_MAX_CHARS = 120;
export const LLM_PROVIDER_API_KEY_MAX_CHARS = 512;
export const LLM_PROVIDER_BASE_URL_MAX_CHARS = 300;

/**
 * 一个可选的模型（ADR 0056）。
 *
 * - `id`：真正发给端点的模型名（OpenAI 的 `id` / Ollama 的 `name`）；
 * - `name`：展示名（OpenAI 的 `display_name` / `name`，Ollama 的 `name`；缺失时等于 `id`）。
 *
 * 面板的 Combobox 同时用这两个字段：`datalist` 的 value = `id`、label = `name`。
 */
export interface LlmModelOption {
  id: string;
  name: string;
}

/** `LLMProvider.fetchModels()` 的返回（ADR 0056）：成功给清单，失败给人话。 */
export type LlmModelListResult =
  | { ok: true; models: LlmModelOption[] }
  | { ok: false; error: string };

/** 一个提供商实例。`apiKey` 为空串 = 未配置（Ollama 与本地兼容端点通常不需要）。 */
export interface LlmProviderConfig {
  id: string;
  type: LlmProviderType;
  /** 面板显示名；允许中文 */
  name: string;
  /** 无尾斜杠；opencode-go 恒为预设地址 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ProviderValidation {
  ok: boolean;
  value: string | null;
  error: string | null;
}

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Ollama 的 `[namespace/]name[:tag]`；也兼容 OpenCode 的 `vendor/model-version` */
const MODEL_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
/** 远程模型名更宽松：允许两段以上路径（例如 `anthropic/claude-sonnet-4`） */
const REMOTE_MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHostForProvider(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function isValidProviderId(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length <= LLM_PROVIDER_ID_MAX_CHARS &&
    PROVIDER_ID_PATTERN.test(raw)
  );
}

/** 生成稳定、可读的 id（用户没填 id 时用；只含小写字母数字与短横线）。 */
export function suggestProviderId(type: LlmProviderType, existing: readonly string[]): string {
  const base = type === 'opencode-go' ? 'opencode-go' : type;
  if (!existing.includes(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function isValidModelName(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (value === '' || value.length > LLM_PROVIDER_MODEL_MAX_CHARS) return false;
  return MODEL_NAME_PATTERN.test(value);
}

export function isValidRemoteModelName(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (value === '' || value.length > LLM_PROVIDER_MODEL_MAX_CHARS) return false;
  return REMOTE_MODEL_NAME_PATTERN.test(value);
}

export function validateProviderName(raw: unknown): ProviderValidation {
  if (typeof raw !== 'string') return { ok: false, value: null, error: '名称必须是字符串' };
  const value = raw.trim();
  if (value === '') return { ok: false, value: null, error: '名称不能为空' };
  if ([...value].length > LLM_PROVIDER_NAME_MAX_CHARS) {
    return { ok: false, value: null, error: `名称最长 ${LLM_PROVIDER_NAME_MAX_CHARS} 字` };
  }
  // 允许中文/字母/数字/空格/常见标点，但禁止控制字符（避免日志换行注入）
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, value: null, error: '名称含控制字符' };
  return { ok: true, value, error: null };
}

/**
 * 地址归一化（ADR 0055 D2.3）。
 *
 * - `ollama`：只允许回环 http，返回 origin；
 * - `openai`：https 任意主机，或回环 http；保留路径（例如 `/v1`），去掉尾斜杠；
 * - `opencode-go`：恒为预设地址，禁止被配置改写。
 */
export function validateProviderBaseUrl(type: LlmProviderType, raw: unknown): ProviderValidation {
  if (type === 'opencode-go') {
    return { ok: true, value: OPENCODE_GO_BASE_URL, error: null };
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, value: null, error: 'Base URL 不能为空' };
  }
  const value = raw.trim();
  if (value.length > LLM_PROVIDER_BASE_URL_MAX_CHARS) {
    return { ok: false, value: null, error: 'Base URL 太长' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, value: null, error: 'Base URL 不是合法 URL' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, value: null, error: 'Base URL 里不能内嵌账号密码' };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, value: null, error: 'Base URL 不能带查询串或锚点' };
  }
  const loopback = isLoopbackHostForProvider(url.hostname);
  if (type === 'ollama') {
    if (url.protocol !== 'http:') {
      return { ok: false, value: null, error: 'Ollama 只允许本地 http 地址' };
    }
    if (!loopback) {
      return { ok: false, value: null, error: 'Ollama 只允许回环地址（127.0.0.1 / localhost）' };
    }
    return { ok: true, value: url.origin, error: null };
  }
  // openai / opencode-go（后者在前面已返回）：远程必须 https，回环可用 http
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return {
      ok: false,
      value: null,
      error: '远程提供商只允许 https（本机回环可用 http）',
    };
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return { ok: true, value: `${url.origin}${pathname}`, error: null };
}

export function validateProviderModel(type: LlmProviderType, raw: unknown): ProviderValidation {
  const validator = type === 'ollama' ? isValidModelName : isValidRemoteModelName;
  if (typeof raw !== 'string') return { ok: false, value: null, error: '模型名必须是字符串' };
  const value = raw.trim();
  if (!validator(value)) {
    return {
      ok: false,
      value: null,
      error:
        type === 'ollama'
          ? '模型名不合法（Ollama 形如 qwen3:4b）'
          : '模型名不合法（只允许字母/数字/._:/-）',
    };
  }
  return { ok: true, value, error: null };
}

export function validateProviderApiKey(raw: unknown): ProviderValidation {
  if (raw === undefined || raw === null) return { ok: true, value: '', error: null };
  if (typeof raw !== 'string') return { ok: false, value: null, error: 'API Key 必须是字符串' };
  const value = raw.trim();
  if (value.length > LLM_PROVIDER_API_KEY_MAX_CHARS) {
    return { ok: false, value: null, error: `API Key 最长 ${LLM_PROVIDER_API_KEY_MAX_CHARS} 字符` };
  }
  // Key 里不该出现空白/换行：出现基本是复制带入了别的字符
  if (/\s/.test(value)) return { ok: false, value: null, error: 'API Key 含空白字符' };
  return { ok: true, value, error: null };
}

/** 给日志/面板看的脱敏形态：永不返回完整 Key。 */
export function maskApiKey(key: string): string {
  if (key === '') return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/**
 * 把一个不可信的提供商对象清洗成 `LlmProviderConfig`。
 * `previous` 用于"编辑时留空 = 保留原 Key"。
 */
export function sanitizeProviderConfig(
  raw: unknown,
  options: { id: string; previous?: LlmProviderConfig | null },
): { ok: true; provider: LlmProviderConfig } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '提供商配置必须是对象' };
  }
  const record = raw as Record<string, unknown>;
  const typeRaw = record['type'];
  if (typeof typeRaw !== 'string' || !LLM_PROVIDER_TYPES.includes(typeRaw as LlmProviderType)) {
    return { ok: false, error: '提供商类型不合法' };
  }
  const type = typeRaw as LlmProviderType;
  const name = validateProviderName(record['name']);
  if (!name.ok || name.value === null) return { ok: false, error: name.error ?? '名称不合法' };

  const baseUrl = validateProviderBaseUrl(type, record['baseUrl']);
  if (!baseUrl.ok || baseUrl.value === null) {
    return { ok: false, error: baseUrl.error ?? 'Base URL 不合法' };
  }
  const model = validateProviderModel(type, record['model']);
  if (!model.ok || model.value === null) return { ok: false, error: model.error ?? '模型名不合法' };

  const key = validateProviderApiKey(record['apiKey']);
  if (!key.ok) return { ok: false, error: key.error ?? 'API Key 不合法' };
  // 编辑时留空 = 沿用旧 Key；新建时留空 = 没有 Key
  const apiKey = key.value === '' && options.previous ? options.previous.apiKey : (key.value ?? '');

  return {
    ok: true,
    provider: {
      id: options.id,
      type,
      name: name.value,
      baseUrl: baseUrl.value,
      apiKey,
      model: model.value,
    },
  };
}

/** 默认的本地 Ollama 提供商（没有 `config.json.llm.providers` 时使用）。 */
export function makeLocalOllamaProvider(model = LOCAL_OLLAMA_DEFAULT_MODEL): LlmProviderConfig {
  return {
    id: LOCAL_OLLAMA_PROVIDER_ID,
    type: 'ollama',
    name: '本地 Ollama',
    baseUrl: LOCAL_OLLAMA_BASE_URL,
    apiKey: '',
    model,
  };
}
