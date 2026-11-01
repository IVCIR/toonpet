/**
 * orchestrator（契约 §7.6、§8.1、§8.3、§9；ADR 0030 / ADR 0031）。
 *
 * 唯一入口 `respond({text, utteranceId})`，三路分流：
 * ① 规则（台词池，≤5ms，命中即返回）→ ② 本地 LLM（8s 硬超时 + §9.2 校验）→ ③ 兜底。
 * 永不 reject（§7.6）；`cancel()` 只中止在途 LLM，不参与语音停止（那是 respond 开头的 barge-in）。
 *
 * 事件（§6.3）：`intent_resolved` / `llm_failed` 的唯一生产者。动作走
 * `cmd:render-intent`（命令），情绪走 `intent_resolved`（事实）——双轨但只执行一次（§7.3）。
 *
 * 本轮新增（ADR 0031）：
 * - **段 3.5 环境事实**：`respond()` 与主动路径都把 `WorldFacts` 交给 `buildPrompt`；
 * - **idle-drive**：每 15s 评估一次"要不要主动开口"，先规则池（`on:'idle'`）再 LLM（3s 超时）；
 * - 主动路径失败**不播兜底**、**不写 memory.db**，但**必须进对话历史**（D5）。
 *
 * 本轮新增（ADR 0032）：
 * - **冷启动预热**：独立于对话的 `/api/generate` 1-token 请求（不建会话、不改熔断、不发事件，D3）；
 * - **托盘诊断数据源**：每次判定/开口把 `proactiveCount` 与 `lastProactiveSkip` 写进
 *   `proactive-stats` 单例，供 `shell` 的托盘菜单只读展示（D4）。
 *
 * 本轮迁移（ADR 0033）：预热**已搬出**本模块——它现在归 `heartbeat.ts` 的生命周期心跳。
 * 理由：预热挂在 idle-drive 的节拍上时，`PET_PROACTIVE_DISABLE=1` 会顺带把它一起关掉；
 * 而"要不要打扰老师"与"把本地模型热好"是两件事。编排层从此**不再认识"预热"这个概念**。
 */
import {
  LLM_HISTORY_TURNS,
  MEMORY_RETRIEVE_LIMIT,
  PROACTIVE_LLM_TIMEOUT_MS,
  PROACTIVE_TICK_MS,
} from '../../shared/constants';
import type { UserUtterancePayload } from '../../shared/events';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { MemoryFact, MemoryPort } from '../../shared/memory-types';
import type { OrchestratorState, Reply } from '../../shared/types';
import type { PresencePort, PresenceSnapshot, WorldFacts } from '../../shared/world-types';
import type { EventBus } from '../event-bus';
import { publishProactiveStats } from '../proactive-stats';
import { evaluateIdleDrive } from './idle-drive';
import type { IdleDriveReason, IdleDriveThresholds } from './idle-drive';
import type { LlmClient, LlmFailureReason } from './llm-client';
import { buildPrompt, formatMemoryFacts } from './prompt';
import type { HistoryTurn } from './prompt';
import { parseAndValidateReply } from './reply-validator';
import type { FallbackEntry, RuleEntry, RulePool } from './rule-pool';
import { buildWorldFacts } from './world';

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
  /**
   * 在场感只读端口（ADR 0030）。缺省时：段 3.5 不注入、idle-drive 永远不触发
   * （"读不到就不打扰"的退化路径，ADR 0031 D2.3）。与 `memory` 同一手法——只依赖结构化端口。
   */
  presence?: PresencePort;
  /**
   * 主动性引擎（ADR 0031）。**缺省关闭**：不传就一个定时器都不建，
   * 因此现有单测（不传该字段）行为与 1.9.0 完全一致。
   */
  proactive?: ProactiveOptions;
  now?: () => number;
  /** 自检/测试可注入确定性 replyId */
  newReplyId?: (utteranceId: string) => string;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

