import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventName, EventPayloads } from '../../shared/events';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { MemoryFact, MemoryPort, MemoryWrite } from '../../shared/memory-types';
import type { PresencePort } from '../../shared/world-types';
import type { EventBus, RendererSink } from '../event-bus';
import { readProactiveStats, resetProactiveStats } from '../proactive-stats';
import { PROACTIVE_HISTORY_USER, PROACTIVE_PROMPT_USER, createOrchestrator } from './index';
import type { Orchestrator, ProactiveOptions, VoicePort } from './index';
import type { LlmChatRequest, LlmChatResult, LlmClient, LlmHealth } from './llm-client';
import { buildPrompt, formatMemoryFacts } from './prompt';
import { createRulePool, parseLinesFile } from './rule-pool';

// ---------------------------------------------------------------------------
// 测试替身（§7.7 I-4：桩实现同一接口，不往公共接口塞 _forTest）
// ---------------------------------------------------------------------------

class FakeBus implements EventBus {
  readonly events: Array<{ name: EventName; payload: EventPayloads[EventName] }> = [];
  readonly commands: Array<{ channel: string; payload: unknown }> = [];
  readonly order: string[] = [];
  private readonly handlers = new Map<string, Set<(payload: never) => void>>();

  setRendererSink(_sink: RendererSink | null): void {
    void _sink;
  }

  emit<K extends EventName>(name: K, payload: EventPayloads[K]): void {
    this.events.push({ name, payload });
    this.order.push(`evt:${name}`);
    for (const handler of [...(this.handlers.get(name) ?? [])]) {
      (handler as (value: EventPayloads[K]) => void)(payload);
    }
  }

  subscribe<K extends EventName>(name: K, handler: (payload: EventPayloads[K]) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    const stored = handler as unknown as (payload: never) => void;
    set.add(stored);
    return () => set?.delete(stored);
  }

  sendCommand(channel: string, payload: unknown): boolean {
    this.commands.push({ channel, payload });
    this.order.push(`cmd:${channel}`);
    return true;
  }

  named<K extends EventName>(name: K): EventPayloads[K][] {
    return this.events.filter((event) => event.name === name).map((event) => event.payload as EventPayloads[K]);
  }
}

interface FakeVoice extends VoicePort {
  readonly speaks: Array<{ text: string; utteranceId: string }>;
  readonly stops: string[];
}

function makeVoice(override?: Partial<VoicePort>): FakeVoice {
  const speaks: Array<{ text: string; utteranceId: string }> = [];
  const stops: string[] = [];
  return {
    speaks,
    stops,
    speak(text: string, utteranceId: string): Promise<'completed' | 'interrupted' | 'failed'> {
      speaks.push({ text, utteranceId });
      return Promise.resolve('completed');
    },
    stopSpeaking(reason): void {
      stops.push(reason ?? 'interrupt');
    },
    ...override,
  };
}

interface FakeLlm extends LlmClient {
  healthCalls: number;
  chatCalls: number;
  lastRequest: LlmChatRequest | null;
}

function makeLlm(options: {
  health?: LlmHealth;
  chat?: (request: LlmChatRequest) => Promise<LlmChatResult>;
} = {}): FakeLlm {
  const llm: FakeLlm = {
    model: 'fake:1b',
    baseUrl: 'http://127.0.0.1:11434',
    requestTimeoutMs: 8000,
    healthCalls: 0,
    chatCalls: 0,
    lastRequest: null,
    async health(): Promise<LlmHealth> {
      llm.healthCalls += 1;
      return options.health ?? { ok: true, model: 'fake:1b' };
    },
    async chat(request: LlmChatRequest): Promise<LlmChatResult> {
      llm.chatCalls += 1;
      llm.lastRequest = request;
      if (options.chat) return options.chat(request);
      return { ok: true, content: '{"text":"老师，我在。","emotion":"neutral","intent":"nod"}' };
    },
  };
  // ADR 0033：预热已迁到 `heartbeat.ts`，编排层的桩不再需要 `warmup`
  // （不实现它恰好也验证了"客户端没有预热能力时心跳静默跳过"）。
  return llm;
}

const LINES = {
  version: 1,
  rules: [
    {
      id: 'greet',
      match: { keywords: ['你好'] },
      reply: { text: '规则回复：老师好。', emotion: 'neutral', intent: 'greet' },
      cooldownMs: 0,
    },
    {
      id: 'pat',
      match: { on: 'head_patted' },
      reply: { text: '规则回复：请不要这样。', emotion: 'shy', intent: 'pat_react' },
      cooldownMs: 0,
    },
    {
      id: 'idle',
      match: { on: 'idle' },
      reply: { text: '空闲台词：……先生、还在吗。', emotion: 'neutral', intent: 'look_at_user' },
      cooldownMs: 900000,
    },
  ],
  fallbacks: [
    { id: 'fb1', reply: { text: '兜底一。', emotion: 'neutral', intent: 'none' } },
    { id: 'fb2', reply: { text: '兜底二。', emotion: 'neutral', intent: 'none' } },
  ],
};

