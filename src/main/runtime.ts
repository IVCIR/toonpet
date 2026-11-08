/**
 * 主进程装配（ADR 0015）：把 orchestrator / voice / 事件总线 / 跨进程通道接起来。
 *
 * 只做装配与 IPC 桥接，不写业务规则：
 * - `cmd:respond`（渲染页/输入条）→ 合成 `user_utterance` 事件 → orchestrator（§6.3 唯一入口）；
 * - `cmd:speech`（渲染侧播放事实）→ voice；
 * - `head_patted`（shell 发）→ orchestrator 的规则池（§9.1 的事件条件）；
 * - `model_ready`（render 发）→ 生命周期心跳立刻预热一次（ADR 0033 D2）。
 *
 * 启动期校验（§9.1 ③）：`lines.json` 不合法或兜底为空 → 抛错，由 bootstrap 退出进程。
 */
import { readFileSync } from 'node:fs';
import { app, desktopCapturer, ipcMain, screen } from 'electron';
import type { IpcMainEvent } from 'electron';
import {
  PANEL_TTS_TEST_FIRST_BYTE_MS,
  PANEL_TTS_TEST_TEXT,
  PANEL_TTS_TEST_TOTAL_MS,
} from '../shared/constants';
import type { MemoryRecord } from '../shared/memory-types';
import type { PanelTtsTestFacts } from '../shared/panel';
import { resolveAppConfig } from './config';
import type { AppConfig } from './config';
import { MINIMAL_CHARACTER_CARD, readCharacterCard } from './character-card';
import { appBus } from './event-bus';
import { logError, logInfo, logWarn } from './log';
import { createMemory } from './memory';
import type { Memory, MemorySnapshot } from './memory';
import { attachUtteranceHandler, createOrchestrator } from './orchestrator';
import type { Orchestrator, OrchestratorSnapshot } from './orchestrator';
import { createHeartbeat } from './orchestrator/heartbeat';
import type { Heartbeat, HeartbeatSnapshot } from './orchestrator/heartbeat';
import { createLlmProvider } from './orchestrator/llm-client';
import type { LLMProvider } from './orchestrator/llm-client';
import {
  LLM_PROVIDER_MAX_COUNT,
  REMOTE_LLM_HEALTH_TIMEOUT_MS,
  makeLocalOllamaProvider,
  type LlmProviderConfig,
} from '../shared/llm-providers';
import type {
  PanelFetchModelsRequest,
  PanelFetchModelsResult,
  PanelProviderTestFacts,
} from '../shared/panel';
import { createModelListService } from './llm-model-list';
import { createRulePool, parseLinesFile } from './orchestrator/rule-pool';
import type { RulePool } from './orchestrator/rule-pool';
import { isValidModelName, readPanelConfigFile, resolvePanelConfigPath } from './panel-config';
import { createPresence } from './presence';
import type { PresencePort } from '../shared/world-types';
import { resolveHeartbeatGate } from './heartbeat-config';
import { onModelReady, readModelReadyAt, resetModelReady } from './model-ready';
import { resetProactiveStats } from './proactive-stats';
import { resolveProactiveEnabled } from './proactive-config';
import { createVoice } from './voice';
import type { Voice, VoiceSnapshot } from './voice';
import { createTtsClient } from './voice/gpt-sovits-client';
import type { TtsClient } from './voice/gpt-sovits-client';
import { isSpeechReport } from './voice/report-guard';
import { createVisionCapture } from './vision/capture';
import { createVisionController } from './vision/vision-controller';
import type { VisionController, VisionSnapshot } from './vision/vision-controller';
import { createVisionOcrClient } from './vision/vision-service';
import { IPC_CHANNELS } from '../shared/ipc';

/** 角色卡缺失时的最小身份行由 `character-card.ts` 统一提供（ADR 0053），这里只做别名 */
const MINIMAL_CARD = MINIMAL_CHARACTER_CARD;

export interface RuntimeSnapshot {
  orchestrator: OrchestratorSnapshot;
  voice: VoiceSnapshot;
  memory: MemorySnapshot;
  llm: {
    model: string;
    baseUrl: string;
    requestTimeoutMs: number;
    /** ADR 0055：当前生效提供商的身份 */
    providerId: string;
    providerType: string;
    providerName: string;
  };
  tts: { enabled: boolean; disabledReason: string | null; baseUrl: string };
  /** ADR 0054：视觉/OCR 的配置与最近一次查询结果（自检据此断言降级/成功） */
  vision: VisionSnapshot;
  data: { cardChars: number; ruleCount: number; fallbackCount: number; dataDir: string };
  /** ADR 0031 D6：主动性开关的最终裁决结果（自检据此断言"默认硬关"） */
  proactive: {
    enabled: boolean;
    reason: string;
    thresholds: Record<string, number | undefined>;
  };
  /**
   * ADR 0033：生命周期心跳与冷启动预热的诊断读数。
   * 自检据此断言"零后台推理"（`enabled === false && running === false && attempts === 0`）。
   */
  warmup: HeartbeatSnapshot;
}

