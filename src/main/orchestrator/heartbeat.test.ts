import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEARTBEAT_TICK_MS,
  LLM_WARMUP_MAX_ATTEMPTS,
  LLM_WARMUP_RETRY_MS,
} from '../../shared/constants';
import type { PresencePort, PresenceSnapshot } from '../../shared/world-types';
import { createHeartbeat } from './heartbeat';
import type { HeartbeatHost } from './heartbeat';
import type { LlmChatResult, LlmClient, LlmWarmupResult } from './llm-client';

// ---------------------------------------------------------------------------
// 测试替身（§7.7 I-4：桩实现同一接口，不往公共接口塞 _forTest）
// ---------------------------------------------------------------------------

interface FakeLlm extends LlmClient {
  warmupCalls: number;
}

/**
 * 假 LLM。`warmup` 不传 = 客户端**不实现**预热（可选方法），
 * 用心跳验证"没有预热能力的客户端会被静默跳过"。
 */
function makeLlm(options: { warmup?: () => Promise<LlmWarmupResult> } = {}): FakeLlm {
  const llm: FakeLlm = {
    model: 'fake:4b',
    baseUrl: 'http://127.0.0.1:11434',
    requestTimeoutMs: 8000,
    warmupCalls: 0,
    async health(): Promise<{ ok: boolean; model: string }> {
      return { ok: true, model: 'fake:4b' };
    },
    async chat(): Promise<LlmChatResult> {
      // 心跳不聊天：这里被调到就说明越界了
      throw new Error('heartbeat 不得调用 chat()');
    },
  };
  const warmup = options.warmup;
  if (warmup) {
    llm.warmup = async (): Promise<LlmWarmupResult> => {
      llm.warmupCalls += 1;
      return warmup();
    };
  }
  return llm;
}

function makePresence(userIdleMs: number | null): PresencePort {
  const snapshot: PresenceSnapshot = {
    userIdleMs,
    foregroundTitle: '',
    foregroundClass: '',
    foregroundCategory: '',
    at: 0,
  };
  return { getSnapshot: () => snapshot };
}

function makeHost(overrides: Partial<HeartbeatHost> = {}): HeartbeatHost {
  return {
    isBusy: () => false,
    isLlmDisabled: () => false,
    ...overrides,
  };
}

/** 固定起点：所有时间断言都用注入时钟，不碰真实时间。 */
const T0 = 1_770_000_000_000;

interface Harness {
  heartbeat: ReturnType<typeof createHeartbeat>;
  llm: FakeLlm;
  start(): void;
  /** 推进一个节拍周期并触发回调（真实节拍器就是这样） */
  tick(): void;
  /** 只触发回调、不推进时钟（测"同一时刻的重复触发"） */
  fire(): void;
  advance(ms: number): void;
  setNow(value: number): void;
  /** 定时器是否真的被 schedule 了（自检/总闸关闭时必须是 false） */
  scheduled(): boolean;
  cancelCount(): number;
}

function setup(
  options: {
    llm?: FakeLlm;
    /** `undefined` = 默认"用户空闲 120s"；`null` = 未装配 presence */
    presence?: PresencePort | null;
    host?: Partial<HeartbeatHost>;
    enabled?: boolean;
  } = {},
): Harness {
  let clock = T0;
  let tickCallback: (() => void) | null = null;
  let cancelCount = 0;
  const llm = options.llm ?? makeLlm({ warmup: async () => ({ ok: true, loadMs: 10 }) });
  const heartbeat = createHeartbeat({
    llm,
    host: makeHost(options.host),
    presence: options.presence === undefined ? makePresence(120_000) : options.presence,
    enabled: options.enabled ?? true,
    reason: 'test',
    intervalMs: HEARTBEAT_TICK_MS,
    schedule: (callback) => {
      tickCallback = callback;
      return 1;
    },
    cancel: () => {
      tickCallback = null;
      cancelCount += 1;
    },
    now: () => clock,
    log: () => undefined,
  });
  return {
    heartbeat,
    llm,
    start(): void {
      heartbeat.start();
    },
    tick(): void {
      clock += HEARTBEAT_TICK_MS;
      tickCallback?.();
    },
    fire(): void {
      tickCallback?.();
    },
    advance(ms: number): void {
      clock += ms;
    },
    setNow(value: number): void {
      clock = value;
    },
    scheduled: () => tickCallback !== null,
    cancelCount: () => cancelCount,
  };
}

