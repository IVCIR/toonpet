/**
 * Ollama 在线状态探测（ADR 0052 D6，控制面板"系统状态 / AI 配置"专用；ADR 0053 增加模型列表）。
 *
 * 四条边界：
 * - **只连回环**：URL 由 `resolveAppConfig()` 给出，非回环在解析阶段就被拒绝（§10.1/§10.2）；
 * - **只读**：`GET /api/tags`，不 pull、不聊天、不预热、不写库，不产生任何按次计费调用；
 * - **不改熔断**：这里的结果只进面板诊断，**不是** `orchestrator` 的健康检查，
 *   不得据此把 `llmDisabled` 置位（§11 的熔断语义属于真实对话路径）；
 * - **不猜模型**：`/api/tags` 返回什么就显示什么；"当前模型在不在"由 `modelNameMatches` 判定，
 *   与 `llm-client.health()` 同一套匹配规则（`:latest` 等价），避免两处口径分叉。
 *
 * 生命周期：没有自己的定时器。由既有 16ms 指针轮询器的 `tick` 调用 `refresh()`，
 * 内部按 `OLLAMA_PROBE_TTL_MS` 节流；同一时刻最多一个在飞请求（`inFlight`）。
 */
import type { PanelModelOption, PanelOllamaFacts } from '../shared/panel';
import { modelNameMatches } from './orchestrator/llm-client';

/** 面板可见时的探测间隔：3s 一次（比 4Hz 的状态刷新慢得多，避免自己变成噪声源） */
export const OLLAMA_PROBE_TTL_MS = 3000;
/** 单次探测超时：本地服务不可达时也必须很快给出"离线" */
export const OLLAMA_PROBE_TIMEOUT_MS = 800;

export interface OllamaProbe {
  /** 只读当前缓存（面板每次推状态时读它，不触发网络） */
  read(): PanelOllamaFacts;
  /** 若缓存过期则发起一次探测（不等待结果）；`force` 忽略 TTL（切换模型后用） */
  refresh(now: number, force?: boolean): void;
  /** 切换当前模型（面板改了模型之后调用）：清掉"上次探测"的时间戳，强制下一次重新探测 */
  useModel(model: string): void;
  /** 组件卸载：丢弃在飞请求的结果 */
  dispose(): void;
}

export interface OllamaProbeOptions {
  baseUrl: string;
  model: string;
  /** 注入 fetch（单测用）；缺省 `globalThis.fetch` */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}（${cause.message}）` : error.message;
  }
  return String(error);
}

interface ProbeOutcome {
  /** 服务可达（HTTP 200 且响应可解析） */
  reachable: boolean;
  latencyMs: number | null;
  detail: string | null;
  models: PanelModelOption[];
}

function readNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** 把 `/api/tags` 的响应折算成"可达 + 模型清单"，不判断"当前模型在不在"（那是调用方的事）。 */
async function probeOnce(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { reachable: false, latencyMs, detail: `HTTP ${response.status}`, models: [] };
    }
    const data = (await response.json()) as {
      models?: Array<{ name?: unknown; model?: unknown; size?: unknown; modified_at?: unknown }>;
    };
    const models: PanelModelOption[] = (data.models ?? [])
      .map((entry): PanelModelOption | null => {
        const name =
          typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : null;
        if (name === null) return null;
        return {
          name,
          sizeBytes: readNumber(entry.size),
          modifiedAt: typeof entry.modified_at === 'string' ? entry.modified_at : null,
        };
      })
      .filter((entry): entry is PanelModelOption => entry !== null);
    return { reachable: true, latencyMs, detail: null, models };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      reachable: false,
      latencyMs: null,
      detail: aborted ? `超过 ${timeoutMs}ms 无响应` : describeError(error),
      models: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createOllamaProbe(options: OllamaProbeOptions): OllamaProbe {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? OLLAMA_PROBE_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? OLLAMA_PROBE_TTL_MS;

  let model = options.model;
  let facts: PanelOllamaFacts = {
    status: 'unknown',
    baseUrl: options.baseUrl,
    model,
    latencyMs: null,
    detail: null,
    checkedAt: null,
    reachable: false,
    modelPresent: false,
    models: [],
  };
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let disposed = false;

  return {
    read(): PanelOllamaFacts {
      return { ...facts, models: [...facts.models] };
    },

    refresh(now: number, force = false): void {
      if (disposed || inFlight) return;
      if (!force && now - lastProbeAt < ttlMs) return;
      if (typeof fetchImpl !== 'function') {
        facts = { ...facts, status: 'unknown', detail: '运行环境没有 fetch', checkedAt: Date.now() };
        return;
      }
      lastProbeAt = now;
      inFlight = true;
      const probeModel = model;
      void probeOnce(options.baseUrl, fetchImpl, timeoutMs)
        .then((result) => {
          if (disposed) return;
          // 探测期间模型被切换过：这份结果属于旧模型，丢弃（下一次 force 探测会补上）
          if (probeModel !== model) return;
          const modelPresent = result.models.some((entry) => modelNameMatches(model, entry.name));
          const status: PanelOllamaFacts['status'] = !result.reachable
            ? 'offline'
            : modelPresent
              ? 'online'
              : 'offline';
          facts = {
            status,
            baseUrl: options.baseUrl,
            model,
            latencyMs: result.latencyMs,
            detail:
              result.reachable && !modelPresent && result.detail === null
                ? `服务在线，但模型 ${model} 不在 /api/tags`
                : result.detail,
            checkedAt: Date.now(),
            reachable: result.reachable,
            modelPresent,
            models: result.models,
          };
        })
        .finally(() => {
          inFlight = false;
        });
    },

    useModel(next: string): void {
      model = next;
      // 缓存里 display 的模型名也要立刻跟上；真正的"在不在"等下一次探测
      facts = { ...facts, model: next, modelPresent: false, status: 'unknown' };
      lastProbeAt = Number.NEGATIVE_INFINITY;
    },

    dispose(): void {
      disposed = true;
    },
  };
}