interface Harness {
  orchestrator: Orchestrator;
  bus: FakeBus;
  voice: FakeVoice;
  llm: FakeLlm;
  memory: FakeMemory;
}

interface FakeMemory extends MemoryPort {
  readonly facts: MemoryFact[];
  readonly queries: string[];
  readonly writes: MemoryWrite[];
  failRetrieve: boolean;
  failWrite: boolean;
}

function makeMemory(facts: MemoryFact[] = []): FakeMemory {
  const fake: FakeMemory = {
    facts,
    queries: [],
    writes: [],
    failRetrieve: false,
    failWrite: false,
    retrieve(query: string, limit = 5): MemoryFact[] {
      fake.queries.push(query);
      if (fake.failRetrieve) throw new Error('memory boom');
      return fake.facts.slice(0, limit);
    },
    write(event: MemoryWrite): void {
      if (fake.failWrite) throw new Error('memory write boom');
      fake.writes.push(event);
    },
  };
  return fake;
}

/** 等一轮 setImmediate：记忆写入是异步排队的（ADR 0020 D5）。 */
async function flushImmediate(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function setup(
  options: {
    llm?: Parameters<typeof makeLlm>[0];
    voice?: Partial<VoicePort>;
    memory?: FakeMemory | null;
    now?: () => number;
    presence?: PresencePort;
    proactive?: ProactiveOptions;
    lines?: typeof LINES;
  } = {},
): Harness {
  const bus = new FakeBus();
  const voice = makeVoice(options.voice);
  const llm = makeLlm(options.llm);
  const memory = options.memory === null ? makeMemory() : (options.memory ?? makeMemory());
  const rules = createRulePool(parseLinesFile(options.lines ?? LINES));
  const orchestrator = createOrchestrator({
    bus,
    voice,
    llm,
    rules,
    card: '测试角色卡',
    ...(options.memory === null ? {} : { memory }),
    ...(options.presence ? { presence: options.presence } : {}),
    ...(options.proactive ? { proactive: options.proactive } : {}),
    now: options.now ?? (() => Date.now()),
    newReplyId: (utteranceId) => `r-${utteranceId}`,
    log: () => undefined,
  });
  return { orchestrator, bus, voice, llm, memory };
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// 分流
// ---------------------------------------------------------------------------

test('§9.1 ①：规则命中 → route=rule，动作命令先于 intent_resolved，且只发布一次', async () => {
  const { orchestrator, bus, voice } = setup();
  const reply = await orchestrator.respond({ text: '你好呀', utteranceId: 'u1' });

  assert.equal(reply.text, '规则回复：老师好。');
  assert.deepEqual(bus.named('intent_resolved'), [
    {
      replyId: 'r-u1',
      text: '规则回复：老师好。',
      emotion: 'neutral',
      intent: 'greet',
      route: 'rule',
    },
  ]);
  const commandIndex = bus.order.indexOf(`cmd:${IPC_CHANNELS.renderIntent}`);
  const eventIndex = bus.order.indexOf('evt:intent_resolved');
  assert.ok(commandIndex >= 0 && eventIndex >= 0 && commandIndex < eventIndex, bus.order.join(','));
  assert.deepEqual(bus.commands[0]?.payload, { intent: 'greet' });
  assert.equal(voice.speaks.length, 1);
  assert.equal(voice.speaks[0]?.text, '规则回复：老师好。');
  assert.equal(voice.speaks[0]?.utteranceId, 'u1');
});

test('§9.1 ③：健康检查失败 → llm_failed(unavailable) 一次，本会话熔断', async () => {
  const { orchestrator, bus, llm } = setup({
    llm: { health: { ok: false, reason: 'unavailable', detail: 'ECONNREFUSED' } },
  });

  const first = await orchestrator.respond({ text: '今天天气不错', utteranceId: 'u1' });
  assert.equal(first.text, '兜底一。');
  const failed = bus.named('llm_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.reason, 'unavailable');
  assert.equal(llm.healthCalls, 1);
  assert.equal(llm.chatCalls, 0);

  const resolved = bus.named('intent_resolved');
  assert.equal(resolved[0]?.route, 'fallback');

  const second = await orchestrator.respond({ text: '再说一句', utteranceId: 'u2' });
  assert.equal(second.text, '兜底二。');
  assert.equal(bus.named('llm_failed').length, 1, '熔断后不得重复发 llm_failed');
  assert.equal(llm.healthCalls, 1, '熔断后不再探测');
});

test('§9.1 ②：LLM 合法输出 → route=llm，历史记一轮', async () => {
  const { orchestrator, bus, llm } = setup();
  const reply = await orchestrator.respond({ text: '你在吗', utteranceId: 'u1' });

  assert.equal(reply.text, '老师，我在。');
  assert.equal(bus.named('intent_resolved')[0]?.route, 'llm');
  assert.equal(llm.chatCalls, 1);
  assert.equal(orchestrator.snapshot().historyTurns, 1);

  // §9.3：system 段包含角色卡与输出约束，最后一条是当前话语
  const messages = llm.lastRequest?.messages ?? [];
  assert.equal(messages[0]?.role, 'system');
  assert.match(messages[0]?.content ?? '', /角色卡/);
  assert.match(messages[0]?.content ?? '', /emotion 只能取/);
  assert.equal(messages[messages.length - 1]?.content, '你在吗');
});

test('§9.2：LLM 输出非法 → llm_failed(invalid_output) 并降级兜底', async () => {
  const { orchestrator, bus } = setup({ llm: { chat: async () => ({ ok: true, content: '不是 JSON' }) } });
  const reply = await orchestrator.respond({ text: '随便说点', utteranceId: 'u1' });

  assert.equal(reply.text, '兜底一。');
  assert.equal(bus.named('llm_failed')[0]?.reason, 'invalid_output');
  assert.equal(bus.named('intent_resolved')[0]?.route, 'fallback');
});

test('§9.1 ②：LLM 超时 → llm_failed(timeout)，不熔断（下一次仍可试 ②）', async () => {
  let call = 0;
  const { orchestrator, bus, llm } = setup({
    llm: {
      chat: async () => {
        call += 1;
        if (call === 1) return { ok: false, reason: 'timeout', detail: '8000ms' };
        return { ok: true, content: '{"text":"这次好了。","emotion":"happy","intent":"nod"}' };
      },
    },
  });

  await orchestrator.respond({ text: '第一句', utteranceId: 'u1' });
  assert.equal(bus.named('llm_failed')[0]?.reason, 'timeout');

  const second = await orchestrator.respond({ text: '第二句', utteranceId: 'u2' });
  assert.equal(second.text, '这次好了。');
  assert.equal(llm.healthCalls, 1, '健康检查只做一次');
});

test('§12：cancel() 中止在途 LLM —— 不发布、不发声、记 llm_failed(aborted)', async () => {
  const { orchestrator, bus, voice, llm } = setup({
    llm: {
      chat: (request) =>
        new Promise<LlmChatResult>((resolve) => {
          const abort = (): void => resolve({ ok: false, reason: 'aborted', detail: 'cancelled' });
          if (request.signal?.aborted) return abort();
          request.signal?.addEventListener('abort', abort, { once: true });
        }),
    },
  });

  const pending = orchestrator.respond({ text: '慢慢想', utteranceId: 'u1' });
  await until(() => llm.chatCalls === 1);
  orchestrator.cancel();
  const reply = await pending;

  assert.ok(reply.text.length > 0, '仍必须返回合法 Reply（§7.6 永不 reject）');
  assert.equal(bus.named('intent_resolved').length, 0);
  assert.equal(voice.speaks.length, 0);
  assert.equal(bus.named('llm_failed')[0]?.reason, 'aborted');
});

test('§12：新话语打断旧话语 —— 只发布新回复，旧回复静默', async () => {
  const { orchestrator, bus, voice, llm } = setup({
    llm: {
      chat: (request) =>
        new Promise<LlmChatResult>((resolve) => {
          const isFirst = request.messages[request.messages.length - 1]?.content === '第一句';
          const abort = (): void => resolve({ ok: false, reason: 'aborted' });
          if (request.signal?.aborted) return abort();
          request.signal?.addEventListener('abort', abort, { once: true });
          if (!isFirst) {
            setTimeout(
              () => resolve({ ok: true, content: '{"text":"第二句的回复。","emotion":"happy","intent":"nod"}' }),
              10,
            );
          }
        }),
    },
  });

  const first = orchestrator.respond({ text: '第一句', utteranceId: 'u1' });
  await until(() => llm.chatCalls === 1);
  const second = orchestrator.respond({ text: '第二句', utteranceId: 'u2' });

  const [firstReply, secondReply] = await Promise.all([first, second]);
  assert.ok(firstReply.text.length > 0);
  assert.equal(secondReply.text, '第二句的回复。');

  const resolved = bus.named('intent_resolved');
  assert.equal(resolved.length, 1, '旧回复不得发布');
  assert.equal(resolved[0]?.route, 'llm');
  assert.equal(voice.speaks.length, 1);
  assert.equal(voice.speaks[0]?.utteranceId, 'u2');
  assert.ok(voice.stops.length >= 2, '两次 respond 开头都要 stopSpeaking（幂等）');
});

test('§9.1 ③：空话语也必定返回合法 Reply', async () => {
  const { orchestrator, bus } = setup({
    llm: { health: { ok: false, reason: 'unavailable' } },
  });
  const reply = await orchestrator.respond({ text: '   ', utteranceId: 'u1' });
  assert.ok(reply.text.length > 0);
  assert.equal(bus.named('intent_resolved')[0]?.route, 'fallback');
});

test('§7.6：chat 抛异常也不 reject（折算兜底）', async () => {
  const { orchestrator, bus } = setup({
    llm: {
      chat: async () => {
        throw new Error('boom');
      },
    },
  });
  const reply = await orchestrator.respond({ text: '说点啥', utteranceId: 'u1' });
  assert.equal(reply.text, '兜底一。');
  assert.equal(bus.named('intent_resolved')[0]?.route, 'fallback');
});

// ---------------------------------------------------------------------------
// 摸头（事件条件）
// ---------------------------------------------------------------------------

test('摸头：空闲时命中 pat 规则，说话时跳过（§5.3 不打断语音）', async () => {
  const fresh = setup();
  fresh.orchestrator.handleHeadPatted(1);
  const resolved = fresh.bus.named('intent_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.route, 'rule');
  assert.equal(resolved[0]?.intent, 'pat_react');
  assert.equal(fresh.voice.speaks.length, 1);
  assert.equal(fresh.orchestrator.snapshot().historyTurns, 0, '摸头台词不进对话历史');

  const speaking = setup();
  speaking.bus.emit('speech_started', { utteranceId: 'u-x', text: '正在说话' });
  speaking.orchestrator.handleHeadPatted(2);
  assert.equal(speaking.bus.named('intent_resolved').length, 0);
  assert.equal(speaking.voice.speaks.length, 0);
});

test('§9.3：prompt 段序固定（约束 → 角色卡 → 记忆 → 历史 → 当前）', () => {
  const messages = buildPrompt({
    card: '角色卡正文',
    memory: ['记忆一'],
    history: [
      { user: '旧问题', assistant: '旧回答' },
      { user: '较新问题', assistant: '较新回答' },
    ],
    userText: '当前问题',
  });

  assert.equal(messages[0]?.role, 'system');
  const system = messages[0]?.content ?? '';
  assert.ok(system.indexOf('JSON') < system.indexOf('角色卡正文'));
  assert.ok(system.indexOf('角色卡正文') < system.indexOf('记忆一'));

  assert.deepEqual(
    messages.slice(1).map((message) => `${message.role}:${message.content}`),
    ['user:旧问题', 'assistant:旧回答', 'user:较新问题', 'assistant:较新回答', 'user:当前问题'],
  );
});

// ---------------------------------------------------------------------------
// 记忆（ADR 0020）
// ---------------------------------------------------------------------------

const MEMORY_FACTS: MemoryFact[] = [
  { id: 7, at: Date.UTC(2026, 9, 30, 2, 0), kind: 'user', text: '我喜欢喝咖啡。', tags: ['like:喝咖啡'], score: 2 },
  { id: 8, at: Date.UTC(2026, 9, 30, 2, 1), kind: 'pet', text: '……コーヒーがお好きなんですね。', tags: [], score: 1 },
];

test('§9.3 段 3：retrieve 结果注入提示词，查询词就是用户话语', async () => {
  const memory = makeMemory(MEMORY_FACTS);
  const { orchestrator, llm } = setup({ memory });
  await orchestrator.respond({ text: '咖啡的事你还记得吗', utteranceId: 'u1' });

  assert.deepEqual(memory.queries, ['咖啡的事你还记得吗']);
  const system = llm.lastRequest?.messages[0]?.content ?? '';
  assert.match(system, /记忆片段：/);
  assert.match(system, /我喜欢喝咖啡。/);
  // 段 3 的时间标签自 ADR 0030 D4 起是相对时间（`[今日]` / `[3日前]`），这里只断言"有标签"
  assert.match(system, /^- \[[^\]]+\] 用户: /mu);
  assert.match(system, /^- \[[^\]]+\] 凯伊: /mu);
  assert.ok(!system.includes('（无）'), '有记忆时不得出现空段占位');
});

test('§9.3 段 3：记忆为空 / 检索抛错都无缝退回“（无）”', async () => {
  const empty = setup({ memory: makeMemory([]) });
  await empty.orchestrator.respond({ text: '还记得吗', utteranceId: 'u1' });
  assert.match(empty.llm.lastRequest?.messages[0]?.content ?? '', /记忆片段：（无）/);

  const broken = setup({ memory: makeMemory(MEMORY_FACTS) });
  broken.memory.failRetrieve = true;
  const reply = await broken.orchestrator.respond({ text: '还记得吗', utteranceId: 'u2' });
  assert.equal(reply.text, '老师，我在。', '记忆失败不得改变回复本身');
  assert.match(broken.llm.lastRequest?.messages[0]?.content ?? '', /记忆片段：（无）/);
});

test('ADR 0020 D5：发布后异步写 user + pet 两条，refId 可追溯', async () => {
  const memory = makeMemory();
  const { orchestrator } = setup({ memory });
  await orchestrator.respond({ text: '我喜欢咖啡', utteranceId: 'u9' });
  await flushImmediate();

  assert.equal(memory.writes.length, 2);
  assert.equal(memory.writes[0]?.kind, 'user');
  assert.equal(memory.writes[0]?.text, '我喜欢咖啡');
  assert.equal(memory.writes[0]?.refId, 'u9#user');
  assert.equal(memory.writes[1]?.kind, 'pet');
  assert.equal(memory.writes[1]?.text, '老师，我在。');
  assert.equal(memory.writes[1]?.refId, 'r-u9#pet');
  assert.equal(memory.writes[0]?.at, memory.writes[1]?.at, '同一轮的两条记忆必须同一时间戳');
});

test('ADR 0020 D5：写库在 speak 之后（不阻塞 TTS 下发）', async () => {
  const memory = makeMemory();
  const { orchestrator, voice } = setup({ memory });
  await orchestrator.respond({ text: '你好呀', utteranceId: 'u1' });

  assert.equal(voice.speaks.length, 1, '语音下发必须已经发生');
  assert.equal(memory.writes.length, 0, '写库被排到当前 tick 之后，不同步阻塞');
  await flushImmediate();
  assert.equal(memory.writes.length, 2);
});

test('ADR 0020 D5：memory.write 抛错不影响回复（被兜住）', async () => {
  const memory = makeMemory();
  memory.failWrite = true;
  const { orchestrator, bus } = setup({ memory });

  const reply = await orchestrator.respond({ text: '你好', utteranceId: 'u1' });
  await flushImmediate();
  assert.ok(reply.text.length > 0);
  assert.equal(bus.named('intent_resolved').length, 1);
});

test('ADR 0020 D5：摸头等合成话语不写记忆（没有用户输入）', async () => {
  const memory = makeMemory();
  const { orchestrator } = setup({ memory });
  orchestrator.handleHeadPatted(1);
  await flushImmediate();
  assert.equal(memory.writes.length, 0);
});

test('ADR 0020 D10：没有注入 memory 时行为与之前完全一致（段 3 为“（无）”）', async () => {
  const { orchestrator, llm } = setup({ memory: null });
  const reply = await orchestrator.respond({ text: '你在吗', utteranceId: 'u1' });
  assert.equal(reply.text, '老师，我在。');
  assert.match(llm.lastRequest?.messages[0]?.content ?? '', /记忆片段：（无）/);
});

test('formatMemoryFacts：条数上限 5、超出截断、坏时间戳被跳过', () => {
  const facts: MemoryFact[] = [
    ...Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      at: Date.UTC(2026, 9, 30),
      kind: 'user' as const,
      text: `记忆${index}`,
      tags: [],
    })),
    { id: 99, at: Number.NaN, kind: 'pet', text: '坏时间戳', tags: [] },
  ];
  const lines = formatMemoryFacts(facts);
  assert.equal(lines.length, 5);
  assert.equal(lines[0], '[10-30] 用户: 记忆0');

  const long = formatMemoryFacts([{ id: 1, at: Date.UTC(2026, 9, 30), kind: 'user', text: 'あ'.repeat(200), tags: [] }]);
  assert.ok((long[0] ?? '').endsWith('…'));
  assert.ok((long[0] ?? '').length < 200);
});

