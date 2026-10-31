/**
 * orchestrator（契约 §7.6、§8.1、§8.3、§9）。
 *
 * 唯一入口 `respond({text, utteranceId})`，三路分流：
 * ① 规则（台词池，≤5ms，命中即返回）→ ② 本地 LLM（8s 硬超时 + §9.2 校验）→ ③ 兜底。
 * 永不 reject（§7.6）；`cancel()` 只中止在途 LLM，不参与语音停止（那是 respond 开头的 barge-in）。
 *
 * 事件（§6.3）：`intent_resolved` / `llm_failed` 的唯一生产者。动作走
 * `cmd:render-intent`（命令），情绪走 `intent_resolved`（事实）——双轨但只执行一次（§7.3）。
 */
import { LLM_HISTORY_TURNS, MEMORY_RETRIEVE_LIMIT } from '../../shared/constants';
import type { UserUtterancePayload } from '../../shared/events';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { MemoryFact, MemoryPort } from '../../shared/memory-types';
import type { OrchestratorState, Reply } from '../../shared/types';
import type { EventBus } from '../event-bus';
import type { LlmClient, LlmFailureReason } from './llm-client';
import { buildPrompt, formatMemoryFacts } from './prompt';
import type { HistoryTurn } from './prompt';
import { parseAndValidateReply } from './reply-validator';
import type { FallbackEntry, RuleEntry, RulePool } from './rule-pool';

export type ReplyRoute = 'rule' | 'llm' | 'fallback';

export interface VoicePort {
  speak(text: string, utteranceId: string): Promise<'completed' | 'interrupted' | 'failed'>;
  stopSpeaking(reason?: 'interrupt' | 'shutdown'): void;
}

export interface OrchestratorDeps {
  bus: EventBus;
  voice: VoicePort;
  llm: LlmClient;
  rules: RulePool;
  /** data/character-card.md 的正文（缺失时由装配层给最小身份行） */
  card: string;
  /**
   * 记忆端口（契约 §7.5；ADR 0020）。缺省或失败时段 ③ 恒为"（无）"。
   * 只依赖 `MemoryPort` 这个结构化类型——不 import `memory` 的实现，
   * 否则会把原生模块拖进 orchestrator 的依赖图（ADR 0020 D10）。
   */
  memory?: MemoryPort;
  now?: () => number;
  /** 自检/测试可注入确定性 replyId */
  newReplyId?: (utteranceId: string) => string;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export interface Orchestrator {
  /** 契约 §7.6：永不 reject，必定返回合法 Reply */
  respond(input: { text: string; utteranceId: string }): Promise<Reply>;
  /** 契约 §7.6：中断在途 LLM；已发出的回复不回滚 */
  cancel(): void;
  /** 内部：`head_patted` 事件入口（事件也是 §9.1 的规则条件；说话/思考时不打断） */
  handleHeadPatted(patCount: number): void;
  /** 内部诊断（不进 RenderState） */
  snapshot(): OrchestratorSnapshot;
  dispose(): void;
}

export interface OrchestratorSnapshot {
  state: OrchestratorState;
  inflightUtteranceId: string | null;
  llmDisabled: boolean;
  llmHealthChecked: boolean;
  llmModel: string;
  historyTurns: number;
  voiceBusy: boolean;
  lastPatAt: number | null;
}

interface UtteranceSession {
  utteranceId: string;
  controller: AbortController;
  cancelled: boolean;
}

interface FinishInput {
  session: UtteranceSession;
  replyId: string;
  reply: Reply;
  route: ReplyRoute;
  utteranceId: string;
  userText: string | null;
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? Date.now;
  const log =
    deps.log ??
    ((level, message, data) => {
      const line = `[orchestrator] ${message}`;
      if (level === 'warn') console.warn(line, data ?? '');
      else console.log(line, data ?? '');
    });

  let state: OrchestratorState = 'idle';
  let session: UtteranceSession | null = null;
  let llmHealthChecked = false;
  let llmDisabled = false;
  let history: HistoryTurn[] = [];
  let replySeq = 0;
  let voiceBusy = false;
  let lastPatAt: number | null = null;