/** 等预热 promise 链跑完（`.then → .catch → .finally` 要两个 tick）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// D1：独立节拍 + 与主动性无关
// ---------------------------------------------------------------------------

test('ADR 0033 D1：心跳按 15s 节拍预热一次，成功后不再发', async () => {
  const h = setup();
  h.start();
  assert.equal(h.scheduled(), true, '总闸打开时必须建节拍器');

  h.tick();
  await flush();
  assert.equal(h.llm.warmupCalls, 1);
  const snapshot = h.heartbeat.snapshot();
  assert.equal(snapshot.warmedUp, true);
  assert.equal(snapshot.attempts, 1);
  assert.equal(snapshot.lastTrigger, 'tick');
  assert.equal(snapshot.lastResult, 'ok');
  assert.equal(snapshot.lastSkip, null);

  h.advance(HEARTBEAT_TICK_MS * 10);
  h.tick();
  await flush();
  assert.equal(h.llm.warmupCalls, 1, '预热成功过就再也不会发');
  assert.equal(h.heartbeat.snapshot().lastSkip, 'warmed-up');
});

test('ADR 0033 D1：心跳只管生命周期——不调 chat()、不产生任何对话副作用', async () => {
  const h = setup();
  h.start();
  h.tick();
  await flush();

  const snapshot = h.heartbeat.snapshot();
  assert.equal(snapshot.attempts, 1);
  // chat() 在桩里直接抛错：能跑到这里就说明心跳从未碰过对话路径（W-1/W-3）
  assert.equal(h.llm.warmupCalls, 1);
});

test('ADR 0033 D1：总闸关闭时不建定时器，也不发任何请求（自检的"零后台推理"）', () => {
  const h = setup({ enabled: false });
  h.start();

  assert.equal(h.scheduled(), false, '关闭时连定时器都不许建');
  assert.equal(h.heartbeat.snapshot().running, false);
  assert.equal(h.heartbeat.warmUpNow('model-ready'), false, 'model_ready 也不能绕开总闸');
  assert.equal(h.llm.warmupCalls, 0);
  assert.equal(h.heartbeat.snapshot().lastSkip, 'disabled');
});

test('ADR 0033 D1：stop() 注销节拍器，之后的节拍不再触发预热', async () => {
  const h = setup();
  h.start();
  h.heartbeat.stop();
  assert.equal(h.scheduled(), false);
  assert.equal(h.cancelCount(), 1);

  h.heartbeat.stop();
  assert.equal(h.cancelCount(), 1, 'stop 幂等');

  // 即使有人还持有旧回调，节拍也不会再打出去（tick 回调已被 cancel 清空）
  h.tick();
  await flush();
  assert.equal(h.llm.warmupCalls, 0);
});

// ---------------------------------------------------------------------------
// D2：model_ready 立刻触发
// ---------------------------------------------------------------------------

test('ADR 0033 D2：model_ready 立刻预热一次（不等 15s 节拍）', async () => {
  const h = setup();
  h.start();
  assert.equal(h.llm.warmupCalls, 0, '启动时不预热：要等模型真的出现');

  const fired = h.heartbeat.warmUpNow('model-ready');
  await flush();

  assert.equal(fired, true);
  assert.equal(h.llm.warmupCalls, 1);
  assert.equal(h.heartbeat.snapshot().lastTrigger, 'model-ready');
  assert.equal(h.heartbeat.snapshot().warmedUp, true);
});

test('ADR 0033 D2：model_ready 早于心跳 start() 也能用（顺序无关）', async () => {
  const h = setup();
  // 故意不 start：事件比装配更快时，这一次触发不能丢
  const fired = h.heartbeat.warmUpNow('model-ready');
  await flush();
  assert.equal(fired, true);
  assert.equal(h.llm.warmupCalls, 1);
});

test('ADR 0033 D3：tick 要求 presence 可读，model-ready 不受它约束', async () => {
  const h = setup({ presence: makePresence(null) });
  h.start();

  h.tick();
  await flush();
  assert.equal(h.llm.warmupCalls, 0, '读不到在场感就不做消耗 CPU 的事（ADR 0032 D3 第 4 条）');
  assert.equal(h.heartbeat.snapshot().lastSkip, 'no-presence');

  // 同一个读不到 presence 的心跳：model_ready 仍然预热（启动动作本身就是"人在场"的证据）
  const fired = h.heartbeat.warmUpNow('model-ready');
  await flush();
  assert.equal(fired, true);
  assert.equal(h.llm.warmupCalls, 1);
  assert.equal(h.heartbeat.snapshot().lastTrigger, 'model-ready');
});

test('ADR 0030 D5：presence 端口抛异常时按"读不到"处理，不冒泡', async () => {
  const broken: PresencePort = {
    getSnapshot() {
      throw new Error('koffi boom');
    },
  };
  const h = setup({ presence: broken });
  h.start();

  h.tick();
  await flush();
  assert.equal(h.llm.warmupCalls, 0);
  assert.equal(h.heartbeat.snapshot().lastSkip, 'no-presence');

  h.heartbeat.warmUpNow('model-ready');
  await flush();
  assert.equal(h.llm.warmupCalls, 1, 'model_ready 不需要 presence，因此仍然预热');
});

// ---------------------------------------------------------------------------
// 条件门槛
// ---------------------------------------------------------------------------

test('ADR 0033：编排层忙碌时两种触发都不抢 CPU', async () => {
  const h = setup({ host: { isBusy: () => true } });
  h.start();

  h.tick();
  await flush();
  assert.equal(h.llm.warmupCalls, 0);
  assert.equal(h.heartbeat.snapshot().lastSkip, 'busy');

  assert.equal(h.heartbeat.warmUpNow('model-ready'), false);
  await flush();
  assert.equal(h.llm.warmupCalls, 0, '在途对话优先：宁可晚 15s 热，也不打断老师说话');
  assert.equal(h.heartbeat.snapshot().lastSkip, 'busy');
});

test('ADR 0032 D3 / §11：已熔断的 LLM 不再预热（只读熔断状态，不改它）', async () => {
  let disabled = false;
  const h = setup({ host: { isLlmDisabled: () => disabled } });
  h.start();
  disabled = true;

  h.tick();
  await flush();
  assert.equal(h.llm.warmupCalls, 0);
  assert.equal(h.heartbeat.snapshot().lastSkip, 'llm-disabled');
});

test('ADR 0032 D3：客户端没有 warmup 方法时静默跳过（不报错、不计数）', async () => {
  const h = setup({ llm: makeLlm() });
  h.start();
  h.tick();
  await flush();

  assert.equal(h.heartbeat.snapshot().lastSkip, 'no-warmup');
  assert.equal(h.heartbeat.snapshot().attempts, 0);
});

test('ADR 0033：单飞——预热在飞时再触发不会叠第二发', async () => {
  let release: ((result: LlmWarmupResult) => void) | null = null;
  const h = setup({
    llm: makeLlm({
      warmup: () =>
        new Promise<LlmWarmupResult>((resolve) => {
          release = resolve;
        }),
    }),
  });

  assert.equal(h.heartbeat.warmUpNow('model-ready'), true);
  assert.equal(h.heartbeat.warmUpNow('tick'), false, '在飞时第二次触发被挡');
  assert.equal(h.llm.warmupCalls, 1);
  assert.equal(h.heartbeat.snapshot().lastSkip, 'in-flight');

  assert.ok(release);
  (release as (result: LlmWarmupResult) => void)({ ok: true, loadMs: 1 });
  await flush();
  assert.equal(h.heartbeat.snapshot().warmedUp, true);
  assert.equal(h.heartbeat.warmUpNow('tick'), false, '已热好就不再发');
  assert.equal(h.llm.warmupCalls, 1);
});

test('ADR 0032 D3：预热失败不改熔断、不抛，按 60s 间隔重试且最多 3 次', async () => {
  const h = setup({
    llm: makeLlm({ warmup: async () => ({ ok: false, reason: 'unavailable', detail: 'ECONNREFUSED' }) }),
  });
  h.start();
  h.tick();
  await flush();

  const first = h.heartbeat.snapshot();
  assert.equal(h.llm.warmupCalls, 1);
  assert.equal(first.warmedUp, false);
  assert.equal(first.lastResult, 'unavailable');
  assert.equal(first.attempts, 1);

  // 重试间隔内不再发
  h.advance(LLM_WARMUP_RETRY_MS - 1_000);
  h.fire();
  await flush();
  assert.equal(h.llm.warmupCalls, 1);
  assert.equal(h.heartbeat.snapshot().lastSkip, 'retry-wait');

  // 跨过间隔 → 第二次；再跨过 → 第三次；之后本会话放弃
  for (let index = 0; index < 6; index += 1) {
    h.advance(LLM_WARMUP_RETRY_MS + 1);
    h.tick();
    await flush();
  }
  assert.equal(h.llm.warmupCalls, LLM_WARMUP_MAX_ATTEMPTS);
  assert.equal(h.heartbeat.snapshot().attempts, LLM_WARMUP_MAX_ATTEMPTS);
  assert.equal(h.heartbeat.snapshot().lastSkip, 'attempts-exhausted');
});

test('ADR 0033：预热抛异常被吞掉（不冒泡到节拍器），计次并标记 error', async () => {
  const h = setup({
    llm: makeLlm({
      warmup: async () => {
        throw new Error('boom');
      },
    }),
  });
  h.start();

  assert.doesNotThrow(() => h.tick());
  await flush();
  assert.equal(h.llm.warmupCalls, 1);
  assert.equal(h.heartbeat.snapshot().lastResult, 'error');
  assert.equal(h.heartbeat.snapshot().attempts, 1);
});

test('ADR 0033：预热中的异常不会让节拍器停摆（下一拍照常重试）', async () => {
  let call = 0;
  const h = setup({
    llm: makeLlm({
      warmup: async () => {
        call += 1;
        if (call === 1) throw new Error('first boom');
        return { ok: true, loadMs: 3 };
      },
    }),
  });
  h.start();

  h.tick();
  await flush();
  assert.equal(h.heartbeat.snapshot().lastResult, 'error');

  h.advance(LLM_WARMUP_RETRY_MS + 1);
  h.tick();
  await flush();
  assert.equal(h.heartbeat.snapshot().warmedUp, true, '第二次成功');
});

test('ADR 0033：snapshot 给出可诊断的默认值与字段', () => {
  const h = setup();
  const before = h.heartbeat.snapshot();
  assert.deepEqual(before, {
    enabled: true,
    running: false,
    reason: 'test',
    intervalMs: HEARTBEAT_TICK_MS,
    warmedUp: false,
    attempts: 0,
    lastAttemptAt: null,
    lastTrigger: null,
    lastResult: null,
    lastSkip: null,
  });

  h.start();
  assert.equal(h.heartbeat.snapshot().running, true);
});
