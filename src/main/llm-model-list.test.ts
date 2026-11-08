import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENCODE_GO_BASE_URL,
  type LlmModelListResult,
  type LlmProviderConfig,
} from '../shared/llm-providers';
import {
  createModelListService,
  inferProviderType,
  modelListKeyFingerprint,
  resolveModelListTarget,
} from './llm-model-list';

function savedProvider(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    id: 'oc',
    type: 'opencode-go',
    name: 'OpenCode Go',
    baseUrl: OPENCODE_GO_BASE_URL,
    apiKey: 'sk-saved-key',
    model: 'glm-5.3-flash',
    ...overrides,
  };
}

function makeService(
  options: {
    saved?: LlmProviderConfig[];
    result?: LlmModelListResult;
    now?: () => number;
  } = {},
) {
  const calls: LlmProviderConfig[] = [];
  let nowValue = 0;
  const now = options.now ?? (() => nowValue);
  const service = createModelListService({
    savedProviders: () => options.saved ?? [],
    fetchModels: async (provider) => {
      calls.push(provider);
      return options.result ?? { ok: true, models: [{ id: 'grok-4.7', name: 'Grok 4.7' }] };
    },
    now,
    throttleMs: 2000,
  });
  return {
    service,
    calls,
    advance(ms: number): void {
      nowValue += ms;
    },
  };
}

test('类型推断：OpenCode Go 预设 / 回环 / 其他', () => {
  assert.equal(inferProviderType(OPENCODE_GO_BASE_URL), 'opencode-go');
  assert.equal(inferProviderType('https://opencode.ai/inference/go/openai/v1/'), 'opencode-go');
  assert.equal(inferProviderType('http://127.0.0.1:11434'), 'ollama');
  assert.equal(inferProviderType('http://localhost:8080/v1'), 'ollama');
  assert.equal(inferProviderType('https://api.example.com/v1'), 'openai');
});

test('Key 指纹只含长度与末 4 位，不泄露明文', () => {
  const fingerprint = modelListKeyFingerprint('sk-super-secret-1234');
  assert.equal(fingerprint, '20:1234');
  assert.equal(fingerprint.includes('super'), false);
  assert.equal(modelListKeyFingerprint(''), 'none');
});

test('解析：OpenCode Go 固定端点，留空 Key 时注入已保存的 Key', () => {
  const resolved = resolveModelListTarget(
    { type: 'opencode-go', baseUrl: 'https://ignored.example.com/v1', apiKey: '', providerId: 'oc' },
    [savedProvider()],
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.target.provider.baseUrl, OPENCODE_GO_BASE_URL);
  assert.equal(resolved.target.provider.apiKey, 'sk-saved-key');
  assert.equal(resolved.target.provider.model, 'glm-5.3-flash');
});

test('安全：地址被改写时绝不复用已保存的 Key', () => {
  const saved = savedProvider({
    id: 'remote',
    type: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-saved-key',
  });
  const resolved = resolveModelListTarget(
    { type: 'openai', baseUrl: 'https://evil.example.com/v1', apiKey: '', providerId: 'remote' },
    [saved],
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.target.provider.apiKey, '');
});

test('安全：类型不一致时也不复用 Key', () => {
  const resolved = resolveModelListTarget(
    { type: 'openai', baseUrl: OPENCODE_GO_BASE_URL, apiKey: '', providerId: 'oc' },
    [savedProvider()],
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.target.provider.apiKey, '');
});

test('用户刚输入的 Key 优先于已保存的 Key', () => {
  const resolved = resolveModelListTarget(
    { type: 'opencode-go', baseUrl: OPENCODE_GO_BASE_URL, apiKey: 'sk-typed', providerId: 'oc' },
    [savedProvider()],
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.target.provider.apiKey, 'sk-typed');
});

test('非法请求：空地址 / 非法 Key / 非 http(s) 地址都被拒绝且不发请求', async () => {
  const { service, calls } = makeService();
  assert.equal((await service.fetch({ baseUrl: '' })).ok, false);
  assert.equal((await service.fetch({ baseUrl: 'http://127.0.0.1:11434', apiKey: 'a b' })).ok, false);
  assert.equal((await service.fetch({ baseUrl: 'file:///x' })).ok, false);
  assert.equal(calls.length, 0);
});

test('2s 节流：同一配置 2s 内只发一次，超过后重新发', async () => {
  const { service, calls, advance } = makeService();
  const request = { type: 'openai' as const, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' };

  const first = await service.fetch(request);
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1);

  const second = await service.fetch(request);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1, '2s 内重复点击应命中缓存');

  advance(1999);
  await service.fetch(request);
  assert.equal(calls.length, 1);

  advance(1);
  await service.fetch(request);
  assert.equal(calls.length, 2, '满 2s 后应重新请求');
});

test('节流键包含 Key 指纹：换 Key 立即重新请求', async () => {
  const { service, calls } = makeService();
  await service.fetch({ type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-one' });
  await service.fetch({ type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-two' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.apiKey, 'sk-two');
});

test('单飞：同一配置并发点击只发一次请求', async () => {
  const gate: { release: (() => void) | null } = { release: null };
  const calls: LlmProviderConfig[] = [];
  const service = createModelListService({
    savedProviders: () => [],
    fetchModels: async (provider) => {
      calls.push(provider);
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { ok: true, models: [{ id: 'grok-4.7', name: 'Grok 4.7' }] };
    },
    now: () => 0,
    throttleMs: 2000,
  });
  const request = { type: 'openai' as const, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' };
  const first = service.fetch(request);
  const second = service.fetch(request);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const release = gate.release;
  if (release) release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

test('空清单 / 失败 / 抛错都折算成 { ok:false, error }', async () => {
  const empty = makeService({ result: { ok: true, models: [] } });
  const emptyResult = await empty.service.fetch({ type: 'openai', baseUrl: 'https://api.example.com/v1' });
  assert.equal(emptyResult.ok, false);
  if (!emptyResult.ok) assert.match(emptyResult.error, /空/);

  const failed = makeService({ result: { ok: false, error: 'HTTP 401（API Key 可能无效）' } });
  const failedResult = await failed.service.fetch({ type: 'openai', baseUrl: 'https://api.example.com/v1' });
  assert.deepEqual(failedResult, { ok: false, error: 'HTTP 401（API Key 可能无效）' });

  const throwing = createModelListService({
    savedProviders: () => [],
    fetchModels: async () => {
      throw new Error('boom');
    },
  });
  const thrown = await throwing.fetch({ type: 'openai', baseUrl: 'https://api.example.com/v1' });
  assert.equal(thrown.ok, false);
  if (!thrown.ok) assert.match(thrown.error, /boom/);
});

test('模型清单去重、去空白，并保留展示名', async () => {
  const { service, calls } = makeService({
    result: {
      ok: true,
      models: [
        { id: ' grok-4.7 ', name: ' Grok 4.7 ' },
        { id: 'grok-4.7', name: '重复项' },
        { id: 'glm-5.3-flash', name: '' },
      ],
    },
  });
  const result = await service.fetch({ type: 'openai', baseUrl: 'https://api.example.com/v1' });
  assert.equal(calls.length, 1);
  assert.deepEqual(result, {
    ok: true,
    models: [
      { id: 'grok-4.7', name: 'Grok 4.7' },
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
    ],
  });
});
