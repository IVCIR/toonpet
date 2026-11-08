/**
 * OCR 客户端（ADR 0054 D3）：调用 OpenAI 兼容的 `/chat/completions`，把 PNG 变成纯文本。
 *
 * 为什么是 OpenAI 兼容而不是 GLM-OCR 私有协议：
 * - 本机部署的 GLM-OCR（vLLM / SGLang）本来就暴露这套接口；
 * - 换成别的本机 OCR（PaddleOCR 的 OpenAI 网关、llama.cpp 的多模态服务）不用改代码；
 * - 单测可以注入 `fetch`，不需要真的起模型。
 *
 * 失败一律返回结果对象，不抛异常（ADR 0054 D5）：调用方只关心"这一轮有没有视觉上下文"。
 */
import {
  VISION_OCR_MAX_TOKENS,
  VISION_TEXT_MAX_CHARS,
} from '../../shared/constants';

export type OcrFailureReason = 'disabled' | 'unavailable' | 'timeout' | 'empty' | 'error';

export interface OcrSuccess {
  ok: true;
  text: string;
  /** 截断前的字符数（诊断用） */
  rawChars: number;
  chars: number;
}

export interface OcrFailure {
  ok: false;
  reason: OcrFailureReason;
  detail: string;
}

export type OcrResult = OcrSuccess | OcrFailure;

export interface OcrRequest {
  png: Buffer;
  /** 外部取消（停止运行/切换配置时用）；与超时谁先到谁生效 */
  signal?: AbortSignal;
  /** 覆盖配置里的超时（自检/测试用） */
  timeoutMs?: number;
  /** 覆盖默认指令（测试用） */
  prompt?: string;
  /** 进入提示词前的截断上限 */
  maxChars?: number;
}

export interface VisionOcrClient {
  readonly enabled: boolean;
  readonly model: string;
  readonly baseUrl: string;
  /** 实际请求的 URL（日志/自检用） */
  readonly endpoint: string;
  recognize(request: OcrRequest): Promise<OcrResult>;
}

export interface VisionOcrOptions {
  enabled: boolean;
  baseUrl: string;
  model: string;
  prompt: string;
  apiKey?: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * base URL → chat completions URL。
 *
 * 兼容三种写法（用户/文档里都出现过）：
 * - `http://127.0.0.1:8000/v1` → `/v1/chat/completions`
 * - `http://127.0.0.1:8000/v1/chat/completions`（已是完整端点，原样用）
 * - `http://127.0.0.1:8000`（裸 origin）→ `/v1/chat/completions`
 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return `${trimmed}/v1/chat/completions`;
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  const prefix = pathname === '' ? '/v1' : pathname;
  return `${url.origin}${prefix}/chat/completions`;
}

const CJK_CLASS =
  '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff01-\\uff60\\uffe0-\\uffe6';
const CJK_SPACE = new RegExp(`(?<=[${CJK_CLASS}])[ \\t\\u3000]+(?=[${CJK_CLASS}])`, 'g');

/**
 * OCR 文本归一化（ADR 0054 D3.3）。
 *
 * Windows OCR / 某些 GLM-OCR 服务会把每个汉字之间插一个空格（"桌 宠 控 制"）；
 * 原样进提示词会让模型以为这是"逐字强调"，读起来也占字符预算。
 * 只去掉**两个 CJK 字符之间**的空格，中英混排的空格（"CPU 占用"）保持原样。
 */
export function normalizeOcrText(raw: string, maxChars = VISION_TEXT_MAX_CHARS): OcrSuccess {
  const withoutBom = raw.replace(/^\ufeff/, '');
  const lines = withoutBom
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\u3000/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0 && !/^```/.test(line))
    .map((line) => line.replace(CJK_SPACE, ''));
  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped.length > 0 && deduped[deduped.length - 1] === line) continue;
    deduped.push(line);
  }
  const joined = deduped.join('\n');
  const rawChars = joined.length;
  if (rawChars > maxChars) {
    return { ok: true, text: `${joined.slice(0, Math.max(0, maxChars - 1))}…`, rawChars, chars: maxChars };
  }
  return { ok: true, text: joined, rawChars, chars: rawChars };
}

function contentToText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (part && typeof part === 'object') {
        const record = part as { type?: unknown; text?: unknown; content?: unknown };
        if (typeof record.text === 'string') parts.push(record.text);
        else if (typeof record.content === 'string') parts.push(record.content);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

/** 从 OpenAI 兼容响应里取正文；取不到返回 null（调用方按 empty 降级） */
export function extractOcrContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    output?: { text?: unknown };
    text?: unknown;
  };
  const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
  const fromMessage = contentToText(choice?.message?.content);
  if (fromMessage !== null) return fromMessage;
  if (typeof choice?.text === 'string') return choice.text;
  if (typeof record.output?.text === 'string') return record.output.text;
  if (typeof record.text === 'string') return record.text;
  return null;
}

export function createVisionOcrClient(options: VisionOcrOptions): VisionOcrClient {
  const endpoint = resolveChatCompletionsUrl(options.baseUrl);
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;

  async function recognize(request: OcrRequest): Promise<OcrResult> {
    if (!options.enabled) {
      return { ok: false, reason: 'disabled', detail: 'PET_VISION_DISABLE=1 或配置关闭了视觉' };
    }
    if (!Buffer.isBuffer(request.png) || request.png.length === 0) {
      return { ok: false, reason: 'empty', detail: '截图 Buffer 为空' };
    }

    const timeoutMs = request.timeoutMs ?? options.timeoutMs;
    const prompt = request.prompt ?? options.prompt;
    const dataUrl = `data:image/png;base64,${request.png.toString('base64')}`;
    const body = {
      model: options.model,
      stream: false,
      temperature: 0,
      max_tokens: VISION_OCR_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        return {
          ok: false,
          reason: 'unavailable',
          detail: `OCR HTTP ${String(response.status)}：${errorBody.slice(0, 300)}`,
        };
      }
      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return {
          ok: false,
          reason: 'error',
          detail: `OCR 响应不是 JSON：${text.slice(0, 200)}`,
        };
      }
      const content = extractOcrContent(payload);
      if (content === null) {
        return { ok: false, reason: 'empty', detail: 'OCR 响应里没有 choices[0].message.content' };
      }
      const normalized = normalizeOcrText(content, request.maxChars ?? VISION_TEXT_MAX_CHARS);
      if (normalized.text.trim() === '') {
        return { ok: false, reason: 'empty', detail: 'OCR 没有识别出任何文字' };
      }
      return normalized;
    } catch (error) {
      if (timedOut) {
        return { ok: false, reason: 'timeout', detail: `OCR 超过 ${String(timeoutMs)}ms` };
      }
      if (request.signal?.aborted) {
        return { ok: false, reason: 'error', detail: 'OCR 被调用方取消' };
      }
      return { ok: false, reason: 'unavailable', detail: `OCR 请求失败：${String(error)}` };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    enabled: options.enabled,
    model: options.model,
    baseUrl: options.baseUrl,
    endpoint,
    recognize,
  };
}