  function nextReplyId(utteranceId: string): string {
    if (deps.newReplyId) return deps.newReplyId(utteranceId);
    replySeq += 1;
    return `r-${now().toString(36)}-${replySeq}`;
  }

  // 用 voice 的事实事件跟踪"是否在播"，让摸头不打断语音（§5.3）；不新增接口
  const offStarted = deps.bus.subscribe('speech_started', () => {
    voiceBusy = true;
  });
  const offEnded = deps.bus.subscribe('speech_ended', () => {
    voiceBusy = false;
  });

  function emitLlmFailed(
    replyId: string,
    reason: LlmFailureReason | 'invalid_output',
    detail?: string,
  ): void {
    // §6.3 的 reason 只有四值；客户端内部的 'error' 归到 'unavailable'（服务/协议不可用）
    const mapped = reason === 'error' ? 'unavailable' : reason;
    deps.bus.emit('llm_failed', {
      replyId,
      reason: mapped,
      ...(detail ? { detail } : {}),
    });
    log('warn', 'LLM 路径失败，走兜底', { replyId, reason: mapped, detail: detail ?? null });
  }

  function publish(input: FinishInput): Reply {
    if (input.session.cancelled) return input.reply;

    deps.bus.sendCommand(IPC_CHANNELS.renderIntent, { intent: input.reply.intent });
    deps.bus.emit('intent_resolved', {
      replyId: input.replyId,
      text: input.reply.text,
      emotion: input.reply.emotion,
      intent: input.reply.intent,
      route: input.route,
    });

    voiceBusy = true;
    void deps.voice.speak(input.reply.text, input.utteranceId).catch((error: unknown) => {
      log('warn', 'voice.speak 异常（已被内部吞掉，这里只记录）', String(error));
    });

    // §9.3 段 3 / ADR 0020 D5：语音已经下发，记忆异步落库（不挡 TTS）
    scheduleMemoryWrite(input);

    if (input.userText !== null) {
      history.push({ user: input.userText, assistant: input.reply.text });
      if (history.length > LLM_HISTORY_TURNS) history = history.slice(-LLM_HISTORY_TURNS);
    }
    log('info', 'intent_resolved 已发', {
      replyId: input.replyId,
      route: input.route,
      emotion: input.reply.emotion,
      intent: input.reply.intent,
    });
    return input.reply;
  }

  function fromRule(entry: RuleEntry, sessionRef: UtteranceSession, replyId: string, utteranceId: string, userText: string | null): Reply {
    log('info', '规则命中（§9.1 ①）', { ruleId: entry.id, replyId });
    return publish({ session: sessionRef, replyId, reply: entry.reply, route: 'rule', utteranceId, userText });
  }

  function fromFallback(entry: FallbackEntry, sessionRef: UtteranceSession, replyId: string, utteranceId: string, userText: string | null): Reply {
    log('info', '兜底台词（§9.1 ③）', { fallbackId: entry.id, replyId });
    return publish({ session: sessionRef, replyId, reply: entry.reply, route: 'fallback', utteranceId, userText });
  }

  /** 被取消的那次 respond：返回合法 Reply 但绝不发布（否则旧回复会抢新话语）。 */
  function silentFallback(): Reply {
    return deps.rules.fallback().reply;
  }

  /**
   * §9.3 段 3：同步检索（契约要求同步、≤50ms）。任何异常都折算为"没有记忆"，
   * 既不改变路由，也不阻断回复（§11）。
   */
  function retrieveMemory(query: string): MemoryFact[] {
    const memory = deps.memory;
    if (!memory) return [];
    try {
      const facts = memory.retrieve(query, MEMORY_RETRIEVE_LIMIT);
      return Array.isArray(facts) ? facts.slice(0, MEMORY_RETRIEVE_LIMIT) : [];
    } catch (error) {
      log('warn', '记忆检索失败，段 3 按"（无）"继续（§11）', String(error));
      return [];
    }
  }

