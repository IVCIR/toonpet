/**
 * ADR 0055：提供商配置的纯校验测试（不联网、不起服务）。
 *
 * 关注点：
 * 1. 默认仍是本地 Ollama；本地地址只允许回环 http；
 * 2. 远程必须 https（回环除外），禁止 URL 内嵌凭证/查询串；
 * 3. OpenCode Go 的端点不可被配置改写；
 * 4. 编辑时 API Key 留空 = 沿用旧 Key；日志脱敏不泄露完整 Key。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maskApiKey,
  OPENCODE_GO_BASE_URL,
  sanitizeProviderConfig,
  suggestProviderId,
  validateProviderBaseUrl,
  validateProviderModel,
} from '../shared/llm-providers';

test('地址校验：Ollama 只允许回环 http', () => {
  assert.equal(validateProviderBaseUrl('ollama', 'http://127.0.0.1:11434/').value, 'http://127.0.0.1:11434');
  assert.equal(validateProviderBaseUrl('ollama', 'http://localhost:11434').ok, true);
  assert.equal(validateProviderBaseUrl('ollama', 'https://127.0.0.1:11434').ok, false);
  assert.equal(validateProviderBaseUrl('ollama', 'http://192.168.1.5:11434').ok, false);
});

test('地址校验：OpenAI 兼容的远程必须 https，回环可用 http 且保留路径', () => {
  assert.equal(
    validateProviderBaseUrl('openai', 'https://api.example.com/v1/').value,
    'https://api.example.com/v1',
  );
  assert.equal(validateProviderBaseUrl('openai', 'http://127.0.0.1:8080/v1').ok, true);
  assert.equal(validateProviderBaseUrl('openai', 'http://api.example.com/v1').ok, false);
  assert.equal(validateProviderBaseUrl('openai', 'https://user:pass@api.example.com/v1').ok, false);
  assert.equal(validateProviderBaseUrl('openai', 'https://api.example.com/v1?key=x').ok, false);
  assert.equal(validateProviderBaseUrl('openai', 'file:///etc/passwd').ok, false);
});

test('地址校验：OpenCode Go 恒为固定端点（配置不能改写）', () => {
  assert.equal(
    validateProviderBaseUrl('opencode-go', 'https://evil.example.com').value,
    OPENCODE_GO_BASE_URL,
  );
});

test('模型校验：Ollama 与远端各自的字符集', () => {
  assert.equal(validateProviderModel('ollama', 'qwen3:4b').ok, true);
  assert.equal(validateProviderModel('ollama', 'qwen3:4b ').value, 'qwen3:4b');
  assert.equal(validateProviderModel('ollama', 'qwen3 4b').ok, false);
  assert.equal(validateProviderModel('ollama', 'https://x/y').ok, false);

  assert.equal(validateProviderModel('openai', 'openai/gpt-4o-mini').ok, true);
  assert.equal(validateProviderModel('opencode-go', 'claude-sonnet-4-20250514').ok, true);
  assert.equal(validateProviderModel('opencode-go', 'bad model').ok, false);
});

test('清洗：编辑时 API Key 留空沿用旧值，填新值则替换', () => {
  const previous = {
    id: 'oc',
    type: 'opencode-go' as const,
    name: 'OpenCode Go',
    baseUrl: OPENCODE_GO_BASE_URL,
    apiKey: 'sk-old-secret',
    model: 'claude-sonnet-4-20250514',
  };
  const keep = sanitizeProviderConfig(
    { type: 'opencode-go', name: 'OpenCode Go', baseUrl: 'ignored', model: 'claude-sonnet-4-20250514', apiKey: '' },
    { id: 'oc', previous },
  );
  assert.equal(keep.ok, true);
  if (keep.ok) assert.equal(keep.provider.apiKey, 'sk-old-secret');

  const replace = sanitizeProviderConfig(
    { type: 'opencode-go', name: 'OpenCode Go', baseUrl: 'ignored', model: 'claude-sonnet-4-20250514', apiKey: 'sk-new' },
    { id: 'oc', previous },
  );
  assert.equal(replace.ok, true);
  if (replace.ok) assert.equal(replace.provider.apiKey, 'sk-new');
});

test('清洗：坏类型/空名称/超长 Key 都被拒绝', () => {
  assert.equal(sanitizeProviderConfig({ type: 'nope', name: 'x', model: 'm' }, { id: 'p' }).ok, false);
  assert.equal(
    sanitizeProviderConfig({ type: 'openai', name: '  ', baseUrl: 'https://x/v1', model: 'm' }, { id: 'p' }).ok,
    false,
  );
  assert.equal(
    sanitizeProviderConfig(
      { type: 'openai', name: 'x', baseUrl: 'https://x/v1', model: 'm', apiKey: 'a'.repeat(513) },
      { id: 'p' },
    ).ok,
    false,
  );
});

test('脱敏：日志里永远不出现完整 Key', () => {
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('short'), '••••');
  const masked = maskApiKey('sk-1234567890abcdef');
  assert.equal(masked.includes('1234567890'), false);
  assert.match(masked, /^sk-…cdef$/);
});

test('id 建议：不重复，且只含合法字符', () => {
  assert.equal(suggestProviderId('openai', []), 'openai');
  assert.equal(suggestProviderId('openai', ['openai']), 'openai-2');
});
