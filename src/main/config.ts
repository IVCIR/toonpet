/**
 * 主进程装配配置（ADR 0015 D1/D2/D6）。
 *
 * 三条原则：
 * 1. **只允许回环地址**：LLM / TTS 的 base URL 在这里校验，外部域名直接抛 `ConfigError`，
 *    让"零出站"从约定变成启动期就失败的可执行规则（§10.1 / §10.2）。
 * 2. **默认值来自契约**：超时、温度、语言等数值一律引用 `src/shared/constants.ts`，不在这里另写一份。
 * 3. **不做文件 IO 以外的探测**：不启动外部进程、不联网、不 pull 模型；缺失即降级。
 */
import path from 'node:path';
import {
  LLM_HARD_TIMEOUT_MS,
  LLM_HEALTH_TIMEOUT_MS,
  TTS_FIRST_BYTE_TIMEOUT_MS,
  TTS_PROMPT_LANG,
  TTS_TEXT_LANG,
  TTS_TOTAL_TIMEOUT_MS,
  VISION_CAPTURE_HARD_MAX_WIDTH_PX,
  VISION_CAPTURE_MAX_WIDTH_PX,
  VISION_CAPTURE_MIN_WIDTH_PX,
  VISION_CONTEXT_TTL_MS,
  VISION_OCR_BASE_URL,
  VISION_OCR_MODEL,
  VISION_OCR_PROMPT_DEFAULT,
  VISION_OCR_TIMEOUT_MS,
} from '../shared/constants';
import type { VisionSource } from '../shared/vision';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LlmConfig {
  /** `http://127.0.0.1:11434`（无尾斜杠） */
  baseUrl: string;
  /** 必须已经 `ollama pull` 到本地；缺失按不可用降级（ADR 0015 D1.2） */
  model: string;
  healthTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface TtsConfig {
  /** `http://127.0.0.1:9880`（无尾斜杠） */
  baseUrl: string;
  /** 3–10 秒参考音频的绝对路径；缺失即"TTS 未配置" */
  refAudioPath: string;
  /** 参考音频的逐字文本；为空即"TTS 未配置" */
  promptText: string;
  /** 参考音频/参考文本的语种（默认 ja：本机凯伊音频是日文，ADR 0019） */
  promptLang: string;
  /** 合成文本的语种（默认 zh：角色对用户说中文） */
  textLang: string;
  firstByteTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface MemoryConfig {
  /** 记忆库文件（ADR 0020 D2）：默认 `<dataDir>/memory.db`，可用 `PET_MEMORY_DB` 覆盖 */
  dbPath: string;
  /** `PET_MEMORY_DISABLE=1` → 完全不碰数据库（逃生口，自检与排查用） */
  enabled: boolean;
}

/** 视觉/OCR 配置（ADR 0054 D1/D5） */
export interface VisionConfig {
  /** `PET_VISION_DISABLE=1` → 热键与 IPC 都返回 disabled，不截屏、不发请求 */
  enabled: boolean;
  /** OpenAI 兼容端点的 base（保留路径，例如 `http://127.0.0.1:8000/v1`） */
  baseUrl: string;
  model: string;
  /** 单次截图 + 识别的总预算 */
  timeoutMs: number;
  /** 送给 OCR 的指令（`PET_OCR_PROMPT` 可覆盖） */
  prompt: string;
  /** 可选 Bearer（本机 vLLM 通常不需要；远程回环代理可能要） */
  apiKey: string | null;
  /** 截图缩放后的最大宽度 */
  maxImageWidth: number;
  /** 视觉上下文保鲜期 */
  contextTtlMs: number;
  /** 默认截图来源：foreground 匹配不到窗口时自动降级为 screen */
  source: VisionSource;
}

export interface AppConfig {
  appRoot: string;
  dataDir: string;
  characterCardPath: string;
  linesPath: string;
  llm: LlmConfig;
  tts: TtsConfig;
  memory: MemoryConfig;
  vision: VisionConfig;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** 回环校验 + 归一化（ADR 0015 D6）：协议必须 http:，主机必须是回环。 */
export function requireLoopbackUrl(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${label} 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:') {
    throw new ConfigError(`${label} 只允许 http:（本地服务），收到 ${url.protocol}`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new ConfigError(`${label} 只允许回环地址（127.0.0.1/localhost/::1），收到 ${url.hostname}`);
  }
  return url.origin;
}

/**
 * 同 `requireLoopbackUrl`，但**保留路径**（去掉尾斜杠）。
 *
 * 存在的唯一理由：OCR 端点的 `/v1` 是地址的一部分，用 origin 会把
 * `http://127.0.0.1:8000/v1` 悄悄变成 `http://127.0.0.1:8000`，
 * 结果请求打到根路径，用户只会看到"OCR 不可用"而不知道为什么（ADR 0054 D1.2）。
 */
export function requireLoopbackUrlWithPath(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${label} 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:') {
    throw new ConfigError(`${label} 只允许 http:（本地服务），收到 ${url.protocol}`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new ConfigError(`${label} 只允许回环地址（127.0.0.1/localhost/::1），收到 ${url.hostname}`);
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readString(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 语种代码归一化为小写（ADR 0019）。
 * GPT-SoVITS 的 `/tts` 内部也会 `lower()`，但应用侧统一小写能让日志、doctor
 * 与请求体保持同一份值，避免 "JA" 与 "ja" 看起来像两个配置。
 */
function readLang(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = readString(env, key);
  return raw === null ? fallback : raw.toLowerCase();
}

/** 布尔开关：只有 `1` / `true` / `yes` / `on` 算开（大小写不敏感），其余算关。 */
function readFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = readString(env, key);
  if (raw === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export interface ResolveConfigOptions {
  appRoot: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveAppConfig(options: ResolveConfigOptions): AppConfig {
  const env = options.env ?? process.env;
  const dataDir = readString(env, 'PET_DATA_DIR') ?? path.join(options.appRoot, 'data');
  // ADR 0053：角色卡可被单独指向别处。唯一理由是取证脚本必须**不写回**用户真实的人格文件
  // （与 PET_PANEL_CONFIG 同一个先例：默认值仍是 `<dataDir>/character-card.md`）。
  const cardOverride = readString(env, 'PET_CHARACTER_CARD');
  const characterCardPath =
    cardOverride === null
      ? path.join(dataDir, 'character-card.md')
      : path.isAbsolute(cardOverride)
        ? cardOverride
        : path.join(options.appRoot, cardOverride);

  return {
    appRoot: options.appRoot,
    dataDir,
    characterCardPath,
    linesPath: path.join(dataDir, 'lines.json'),
    llm: {
      baseUrl: requireLoopbackUrl(readString(env, 'PET_LLM_URL') ?? 'http://127.0.0.1:11434', 'PET_LLM_URL'),
      model: readString(env, 'PET_LLM_MODEL') ?? 'qwen3:4b',
      healthTimeoutMs: readInt(env, 'PET_LLM_HEALTH_TIMEOUT_MS', LLM_HEALTH_TIMEOUT_MS, 100, 5000),
      requestTimeoutMs: readInt(env, 'PET_LLM_TIMEOUT_MS', LLM_HARD_TIMEOUT_MS, 500, 60000),
    },
    tts: {
      baseUrl: requireLoopbackUrl(readString(env, 'PET_TTS_URL') ?? 'http://127.0.0.1:9880', 'PET_TTS_URL'),
      refAudioPath: readString(env, 'PET_TTS_REF_AUDIO') ?? path.join(dataDir, 'ref', 'kaiyi.wav'),
      promptText: readString(env, 'PET_TTS_PROMPT_TEXT') ?? '',
      // ADR 0019：参考音频是日文，prompt_lang 默认 ja；回复文本默认 zh
      promptLang: readLang(env, 'PET_TTS_PROMPT_LANG', TTS_PROMPT_LANG),
      textLang: readLang(env, 'PET_TTS_TEXT_LANG', TTS_TEXT_LANG),
      // ADR 0015 D2.5：CPU 非流式部署必须能放宽；默认值仍是契约值
      firstByteTimeoutMs: readInt(
        env,
        'PET_TTS_FIRST_BYTE_TIMEOUT_MS',
        TTS_FIRST_BYTE_TIMEOUT_MS,
        200,
        120000,
      ),
      totalTimeoutMs: readInt(env, 'PET_TTS_TOTAL_TIMEOUT_MS', TTS_TOTAL_TIMEOUT_MS, 1000, 300000),
    },
    // ADR 0020 D2/D10：记忆库位置与开关；默认 data/memory.db（已加入 .gitignore）
    memory: {
      dbPath: readString(env, 'PET_MEMORY_DB') ?? path.join(dataDir, 'memory.db'),
      enabled: !readFlag(env, 'PET_MEMORY_DISABLE'),
    },
    // ADR 0054 D1：视觉/OCR。默认指向本机 GLM-OCR 的 OpenAI 兼容端点；
    // 端点缺失不是配置错误 —— 运行期按"OCR 不可用"降级（ADR 0054 D5）。
    vision: {
      enabled: !readFlag(env, 'PET_VISION_DISABLE'),
      baseUrl: requireLoopbackUrlWithPath(
        readString(env, 'PET_OCR_URL') ?? VISION_OCR_BASE_URL,
        'PET_OCR_URL',
      ),
      model: readString(env, 'PET_OCR_MODEL') ?? VISION_OCR_MODEL,
      timeoutMs: readInt(env, 'PET_OCR_TIMEOUT_MS', VISION_OCR_TIMEOUT_MS, 1000, 60000),
      prompt: readString(env, 'PET_OCR_PROMPT') ?? VISION_OCR_PROMPT_DEFAULT,
      apiKey: readString(env, 'PET_OCR_API_KEY'),
      maxImageWidth: readInt(
        env,
        'PET_VISION_MAX_WIDTH',
        VISION_CAPTURE_MAX_WIDTH_PX,
        VISION_CAPTURE_MIN_WIDTH_PX,
        VISION_CAPTURE_HARD_MAX_WIDTH_PX,
      ),
      contextTtlMs: readInt(env, 'PET_VISION_CONTEXT_TTL_MS', VISION_CONTEXT_TTL_MS, 5000, 600000),
      source: readString(env, 'PET_VISION_SOURCE') === 'screen' ? 'screen' : 'foreground',
    },
  };
}