/**
 * 面板 → 主进程的 AI/记忆管理端口（ADR 0053）。
 *
 * 这些方法**不在模块契约里**（不发事件、不改 `RenderState`），只由控制面板控制器调用；
 * `shell` 不许直接碰 `memory` 或 `llm`。`fetchModels()` 对应只读通道
 * `cmd:fetch-models`（ADR 0056），它仍然只接受面板 sender。
 */
export interface PanelBackend {
  /** 当前生效的模型名（`config.json` 覆盖过环境变量时是覆盖值） */
  llmModel(): string;
  /** 本会话 LLM 是否已被熔断（只读，面板展示用） */
  llmDisabled(): boolean;
  /** ADR 0055：当前所有提供商（含 Key；只在内核/面板控制器之间传递，绝不跨进程） */
  llmProviders(): LlmProviderConfig[];
  /** ADR 0055：当前生效的提供商 id */
  activeProviderId(): string;
  /** 换本地 Ollama 的模型：新 `LlmClient` + 重置编排层健康检查 + 心跳重新预热 */
  applyLlmModel(model: string): PanelLlmChange;
  /** ADR 0055：保存/新增一个提供商；若它是当前生效项则立即换客户端 */
  applyProvider(provider: LlmProviderConfig): PanelLlmChange;
  /** ADR 0055：切换生效提供商 */
  activateProvider(id: string): PanelLlmChange;
  /** ADR 0055：删除提供商（若删的是生效项，自动切到剩下的第一个） */
  deleteProvider(id: string): PanelLlmChange;
  /** ADR 0055：测试一个提供商的连通性（不改变熔断/不写盘） */
  testProvider(id: string): Promise<PanelProviderTestFacts>;
  /**
   * ADR 0056：用临时客户端拉取模型清单（只读；2s 节流在主进程）。
   * 面板只给当前表单的地址与"用户刚输入的 Key"；已保存的 Key 由这里注入。
   */
  fetchModels(request: PanelFetchModelsRequest): Promise<PanelFetchModelsResult>;
  /** 换内存里的角色卡（文件写入由调用方负责，这里只影响下一轮 prompt） */
  applyCharacterCard(text: string): { ok: boolean; error: string | null; chars: number };
  /** TTS 连通性测试（固定文案、短预算、不写记忆、不发事件） */
  testTts(): Promise<PanelTtsTestFacts>;
  /** 最近 N 条记忆（时间倒序） */
  memories(limit: number): MemoryRecord[];
  /** 删除一条；返回是否真的删到 */
  deleteMemory(id: number): boolean;
  /** 清空全部；返回删除行数 */
  clearMemories(): number;
  memoryRows(): number;
  memoryEnabled(): boolean;
  memoryMode(): string;
  memoryDbPath(): string;
  memoryLastError(): string | null;
}

export interface PanelLlmChange {
  ok: boolean;
  error: string | null;
  /** 成功时给人看的一句话（例如"已换成 qwen2.5:7b，下一轮对话用它"） */
  notice: string | null;
  /** ADR 0055：变更后的提供商列表与生效 id（面板据此原子刷新，不靠猜） */
  providers?: LlmProviderConfig[];
  activeProvider?: string;
}

export interface Runtime {
  start(): Promise<void>;
  stop(): void;
  snapshot(): RuntimeSnapshot;
  /** ADR 0053：面板后端（懒取；`start()` 之前调用会得到"未就绪"的明确错误） */
  panel(): PanelBackend;
  /** ADR 0054：视觉/OCR 控制器（`start()` 之前调用会抛错，由装配方兜住） */
  vision(): VisionController;
}

export interface RuntimeDeps {
  appRoot?: string;
}

let current: Runtime | null = null;

/** selftest 读取内部诊断用（不是公共接口，也不跨进程暴露）。 */
export function getRuntime(): Runtime | null {
  return current;
}

function loadCharacterCard(config: AppConfig): string {
  const read = readCharacterCard(config.characterCardPath);
  if (!read.ok) {
    logWarn('orchestrator', '角色卡读取失败，改用最小身份行（ADR 0015 D1.8）', {
      path: config.characterCardPath,
      error: read.error,
    });
    return MINIMAL_CHARACTER_CARD;
  }
  if (read.chars === 0) {
    logWarn('orchestrator', '角色卡为空，改用最小身份行', { path: config.characterCardPath });
    return MINIMAL_CHARACTER_CARD;
  }
  logInfo('orchestrator', '角色卡已加载', { path: config.characterCardPath, chars: read.chars });
  return read.text;
}

