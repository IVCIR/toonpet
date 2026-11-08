/**
 * Ollama 探测的测试（ADR 0052 D6；ADR 0053 增加模型列表）。
 *
 * 注入 `fetch`，**不联网**：验三态（在线 / 服务在但缺模型 / 不可达）、模型清单解析、
 * 超时文案、TTL 节流、切模型后强制重探与 dispose 后丢弃结果。它只服务面板诊断，不得影响熔断。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOllamaProbe } from './ollama-probe';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('Ollama 探测：服务在线且模型在 /api/tags → online', async () => {
  let calls = 0;
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ models: [{ name: 'qwen3:4b' }, { name: 'llama3:8b' }] });
    }) as typeof fetch,
  });
  assert.equal(probe.read().status, 'unknown');
  probe.refresh(performance.now());
  await flush();
  const facts = probe.read();
  assert.equal(facts.status, 'online');
  assert.equal(facts.model, 'qwen3:4b');
  assert.equal(facts.detail, null);
  assert.equal(facts.reachable, true);
  assert.equal(facts.modelPresent, true);
  assert.deepEqual(
    facts.models.map((entry) => entry.name),
    ['qwen3:4b', 'llama3:8b'],
  );
  assert.ok(facts.latencyMs !== null && facts.latencyMs >= 0);
  assert.equal(calls, 1);
});

test('Ollama 探测：模型清单带体积与更新时间（下拉框要显示"4.0 GB"这类信息）', async () => {
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    fetchImpl: (async () =>
      jsonResponse({
        models: [
          { name: 'qwen3:4b', size: 2_500_000_000, modified_at: '2026-10-01T08:00:00Z' },
          { model: 'llama3:8b', size: 'nope' },
        ],
      })) as typeof fetch,
  });
  probe.refresh(performance.now());
  await flush();
  const models = probe.read().models;
  assert.equal(models.length, 2);
  assert.equal(models[0]?.sizeBytes, 2_500_000_000);
  assert.equal(models[0]?.modifiedAt, '2026-10-01T08:00:00Z');
  // 坏字段降级为 null，不丢整个条目
  assert.equal(models[1]?.name, 'llama3:8b');
  assert.equal(models[1]?.sizeBytes, null);
});

test('Ollama 探测：标签带 :latest 后缀也算同一个模型', async () => {
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    fetchImpl: (async () => jsonResponse({ models: [{ name: 'qwen3:4b:latest' }] })) as typeof fetch,
  });
  probe.refresh(performance.now());
  await flush();
  assert.equal(probe.read().status, 'online');
});

test('Ollama 探测：服务在线但缺模型 → offline，且说清缺哪个', async () => {
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    fetchImpl: (async () => jsonResponse({ models: [{ name: 'llama3:8b' }] })) as typeof fetch,
  });
  probe.refresh(performance.now());
  await flush();
  const facts = probe.read();
  assert.equal(facts.status, 'offline');
  // 服务本身是通的：面板要能把"服务没起来"与"模型没拉下来"分开显示
  assert.equal(facts.reachable, true);
  assert.equal(facts.modelPresent, false);
  assert.match(facts.detail ?? '', /qwen3:4b/);
});

test('Ollama 探测：连接被拒绝 → offline（文案来自异常）', async () => {
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    fetchImpl: (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: new Error('ECONNREFUSED') });
    }) as typeof fetch,
  });
  probe.refresh(performance.now());
  await flush();
  const facts = probe.read();
  assert.equal(facts.status, 'offline');
  assert.equal(facts.reachable, false);
  assert.deepEqual(facts.models, []);
  assert.match(facts.detail ?? '', /ECONNREFUSED/);
  assert.equal(facts.latencyMs, null);
});

test('Ollama 探测：HTTP 错误码 → offline 且带状态码', async () => {
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    fetchImpl: (async () => jsonResponse({}, 500)) as typeof fetch,
  });
  probe.refresh(performance.now());
  await flush();
  assert.equal(probe.read().status, 'offline');
  assert.match(probe.read().detail ?? '', /HTTP 500/);
});

test('Ollama 探测：TTL 内不重复发请求（面板 4Hz 推状态也不会打爆本地服务）', async () => {
  let calls = 0;
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    ttlMs: 3000,
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ models: [{ name: 'qwen3:4b' }] });
    }) as typeof fetch,
  });
  const now = performance.now();
  probe.refresh(now);
  probe.refresh(now + 100);
  probe.refresh(now + 2900);
  await flush();
  assert.equal(calls, 1);
  probe.refresh(now + 3001);
  await flush();
  assert.equal(calls, 2);
});

test('Ollama 探测：force 绕过 TTL（切换模型后立刻重探）', async () => {
  let calls = 0;
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    ttlMs: 60_000,
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ models: [{ name: 'llama3:8b' }] });
    }) as typeof fetch,
  });
  probe.refresh(performance.now());
  await flush();
  probe.useModel('llama3:8b');
  assert.equal(probe.read().status, 'unknown', '切模型后旧结论作废');
  probe.refresh(performance.now(), true);
  await flush();
  assert.equal(calls, 2);
  assert.equal(probe.read().status, 'online');
  assert.equal(probe.read().model, 'llama3:8b');
});

test('Ollama 探测：同一时刻最多一个在飞请求', async () => {
  let calls = 0;
  const holder: { release: ((value: Response) => void) | null } = { release: null };
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    fetchImpl: (async () => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        holder.release = resolve;
      });
    }) as typeof fetch,
  });
  probe.refresh(performance.now());
  probe.refresh(performance.now() + 5000);
  assert.equal(calls, 1);
  holder.release?.(jsonResponse({ models: [{ name: 'qwen3:4b' }] }));
  await flush();
  assert.equal(probe.read().status, 'online');
});

test('Ollama 探测：dispose 后丢弃在飞结果', async () => {
  const holder: { release: ((value: Response) => void) | null } = { release: null };
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    fetchImpl: (async () =>
      new Promise<Response>((resolve) => {
        holder.release = resolve;
      })) as typeof fetch,
  });
  probe.refresh(performance.now());
  probe.dispose();
  holder.release?.(jsonResponse({ models: [{ name: 'qwen3:4b' }] }));
  await flush();
  assert.equal(probe.read().status, 'unknown');
});