  /**
   * ADR 0020 D5：发布之后异步写 `kind='user'` 与 `kind='pet'` 两条。
   *
   * - 用 `setImmediate` 排到当前 tick 之后：`voice.speak()` 已经在 `publish()` 里
   *   下发完毕，写库不会挡在 TTS 前面；
   * - 摸头等合成话语（`userText === null`）不写，避免污染记忆；
   * - 写失败由 `memory.write` 自己吞掉，这里再兜一层防止实现违约。
   */
  function scheduleMemoryWrite(input: FinishInput): void {
    const memory = deps.memory;
    const userText = input.userText;
    if (!memory || userText === null || userText === '') return;
    const at = now();
    const utteranceId = input.utteranceId;
    const replyId = input.replyId;
    const petText = input.reply.text;
    setImmediate(() => {
      try {
        memory.write({ kind: 'user', text: userText, at, refId: `${utteranceId}#user` });
        memory.write({ kind: 'pet', text: petText, at, refId: `${replyId}#pet` });
      } catch (error) {
        log('warn', '记忆写入异常（memory.write 应自吞异常，这里兜底）', String(error));
      }
    });
  }

  async function ensureLlmHealthy(): Promise<{ ok: boolean; detail?: string }> {
    if (llmDisabled) return { ok: false, detail: '本会话已熔断' };
    if (llmHealthChecked) return { ok: true };
    llmHealthChecked = true;
    const health = await deps.llm.health();
    if (!health.ok) {
      llmDisabled = true;
      log('warn', '本地 LLM 不可用，本会话不再探测 ②（§11）', {
        reason: health.reason,
        detail: health.detail,
        models: health.models ?? null,
        model: deps.llm.model,
      });
      return { ok: false, detail: health.detail ?? health.reason };
    }
    log('info', '本地 LLM 健康检查通过', { model: health.model, models: health.models ?? null });
    return { ok: true };
  }

  async function respond(input: { text: string; utteranceId: string }): Promise<Reply> {
    // §12：新话语到达 → 先取消在途 LLM，再让 voice 以 interrupted 结束旧语音
    if (session) {
      session.cancelled = true;
      session.controller.abort();
      log('info', '新话语打断在途 LLM（§12）', { previous: session.utteranceId });
    }
    deps.voice.stopSpeaking('interrupt');

    const current: UtteranceSession = {
      utteranceId: input.utteranceId,
      controller: new AbortController(),
      cancelled: false,
    };
    session = current;
    state = 'thinking';

    const replyId = nextReplyId(input.utteranceId);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const startedAt = now();

    try {
      // ① 规则池
      const rule = deps.rules.matchText(text, now());
      if (rule) return fromRule(rule, current, replyId, input.utteranceId, text);

      // ② 本地 LLM
      if (llmDisabled) {
        return fromFallback(
          deps.rules.fallback(),
          current,
          replyId,
          input.utteranceId,
          text,
        );
      }

      const healthy = await ensureLlmHealthy();
      if (current.cancelled) return silentFallback();
      if (!healthy.ok) {
        // 健康检查失败已经在 ensureLlmHealthy 里记过一次；首次仍补一条 llm_failed（§6.3 要求）
        emitLlmFailed(replyId, 'unavailable', healthy.detail);
        return fromFallback(deps.rules.fallback(), current, replyId, input.utteranceId, text);
      }

      const remaining = deps.llm.requestTimeoutMs - (now() - startedAt);
      if (remaining <= 100) {
        emitLlmFailed(replyId, 'timeout', 'thinking 预算已被健康检查耗尽');
        return fromFallback(deps.rules.fallback(), current, replyId, input.utteranceId, text);
      }

      const facts = retrieveMemory(text);
      const memory = formatMemoryFacts(facts);
      const messages = buildPrompt({
        card: deps.card,
        memory,
        history,
        userText: text,
      });
      log('info', 'LLM 请求已装配', {
        replyId,
        hasCard: deps.card.trim().length > 0,
        cardChars: deps.card.length,
        memoryFacts: memory.length,
        historyTurns: history.length,
        systemChars: messages[0]?.content.length ?? 0,
      });

      const result = await deps.llm.chat({
        messages,
        timeoutMs: remaining,
        signal: current.controller.signal,
      });

      if (current.cancelled) {
        if (!result.ok && result.reason === 'aborted') emitLlmFailed(replyId, 'aborted');
        return silentFallback();
      }

      if (!result.ok) {
        if (result.reason === 'aborted') emitLlmFailed(replyId, 'aborted');
        else emitLlmFailed(replyId, result.reason, result.detail);
        if (result.reason === 'unavailable') llmDisabled = true; // 服务中途消失 → 本会话熔断
        return fromFallback(deps.rules.fallback(), current, replyId, input.utteranceId, text);
      }

      // §9.2 校验（不合法即 invalid_output → ③）
      const outcome = parseAndValidateReply(result.content);
      if (!outcome.ok || !outcome.reply) {
        emitLlmFailed(replyId, 'invalid_output', `${String(outcome.reason)}: ${String(outcome.detail ?? '')}`);
        return fromFallback(deps.rules.fallback(), current, replyId, input.utteranceId, text);
      }
      if (outcome.repaired.length > 0) {
        log('warn', 'LLM 输出经清洗/字段修复后通过校验（§9.2）', {
          replyId,
          repaired: outcome.repaired,
        });
      }

      return publish({
        session: current,
        replyId,
        reply: outcome.reply,
        route: 'llm',
        utteranceId: input.utteranceId,
        userText: text,
      });
    } catch (error) {
      log('warn', '编排异常，走兜底（§7.6 永不 reject）', String(error));
      return fromFallback(deps.rules.fallback(), current, replyId, input.utteranceId, text);
    } finally {
      if (session === current) {
        session = null;
        state = 'idle';
      }
    }
  }