function loadRules(config: AppConfig): RulePool {
  let raw: string;
  try {
    raw = readFileSync(config.linesPath, 'utf8');
  } catch (error) {
    throw new Error(`台词池读取失败（§9.1 ③：无兜底不得启动）：${config.linesPath} ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`台词池不是合法 JSON（§9.1 ③）：${String(error)}`);
  }

  const lines = parseLinesFile(parsed);
  logInfo('orchestrator', '台词池已加载', {
    path: config.linesPath,
    rules: lines.rules.length,
    fallbacks: lines.fallbacks.length,
  });
  return createRulePool(lines);
}

function makeRuntime(deps: RuntimeDeps): Runtime {
  let started = false;
  let config: AppConfig | null = null;
  let orchestrator: Orchestrator | null = null;
  let voice: Voice | null = null;
  let llm: LLMProvider | null = null;
  /** ADR 0055：所有已配置提供商（至少包含一个本地 Ollama 回退项） */
  let providers: LlmProviderConfig[] = [];
  let activeProviderId = '';
  let tts: TtsClient | null = null;
  let rules: RulePool | null = null;
  let memory: Memory | null = null;
  let presence: PresencePort | null = null;
  let proactiveGate = { enabled: false, reason: 'not-started', thresholds: {} };
  let heartbeat: Heartbeat | null = null;
  let visionController: VisionController | null = null;
  let cardChars = 0;
  let offUtterance: (() => void) | null = null;
  let offPat: (() => void) | null = null;
  let offModelReady: (() => void) | null = null;

  const onSpeech = (_event: IpcMainEvent, report: unknown): void => {
    if (!isSpeechReport(report)) {
      logWarn('voice', 'cmd:speech 载荷非法，已丢弃', report);
      return;
    }
    voice?.handleSpeechReport(report);
  };

  // ------------------------------------------------------------------
  // ADR 0055：提供商切换（只在主进程内使用；面板经 PanelBackend 调用）
  // ------------------------------------------------------------------

  function providerList(): LlmProviderConfig[] {
    return providers.map((entry) => ({ ...entry }));
  }

  function findProvider(id: string): LlmProviderConfig | null {
    return providers.find((entry) => entry.id === id) ?? null;
  }

  function buildClient(provider: LlmProviderConfig): LLMProvider {
    const localHealthTimeoutMs = config?.llm.healthTimeoutMs ?? 1500;
    return createLlmProvider(provider, {
      // 云端点通常跨公网：800ms 的本地健康预算会把健康服务误判为不可用
      healthTimeoutMs:
        provider.type === 'ollama'
          ? localHealthTimeoutMs
          : Math.max(localHealthTimeoutMs, REMOTE_LLM_HEALTH_TIMEOUT_MS),
      requestTimeoutMs: config?.llm.requestTimeoutMs ?? 15000,
    });
  }

  /**
   * ADR 0056：模型列表拉取器。只存在于主进程，`savedProviders` 直接读闭包里的
   * `providers`（含 Key），因此"编辑时留空 Key"不需要把明文再发给渲染进程。
   * 2s 节流/单飞/缓存都在 `createModelListService` 里，本函数只负责造临时客户端。
   */
  const modelListService = createModelListService({
    savedProviders: () => providers,
    fetchModels: async (provider, timeoutMs) => {
      const client = buildClient(provider);
      return client.fetchModels({ timeoutMs });
    },
  });

  /**
   * 换客户端并**同时清零**编排层健康检查/熔断与心跳预热状态（ADR 0055 D6）。
   * 顺序固定：先建好新客户端，再换；任何一步失败都不会留下半更新的状态。
   */
  function activateProvider(provider: LlmProviderConfig, reason: string): PanelLlmChange {
    if (!started || !config) return { ok: false, error: '编排尚未就绪', notice: null };
    let client: LLMProvider;
    try {
      client = buildClient(provider);
    } catch (error) {
      return { ok: false, error: `创建提供商客户端失败：${String(error)}`, notice: null };
    }
    const previous = llm?.providerId ?? '—';
    llm = client;
    activeProviderId = provider.id;
    config.llm = { ...config.llm, baseUrl: client.baseUrl, model: client.model };
    orchestrator?.replaceLlm(client, reason);
    heartbeat?.retarget(client, reason);
    logInfo('panel', 'LLM 提供商已切换（熔断/预热已清零）', {
      from: previous,
      to: provider.id,
      type: provider.type,
      name: provider.name,
      baseUrl: client.baseUrl,
      model: client.model,
      // 永远只记"有没有 Key"，不记 Key 本身
      apiKey: provider.apiKey === '' ? '未配置' : '已配置',
      reason,
    });
    return {
      ok: true,
      error: null,
      notice: `已切换到 ${provider.name}（${provider.model}），下一轮对话生效`,
      providers: providerList(),
      activeProvider: activeProviderId,
    };
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      const appRoot = deps.appRoot ?? app.getAppPath();
      config = resolveAppConfig({ appRoot });

      // ADR 0053：`config.json` 的 `llm.model` 覆盖 `PET_LLM_MODEL`（面板选过的模型优先）。
      // 说明顺序：环境变量是"默认值来源"，配置文件是"用户显式选择"；两者都不改对方的文件。
      const panelConfigPath = resolvePanelConfigPath(appRoot, process.env);
      const panelConfig = readPanelConfigFile(panelConfigPath);
      if (panelConfig.error) {
        logWarn('panel', 'config.json 有问题，按默认值启动（不影响面板以外的功能）', {
          error: panelConfig.error,
          configPath: panelConfigPath,
        });
      }
      if (panelConfig.llmModel !== null) {
        config.llm = { ...config.llm, model: panelConfig.llmModel };
        logInfo('panel', '模型选择来自 config.json（覆盖 PET_LLM_MODEL）', {
          model: panelConfig.llmModel,
          configPath: panelConfigPath,
        });
      }

      // ADR 0055：解析提供商列表。空配置 = 默认本地 Ollama；若用户只配了远程，
      // 仍追加一个本地 Ollama 作为回退选项（硬约束：本地 Ollama 永远在列表里）。
      const envLocal = makeLocalOllamaProvider(config.llm.model);
      envLocal.baseUrl = config.llm.baseUrl;
      let resolved = panelConfig.llmProviders.map((entry) => ({ ...entry }));
      if (resolved.length === 0) resolved = [envLocal];
      else if (!resolved.some((entry) => entry.type === 'ollama')) resolved = [...resolved, envLocal];
      providers = resolved;
      const wanted = panelConfig.llmActiveProvider;
      activeProviderId =
        wanted !== null && providers.some((entry) => entry.id === wanted)
          ? wanted
          : providers.find((entry) => entry.type === 'ollama')?.id ?? providers[0]?.id ?? '';
      const activeProvider = providers.find((entry) => entry.id === activeProviderId) ?? providers[0]!;
      if (panelConfig.llmProviders.length > 0) {
        logInfo('panel', 'LLM 提供商来自 config.json', {
          activeProvider: activeProviderId,
          providers: providers.map((entry) => ({ id: entry.id, type: entry.type, model: entry.model })),
        });
      }

      const card = loadCharacterCard(config);
      cardChars = card.length;
      rules = loadRules(config);

      tts = createTtsClient(config.tts);
      if (tts.enabled) {
        logInfo('voice', 'TTS 已配置', {
          baseUrl: tts.baseUrl,
          refAudio: config.tts.refAudioPath,
          promptLang: config.tts.promptLang,
          textLang: config.tts.textLang,
          firstByteTimeoutMs: config.tts.firstByteTimeoutMs,
          totalTimeoutMs: config.tts.totalTimeoutMs,
        });
      } else {
        logWarn('voice', 'TTS 未配置：本轮回复只有字幕气泡（§11 TTS 行）', {
          baseUrl: tts.baseUrl,
          reason: tts.disabledReason,
          refAudio: config.tts.refAudioPath,
          promptLang: config.tts.promptLang,
          textLang: config.tts.textLang,
        });
      }

      llm = createLlmProvider(activeProvider, {
        healthTimeoutMs: config.llm.healthTimeoutMs,
        requestTimeoutMs: config.llm.requestTimeoutMs,
      });
      config.llm = { ...config.llm, baseUrl: llm.baseUrl, model: llm.model };
      logInfo('orchestrator', 'LLM 提供商已装配（ADR 0055）', {
        providerId: llm.providerId,
        providerType: llm.providerType,
        providerName: llm.providerName,
        baseUrl: llm.baseUrl,
        model: llm.model,
        requestTimeoutMs: llm.requestTimeoutMs,
        apiKey: activeProvider.apiKey === '' ? '未配置' : '已配置',
      });

      voice = createVoice({
        bus: appBus,
        tts,
        log: (level, message, data) =>
          level === 'warn' ? logWarn('voice', message, data) : logInfo('voice', message, data),
      });

      // ADR 0020：记忆库不是启动必需项。init 失败只降级，不阻止桌宠起来（§11）。
      memory = createMemory({
        log: (level, message, data) =>
          level === 'warn' ? logWarn('memory', message, data) : logInfo('memory', message, data),
      });
      if (config.memory.enabled) {
        try {
          await memory.init(config.memory.dbPath);
        } catch (error) {
          // init 内部已经记过 warn；这里只补一条装配层事实
          logWarn('memory', '记忆初始化失败，本轮段 3 恒为"（无）"（§11）', { error: String(error) });
        }
      } else {
        logWarn('memory', '记忆已被 PET_MEMORY_DISABLE 关闭（段 3 恒为"（无）"）');
      }

      // ADR 0030：在场感（Win32 只读）。它自己 2s 节流、懒采样，不开定时器。
      presence = createPresence({
        log: (level, message, data) =>
          level === 'warn' ? logWarn('presence', message, data) : logInfo('presence', message, data),
      });
      // 启动时先采一次：让第一条日志就能看出"读不读得到空闲毫秒"，而不是等到 90s 后
      const firstPresence = presence.getSnapshot();
      logInfo('presence', '在场感首采', {
        userIdleMs: firstPresence.userIdleMs,
        foregroundTitle: firstPresence.foregroundTitle,
        foregroundClass: firstPresence.foregroundClass,
        // ADR 0032 D1：进提示词的是这一个，原始标题只留在上一行给诊断
        foregroundCategory: firstPresence.foregroundCategory,
      });

      // ADR 0032 D4：托盘的两行诊断是"本进程内"的读数，装配时清零（重启即归零）
      resetProactiveStats();

      proactiveGate = resolveProactiveEnabled();
      if (proactiveGate.enabled) {
        logInfo('orchestrator', '主动性已启用（ADR 0031）', { gate: proactiveGate.reason });
      } else {
        logInfo('orchestrator', '主动性已关闭（ADR 0031）', { gate: proactiveGate.reason });
      }

      orchestrator = createOrchestrator({
        bus: appBus,
        voice,
        llm,
        rules,
        card,
        memory,
        // ADR 0030：在场感只读端口。koffi 缺失时它自己降级成"读不到"，不阻断启动
        presence: presence ?? undefined,
        // ADR 0031：主动性。自检默认硬关（PET_SELFTEST=1），阈值可用 PET_PROACTIVE_* 覆盖
        proactive: { enabled: proactiveGate.enabled, thresholds: proactiveGate.thresholds },
        // ADR 0054：视觉上下文的保鲜期与配置同源
        visionTtlMs: config.vision.contextTtlMs,
        log: (level, message, data) =>
          level === 'warn' ? logWarn('orchestrator', message, data) : logInfo('orchestrator', message, data),
      });

      offUtterance = attachUtteranceHandler(appBus, orchestrator);
      offPat = appBus.subscribe('head_patted', (payload) => {
        orchestrator?.handleHeadPatted(payload.patCount);
      });

      // ADR 0054：视觉/OCR。截图平台能力在这里注入（vision 模块自己不 import electron），
      // 成功后把上下文交给编排层；失败只记 WARN，不影响对话。
      const ocr = createVisionOcrClient({
        enabled: config.vision.enabled,
        baseUrl: config.vision.baseUrl,
        model: config.vision.model,
        prompt: config.vision.prompt,
        apiKey: config.vision.apiKey,
        timeoutMs: config.vision.timeoutMs,
      });
      const capturePort = createVisionCapture({
        getSources: (options) => desktopCapturer.getSources(options),
        getCursorScreenPoint: () => screen.getCursorScreenPoint(),
        getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
        getPrimaryDisplay: () => screen.getPrimaryDisplay(),
      });
      visionController = createVisionController({
        config: config.vision,
        ocr,
        capturePort,
        getForegroundTitle: () => presence?.getSnapshot().foregroundTitle ?? null,
        onContext: (context) => orchestrator?.replaceVision(context, 'vision-query'),
        log: (level, message, data) =>
          level === 'warn' ? logWarn('vision', message, data) : logInfo('vision', message, data),
      });
      if (config.vision.enabled) {
        logInfo('vision', '视觉/OCR 已装配（截图 → OpenAI 兼容 OCR → 段 3.6）', {
          baseUrl: config.vision.baseUrl,
          endpoint: ocr.endpoint,
          model: config.vision.model,
          source: config.vision.source,
          timeoutMs: config.vision.timeoutMs,
          maxImageWidth: config.vision.maxImageWidth,
          contextTtlMs: config.vision.contextTtlMs,
        });
      } else {
        logWarn('vision', '视觉已关闭（PET_VISION_DISABLE=1）：热键与 cmd:vision-query 返回 disabled');
      }

      // ADR 0033 D1：生命周期心跳与主动性**彻底解耦**。它是独立的一个 15s 节拍，
      // 目前只做冷启动预热；`PET_PROACTIVE_DISABLE=1` 关掉的是"要不要打扰"，不是"把模型热好"。
      const warmupGate = resolveHeartbeatGate();
      heartbeat = createHeartbeat({
        llm,
        presence,
        enabled: warmupGate.enabled,
        reason: warmupGate.reason,
        // 只读两个事实：心跳不改编排状态，也不替它做决定（§7.7 I-1）
        host: {
          isBusy: () => {
            const snapshot = orchestrator?.snapshot();
            // 编排层还没装配好 → 按"忙"处理：别在启动窗口里跟模型加载抢 CPU
            if (!snapshot) return true;
            return snapshot.state !== 'idle' || snapshot.inflightUtteranceId !== null || snapshot.voiceBusy;
          },
          isLlmDisabled: () => orchestrator?.snapshot().llmDisabled === true,
        },
        log: (level, message, data) =>
          level === 'warn'
            ? logWarn('heartbeat', message, data)
            : logInfo('heartbeat', message, data),
      });

      // 总闸的裁决结果由 heartbeat.start() 自己记一条（关闭时连定时器都不建，ADR 0033 D1.1）

      // ADR 0033 D2：她站上桌面（`model_ready`）的那一瞬间就发一次预热 ——
      // 这样"她出现"与"模型热好"同时发生，首问不再撞 8s 冷启动预算。
      // 走 `model-ready` 的观察者而不是 `appBus`：后者会把事件回环转发给渲染侧（见该文件注释）。
      offModelReady = onModelReady(() => {
        heartbeat?.warmUpNow('model-ready');
      });

      heartbeat.start();

      // 渲染进程可能比 runtime 装配得更快（自检里实测会发生）：`model_ready` 早到的那一次
      // 由 shell 落的闩锁补回来，否则"最该预热的那一次"恰好会被丢掉（ADR 0033 D2.2）。
      const earlyReadyAt = readModelReadyAt();
      if (earlyReadyAt !== null) {
        logInfo('heartbeat', 'model_ready 早于编排装配完成，补发一次预热', { readyAt: earlyReadyAt });
        heartbeat.warmUpNow('model-ready');
      }

      ipcMain.on(IPC_CHANNELS.speech, onSpeech);

      started = true;
      logInfo('runtime', '编排与语音链路已就绪', {
        dataDir: config.dataDir,
        ruleCount: rules.rules.length,
        fallbackCount: rules.fallbacks.length,
        cardChars,
        memory: memory.snapshot(),
      });
    },

    stop(): void {
      if (!started) return;
      started = false;
      ipcMain.removeListener(IPC_CHANNELS.speech, onSpeech);
      offUtterance?.();
      offPat?.();
      offModelReady?.();
      offUtterance = null;
      offPat = null;
      offModelReady = null;
      // ADR 0033：心跳先停（不再发任何预热请求），再拆编排/语音
      heartbeat?.stop();
      heartbeat = null;
      resetModelReady();
      modelListService.clear();
      visionController?.dispose();
      visionController = null;
      voice?.dispose();
      orchestrator?.dispose();
      memory?.close();
      presence = null;
      voice = null;
      orchestrator = null;
      memory = null;
      logInfo('runtime', '编排与语音链路已停止');
    },

    snapshot(): RuntimeSnapshot {
      if (!orchestrator || !voice || !llm || !tts || !rules || !config || !memory || !heartbeat) {
        throw new Error('runtime 尚未 start');
      }
      const vision = visionController?.snapshot() ?? {
        enabled: false,
        model: '',
        baseUrl: '',
        pending: false,
        lastAt: null,
        lastOk: null,
        lastReason: null,
        lastChars: 0,
        contextAvailable: false,
        contextAt: null,
        queries: 0,
        failures: 0,
      };
      return {
        orchestrator: orchestrator.snapshot(),
        voice: voice.snapshot(),
        memory: memory.snapshot(),
        llm: {
          model: llm.model,
          baseUrl: llm.baseUrl,
          requestTimeoutMs: llm.requestTimeoutMs,
          providerId: llm.providerId,
          providerType: llm.providerType,
          providerName: llm.providerName,
        },
        tts: { enabled: tts.enabled, disabledReason: tts.disabledReason, baseUrl: tts.baseUrl },
        vision,
        data: {
          cardChars,
          ruleCount: rules.rules.length,
          fallbackCount: rules.fallbacks.length,
          dataDir: config.dataDir,
        },
        proactive: { ...proactiveGate, thresholds: { ...proactiveGate.thresholds } },
        warmup: heartbeat.snapshot(),
      };
    },

    /**
     * ADR 0053：面板后端。
     *
     * 每个方法都先检查 `started`：面板可能比 runtime 先创建（例如启动失败时用户点开了面板），
     * 那时必须给出"未就绪"，而不是抛异常把 IPC 打成 rejected。
     */
    panel(): PanelBackend {
      const notReady = (error: string): PanelLlmChange => ({ ok: false, error, notice: null });
      const isReady = (): boolean => started && config !== null;

      return {
        llmModel(): string {
          return llm?.model ?? config?.llm.model ?? '—';
        },

        llmDisabled(): boolean {
          try {
            return orchestrator?.snapshot().llmDisabled === true;
          } catch {
            return false;
          }
        },

        llmProviders(): LlmProviderConfig[] {
          return providerList();
        },

        activeProviderId(): string {
          return activeProviderId;
        },

        applyLlmModel(model: string): PanelLlmChange {
          if (!isReady() || !config) return notReady('编排尚未就绪');
          const next = typeof model === 'string' ? model.trim() : '';
          if (!isValidModelName(next)) return notReady('模型名不合法');
          // ADR 0055：旧的"本地模型"入口只改 Ollama 提供商；远端提供商请用 provider-* 动作
          const ollama = providers.find((entry) => entry.type === 'ollama');
          if (!ollama) return notReady('配置里没有 Ollama 提供商');
          if (ollama.model === next && activeProviderId === ollama.id) {
            return { ok: true, error: null, notice: `已经在用 ${next}`, providers: providerList(), activeProvider: activeProviderId };
          }
          ollama.model = next;
          if (activeProviderId === ollama.id) {
            const change = activateProvider(ollama, 'panel-model');
            if (!change.ok) return change;
            return { ...change, notice: `已换成 ${next}，下一轮对话生效` };
          }
          logInfo('panel', '本地 Ollama 模型已更新（未激活，不换客户端）', {
            model: next,
            providerId: ollama.id,
          });
          return {
            ok: true,
            error: null,
            notice: `已更新本地模型为 ${next}（当前未激活）`,
            providers: providerList(),
            activeProvider: activeProviderId,
          };
        },

        applyProvider(provider: LlmProviderConfig): PanelLlmChange {
          if (!isReady()) return notReady('编排尚未就绪');
          const index = providers.findIndex((entry) => entry.id === provider.id);
          if (index >= 0) providers[index] = { ...provider };
          else if (providers.length >= LLM_PROVIDER_MAX_COUNT) {
            return notReady(`最多 ${LLM_PROVIDER_MAX_COUNT} 个提供商`);
          } else providers.push({ ...provider });
          if (provider.id === activeProviderId) {
            return activateProvider(provider, 'panel-provider-save');
          }
          // 非当前生效项：只更新列表，不换在跑的客户端
          logInfo('panel', '提供商配置已更新（非当前生效项）', {
            providerId: provider.id,
            type: provider.type,
            model: provider.model,
          });
          return {
            ok: true,
            error: null,
            notice: `已保存 ${provider.name}`,
            providers: providerList(),
            activeProvider: activeProviderId,
          };
        },

        activateProvider(id: string): PanelLlmChange {
          if (!isReady()) return notReady('编排尚未就绪');
          const provider = findProvider(id);
          if (!provider) return notReady(`没有这个提供商：${id}`);
          return activateProvider(provider, 'panel-provider-activate');
        },

        deleteProvider(id: string): PanelLlmChange {
          if (!isReady()) return notReady('编排尚未就绪');
          const provider = findProvider(id);
          if (!provider) return notReady(`没有这个提供商：${id}`);
          if (providers.length <= 1) return notReady('至少要保留一个提供商');
          // 本地 Ollama 是默认回退选项（ADR 0055 D2）：可以换模型，但不能把最后一个删掉
          if (provider.type === 'ollama' && providers.filter((entry) => entry.type === 'ollama').length <= 1) {
            return notReady('至少要保留一个本地 Ollama 作为回退选项');
          }
          providers = providers.filter((entry) => entry.id !== id);
          if (activeProviderId === id) {
            const next = providers[0]!;
            const change = activateProvider(next, 'panel-provider-delete');
            if (!change.ok) return change;
            return { ...change, notice: `已删除 ${provider.name}，并切回 ${next.name}` };
          }
          logInfo('panel', '提供商已删除（非当前生效项）', { providerId: id, type: provider.type });
          return {
            ok: true,
            error: null,
            notice: `已删除 ${provider.name}`,
            providers: providerList(),
            activeProvider: activeProviderId,
          };
        },

        async testProvider(id: string): Promise<PanelProviderTestFacts> {
          const provider = findProvider(id);
          const at = new Date().toISOString();
          if (!provider) {
            return {
              id,
              status: 'failed',
              detail: '没有这个提供商',
              latencyMs: null,
              reachable: false,
              modelPresent: null,
              checkedAt: at,
            };
          }
          const startedAt = Date.now();
          try {
            const client = buildClient(provider);
            const health = await client.health();
            const latencyMs = Math.max(0, Date.now() - startedAt);
            return {
              id,
              status: health.ok ? 'ok' : 'failed',
              detail:
                health.ok === true
                  ? health.detail ??
                    `${provider.type === 'ollama' ? 'Ollama' : '端点'}可用${health.models && health.models.length > 0 ? ` · ${health.models.length} 个模型` : ''}`
                  : health.detail ?? health.reason ?? '连接失败',
              latencyMs,
              reachable: health.reachable === true,
              modelPresent: health.modelPresent ?? null,
              checkedAt: at,
            };
          } catch (error) {
            return {
              id,
              status: 'failed',
              detail: String(error),
              latencyMs: Math.max(0, Date.now() - startedAt),
              reachable: false,
              modelPresent: null,
              checkedAt: at,
            };
          }
        },

        async fetchModels(request: PanelFetchModelsRequest): Promise<PanelFetchModelsResult> {
          if (!isReady()) return { ok: false, error: '编排尚未就绪' };
          const startedAt = Date.now();
          const result = await modelListService.fetch(request);
          const durationMs = Math.max(0, Date.now() - startedAt);
          const requestType = typeof request?.type === 'string' ? request.type : null;
          const requestBaseUrl = typeof request?.baseUrl === 'string' ? request.baseUrl : null;
          const requestProviderId =
            typeof request?.providerId === 'string' ? request.providerId : null;
          const requestApiKey =
            typeof request?.apiKey === 'string' && request.apiKey !== ''
              ? '已输入'
              : '沿用已保存/未配置';
          if (result.ok) {
            logInfo('panel', '模型列表已拉取', {
              type: requestType,
              baseUrl: requestBaseUrl,
              providerId: requestProviderId,
              apiKey: requestApiKey,
              models: result.models.length,
              durationMs,
            });
          } else {
            logWarn('panel', '模型列表拉取失败（面板显示红色提示，仍可手填保存）', {
              type: requestType,
              baseUrl: requestBaseUrl,
              providerId: requestProviderId,
              apiKey: requestApiKey,
              error: result.error,
              durationMs,
            });
          }
          return result;
        },

        applyCharacterCard(text: string): { ok: boolean; error: string | null; chars: number } {
          if (!isReady() || !orchestrator) {
            return { ok: false, error: '编排尚未就绪', chars: 0 };
          }
          const next = typeof text === 'string' ? text.trim() : '';
          if (next === '') return { ok: false, error: '角色卡不能为空', chars: 0 };
          orchestrator.replaceCard(next, 'panel');
          cardChars = [...next].length;
          return { ok: true, error: null, chars: cardChars };
        },

        async testTts(): Promise<PanelTtsTestFacts> {
          const base: PanelTtsTestFacts = {
            ok: false,
            enabled: false,
            baseUrl: config?.tts.baseUrl ?? '',
            refAudioPath: config?.tts.refAudioPath ?? '',
            ms: null,
            bytes: null,
            reason: null,
            detail: null,
          };
          if (!isReady() || !config) {
            return { ...base, reason: 'unavailable', detail: '编排尚未就绪' };
          }
          // 用**独立**的短预算客户端：真实回复的预算（首字节 ~30s）不适合一个按钮
          const probe = createTtsClient({
            ...config.tts,
            firstByteTimeoutMs: PANEL_TTS_TEST_FIRST_BYTE_MS,
            totalTimeoutMs: PANEL_TTS_TEST_TOTAL_MS,
          });
          if (!probe.enabled) {
            logWarn('voice', 'TTS 连通性测试未发出：配置不全', { detail: probe.disabledReason });
            return { ...base, enabled: false, reason: 'disabled', detail: probe.disabledReason };
          }
          const startedAt = Date.now();
          const result = await probe.synthesize(PANEL_TTS_TEST_TEXT);
          const ms = Math.max(0, Date.now() - startedAt);
          if (result.ok) {
            logInfo('voice', 'TTS 连通性测试通过', { ms, bytes: result.audio.byteLength });
            return {
              ...base,
              ok: true,
              enabled: true,
              ms,
              bytes: result.audio.byteLength,
              reason: null,
              detail: null,
            };
          }
          logWarn('voice', 'TTS 连通性测试失败', { ms, reason: result.reason, detail: result.detail ?? null });
          return {
            ...base,
            enabled: true,
            ms,
            reason: result.reason,
            detail: result.detail ?? null,
          };
        },

        memories(limit: number): MemoryRecord[] {
          if (!memory) return [];
          return memory.listRecent(limit);
        },

        deleteMemory(id: number): boolean {
          if (!memory) return false;
          return memory.deleteById(id);
        },

        clearMemories(): number {
          if (!memory) return 0;
          return memory.clearAll();
        },

        memoryRows(): number {
          if (!memory) return 0;
          try {
            return memory.snapshot().rows;
          } catch {
            return 0;
          }
        },

        memoryEnabled(): boolean {
          return memory?.snapshot().enabled === true;
        },

        memoryMode(): string {
          return memory?.snapshot().mode ?? 'disabled';
        },

        memoryDbPath(): string {
          return config?.memory.dbPath ?? '';
        },

        memoryLastError(): string | null {
          return memory?.snapshot().lastError ?? null;
        },
      };
    },

    vision(): VisionController {
      if (!visionController) throw new Error('runtime 尚未 start（视觉控制器未装配）');
      return visionController;
    },
  };
}

export function createRuntime(deps: RuntimeDeps = {}): Runtime {
  const runtime = makeRuntime(deps);
  current = runtime;
  return runtime;
}

/** bootstrap 用的单例装配；重复调用返回同一个实例。 */
export function ensureRuntime(): Runtime {
  if (!current) current = makeRuntime({});
  return current;
}

/** 启动期装配失败的可读出口（bootstrap 捕获后退出）。 */
export function logRuntimeFailure(error: unknown): void {
  logError('runtime', '装配失败（§9.1 ③：拒绝启动）', error);
}