/** 主动性引擎的可注入配置（ADR 0031 D6）。 */
export interface ProactiveOptions {
  enabled: boolean;
  /** 评估节拍；缺省 `PROACTIVE_TICK_MS`（15s）。**不是**指针轮询器 */
  intervalMs?: number;
  /** 阈值覆盖（自检/单测压时间用） */
  thresholds?: Partial<IdleDriveThresholds>;
  /** 注入定时器（单测用假定时器）；缺省 `setInterval` */
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * 主动话语进历史时占位的"用户侧"（ADR 0031 D5）。
 * 它不是用户说的话，只是一条舞台指示：让她下一轮知道"我自己开过口"。
 */
export const PROACTIVE_HISTORY_USER = '（彼女が自分から話しかけた）';

/**
 * 主动路径给模型的"用户侧"输入（ADR 0031 D4.3）。
 * 同样是舞台指示，不是用户话语；**不写入历史、不写 memory.db、不进日志正文**。
 */
export const PROACTIVE_PROMPT_USER =
  '（いま先生は静かにしています。あなたから短く話しかけてください。説教や質問攻めはしないこと。）';

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
  /** ADR 0031：主动性引擎是否真的被装配（自检据此断言"默认硬关"） */
  proactiveEnabled: boolean;
  /** 本会话已主动开口次数（规则 + LLM 合并计） */
  proactiveCount: number;
  lastProactiveAt: number | null;
  /** 上一次评估为什么没开口（`ok` 表示上一次是"开了"，诊断用） */
  lastProactiveSkip: IdleDriveReason | null;
  lastInteractionAt: number | null;
  /** 段 3.5 是否会带"输入状态"：false = presence 读不到空闲毫秒 */
  presenceIdleKnown: boolean;
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
  /** ADR 0031 D5：主动话语——进历史，但**不**写 memory.db */
  proactive?: boolean;
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

  // --- ADR 0031：主动性的全部状态（都在内存里，重启归零） ---
  /** 本进程启动时刻：本会话还没有任何交互时，idle-drive 用它当 gap 的基准 */
  const sessionStartedAt = now();
  let lastInteractionAt: number | null = null;
  let lastProactiveAt: number | null = null;
  let proactiveCount = 0;
  let lastProactiveSkip: IdleDriveReason | null = null;
  let proactiveTimer: unknown = null;

  function nextReplyId(utteranceId: string): string {
    if (deps.newReplyId) return deps.newReplyId(utteranceId);
    replySeq += 1;
    return `r-${now().toString(36)}-${replySeq}`;
  }

  function pushHistory(user: string, assistant: string): void {
    history.push({ user, assistant });
    if (history.length > LLM_HISTORY_TURNS) history = history.slice(-LLM_HISTORY_TURNS);
  }