// ---------------------------------------------------------------------------
// 主动性 idle-drive（ADR 0031）
// ---------------------------------------------------------------------------

/** 没有 `on:'idle'` 台词的台词池：用来验证"规则未命中 → 才走 LLM"这一级 */
const LINES_NO_IDLE = {
  version: 1,
  rules: LINES.rules.filter((rule) => rule.match.on !== 'idle'),
  fallbacks: LINES.fallbacks,
};

interface ProactiveHarness extends Harness {
  /** 手动触发一次"15s 节拍"（真实定时器被替换成了这个） */
  tick(): void;
  setNow(value: number): void;
  setUserIdle(value: number | null): void;
}

/** 假 presence：空闲值可变，类别固定（段 3.5 用得到，但这里只关心"有无"） */
function makePresence(initial: number | null): { port: PresencePort; setIdle(value: number | null): void } {
  const state = { idle: initial };
  return {
    port: {
      getSnapshot: () => ({
        userIdleMs: state.idle,
        foregroundTitle: 'main.ts - aa3dpet - Visual Studio Code',
        foregroundClass: 'Chrome_WidgetWin_1',
        // ADR 0032 D1：段 3.5 只认归一化类别
        foregroundCategory: 'coding',
        at: 0,
      }),
    },
    setIdle(value: number | null): void {
      state.idle = value;
    },
  };
}

