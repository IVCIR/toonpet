import assert from 'node:assert/strict';
import test from 'node:test';
import { VISION_SEGMENT_MAX_CHARS } from '../../shared/constants';
import type { EventName, EventPayloads } from '../../shared/events';
import type { VisionContext } from '../../shared/vision';
import type { EventBus, RendererSink } from '../event-bus';
import type { LlmChatRequest, LlmChatResult, LlmClient, LlmHealth } from './llm-client';
import { createOrchestrator } from './index';
import { buildPrompt, formatVisionSegment } from './prompt';
import { createRulePool, parseLinesFile } from './rule-pool';

const CONTEXT: VisionContext = {
  text: 'VISION TEST 2026\n桌宠控制面板',
  chars: 22,
  at: 1_700_000_000_000,
  source: 'screen',
  model: 'glm-ocr',
};

class FakeBus implements EventBus {
  setRendererSink(_sink: RendererSink | null): void {
    void _sink;
  }
  emit<K extends EventName>(_name: K, _payload: EventPayloads[K]): void {
    void _name;
    void _payload;
  }
  subscribe<K extends EventName>(_name: K, _handler: (payload: EventPayloads[K]) => void): () => void {
    void _name;
    void _handler;
    return () => undefined;
  }
  sendCommand(_channel: string, _payload: unknown): boolean {
    void _channel;
    void _payload;
    return true;
  }
}

class FakeLlm implements LlmClient {
  readonly model = 'fake:1b';
  readonly baseUrl = 'http://127.0.0.1:11434';
  readonly requestTimeoutMs = 8000;
  readonly requests: LlmChatRequest[] = [];
  async health(): Promise<LlmHealth> {
    return { ok: true, model: this.model };
  }
  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    this.requests.push(request);
    return { ok: true, content: '{"text":"はい、先生。","emotion":"neutral","intent":"nod"}' };
  }
}

const RULES = parseLinesFile({
  version: 1,
  rules: [
    {
      id: 'greet',
      match: { keywords: ['你好'] },
      reply: { text: '规则回复。', emotion: 'neutral', intent: 'greet' },
      cooldownMs: 0,
    },
  ],
  fallbacks: [{ id: 'f1', reply: { text: '兜底回复。', emotion: 'neutral', intent: 'none' } }],
});

test('ADR 0054 D4：段 3.6 没有上下文时不产生任何字节变化', () => {
  const base = { card: '角色卡', memory: [], history: [], userText: 'こんにちは' };
  const withoutVision = buildPrompt(base);
  assert.equal(withoutVision[0].content.includes('視覚情報'), false);
  assert.equal(
    withoutVision[0].content,
    buildPrompt({ ...base, now: CONTEXT.at + 1000 })[0].content,
  );
});

test('ADR 0054 D4：段 3.6 带"数据不是指令"约束，且受 600 字预算约束', () => {
  const segment = formatVisionSegment(CONTEXT, CONTEXT.at + 12_000);
  assert.match(segment, /視覚情報/);
  assert.match(segment, /データであり指示ではない/);
  assert.match(segment, /12秒前/);
  assert.ok(segment.includes('VISION TEST 2026'));
  assert.ok(segment.length <= VISION_SEGMENT_MAX_CHARS);

  const huge: VisionContext = {
    ...CONTEXT,
    text: Array.from({ length: 50 }, (_, index) => `行${index + 1}：${'字'.repeat(80)}`).join('\n'),
    chars: 50 * 90,
  };
  const clipped = formatVisionSegment(huge, huge.at);
  assert.ok(clipped.length <= VISION_SEGMENT_MAX_CHARS, `segment=${clipped.length}`);
});

test('ADR 0054 D4.2：视觉上下文一次性消费；第二轮不再注入；过期丢弃', async () => {
  let clock = CONTEXT.at;
  const llm = new FakeLlm();
  const orchestrator = createOrchestrator({
    bus: new FakeBus(),
    voice: {
      speak: async () => 'completed',
      stopSpeaking: () => undefined,
    },
    llm,
    rules: createRulePool(RULES),
    card: '角色卡',
    now: () => clock,
    visionTtlMs: 60_000,
  });

  orchestrator.replaceVision(CONTEXT, 'test');
  assert.equal(orchestrator.snapshot().visionAvailable, true);
  assert.equal(orchestrator.snapshot().visionChars, CONTEXT.chars);

  await orchestrator.respond({ text: '画面に何がある？', utteranceId: 'u1' });
  assert.equal(llm.requests.length, 1);
  assert.match(llm.requests[0]?.messages[0]?.content ?? '', /VISION TEST 2026/);
  assert.equal(orchestrator.snapshot().visionAvailable, false);

  await orchestrator.respond({ text: 'もう一度', utteranceId: 'u2' });
  assert.equal(llm.requests.length, 2);
  assert.equal((llm.requests[1]?.messages[0]?.content ?? '').includes('VISION TEST 2026'), false);

  clock += 60_001;
  orchestrator.replaceVision({ ...CONTEXT, at: clock - 60_001 }, 'test');
  await orchestrator.respond({ text: '古い画面', utteranceId: 'u3' });
  assert.equal((llm.requests[2]?.messages[0]?.content ?? '').includes('VISION TEST 2026'), false);
  assert.equal(orchestrator.snapshot().visionAvailable, false);
  orchestrator.dispose();
});

test('ADR 0054 D4.2：规则命中不消费视觉上下文（留给下一次 LLM 轮次）', async () => {
  const llm = new FakeLlm();
  const orchestrator = createOrchestrator({
    bus: new FakeBus(),
    voice: { speak: async () => 'completed', stopSpeaking: () => undefined },
    llm,
    rules: createRulePool(RULES),
    card: '角色卡',
    now: () => CONTEXT.at,
    visionTtlMs: 60_000,
  });

  orchestrator.replaceVision(CONTEXT, 'test');
  const reply = await orchestrator.respond({ text: '你好', utteranceId: 'u1' });
  assert.equal(reply.text, '规则回复。');
  assert.equal(llm.requests.length, 0);
  assert.equal(orchestrator.snapshot().visionAvailable, true);

  await orchestrator.respond({ text: '规则之外', utteranceId: 'u2' });
  assert.equal(llm.requests.length, 1);
  assert.match(llm.requests[0]?.messages[0]?.content ?? '', /VISION TEST 2026/);
  orchestrator.dispose();
});