  /**
   * 段 3.5 的输入（ADR 0030 D2）。`presence` 缺省时返回的 `userIdleMs` 为 `null`，
   * 于是段 3.5 只剩时间戳——仍然有"时间感"，只是没有"在场感"。
   */
  function buildWorld(at: number): WorldFacts {
    return buildWorldFacts({
      now: at,
      presence: deps.presence?.getSnapshot() ?? null,
      lastInteractionAt,
    });
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

    if (input.proactive === true) {
      // ADR 0031 D5：主动话语必须进历史，否则下一轮模型不知道自己刚说过什么，会重复同一句话。
      // 注意：`userText` 仍为 null，所以 memory.db 不会写入（D5.2：自言自语不污染长期记忆）。
      pushHistory(PROACTIVE_HISTORY_USER, input.reply.text);
    } else if (input.userText !== null) {
      pushHistory(input.userText, input.reply.text);
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
    // ADR 0031 D2：任何用户话语都算一次交互——idle-drive 的 90s gap 从这里重新计时
    lastInteractionAt = now();

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
      const memory = formatMemoryFacts(facts, MEMORY_RETRIEVE_LIMIT, now());
      const messages = buildPrompt({
        card: deps.card,
        memory,
        history,
        userText: text,
        // ADR 0030 D2：段 3.5。presence 缺省时只有时间戳，仍然比 1.9.0 多一个"此刻"
        world: buildWorld(now()),
      });
      log('info', 'LLM 请求已装配', {
        replyId,
        hasCard: deps.card.trim().length > 0,
        cardChars: deps.card.length,
        memoryFacts: memory.length,
        historyTurns: history.length,
        systemChars: messages[0]?.content.length ?? 0,
        hasWorld: true,
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

  // ------------------------------------------------------------------
  // ADR 0031：主动性引擎（idle-drive 的判定逻辑全在 idle-drive.ts，这里只做接线）
  // ------------------------------------------------------------------

  /**
   * 主动路径能不能升级到 LLM（ADR 0031 D4.1）。
   *
   * 只有"本会话已经成功做过一次健康检查、且没有熔断"才允许。
   * 理由：§11 的熔断语义是**用户触发的**——不能让桌宠自己的后台探测把 LLM 判死，
   * 否则一次空闲时的心血来潮会改变用户后续每一次交互的路由。
   */
  function llmUsable(): boolean {
    return llmHealthChecked && !llmDisabled;
  }

  function proactiveDecision(at: number, presence: PresenceSnapshot | null) {
    return evaluateIdleDrive({
      enabled: deps.proactive?.enabled === true,
      now: at,
      sessionStartedAt,
      orchestratorIdle: state === 'idle' && session === null,
      voiceBusy,
      userIdleMs: presence?.userIdleMs ?? null,
      lastInteractionAt,
      lastProactiveAt,
      firedCount: proactiveCount,
      llmUsable: llmUsable(),
      ...(deps.proactive?.thresholds ? { thresholds: deps.proactive.thresholds } : {}),
    });
  }

  /**
   * 发布一次主动话语（ADR 0031 D5）。
   * `userText: null` → 不写 memory.db；`proactive: true` → 进对话历史。
   */
  function publishProactive(reply: Reply, route: ReplyRoute, utteranceId: string): Reply {
    const at = now();
    proactiveCount += 1;
    lastProactiveAt = at;
    lastProactiveSkip = 'ok';
    // ADR 0032 D4：托盘的两行诊断就从这里拿到最新读数（发布即计数，失败不计）
    publishProactiveStats({ firedCount: proactiveCount, lastReason: 'ok' }, at);
    return publish({
      session: { utteranceId, controller: new AbortController(), cancelled: false },
      replyId: `p-${at.toString(36)}-${proactiveCount}`,
      reply,
      route,
      utteranceId,
      userText: null,
      proactive: true,
    });
  }

  /**
   * 每 15s 评估一次：先规则（零延迟），规则没有可说的才考虑 LLM（3s）。
   *
   * 这里**不再**预热：预热归 `heartbeat.ts`（ADR 0033）。旧实现把预热塞在本节拍的第一件事里，
   * 于是"关掉主动性"等于"永远不预热"；如果谁想把它挪回来，请先读 ADR 0033 D1。
   */
  function tickProactive(): void {
    const opts = deps.proactive;
    if (!opts?.enabled) return;
    const at = now();
    const presence = deps.presence?.getSnapshot() ?? null;

    const decision = proactiveDecision(at, presence);
    lastProactiveSkip = decision.reason;
    publishProactiveStats({ firedCount: proactiveCount, lastReason: lastProactiveSkip }, at);
    if (!decision.fire) {
      // 把 userIdleMs 与 gap 一起打出来：排查"她为什么不说话"时，这两个数字就是答案。
      // gap 的基准与 evaluateIdleDrive 保持一致（无交互时以"最后一次输入"为准），
      // 否则日志会显示 gapMs:0 而实际判定用的是 idle —— 诊断信息必须与判定同源。
      const reference =
        lastInteractionAt ??
        (presence?.userIdleMs !== null && presence?.userIdleMs !== undefined
          ? at - presence.userIdleMs
          : sessionStartedAt);
      log('info', 'idle-drive：不开口', {
        reason: decision.reason,
        userIdleMs: presence?.userIdleMs ?? null,
        gapMs: Math.max(0, at - reference),
        hour: decision.hour,
        night: decision.night,
        budget: decision.budget,
        remaining: decision.remaining,
      });
      return;
    }

    // ① 规则池：`data/lines.json` 的 `on:'idle'` 条目（零推理、零延迟）
    const rule = deps.rules.matchIdle(at);
    if (rule) {
      log('info', 'idle-drive：规则命中，主动开口（§9.1 ①）', {
        ruleId: rule.id,
        remaining: decision.remaining,
      });
      publishProactive(rule.reply, 'rule', `idle-rule-${at.toString(36)}`);
      return;
    }

    // ② LLM：3s 超时；**失败即沉默**，不播兜底、不发 llm_failed（ADR 0031 D4.2）
    if (!decision.allowLlm) {
      // 判定通过但"没有台词可说"：托盘若显示"已开口"就是在撒谎，这里如实记一条静默原因
      publishProactiveStats({ firedCount: proactiveCount, lastReason: 'no-lines' }, at);
      log('info', 'idle-drive：无空闲台词且 LLM 不可用，保持沉默');
      return;
    }
    void proactiveLlm(at);
  }

  async function proactiveLlm(at: number): Promise<void> {
    const current: UtteranceSession = {
      utteranceId: `idle-llm-${at.toString(36)}`,
      controller: new AbortController(),
      cancelled: false,
    };
    session = current;
    state = 'thinking';
    try {
      const messages = buildPrompt({
        card: deps.card,
        // 主动路径不检索记忆：没有用户查询词，硬造一个只会引入噪声（ADR 0031 D4.4）
        memory: [],
        history,
        userText: PROACTIVE_PROMPT_USER,
        world: buildWorld(at),
      });
      const result = await deps.llm.chat({
        messages,
        timeoutMs: PROACTIVE_LLM_TIMEOUT_MS,
        signal: current.controller.signal,
      });
      // 用户在这 3s 内说话了 → 让位，一个字都不发
      if (current.cancelled) {
        // 让位不算"她失败"：下一拍 idle-drive 会以 busy/其它原因覆盖这一行
        log('info', 'idle-drive：被用户打断，放弃本次主动话语');
        return;
      }
      if (!result.ok) {
        publishProactiveStats({ firedCount: proactiveCount, lastReason: 'llm-failed' }, now());
        log('warn', 'idle-drive：LLM 未产出，保持沉默（不播兜底）', { reason: result.reason });
        return;
      }
      const outcome = parseAndValidateReply(result.content);
      if (!outcome.ok || !outcome.reply) {
        publishProactiveStats({ firedCount: proactiveCount, lastReason: 'llm-failed' }, now());
        log('warn', 'idle-drive：LLM 输出不合法，保持沉默', {
          reason: String(outcome.reason),
          detail: String(outcome.detail ?? ''),
        });
        return;
      }
      publishProactive(outcome.reply, 'llm', current.utteranceId);
    } catch (error) {
      publishProactiveStats({ firedCount: proactiveCount, lastReason: 'llm-failed' }, now());
      log('warn', 'idle-drive：LLM 异常，保持沉默', String(error));
    } finally {
      if (session === current) {
        session = null;
        state = 'idle';
      }
    }
  }

  function startProactiveTimer(): void {
    const opts = deps.proactive;
    if (!opts?.enabled) {
      // ADR 0032 D4：没开主动性时托盘也要能说清"为什么没开"，
      // 而不是留一个含糊的"尚未评估"（自检里主动性是硬关的，正好走这一条）。
      publishProactiveStats({ firedCount: 0, lastReason: 'disabled' }, now());
      return;
    }
    const intervalMs = opts.intervalMs ?? PROACTIVE_TICK_MS;
    const schedule =
      opts.schedule ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
    proactiveTimer = schedule(() => {
      try {
        tickProactive();
      } catch (error) {
        // 主动路径崩了绝不能拖垮主链路：吞掉、记一条、下个节拍继续
        log('warn', 'idle-drive 评估异常（已忽略，下个节拍继续）', String(error));
      }
    }, intervalMs);
    log('info', 'idle-drive 已装配（ADR 0031）', { intervalMs });
  }

  function stopProactiveTimer(): void {
    if (proactiveTimer === null) return;
    const cancel =
      deps.proactive?.cancel ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
    try {
      cancel(proactiveTimer);
    } catch (error) {
      log('warn', 'idle-drive 定时器停止失败（进程退出时无所谓）', String(error));
    }
    proactiveTimer = null;
  }

  startProactiveTimer();

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
      // 摸头也是"用户在交互"：主动性的 90s gap 从此重新计时（ADR 0031 D2.1）
      lastInteractionAt = now();
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
        proactiveEnabled: deps.proactive?.enabled === true,
        proactiveCount,
        lastProactiveAt,
        lastProactiveSkip,
        lastInteractionAt,
        presenceIdleKnown: (deps.presence?.getSnapshot().userIdleMs ?? null) !== null,
      };
    },

    dispose(): void {
      stopProactiveTimer();
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