const PROACTIVE_T0 = new Date(2026, 10, 1, 21, 0, 0).getTime();
/** 默认"用户已经离开键盘 2 分钟" */
const PROACTIVE_IDLE_MS = 120_000;

function setupProactive(
  options: {
    llm?: Parameters<typeof makeLlm>[0];
    memory?: FakeMemory | null;
    presence?: { port: PresencePort; setIdle(value: number | null): void };
    lines?: typeof LINES;
  } = {},
): ProactiveHarness {
  let clock = PROACTIVE_T0;
  const presence = options.presence ?? makePresence(PROACTIVE_IDLE_MS);
  let tickCallback: (() => void) | null = null;
  const harness = setup({
    ...(options.llm ? { llm: options.llm } : {}),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.lines ? { lines: options.lines } : {}),
    now: () => clock,
    presence: presence.port,
    proactive: {
      enabled: true,
      intervalMs: 15_000,
      schedule: (callback) => {
        tickCallback = callback;
        return 1;
      },
      cancel: () => {
        tickCallback = null;
      },
    },
  });
  return {
    ...harness,
    tick(): void {
      // 每次"节拍"都先推进时钟到下一次评估点，模拟真实节拍器
      clock += 15_000;
      tickCallback?.();
    },
    setNow(value: number): void {
      clock = value;
    },
    setUserIdle(value: number | null): void {
      presence.setIdle(value);
    },
  };
}