  return {
    respond,

    cancel(): void {
      if (!session) return;
      session.cancelled = true;
      session.controller.abort();
      log('info', 'cancel：中止在途 LLM', { utteranceId: session.utteranceId });
    },

    handleHeadPatted(patCount: number): void {
      lastPatAt = now();
      if (state === 'thinking') {
        log('info', '摸头：正在 thinking，跳过台词（不打断在途 LLM）', { patCount });
        return;
      }
      if (voiceBusy) {
        // §5.3：说话时被摸头不打断语音，只做身体反应（render 自己消费 head_patted）
        log('info', '摸头：正在说话，跳过台词（§5.3 不打断语音）', { patCount });
        return;
      }
      const rule = deps.rules.matchPat(now());
      if (!rule) return;
      const utteranceId = `pat-${patCount}-${Math.round(now())}`;
      const replyId = nextReplyId(utteranceId);
      const synthetic: UtteranceSession = {
        utteranceId,
        controller: new AbortController(),
        cancelled: false,
      };
      publish({
        session: synthetic,
        replyId,
        reply: rule.reply,
        route: 'rule',
        utteranceId,
        userText: null,
      });
    },

    snapshot(): OrchestratorSnapshot {
      return {
        state,
        inflightUtteranceId: session?.utteranceId ?? null,
        llmDisabled,
        llmHealthChecked,
        llmModel: deps.llm.model,
        historyTurns: history.length,
        voiceBusy,
        lastPatAt,
      };
    },

    dispose(): void {
      offStarted();
      offEnded();
      if (session) {
        session.cancelled = true;
        session.controller.abort();
        session = null;
      }
    },
  };
}

/** 运行时把 `user_utterance` 绑定到 respond；返回退订函数（§6.4 E-1）。 */
export function attachUtteranceHandler(
  bus: EventBus,
  orchestrator: Orchestrator,
): () => void {
  return bus.subscribe('user_utterance', (payload: UserUtterancePayload) => {
    void orchestrator.respond({ text: payload.text, utteranceId: payload.utteranceId });
  });
}
