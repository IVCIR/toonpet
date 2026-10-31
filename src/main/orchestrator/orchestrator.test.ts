import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventName, EventPayloads } from '../../shared/events';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { MemoryFact, MemoryPort, MemoryWrite } from '../../shared/memory-types';
import type { EventBus, RendererSink } from '../event-bus';
import { createOrchestrator } from './index';
import type { Orchestrator, VoicePort } from './index';
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
  options: { llm?: Parameters<typeof makeLlm>[0]; voice?: Partial<VoicePort>; memory?: FakeMemory | null } = {},
): Harness {
  const bus = new FakeBus();
  const voice = makeVoice(options.voice);
  const llm = makeLlm(options.llm);
  const memory = options.memory === null ? makeMemory() : (options.memory ?? makeMemory());
  const rules = createRulePool(parseLinesFile(LINES));
  const orchestrator = createOrchestrator({
    bus,
    voice,
    llm,
    rules,
    card: '测试角色卡',
    ...(options.memory === null ? {} : { memory }),
    now: () => Date.now(),
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
  assert.match(system, /\[10-30\] 用户: /);
  assert.match(system, /\[10-30\] 凯伊: /);
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