/** 让"距上次交互"足够久：直接跳过 90s 门槛 */
function passGap(harness: ProactiveHarness): void {
  harness.setNow(PROACTIVE_T0 + 120_000);
}

test('ADR 0031 D3：空闲 → 规则命中 → route=rule 主动开口，进历史、不写记忆', async () => {
  const memory = makeMemory();
  const h = setupProactive({ memory });
  passGap(h);
  h.tick();
  await flushImmediate();

  const resolved = h.bus.named('intent_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.route, 'rule');
  assert.equal(resolved[0]?.intent, 'look_at_user');
  assert.match(resolved[0]?.text ?? '', /空闲台词/);
  assert.equal(h.voice.speaks.length, 1, '主动话语走同一条语音链路（§7.4）');
  assert.equal(h.orchestrator.snapshot().proactiveCount, 1);
  assert.equal(h.orchestrator.snapshot().historyTurns, 1, 'ADR 0031 D5：必须进对话历史');
  assert.equal(memory.writes.length, 0, 'ADR 0031 D5.2：自言自语绝不写 memory.db');
});

test('ADR 0031 D2：用户还在操作（空闲 10s）时一个字都不说', () => {
  const h = setupProactive();
  passGap(h);
  h.setUserIdle(10_000);
  h.tick();

  assert.equal(h.bus.named('intent_resolved').length, 0);
  assert.equal(h.voice.speaks.length, 0);
  assert.equal(h.orchestrator.snapshot().lastProactiveSkip, 'user-active');
});

test('ADR 0031 D2.2：用户离开超过 5 分钟 → 不打扰（对空房间说话不算灵魂感）', () => {
  const h = setupProactive();
  passGap(h);
  h.setUserIdle(6 * 60_000);
  h.tick();
  assert.equal(h.bus.named('intent_resolved').length, 0);
  assert.equal(h.orchestrator.snapshot().lastProactiveSkip, 'user-away');
});

test('ADR 0031 D4.1：LLM 未做过健康检查时，规则未命中就保持沉默（不擅自探测）', async () => {
  const h = setupProactive({ lines: LINES_NO_IDLE });
  passGap(h);
  h.tick();
  await flushImmediate();

  assert.equal(h.llm.chatCalls, 0, 'LLM 从未健康检查过时，主动路径不得擅自发起推理');
  assert.equal(h.bus.named('intent_resolved').length, 0);
  assert.equal(h.voice.speaks.length, 0);
  // 判定通过但"没有台词 + LLM 不可用"：托盘必须看到 no-lines，而不是"已开口"（ADR 0032 D4）
  assert.equal(readProactiveStats().lastReason, 'no-lines');
  assert.equal(readProactiveStats().firedCount, 0);
});

test('ADR 0031 D4.2：主动路径 LLM 失败 → 完全沉默（不发 llm_failed、不播兜底）', async () => {
  const h = setupProactive({
    lines: LINES_NO_IDLE,
    llm: {
      chat: async (request) => {
        // 先让用户那轮成功，把 llmHealthChecked 打开
        const isProactive = request.messages[request.messages.length - 1]?.content === PROACTIVE_PROMPT_USER;
        if (isProactive) return { ok: false, reason: 'timeout', detail: '3000ms' };
        return { ok: true, content: '{"text":"我在。","emotion":"neutral","intent":"nod"}' };
      },
    },
  });

  await h.orchestrator.respond({ text: '今天的天气如何', utteranceId: 'u1' });
  assert.equal(h.llm.chatCalls, 1);
  h.bus.emit('speech_ended', { utteranceId: 'u1', reason: 'completed', durationMs: 10 });
  h.setNow(PROACTIVE_T0 + 120_000);
  h.tick();
  await flushImmediate();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.llm.chatCalls, 2, '确实尝试过主动推理');
  assert.equal(
    h.bus.named('intent_resolved').length,
    1,
    '只有用户那一轮；主动失败不得发布任何回复',
  );
  assert.equal(h.bus.named('llm_failed').length, 0, '主动失败不广播 llm_failed（§6.3 的失败语义属于用户话语）');
  assert.equal(h.voice.speaks.length, 1, '不得播兜底台词');
  assert.equal(h.orchestrator.snapshot().proactiveCount, 0, '失败不计入预算');
  // 主动推理失败也要在托盘上如实显示"为什么没开口"（ADR 0032 D4）
  assert.equal(readProactiveStats().lastReason, 'llm-failed');
  assert.equal(readProactiveStats().firedCount, 0);
});

