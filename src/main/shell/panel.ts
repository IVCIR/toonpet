/**
 * 控制面板的主进程控制器（ADR 0052；ADR 0053 扩展到人格/模型/记忆）。
 *
 * 一个文件回答五个问题：
 * 1. **谁拥有窗口**：`shell`（§3.1/§7.2）。面板窗口懒创建（第一次打开时），关闭只 `hide`。
 * 2. **物理调参值存在哪**：主进程是唯一权威。`values` 是"当前生效值"（启动时 = 默认值 ⊕
 *    `config.json` 的覆盖），面板的 `preview` 改它但**不写盘**，`save` 才写盘。
 * 3. **怎么到渲染侧**：`cmd:tuning` 单向命令（`appBus.sendCommand`）。渲染侧收到即改内存值，
 *    下一帧生效；**不重启、不 reload、不重建模型**。
 * 4. **状态怎么回来**：复用既有 16ms 轮询器，每 `PANEL_STATE_POLL_MS`（250ms）发一次
 *    `cmd:state-poll`，渲染侧回 `cmd:state-report`；主进程缓存后 4Hz 推给面板
 *    （`cmd:panel-state`）。**没有新定时器**（§12）。
 * 5. **人格/模型/记忆怎么改**（ADR 0053）：面板只发 `cmd:panel`；文件写入（角色卡 / config.json 的
 *    `llm.model`）由本文件负责，**运行期状态**（换 LlmClient、换内存里的角色卡、读写 SQLite）
 *    由 `runtime.panel()` 负责。`shell` 不 import `memory`，也不自己造 `LlmClient`。
 * 6. **模型列表怎么拉**（ADR 0056）：`cmd:fetch-models` 是**只读**通道，本文件只做
 *    sender/形状校验，临时客户端、Key 注入与 2s 节流都在 `runtime.panel().fetchModels()`。
 *
 * 明确不做：不新增 §6.3 事件、不改 `RenderState`、不碰主窗口 `focusable`
 * （§3.2 / §3.6 P-3）、不为面板起任何本地 HTTP 服务、不在主进程开任何定时器。
 */
import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  PANEL_MEMORY_LIST_LIMIT,
  PANEL_MEMORY_LIST_LIMIT_MAX,
  PANEL_PROFILE_REFRESH_MS,
  PANEL_RENDER_STALE_MS,
  PANEL_STATE_POLL_MS,
} from '../../shared/constants';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { MemoryRecord } from '../../shared/memory-types';
import {
  diffTunableValues,
  sanitizeTunablePatch,
  sanitizeTunableValues,
  TUNABLE_DEFAULTS,
} from '../../shared/tunable-params';
import type { TunableValues } from '../../shared/tunable-params';
import type {
  PanelAction,
  PanelCardFacts,
  PanelConfigFacts,
  PanelFetchModelsRequest,
  PanelFetchModelsResult,
  PanelMemoryFacts,
  PanelModelOption,
  PanelOllamaFacts,
  PanelPersonaFacts,
  PanelProviderFacts,
  PanelProviderTestFacts,
  PanelResult,
  PanelStatus,
  PanelTtsTestFacts,
} from '../../shared/panel';
import {
  isValidProviderId,
  makeLocalOllamaProvider,
  sanitizeProviderConfig,
  suggestProviderId,
  type LlmProviderConfig,
  type LlmProviderType,
} from '../../shared/llm-providers';
import { readCharacterCard, writeCharacterCard } from '../character-card';
import { resolveAppConfig } from '../config';
import type { AppConfig } from '../config';
import { createOllamaProbe } from '../ollama-probe';
import type { OllamaProbe } from '../ollama-probe';
import {
  isValidModelName,
  readPanelConfigFile,
  resolvePanelConfigPath,
  writePanelConfigFile,
} from '../panel-config';
import { createPanelWindow, loadPanelRenderer } from './panel-window';

