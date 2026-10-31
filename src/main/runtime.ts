/**
 * 主进程装配（ADR 0015）：把 orchestrator / voice / 事件总线 / 跨进程通道接起来。
 *
 * 只做装配与 IPC 桥接，不写业务规则：
 * - `cmd:respond`（渲染页/输入条）→ 合成 `user_utterance` 事件 → orchestrator（§6.3 唯一入口）；
 * - `cmd:speech`（渲染侧播放事实）→ voice；
 * - `head_patted`（shell 发）→ orchestrator 的规则池（§9.1 的事件条件）。
 *
 * 启动期校验（§9.1 ③）：`lines.json` 不合法或兜底为空 → 抛错，由 bootstrap 退出进程。
 */
import { readFileSync } from 'node:fs';
import { app, ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { resolveAppConfig } from './config';
import type { AppConfig } from './config';
import { appBus } from './event-bus';
import { logError, logInfo, logWarn } from './log';
import { createMemory } from './memory';
import type { Memory, MemorySnapshot } from './memory';
import { attachUtteranceHandler, createOrchestrator } from './orchestrator';
import type { Orchestrator, OrchestratorSnapshot } from './orchestrator';
import { createLlmClient } from './orchestrator/llm-client';
import type { LlmClient } from './orchestrator/llm-client';
import { createRulePool, parseLinesFile } from './orchestrator/rule-pool';
import type { RulePool } from './orchestrator/rule-pool';
import { createVoice } from './voice';
import type { Voice, VoiceSnapshot } from './voice';
import { createTtsClient } from './voice/gpt-sovits-client';
import type { TtsClient } from './voice/gpt-sovits-client';
import { isSpeechReport } from './voice/report-guard';
import { IPC_CHANNELS } from '../shared/ipc';

/** 角色卡缺失时的最小身份行（不编造人格细节，只保证 LLM 有基本口吻）。 */
const MINIMAL_CARD =
  '你是天童凯伊，千年科学学园的学生，曾与爱丽丝共用同一人格。请用平实、克制、略带傲娇的语气回答，称呼用户为“老师”。';

export interface RuntimeSnapshot {
  orchestrator: OrchestratorSnapshot;
  voice: VoiceSnapshot;
  memory: MemorySnapshot;
  llm: { model: string; baseUrl: string; requestTimeoutMs: number };
  tts: { enabled: boolean; disabledReason: string | null; baseUrl: string };
  data: { cardChars: number; ruleCount: number; fallbackCount: number; dataDir: string };
}

export interface Runtime {
  start(): Promise<void>;
  stop(): void;
  snapshot(): RuntimeSnapshot;
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
  try {
    const text = readFileSync(config.characterCardPath, 'utf8').trim();
    if (text === '') {
      logWarn('orchestrator', '角色卡为空，改用最小身份行', { path: config.characterCardPath });
      return MINIMAL_CARD;
    }
    logInfo('orchestrator', '角色卡已加载', { path: config.characterCardPath, chars: text.length });
    return text;
  } catch (error) {
    logWarn('orchestrator', '角色卡读取失败，改用最小身份行（ADR 0015 D1.8）', {
      path: config.characterCardPath,
      error: String(error),
    });
    return MINIMAL_CARD;
  }
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
  let llm: LlmClient | null = null;
  let tts: TtsClient | null = null;
  let rules: RulePool | null = null;
  let memory: Memory | null = null;
  let cardChars = 0;
  let offUtterance: (() => void) | null = null;
  let offPat: (() => void) | null = null;

  const onSpeech = (_event: IpcMainEvent, report: unknown): void => {
    if (!isSpeechReport(report)) {
      logWarn('voice', 'cmd:speech 载荷非法，已丢弃', report);
      return;
    }
    voice?.handleSpeechReport(report);
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      const appRoot = deps.appRoot ?? app.getAppPath();
      config = resolveAppConfig({ appRoot });

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

      llm = createLlmClient(config.llm);
      logInfo('orchestrator', 'LLM 客户端已装配', {
        baseUrl: llm.baseUrl,
        model: llm.model,
        requestTimeoutMs: llm.requestTimeoutMs,
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

      orchestrator = createOrchestrator({
        bus: appBus,
        voice,
        llm,
        rules,
        card,
        memory,
        log: (level, message, data) =>
          level === 'warn' ? logWarn('orchestrator', message, data) : logInfo('orchestrator', message, data),
      });

      offUtterance = attachUtteranceHandler(appBus, orchestrator);
      offPat = appBus.subscribe('head_patted', (payload) => {
        orchestrator?.handleHeadPatted(payload.patCount);
      });

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
      offUtterance = null;
      offPat = null;
      voice?.dispose();
      orchestrator?.dispose();
      memory?.close();
      voice = null;
      orchestrator = null;
      memory = null;
      logInfo('runtime', '编排与语音链路已停止');
    },

    snapshot(): RuntimeSnapshot {
      if (!orchestrator || !voice || !llm || !tts || !rules || !config || !memory) {
        throw new Error('runtime 尚未 start');
      }
      return {
        orchestrator: orchestrator.snapshot(),
        voice: voice.snapshot(),
        memory: memory.snapshot(),
        llm: { model: llm.model, baseUrl: llm.baseUrl, requestTimeoutMs: llm.requestTimeoutMs },
        tts: { enabled: tts.enabled, disabledReason: tts.disabledReason, baseUrl: tts.baseUrl },
        data: {
          cardChars,
          ruleCount: rules.rules.length,
          fallbackCount: rules.fallbacks.length,
          dataDir: config.dataDir,
        },
      };
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