test('ADR 0031 D4.3：主动路径 LLM 成功 → route=llm，历史里是"她自己开的口"', async () => {
  const h = setupProactive({
    lines: LINES_NO_IDLE,
    llm: {
      chat: async (request) => {
        const isProactive = request.messages[request.messages.length - 1]?.content === PROACTIVE_PROMPT_USER;
        return {
          ok: true,
          content: isProactive
            ? '{"text":"先生、少し休みませんか。","emotion":"happy","intent":"tilt_head"}'
            : '{"text":"我在。","emotion":"neutral","intent":"nod"}',
        };
      },
    },
  });

  await h.orchestrator.respond({ text: '今天的天气如何', utteranceId: 'u1' });
  // 桩 voice 不会自己发 speech_ended；手动收尾，否则 voiceBusy 会一直是 true（idle-drive 判 busy）
  h.bus.emit('speech_ended', { utteranceId: 'u1', reason: 'completed', durationMs: 10 });
  h.setNow(PROACTIVE_T0 + 120_000);
  h.tick();
  await flushImmediate();

  const resolved = h.bus.named('intent_resolved');
  assert.equal(resolved.length, 2);
  assert.equal(resolved[1]?.route, 'llm');
  assert.equal(resolved[1]?.text, '先生、少し休みませんか。');
  assert.equal(h.orchestrator.snapshot().proactiveCount, 1);

  // 下一轮请求的 system 段 3.5 + 历史里能看到她刚说过的话
  await h.orchestrator.respond({ text: '嗯？', utteranceId: 'u2' });
  const messages = h.llm.lastRequest?.messages ?? [];
  const flat = messages.map((message) => `${message.role}:${message.content}`).join('\n');
  assert.match(flat, new RegExp(PROACTIVE_HISTORY_USER));
  assert.match(flat, /先生、少し休みませんか。/);
});