export type PanelLog = (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

/**
 * 面板能调用的运行期后端（由 `shell` 注入 `runtime.panel()`）。
 *
 * 只声明"面板要什么"，**不**把整个 `Runtime` 拖进 shell 的类型图：
 * `shell` 理论上可以在没有 runtime 的情况下存在（例如装配失败时面板仍可看配置）。
 */
export interface PanelBackendLike {
  llmModel(): string;
  llmDisabled(): boolean;
  /** ADR 0055：提供商管理 */
  llmProviders(): LlmProviderConfig[];
  activeProviderId(): string;
  applyLlmModel(model: string): { ok: boolean; error: string | null; notice: string | null; providers?: LlmProviderConfig[]; activeProvider?: string };
  applyProvider(provider: LlmProviderConfig): { ok: boolean; error: string | null; notice: string | null; providers?: LlmProviderConfig[]; activeProvider?: string };
  activateProvider(id: string): { ok: boolean; error: string | null; notice: string | null; providers?: LlmProviderConfig[]; activeProvider?: string };
  deleteProvider(id: string): { ok: boolean; error: string | null; notice: string | null; providers?: LlmProviderConfig[]; activeProvider?: string };
  testProvider(id: string): Promise<PanelProviderTestFacts>;
  /**
   * ADR 0056：用临时客户端拉取模型清单（只读；2s 节流在主进程）。
   * `apiKey` 留空时由主进程在"类型 + 地址都匹配"的前提下注入已保存的 Key。
   */
  fetchModels(request: PanelFetchModelsRequest): Promise<PanelFetchModelsResult>;
  applyCharacterCard(text: string): { ok: boolean; error: string | null; chars: number };
  testTts(): Promise<PanelTtsTestFacts>;
  memories(limit: number): MemoryRecord[];
  deleteMemory(id: number): boolean;
  clearMemories(): number;
  memoryRows(): number;
  memoryEnabled(): boolean;
  memoryMode(): string;
  memoryDbPath(): string;
  memoryLastError(): string | null;
}

export interface PanelControllerOptions {
  appRoot: string;
  log: PanelLog;
  /** 把一组值送到角色渲染页（`cmd:tuning`）；返回是否送达 */
  sendTuning: (values: TunableValues, reason: string) => boolean;
  /** 请角色渲染页回报一次状态（`cmd:state-poll`） */
  requestRenderState: () => boolean;
  /** 校验 `cmd:state-report` 的发送方必须是主窗口渲染页 */
  isMainRenderer: (sender: WebContents) => boolean;
  /** ADR 0053：运行期后端（换模型 / 换角色卡 / TTS 测试 / 记忆读写）；未装配时为 `null` */
  backend?: () => PanelBackendLike | null;
  /** 注入配置路径（自检/截图脚本用来隔离用户配置）；缺省 `<appRoot>/config.json` */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PanelDiagnostics {
  exists: boolean;
  visible: boolean;
  values: TunableValues;
  configPath: string;
  savedAt: string | null;
  lastError: string | null;
  renderFactsAt: number | null;
  /** 最近一次 `cmd:state-report` 的完整快照（自检取证用；不跨进程暴露） */
  render: PanelStatus['render'];
  polls: number;
  ollama: PanelOllamaFacts;
  /** ADR 0053：当前生效模型（`config.json` 覆盖后的值） */
  model: string;
  /** ADR 0053：角色卡文件路径（取证脚本据此核对落盘） */
  cardPath: string;
  /** ADR 0053：最近一次角色卡保存的时间（ISO 8601） */
  cardSavedAt: string | null;
  /** ADR 0053：最近一次记忆操作的计数（面板/取证脚本读） */
  memoryOps: number;
}

export interface PanelController {
  /** 打开（首次会创建窗口并装载页面）；返回是否成功 */
  open(): boolean;
  /** 收起（关闭按钮/托盘再次点击走这里）；不销毁、不退出 */
  hide(): void;
  /** 面板窗口是否可见 */
  isVisible(): boolean;
  /** 面板窗口句柄（自检截图用；不是对外接口） */
  window(): BrowserWindow | null;
  /** 把当前生效值推给角色渲染页（启动后调用一次） */
  syncToRenderer(reason: string): void;
  /** 由既有 16ms 轮询器驱动：推状态、探 Ollama；面板不可见时立即返回 */
  tick(now: number): void;
  /** 当前生效值（只读拷贝） */
  values(): TunableValues;
  diagnostics(): PanelDiagnostics;
  dispose(): void;
}

const PANEL_PERSONA_FILE = 'data/character-card.md';
const FALLBACK_LLM = { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b' };

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 配置文件可能是用户手改的坏 JSON；读取失败只降级，不挡启动。 */
function loadValues(configPath: string): {
  values: TunableValues;
  savedAt: string | null;
  error: string | null;
  loadedFromFile: boolean;
} {
  const state = readPanelConfigFile(configPath);
  const values: TunableValues = { ...TUNABLE_DEFAULTS };
  for (const [id, value] of Object.entries(state.tuning)) {
    // parsePanelConfig 已经夹取过；这里再走一次统一入口，保证"文件 → 内存"同一条路
    Object.assign(values, sanitizeTunablePatch({ [id]: value }));
  }
  return {
    values,
    savedAt: state.savedAt,
    error: state.error,
    loadedFromFile: Object.keys(state.tuning).length > 0,
  };
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 0.1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function createPanelController(options: PanelControllerOptions): PanelController {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolvePanelConfigPath(options.appRoot, env);

  let panelWindow: BrowserWindow | null = null;
  let loading = false;
  let disposed = false;

  const initial = loadValues(configPath);
  const initialConfig = readPanelConfigFile(configPath);
  let values: TunableValues = initial.values;
  let savedAt: string | null = initial.savedAt;
  let lastError: string | null = initial.error;
  /** 用户从面板选过的模型（`config.json` 的 `llm.model`）；`null` = 没选过，跟环境变量走 */
  let modelOverride: string | null = initialConfig.llmModel;
  /** ADR 0055：提供商列表（未保存时 = 运行时默认本地 Ollama） */
  let providers: LlmProviderConfig[] =
    initialConfig.llmProviders.length > 0
      ? initialConfig.llmProviders.map((entry) => ({ ...entry }))
      : [makeLocalOllamaProvider(modelOverride ?? FALLBACK_LLM.model)];
  let activeProviderId: string =
    initialConfig.llmActiveProvider ?? providers[0]?.id ?? 'local-ollama';
  /** 最近一次连接测试（按提供商 id）；只存在内存，不写盘 */
  const providerTests = new Map<string, PanelProviderTestFacts>();

  let renderFacts: PanelStatus['render'] = null;
  let renderFactsAt: number | null = null;
  let lastPollAt = Number.NEGATIVE_INFINITY;
  let lastPreviewLogAt = Number.NEGATIVE_INFINITY;
  let pollCount = 0;
  let cardSavedAt: string | null = null;
  let memoryOps = 0;

  /** AI 人格 / 记忆管理概览（静态文件，5s 刷新一次即可；不每次 tick 都 stat） */
  let profileAt = Number.NEGATIVE_INFINITY;
  let persona: PanelPersonaFacts = fallbackPersona();
  let memory: PanelMemoryFacts = fallbackMemory();

  const ollama: OllamaProbe = createOllamaProbe({
    ...resolveOllamaTarget(),
    ...(env['PET_OLLAMA_PROBE_TIMEOUT_MS'] ? { timeoutMs: Number(env['PET_OLLAMA_PROBE_TIMEOUT_MS']) } : {}),
  });

  function backend(): PanelBackendLike | null {
    try {
      return options.backend?.() ?? null;
    } catch (error) {
      options.log('warn', '控制面板：运行期后端不可用（只读概览继续）', { error: toMessage(error) });
      return null;
    }
  }

  /** ADR 0055：以运行时为准刷新提供商列表（runtime 会补上本地 Ollama 回退项）。 */
  function syncProvidersFromRuntime(): void {
    const runtimeBackend = backend();
    if (!runtimeBackend) return;
    try {
      const list = runtimeBackend.llmProviders();
      if (list.length > 0) providers = list.map((entry) => ({ ...entry }));
      const active = runtimeBackend.activeProviderId();
      if (active !== '') activeProviderId = active;
    } catch (error) {
      options.log('warn', '控制面板：读取提供商列表失败，使用本地缓存', { error: toMessage(error) });
    }
  }

  function currentProvider(): LlmProviderConfig | null {
    return providers.find((entry) => entry.id === activeProviderId) ?? providers[0] ?? null;
  }

  function providerFacts(): PanelProviderFacts[] {
    // 每次投影都重新计算 `active`，避免"激活后旧项还亮着"
    return providers.map((entry) => ({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      baseUrl: entry.baseUrl,
      model: entry.model,
      hasApiKey: entry.apiKey !== '',
      active: entry.id === activeProviderId,
      test: providerTests.get(entry.id) ?? null,
    }));
  }

  /**
   * 把提供商配置写进 `config.json`（新格式 `llm.providers` + `llm.activeProvider`）。
   * 这是**唯一**的提供商持久化入口；所有写盘动作都带上同一份列表，避免互相覆盖。
   */
  function persistLlmProviders(): { ok: boolean; error: string | null } {
    const at = new Date().toISOString();
    const write = writePanelConfigFile(
      configPath,
      {
        values,
        llmModel: null,
        llmProviders: providers,
        llmActiveProvider: activeProviderId,
      },
      at,
    );
    if (write.ok) {
      savedAt = at;
      lastError = null;
    } else {
      lastError = write.error;
      options.log('error', '控制面板：提供商配置写入 config.json 失败', { error: write.error });
    }
    return write;
  }

  /** 保存参数时也要带上提供商，否则会把 `llm.providers` 覆盖成旧的 `llm.model`。 */
  function writeConfigWithProviders(valuesToWrite: TunableValues): { ok: boolean; error: string | null } {
    return writePanelConfigFile(
      configPath,
      {
        values: valuesToWrite,
        llmModel: providers.length > 0 ? null : modelOverride,
        llmProviders: providers.length > 0 ? providers : null,
        llmActiveProvider: providers.length > 0 ? activeProviderId : null,
      },
      new Date().toISOString(),
    );
  }

  function applyRuntimeProviderChange(change: {
    providers?: LlmProviderConfig[];
    activeProvider?: string;
  }): void {
    if (change.providers && change.providers.length > 0) {
      providers = change.providers.map((entry) => ({ ...entry }));
    }
    if (change.activeProvider && change.activeProvider !== '') activeProviderId = change.activeProvider;
  }

  function testAndRemember(id: string): Promise<PanelProviderTestFacts> {
    const runtimeBackend = backend();
    if (!runtimeBackend) {
      return Promise.resolve({
        id,
        status: 'failed',
        detail: '编排尚未就绪',
        latencyMs: null,
        reachable: false,
        modelPresent: null,
        checkedAt: new Date().toISOString(),
      });
    }
    return runtimeBackend.testProvider(id).then(
      (facts) => {
        providerTests.set(id, facts);
        return facts;
      },
      (error: unknown) => {
        const facts: PanelProviderTestFacts = {
          id,
          status: 'failed',
          detail: toMessage(error),
          latencyMs: null,
          reachable: false,
          modelPresent: null,
          checkedAt: new Date().toISOString(),
        };
        providerTests.set(id, facts);
        return facts;
      },
    );
  }

  function safeConfig(): AppConfig | null {
    try {
      return resolveAppConfig({ appRoot: options.appRoot, env });
    } catch (error) {
      options.log('warn', '控制面板：装配配置解析失败，只读概览使用回退值', { error: toMessage(error) });
      return null;
    }
  }

  function cardPath(): string {
    return safeConfig()?.characterCardPath ?? path.join(options.appRoot, PANEL_PERSONA_FILE);
  }

  function resolveOllamaTarget(): { baseUrl: string; model: string } {
    const config = safeConfig();
    const local = providers.find((entry) => entry.type === 'ollama') ?? currentProvider();
    if (local && local.type === 'ollama') {
      return { baseUrl: local.baseUrl, model: local.model };
    }
    if (!config) return { ...FALLBACK_LLM };
    return { baseUrl: config.llm.baseUrl, model: config.llm.model };
  }

  function fallbackPersona(): PanelPersonaFacts {
    return {
      cardPath: path.join(options.appRoot, PANEL_PERSONA_FILE),
      cardExists: false,
      cardChars: 0,
      llmModel: FALLBACK_LLM.model,
      llmBaseUrl: FALLBACK_LLM.baseUrl,
      llmProviderType: 'ollama',
      llmProviderName: '本地 Ollama',
      llmProviderId: 'local-ollama',
      llmDisabled: false,
      ttsEnabled: false,
      ttsRefAudioPath: '',
      ttsDisabledReason: '未配置',
    };
  }

  function fallbackMemory(): PanelMemoryFacts {
    return {
      enabled: true,
      mode: 'file',
      dbPath: path.join(options.appRoot, 'data', 'memory.db'),
      dbExists: false,
      dbBytes: null,
      dbUpdatedAt: null,
      rows: 0,
      lastError: null,
    };
  }

  function refreshProfile(now: number, force = false): void {
    if (!force && now - profileAt < PANEL_PROFILE_REFRESH_MS && profileAt !== Number.NEGATIVE_INFINITY) return;
    profileAt = now;
    const config = safeConfig();
    const runtimeBackend = backend();
    syncProvidersFromRuntime();

    const card = readCharacterCard(cardPath());
    const ttsEnabled = config ? config.tts.promptText.trim() !== '' && existsSync(config.tts.refAudioPath) : false;
    const ttsDisabledReason = !config
      ? '未配置'
      : config.tts.promptText.trim() === ''
        ? '参考文本（PET_TTS_PROMPT_TEXT）为空'
        : !existsSync(config.tts.refAudioPath)
          ? '参考音频不存在'
          : null;
    const active = currentProvider();
    persona = {
      cardPath: cardPath(),
      cardExists: card.exists,
      cardChars: card.chars,
      llmModel: runtimeBackend?.llmModel() ?? active?.model ?? config?.llm.model ?? FALLBACK_LLM.model,
      llmBaseUrl: active?.baseUrl ?? config?.llm.baseUrl ?? FALLBACK_LLM.baseUrl,
      llmProviderType: active?.type ?? 'ollama',
      llmProviderName: active?.name ?? '本地 Ollama',
      llmProviderId: active?.id ?? 'local-ollama',
      llmDisabled: runtimeBackend?.llmDisabled() ?? false,
      ttsEnabled,
      ttsRefAudioPath: config?.tts.refAudioPath ?? '',
      ttsDisabledReason,
    };

    const dbPath = runtimeBackend?.memoryDbPath() || config?.memory.dbPath || path.join(options.appRoot, 'data', 'memory.db');
    let dbExists = false;
    let dbBytes: number | null = null;
    let dbUpdatedAt: string | null = null;
    try {
      const stat = statSync(dbPath);
      dbExists = true;
      dbBytes = stat.size;
      dbUpdatedAt = new Date(stat.mtimeMs).toISOString();
    } catch {
      dbExists = false;
    }
    memory = {
      enabled: runtimeBackend?.memoryEnabled() ?? config?.memory.enabled ?? true,
      mode: runtimeBackend?.memoryMode() ?? 'file',
      dbPath,
      dbExists,
      dbBytes,
      dbUpdatedAt,
      rows: runtimeBackend?.memoryRows() ?? 0,
      lastError: runtimeBackend?.memoryLastError() ?? null,
    };
  }

  function configFacts(): PanelConfigFacts {
    return { configPath, savedAt, loadedFromFile: initial.loadedFromFile };
  }

  function buildStatus(now: number): PanelStatus {
    refreshProfile(now);
    const fresh =
      renderFacts !== null && renderFactsAt !== null && now - renderFactsAt <= PANEL_RENDER_STALE_MS;
    return {
      render: fresh ? renderFacts : null,
      ollama: ollama.read(),
      persona,
      providers: providerFacts(),
      memory,
      panelVisible: panelWindow !== null && !panelWindow.isDestroyed() && panelWindow.isVisible(),
    };
  }

  function pushStatus(now: number): void {
    const window = panelWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (!window.isVisible()) return;
    window.webContents.send(IPC_CHANNELS.panelState, buildStatus(now));
  }

  function applyValues(next: TunableValues, reason: string): void {
    values = next;
    const delivered = options.sendTuning(values, reason);
    if (!delivered) {
      options.log('warn', '控制面板：渲染页未就绪，本次改动只留在主进程（下一次 open 前会补发）', {
        reason,
      });
    }
  }

  function result(ok: boolean, error?: string): PanelResult {
    return {
      ok,
      values: { ...values },
      config: configFacts(),
      ...(error ? { error } : {}),
    };
  }

  function cardFacts(): PanelCardFacts {
    const read = readCharacterCard(cardPath());
    return {
      path: cardPath(),
      exists: read.exists,
      chars: read.chars,
      text: read.text,
      error: read.error,
    };
  }

  /** 模型是否在"最近一次 /api/tags 结果"里（空列表视为"没探测过"，不据此拒绝） */
  function knownModels(): PanelModelOption[] {
    return ollama.read().models;
  }

  async function handleAction(raw: unknown): Promise<PanelResult> {
    if (!isRecord(raw) || typeof raw['action'] !== 'string') {
      return result(false, '请求格式非法（缺少 action）');
    }
    const action = raw['action'];
    switch (action) {
      case 'snapshot':
        return result(true);

      case 'status': {
        // 状态本身走推送；这里只是让面板"立刻拿到一次"，不额外引入通道
        refreshProfile(performance.now(), true);
        // "重新探测"按钮走这条：强制忽略 TTL，否则用户会以为点了没反应
        ollama.refresh(performance.now(), true);
        pushStatus(performance.now());
        return result(true);
      }

      case 'hide': {
        // Esc 与标题栏关闭按钮同一条路径：只 hide，不销毁、不退出
        const window = panelWindow;
        if (window && !window.isDestroyed() && window.isVisible()) {
          window.hide();
          options.log('info', '控制面板已收起（Esc）');
        }
        return result(true);
      }

      case 'preview': {
        const patch = sanitizeTunablePatch(raw['values']);
        if (Object.keys(patch).length === 0) return result(true);
        const next: TunableValues = { ...values, ...patch };
        applyValues(next, 'preview');
        const now = performance.now();
        if (now - lastPreviewLogAt >= 500) {
          lastPreviewLogAt = now;
          options.log('info', '控制面板：参数预览已下发（未保存）', patch);
        }
        return result(true);
      }

      case 'save': {
        const patch = sanitizeTunablePatch(raw['values']);
        const next: TunableValues = { ...values, ...patch };
        const at = new Date().toISOString();
        const write = writeConfigWithProviders(next);
        if (!write.ok) {
          lastError = write.error;
          options.log('error', '控制面板：config.json 写入失败（本次改动仍实时生效）', {
            error: write.error,
          });
          applyValues(next, 'save-failed');
          return result(false, write.error ?? '写入失败');
        }
        savedAt = at;
        lastError = null;
        applyValues(next, 'save');
        options.log('info', '控制面板：参数已保存到 config.json（重启后仍生效）', {
          configPath,
          // 日志只列"真的与默认值不同"的项：面板回传的是完整一组值，直接列 keys 会假装五项都改过
          changed: Object.keys(diffTunableValues(next)),
          values: next,
        });
        return result(true);
      }

      case 'reset': {
        const at = new Date().toISOString();
        const next: TunableValues = { ...TUNABLE_DEFAULTS };
        const write = writeConfigWithProviders(next);
        savedAt = write.ok ? at : savedAt;
        lastError = write.ok ? null : write.error;
        applyValues(next, 'reset');
        options.log('info', '控制面板：已恢复默认值（并写回 config.json）', {
          configPath,
          ok: write.ok,
          error: write.error,
        });
        return result(write.ok, write.ok ? undefined : (write.error ?? '写入失败'));
      }

      // ------------------------------------------------------------------
      // ADR 0053：AI 配置
      // ------------------------------------------------------------------

      case 'card': {
        const facts = cardFacts();
        return { ...result(true), card: facts };
      }

      case 'save-card': {
        const text = raw['text'];
        if (typeof text !== 'string') return result(false, '角色卡内容必须是字符串');
        const write = writeCharacterCard(cardPath(), text);
        if (!write.ok) {
          options.log('warn', '控制面板：角色卡保存被拒绝', { error: write.error });
          return { ...result(false, write.error ?? '角色卡保存失败'), card: cardFacts() };
        }
        // 先写盘、再让运行时换内存里的 card：反过来的话，内存里是新人格但文件是旧的，
        // 重启后"人格又变了"会非常难排查。
        const applied = backend()?.applyCharacterCard(write.text);
        cardSavedAt = new Date().toISOString();
        refreshProfile(performance.now(), true);
        if (!applied || !applied.ok) {
          // 盘已经改了：如实告诉用户"已写入文件，本轮未生效（重启后生效）"
          const reason = applied?.error ?? '运行期后端未就绪';
          options.log('warn', '控制面板：角色卡已写盘，但运行期未应用（重启后生效）', { reason });
          return {
            ...result(false, `角色卡已写入文件，但本轮未生效：${reason}`),
            card: cardFacts(),
          };
        }
        options.log('info', '控制面板：角色卡已保存并热更新（下一轮对话生效）', {
          path: cardPath(),
          chars: write.chars,
        });
        return {
          ...result(true),
          card: cardFacts(),
          notice: `角色卡已保存（${write.chars} 字），下一轮对话就用新的人格`,
        };
      }

      case 'set-model': {
        const model = raw['model'];
        if (!isValidModelName(model)) return result(false, '模型名不合法');
        const next = model.trim();
        const models = knownModels();
        if (models.length > 0 && !models.some((entry) => entry.name === next)) {
          // 本地没有这个模型：明确拒绝，而不是让她下一轮对话静默熔断（§11）
          return result(false, `本地没有这个模型：${next}（先 ollama pull）`);
        }
        const runtimeBackend = backend();
        if (!runtimeBackend) return result(false, '编排尚未就绪（重启应用后生效）');
        const applied = runtimeBackend.applyLlmModel(next);
        if (!applied.ok) {
          options.log('warn', '控制面板：模型切换失败', { model: next, error: applied.error });
          return result(false, applied.error ?? '模型切换失败');
        }
        // 运行期换成功才写盘：避免"文件里是新模型、跑的是旧模型"这种半更新状态
        modelOverride = next;
        applyRuntimeProviderChange(applied);
        const at = new Date().toISOString();
        const write = writeConfigWithProviders(values);
        if (!write.ok) {
          options.log('error', '控制面板：模型已切换但写入 config.json 失败（重启后会回到旧模型）', {
            error: write.error,
            model: next,
          });
          return {
            ...result(false, write.error ?? '写入失败'),
            model: runtimeBackend.llmModel(),
            providers: providerFacts(),
            activeProvider: activeProviderId,
            notice: '已生效，但写入 config.json 失败：重启后会回到旧模型',
          };
        }
        savedAt = at;
        lastError = null;
        ollama.useModel(next);
        ollama.refresh(performance.now(), true);
        refreshProfile(performance.now(), true);
        options.log('info', '控制面板：模型已切换并写入 config.json', {
          model: next,
          configPath,
        });
        return {
          ...result(true),
          model: next,
          providers: providerFacts(),
          activeProvider: activeProviderId,
          notice: applied.notice ?? `已换成 ${next}，下一轮对话生效`,
        };
      }

      // ------------------------------------------------------------------
      // ADR 0055：LLM 提供商
      // ------------------------------------------------------------------

      case 'providers': {
        syncProvidersFromRuntime();
        return { ...result(true), providers: providerFacts(), activeProvider: activeProviderId };
      }

      case 'provider-save': {
        const runtimeBackend = backend();
        if (!runtimeBackend) return result(false, '编排尚未就绪（重启应用后生效）');
        const rawProvider = raw['provider'];
        if (!isRecord(rawProvider)) return result(false, '提供商配置格式非法');
        const requestedId = rawProvider['id'];
        const existing =
          typeof requestedId === 'string'
            ? providers.find((entry) => entry.id === requestedId) ?? null
            : null;
        let id: string;
        if (existing) {
          id = existing.id;
        } else if (isValidProviderId(requestedId) && !providers.some((entry) => entry.id === requestedId)) {
          id = requestedId;
        } else {
          const type = rawProvider['type'];
          id = suggestProviderId(
            type === 'ollama' || type === 'openai' || type === 'opencode-go' ? type : 'openai',
            providers.map((entry) => entry.id),
          );
        }
        if (existing === null && providers.length >= 10) {
          return result(false, '最多只能配置 10 个提供商');
        }
        const sanitized = sanitizeProviderConfig(rawProvider, { id, previous: existing });
        if (!sanitized.ok) return result(false, sanitized.error);
        const applied = runtimeBackend.applyProvider(sanitized.provider);
        if (!applied.ok) {
          options.log('warn', '控制面板：提供商保存失败', {
            providerId: id,
            type: sanitized.provider.type,
            error: applied.error,
          });
          return result(false, applied.error ?? '提供商保存失败');
        }
        applyRuntimeProviderChange(applied);
        const write = persistLlmProviders();
        if (!write.ok) {
          return {
            ...result(false, write.error ?? '写入失败'),
            providers: providerFacts(),
            activeProvider: activeProviderId,
            notice: '已生效，但写入 config.json 失败：重启后会丢失',
          };
        }
        // 当前生效项保存后立刻测一次连接：失败要在面板上看见"连接失败"，而不是等下次对话
        const test =
          sanitized.provider.id === activeProviderId ? await testAndRemember(sanitized.provider.id) : undefined;
        options.log('info', '控制面板：提供商已保存', {
          providerId: sanitized.provider.id,
          type: sanitized.provider.type,
          model: sanitized.provider.model,
          active: sanitized.provider.id === activeProviderId,
          apiKey: sanitized.provider.apiKey === '' ? '未配置' : '已配置',
        });
        return {
          ...result(true),
          providers: providerFacts(),
          activeProvider: activeProviderId,
          ...(test ? { providerTest: test } : {}),
          notice: applied.notice ?? `已保存 ${sanitized.provider.name}`,
        };
      }

      case 'provider-activate': {
        const id = raw['id'];
        if (typeof id !== 'string') return result(false, '提供商 id 非法');
        const runtimeBackend = backend();
        if (!runtimeBackend) return result(false, '编排尚未就绪');
        const applied = runtimeBackend.activateProvider(id);
        if (!applied.ok) {
          options.log('warn', '控制面板：提供商切换失败', { providerId: id, error: applied.error });
          return result(false, applied.error ?? '提供商切换失败');
        }
        applyRuntimeProviderChange(applied);
        const write = persistLlmProviders();
        const test = await testAndRemember(id);
        const active = currentProvider();
        if (active?.type === 'ollama') {
          ollama.useModel(active.model);
          ollama.refresh(performance.now(), true);
        }
        refreshProfile(performance.now(), true);
        options.log('info', '控制面板：提供商已切换', {
          providerId: id,
          type: active?.type ?? null,
          model: active?.model ?? null,
          persisted: write.ok,
        });
        return {
          ...result(write.ok, write.ok ? undefined : (write.error ?? '写入失败')),
          providers: providerFacts(),
          activeProvider: activeProviderId,
          providerTest: test,
          notice: applied.notice ?? '已切换提供商，下一轮对话生效',
        };
      }

      case 'provider-delete': {
        const id = raw['id'];
        if (typeof id !== 'string') return result(false, '提供商 id 非法');
        const runtimeBackend = backend();
        if (!runtimeBackend) return result(false, '编排尚未就绪');
        const applied = runtimeBackend.deleteProvider(id);
        if (!applied.ok) return result(false, applied.error ?? '删除失败');
        applyRuntimeProviderChange(applied);
        providerTests.delete(id);
        const write = persistLlmProviders();
        refreshProfile(performance.now(), true);
        options.log('info', '控制面板：提供商已删除', { providerId: id, persisted: write.ok });
        return {
          ...result(write.ok, write.ok ? undefined : (write.error ?? '写入失败')),
          providers: providerFacts(),
          activeProvider: activeProviderId,
          notice: applied.notice ?? '已删除',
        };
      }

      case 'provider-test': {
        const id = raw['id'];
        if (typeof id !== 'string') return result(false, '提供商 id 非法');
        const test = await testAndRemember(id);
        return {
          ...result(true),
          providers: providerFacts(),
          activeProvider: activeProviderId,
          providerTest: test,
        };
      }

      case 'tts-test': {
        const runtimeBackend = backend();
        if (!runtimeBackend) {
          return {
            ...result(false, '编排尚未就绪'),
            tts: {
              ok: false,
              enabled: false,
              baseUrl: '',
              refAudioPath: '',
              ms: null,
              bytes: null,
              reason: 'unavailable',
              detail: '编排尚未就绪',
            },
          };
        }
        return runtimeBackend.testTts().then(
          (facts) => ({ ...result(facts.ok, facts.ok ? undefined : (facts.detail ?? facts.reason ?? 'TTS 不可用')), tts: facts }),
          (error: unknown) => {
            options.log('warn', '控制面板：TTS 测试异常', { error: toMessage(error) });
            return {
              ...result(false, toMessage(error)),
              tts: {
                ok: false,
                enabled: true,
                baseUrl: '',
                refAudioPath: '',
                ms: null,
                bytes: null,
                reason: 'error',
                detail: toMessage(error),
              } satisfies PanelTtsTestFacts,
            };
          },
        );
      }

      // ------------------------------------------------------------------
      // ADR 0053：记忆管理
      // ------------------------------------------------------------------

      case 'memories': {
        const runtimeBackend = backend();
        if (!runtimeBackend) return { ...result(false, '编排尚未就绪'), memories: [] };
        const rawLimit = raw['limit'];
        const limit =
          typeof rawLimit === 'number' && Number.isFinite(rawLimit)
            ? Math.min(PANEL_MEMORY_LIST_LIMIT_MAX, Math.max(1, Math.floor(rawLimit)))
            : PANEL_MEMORY_LIST_LIMIT;
        const rows = runtimeBackend.memories(limit);
        refreshProfile(performance.now(), true);
        return { ...result(true), memories: rows, memoryRows: runtimeBackend.memoryRows() };
      }

      case 'memory-delete': {
        const id = raw['id'];
        if (typeof id !== 'number' || !Number.isFinite(id)) return result(false, '记忆 id 非法');
        const runtimeBackend = backend();
        if (!runtimeBackend) return result(false, '编排尚未就绪');
        const deleted = runtimeBackend.deleteMemory(Math.floor(id));
        memoryOps += 1;
        refreshProfile(performance.now(), true);
        options.log('info', '控制面板：已删除一条记忆', {
          id: Math.floor(id),
          deleted,
          rows: runtimeBackend.memoryRows(),
        });
        return {
          ...result(true),
          deleted,
          memoryRows: runtimeBackend.memoryRows(),
          notice: deleted ? '已删除这一条' : '没有找到这一条（可能已被删掉）',
        };
      }

      case 'memory-clear': {
        // 二次确认是**硬条件**：面板 UI 的点两次只是体验，主进程必须再挡一道
        if (raw['confirm'] !== true) return result(false, '清空记忆需要二次确认');
        const runtimeBackend = backend();
        if (!runtimeBackend) return result(false, '编排尚未就绪');
        const cleared = runtimeBackend.clearMemories();
        memoryOps += 1;
        refreshProfile(performance.now(), true);
        options.log('info', '控制面板：已清空全部记忆（她失忆了）', {
          cleared,
          rows: runtimeBackend.memoryRows(),
        });
        return {
          ...result(true),
          cleared,
          memoryRows: runtimeBackend.memoryRows(),
          notice: cleared === 0 ? '记忆本来就是空的' : `已清空 ${cleared} 条记忆`,
        };
      }

      default:
        return result(false, `未知 action：${String(action)}`);
    }
  }

  /**
   * ADR 0056：`cmd:fetch-models` 的载荷只做形状校验；类型/地址/Key 的业务校验在
   * `runtime.panel().fetchModels()`（`llm-model-list.ts`）里。
   */
  function parseFetchModelsRequest(raw: unknown): PanelFetchModelsRequest | null {
    if (!isRecord(raw)) return null;
    const baseUrl = raw['baseUrl'];
    if (typeof baseUrl !== 'string') return null;
    const type = raw['type'];
    if (type !== undefined && typeof type !== 'string') return null;
    const apiKey = raw['apiKey'];
    if (apiKey !== undefined && typeof apiKey !== 'string') return null;
    const providerId = raw['providerId'];
    if (providerId !== undefined && typeof providerId !== 'string') return null;
    return {
      baseUrl,
      ...(typeof type === 'string' ? { type: type as LlmProviderType } : {}),
      ...(typeof apiKey === 'string' ? { apiKey } : {}),
      ...(typeof providerId === 'string' && providerId !== '' ? { providerId } : {}),
    };
  }

  /** 只接受面板窗口发来的请求（与 `cmd:respond` 的发送方白名单同一原则）。 */
  function isFromPanel(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    const window = panelWindow;
    if (!window || window.isDestroyed()) return false;
    return event.sender === window.webContents;
  }

  const onFetchModels = async (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<PanelFetchModelsResult> => {
    if (!isFromPanel(event)) {
      options.log('warn', 'cmd:fetch-models 来自未知页面，已拒绝');
      return { ok: false, error: '请求方不是控制面板' };
    }
    const request = parseFetchModelsRequest(payload);
    if (!request) return { ok: false, error: '请求格式非法' };
    const runtimeBackend = backend();
    if (!runtimeBackend) return { ok: false, error: '编排尚未就绪' };
    try {
      return await runtimeBackend.fetchModels(request);
    } catch (error) {
      options.log('warn', '控制面板：拉取模型列表异常', { error: toMessage(error) });
      return { ok: false, error: toMessage(error) };
    }
  };

  const onPanelInvoke = async (
    event: IpcMainInvokeEvent,
    action: unknown,
  ): Promise<PanelResult> => {
    if (!isFromPanel(event)) {
      options.log('warn', 'cmd:panel 来自未知页面，已拒绝');
      return result(false, '请求方不是控制面板');
    }
    try {
      // 少数动作要等网络（TTS 测试），统一在这里 await；同步动作照旧立即 resolve
      return await handleAction(action);
    } catch (error) {
      lastError = toMessage(error);
      options.log('error', '控制面板：处理请求时抛错', { error: lastError });
      return result(false, lastError);
    }
  };

  const onStateReport = (event: IpcMainEvent, payload: unknown): void => {
    if (!options.isMainRenderer(event.sender)) return;
    if (!isRecord(payload)) return;
    const state = payload['state'];
    const clip = payload['clip'];
    if (!isRecord(state) || !isRecord(clip)) return;

    const sitRaw = payload['sit'];
    const sit = isRecord(sitRaw)
      ? {
          stage: sitRaw['stage'] === 'b' ? ('b' as const) : ('a' as const),
          sitPoseGain: Number(sitRaw['sitPoseGain']) || 0,
          phaseAHeadAppliedRad: Number(sitRaw['phaseAHeadAppliedRad']) || 0,
          spineOverlayApplied: Number(sitRaw['spineOverlayApplied']) || 0,
        }
      : null;

    renderFacts = {
      // 渲染侧发来的就是 `getState()` 的原样对象；字段级别的严格校验在主进程意义不大，
      // 面板只用它显示。这里只保证"不是 undefined"。
      state: state as unknown as NonNullable<PanelStatus['render']>['state'],
      clip: {
        name: typeof clip['name'] === 'string' ? clip['name'] : null,
        slot: typeof clip['slot'] === 'string' ? clip['slot'] : null,
        timeSeconds: Number(clip['timeSeconds']) || 0,
        weight: Number(clip['weight']) || 0,
      },
      sit,
      tuning: sanitizeTunableValues(payload['tuning']),
      collectedAt: Number(payload['collectedAt']) || 0,
    };
    renderFactsAt = performance.now();
    // 收到就立刻推一次：不必等下一个 250ms 节拍（拖拽/说话时状态变化很快）
    pushStatus(renderFactsAt);
  };

  function installIpc(): void {
    ipcMain.handle(IPC_CHANNELS.panel, onPanelInvoke);
    ipcMain.handle(IPC_CHANNELS.fetchModels, onFetchModels);
    ipcMain.on(IPC_CHANNELS.stateReport, onStateReport);
  }

  function removeIpc(): void {
    ipcMain.removeHandler(IPC_CHANNELS.panel);
    ipcMain.removeHandler(IPC_CHANNELS.fetchModels);
    ipcMain.removeListener(IPC_CHANNELS.stateReport, onStateReport);
  }

  function installWindowBehavior(window: BrowserWindow): void {
    // 需求：关闭面板**不退出应用**，再次点托盘可重新打开。
    // 折成 hide 而不是 destroy：滑块位置、滚动位置与"未保存的预览值"都还在。
    window.on('close', (event) => {
      if (disposed) return; // stop()/退出流程：允许真正关闭
      event.preventDefault();
      window.hide();
      options.log('info', '控制面板已收起（应用继续运行，可再次从托盘打开）');
    });
    window.on('closed', () => {
      if (panelWindow === window) panelWindow = null;
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      options.log('error', '控制面板渲染进程退出：销毁窗口，下次打开时重建', details);
      if (!window.isDestroyed()) window.destroy();
    });
  }

  function ensureWindow(): BrowserWindow | null {
    if (panelWindow && !panelWindow.isDestroyed()) return panelWindow;
    try {
      const window = createPanelWindow();
      panelWindow = window;
      installWindowBehavior(window);
      loading = true;
      void loadPanelRenderer(window)
        .then(() => {
          loading = false;
          options.log('info', '控制面板页面已装载', { configPath });
        })
        .catch((error: unknown) => {
          loading = false;
          options.log('warn', '控制面板页面装载失败：面板会显示空白窗', { error: toMessage(error) });
        });
      return window;
    } catch (error) {
      options.log('error', '控制面板窗口创建失败（抽屉功能不可用，桌宠不受影响）', {
        error: toMessage(error),
      });
      return null;
    }
  }

  /** 一次节拍：请求渲染侧快照 + 探 Ollama + 推状态。由 16ms 轮询器驱动（面板不可见时立即返回）。 */
  function runTick(now: number): void {
    const window = panelWindow;
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    if (now - lastPollAt < PANEL_STATE_POLL_MS) return;
    lastPollAt = now;
    pollCount += 1;
    options.requestRenderState();
    ollama.refresh(now);
    pushStatus(now);
  }

  installIpc();
  if (initial.error) {
    options.log('warn', '控制面板：配置文件有问题，已按默认值启动', { error: initial.error, configPath });
  }
  options.log('info', '控制面板控制器已就绪', {
    configPath,
    loadedFromFile: initial.loadedFromFile,
    modelOverride,
    values,
  });

  return {
    open(): boolean {
      if (disposed) return false;
      const window = ensureWindow();
      if (!window || window.isDestroyed()) return false;
      // 首次显示前给页面一点装载时间：`show()` 之后 Chromium 才会开始渲染，
      // 先 show 再 focus，避免"窗口出现了但内容是白的"。
      window.show();
      window.focus();
      window.webContents.focus();
      lastPollAt = Number.NEGATIVE_INFINITY;
      // 打开瞬间补一次状态与探测，不用等到下一个节拍（≤16ms）
      runTick(performance.now());
      options.log('info', '控制面板已打开', {
        visible: window.isVisible(),
        loading,
        values,
      });
      return true;
    },

    hide(): void {
      const window = panelWindow;
      if (!window || window.isDestroyed() || !window.isVisible()) return;
      window.hide();
      options.log('info', '控制面板已收起');
    },

    isVisible(): boolean {
      return panelWindow !== null && !panelWindow.isDestroyed() && panelWindow.isVisible();
    },

    window(): BrowserWindow | null {
      const window = panelWindow;
      return window && !window.isDestroyed() ? window : null;
    },

    syncToRenderer(reason: string): void {
      applyValues(values, reason);
    },

    tick(now: number): void {
      runTick(now);
    },

    values(): TunableValues {
      return { ...values };
    },

    diagnostics(): PanelDiagnostics {
      const window = panelWindow;
      return {
        exists: window !== null && !window.isDestroyed(),
        visible: window !== null && !window.isDestroyed() && window.isVisible(),
        values: { ...values },
        configPath,
        savedAt,
        lastError,
        renderFactsAt,
        render: renderFacts,
        polls: pollCount,
        ollama: ollama.read(),
        model: backend()?.llmModel() ?? modelOverride ?? FALLBACK_LLM.model,
        cardPath: cardPath(),
        cardSavedAt,
        memoryOps,
      };
    },

    dispose(): void {
      disposed = true;
      removeIpc();
      ollama.dispose();
      const window = panelWindow;
      panelWindow = null;
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}