test('ADR 0031 D4.5：主动推理期间用户开口 → 让位，一个字都不发', async () => {
  const h = setupProactive({
    lines: LINES_NO_IDLE,
    llm: {
      chat: (request) => {
        const isProactive = request.messages[request.messages.length - 1]?.content === PROACTIVE_PROMPT_USER;
        if (!isProactive) {
          return Promise.resolve({ ok: true, content: '{"text":"你好。","emotion":"neutral","intent":"greet"}' });
        }
        return new Promise<LlmChatResult>((resolve) => {
          const abort = (): void => resolve({ ok: false, reason: 'aborted' });
          if (request.signal?.aborted) return abort();
          request.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    },
  });

  // 打开健康检查
  await h.orchestrator.respond({ text: '今天的天气如何', utteranceId: 'u1' });
  // 桩 voice 不会自己发 speech_ended；手动收尾，否则 voiceBusy 会一直是 true（idle-drive 判 busy）
  h.bus.emit('speech_ended', { utteranceId: 'u1', reason: 'completed', durationMs: 10 });
  h.setNow(PROACTIVE_T0 + 120_000);
  h.tick();
  await until(() => h.llm.chatCalls === 2);

  // 用户突然说话（命中规则：不需要再进 LLM）
  const reply = await h.orchestrator.respond({ text: '你好', utteranceId: 'u2' });
  assert.equal(reply.text, '规则回复：老师好。');
  await flushImmediate();

  const resolved = h.bus.named('intent_resolved');
  assert.equal(resolved.length, 2, '用户那轮 + 更早的 LLM 轮，主动那轮被丢弃');
  assert.equal(resolved[1]?.route, 'rule', '主动 LLM 被取消后不得发布');
  assert.equal(h.orchestrator.snapshot().proactiveCount, 0);
});

test('ADR 0031 D3：主动话语进 system 段 3.5（时间感在主动路径上同样生效）', async () => {
  const h = setupProactive({
    lines: LINES_NO_IDLE,
    llm: {
      chat: async (request) => {
        const isProactive = request.messages[request.messages.length - 1]?.content === PROACTIVE_PROMPT_USER;
        return {
          ok: true,
          content: isProactive
            ? '{"text":"……先生。","emotion":"neutral","intent":"none"}'
            : '{"text":"我在。","emotion":"neutral","intent":"nod"}',
        };
      },
    },
  });

  await h.orchestrator.respond({ text: '今天的天气如何', utteranceId: 'u1' });
  // 桩 voice 不会自己发 speech_ended；手动收尾，否则 voiceBusy 会一直是 true（idle-drive 判 busy）
  h.bus.emit('speech_ended', { utteranceId: 'u1', reason: 'completed', durationMs: 10 });
  h.setNow(PROACTIVE_T0 + 120_000);
  h.tick();
  await flushImmediate();

  const proactiveRequest = h.llm.lastRequest;
  const system = proactiveRequest?.messages[0]?.content ?? '';
  assert.match(system, /環境: /);
  assert.match(system, /先生は 2 分前まで入力中/);
  assert.match(system, /前面のアプリ: coding/, 'ADR 0032 D1：段 3.5 里只有归一化类别');
  assert.match(system, /先生は今、プログラミングに集中している/, 'ADR 0032 D2：coding 追加提示');
  assert.equal(proactiveRequest?.timeoutMs, 3000, '主动路径必须用 3s 短超时');
});

// ---------------------------------------------------------------------------
// 托盘诊断的数据源（ADR 0032 D4）
// ---------------------------------------------------------------------------

test('ADR 0032 D4：判定与开口都写进 proactive-stats（托盘两行诊断的数据源）', async () => {
  resetProactiveStats();
  const h = setupProactive({ lines: LINES });

  // ① 用户正在操作 → user-active，不计入次数
  passGap(h);
  h.setUserIdle(10_000);
  h.tick();
  assert.equal(readProactiveStats().firedCount, 0);
  assert.equal(readProactiveStats().lastReason, 'user-active');

  // ② 用户静下来 → 规则命中主动开口 → 次数 +1、原因变 ok
  h.setUserIdle(PROACTIVE_IDLE_MS);
  h.tick();
  await flushImmediate();
  assert.equal(readProactiveStats().firedCount, 1);
  assert.equal(readProactiveStats().lastReason, 'ok');
  assert.equal(h.orchestrator.snapshot().lastProactiveSkip, 'ok');

  // ③ 读出来的是副本：改它不影响下一次读数
  const copy = readProactiveStats();
  copy.firedCount = 99;
  assert.equal(readProactiveStats().firedCount, 1);

  // ④ reset 之后归零（进程重启 / 自检重入）
  resetProactiveStats();
  assert.deepEqual(readProactiveStats(), { firedCount: 0, lastReason: null, updatedAt: 0 });
});

test('ADR 0032 D4：没装配主动性时，托盘看到的是 disabled 而不是含糊的"尚未评估"', () => {
  resetProactiveStats();
  setup(); // 不传 proactive
  assert.equal(readProactiveStats().lastReason, 'disabled');
  assert.equal(readProactiveStats().firedCount, 0);
});

// ---------------------------------------------------------------------------
// ADR 0053：运行期换模型 / 换角色卡（控制面板 → 内部方法）
// ---------------------------------------------------------------------------

test('ADR 0053 replaceCard：换卡后下一次 prompt 用新人格，在途历史不清空', async () => {
  const { orchestrator, llm } = setup();
  await orchestrator.respond({ text: '今天好安静', utteranceId: 'u1' });
  assert.match(llm.lastRequest?.messages[0]?.content ?? '', /测试角色卡/);
  const turnsBefore = orchestrator.snapshot().historyTurns;

  orchestrator.replaceCard('新的角色卡：你现在说话很冲。', 'panel');
  assert.equal(orchestrator.snapshot().cardChars, '新的角色卡：你现在说话很冲。'.length);

  await orchestrator.respond({ text: '你在想什么', utteranceId: 'u2' });
  const system = llm.lastRequest?.messages[0]?.content ?? '';
  assert.match(system, /新的角色卡/);
  // 换卡不清空历史：轮数只会增加，不会回到 0
  assert.ok(orchestrator.snapshot().historyTurns > turnsBefore, '历史轮次保留，不清空');
});

test('ADR 0053 replaceLlm：清零健康检查与熔断，新客户端重新探活', async () => {
  // 第一个客户端永远不健康 → 一次失败即本会话熔断（§11）
  const broken = makeLlm({ health: { ok: false, model: '' } as LlmHealth });
  const bus = new FakeBus();
  const voice = makeVoice({});
  const rules = createRulePool(parseLinesFile(LINES));
  const orchestrator = createOrchestrator({
    bus,
    voice,
    llm: broken,
    rules,
    card: '测试角色卡',
    memory: makeMemory(),
    now: () => Date.now(),
    newReplyId: (utteranceId) => `r-${utteranceId}`,
    log: () => undefined,
  });
  await orchestrator.respond({ text: '这是不匹配规则的一句话', utteranceId: 'u1' });
  assert.equal(orchestrator.snapshot().llmDisabled, true);
  assert.equal(broken.healthCalls, 1);

  // 换成健康的模型：必须允许重新探活，而不是继承旧模型的熔断
  const healthy = makeLlm();
  orchestrator.replaceLlm(healthy, 'panel');
  const afterSwitch = orchestrator.snapshot();
  assert.equal(afterSwitch.llmDisabled, false);
  assert.equal(afterSwitch.llmHealthChecked, false);
  assert.equal(afterSwitch.llmModel, 'fake:1b');

  await orchestrator.respond({ text: '这也是不匹配规则的一句话', utteranceId: 'u2' });
  assert.equal(healthy.healthCalls, 1, '新客户端被真正探活');
  assert.equal(orchestrator.snapshot().llmDisabled, false);
  assert.equal(broken.healthCalls, 1, '旧客户端不再被使用');
});

