/**
 * `config.json` 持久化的测试（ADR 0052 D5；ADR 0053 加 `llm.model`）。
 *
 * 四条必须成立的规则：
 * 1. 坏文件不抛、不阻断启动（解析失败只报错，值用默认）；
 * 2. 只写与默认值不同的项，且**保留未知顶层键**（以后要放别的设置）；
 * 3. 写入是"临时文件 + rename"，读回就是写进去的东西；
 * 4. `llm.model` 只接受合法模型名，写 `null` 时从文件里**移除** `llm` 键。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OPENCODE_GO_BASE_URL } from '../shared/llm-providers';
import {
  countCustomized,
  isValidModelName,
  PANEL_CONFIG_VERSION,
  parsePanelConfig,
  readPanelConfigFile,
  resolvePanelConfigPath,
  serializePanelConfig,
  writePanelConfigFile,
} from './panel-config';
import { TUNABLE_DEFAULTS, TUNABLE_META } from '../shared/tunable-params';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'aa3dpet-panel-'));
}

test('config.json：合法文件只取已知项，越界被夹到区间', () => {
  const state = parsePanelConfig(
    JSON.stringify({
      version: 1,
      updatedAt: '2026-11-06T03:12:44.120Z',
      tuning: { 'sit.phaseAHeadTuneRad': -0.12, 'gaze.eyeStiffness': 999, unknown: 1 },
    }),
  );
  assert.equal(state.tuning['sit.phaseAHeadTuneRad'], -0.12);
  assert.equal(state.tuning['gaze.eyeStiffness'], TUNABLE_META['gaze.eyeStiffness'].max);
  assert.equal('unknown' in state.tuning, false);
  assert.equal(state.savedAt, '2026-11-06T03:12:44.120Z');
  assert.match(state.error ?? '', /1 项被忽略/);
});

test('config.json：坏 JSON / 非对象 / 坏时间戳都不抛', () => {
  const broken = parsePanelConfig('{ not json');
  assert.deepEqual(broken.tuning, {});
  assert.equal(broken.llmModel, null);
  assert.match(broken.error ?? '', /不是合法 JSON/);
  assert.equal(broken.exists, true);

  const array = parsePanelConfig('[1,2,3]');
  assert.deepEqual(array.tuning, {});
  assert.match(array.error ?? '', /顶层不是对象/);

  const badTime = parsePanelConfig(JSON.stringify({ updatedAt: '昨天', tuning: {} }));
  assert.equal(badTime.savedAt, null);
  assert.equal(badTime.error, null);

  const noTuning = parsePanelConfig(JSON.stringify({ version: 1 }));
  assert.deepEqual(noTuning.tuning, {});
  assert.equal(noTuning.error, null);
});

test('config.json：不存在的文件按"空配置"返回（首次运行不是错误）', () => {
  const dir = tempDir();
  try {
    const state = readPanelConfigFile(path.join(dir, 'missing.json'));
    assert.equal(state.exists, false);
    assert.equal(state.error, null);
    assert.deepEqual(state.tuning, {});
    assert.equal(state.llmModel, null);
    assert.equal(state.savedAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config.json：序列化只写改动项，保留未知顶层键，版本固定', () => {
  const text = serializePanelConfig(
    { values: { ...TUNABLE_DEFAULTS, 'sit.phaseAHeadTuneRad': -0.12, 'sit.spineOverlayWeight': 0.85 } },
    '2026-11-06T03:12:44.120Z',
    JSON.stringify({ window: { alwaysOnTop: true }, tuning: { 'gaze.eyeStiffness': 99 } }),
  );
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed['version'], PANEL_CONFIG_VERSION);
  assert.equal(parsed['updatedAt'], '2026-11-06T03:12:44.120Z');
  assert.deepEqual(parsed['tuning'], {
    'sit.phaseAHeadTuneRad': -0.12,
    'sit.spineOverlayWeight': 0.85,
  });
  // 未知顶层键原样保留（本文件不解析它们）
  assert.deepEqual(parsed['window'], { alwaysOnTop: true });
  assert.ok(text.endsWith('\n'));
});

test('config.json：写盘 → 读回是同一组值（原子写不留 .tmp）', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  try {
    writeFileSync(file, JSON.stringify({ keep: 'me' }), 'utf8');
    const values = { ...TUNABLE_DEFAULTS, 'gaze.eyeStiffness': 16 };
    const write = writePanelConfigFile(file, { values }, '2026-11-06T04:00:00.000Z');
    assert.equal(write.ok, true);
    assert.equal(write.error, null);

    const state = readPanelConfigFile(file);
    assert.equal(state.tuning['gaze.eyeStiffness'], 16);
    assert.equal(state.savedAt, '2026-11-06T04:00:00.000Z');
    assert.equal(state.error, null);
    assert.equal(countCustomized(values), 1);

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(raw['keep'], 'me');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config.json：路径可被 PET_PANEL_CONFIG 覆盖（截图脚本隔离用户配置）', () => {
  assert.equal(
    resolvePanelConfigPath('D:\\app', {} as NodeJS.ProcessEnv),
    path.join('D:\\app', 'config.json'),
  );
  assert.equal(
    resolvePanelConfigPath('D:\\app', { PET_PANEL_CONFIG: 'tmp\\panel-shot.json' } as NodeJS.ProcessEnv),
    path.join('D:\\app', 'tmp\\panel-shot.json'),
  );
  const absolute = path.join('C:\\', 'elsewhere', 'panel.json');
  assert.equal(
    resolvePanelConfigPath('D:\\app', { PET_PANEL_CONFIG: absolute } as NodeJS.ProcessEnv),
    absolute,
  );
});

// ---------------------------------------------------------------------------
// ADR 0053：llm.model
// ---------------------------------------------------------------------------

test('config.json：llm.model 合法时被读出，写回时保留在 llm 下', () => {
  const state = parsePanelConfig(JSON.stringify({ llm: { model: 'qwen3:4b' } }));
  assert.equal(state.llmModel, 'qwen3:4b');
  assert.equal(state.error, null);

  const text = serializePanelConfig(
    { values: { ...TUNABLE_DEFAULTS }, llmModel: 'qwen2.5:7b-instruct' },
    '2026-11-06T05:00:00.000Z',
  );
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(parsed['llm'], { model: 'qwen2.5:7b-instruct' });

  const round = parsePanelConfig(text);
  assert.equal(round.llmModel, 'qwen2.5:7b-instruct');
});

test('config.json：llm.model 非法时忽略并记一条"被忽略"，不当成致命错误', () => {
  const state = parsePanelConfig(JSON.stringify({ llm: { model: 'http://evil/x' } }));
  assert.equal(state.llmModel, null);
  assert.match(state.error ?? '', /llm\.model/);
});

test('config.json：llmModel 为 null 时移除 llm 键（回到环境变量默认）', () => {
  const text = serializePanelConfig(
    { values: { ...TUNABLE_DEFAULTS }, llmModel: null },
    '2026-11-06T05:00:00.000Z',
    JSON.stringify({ llm: { model: 'qwen3:4b' }, keep: 1 }),
  );
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal('llm' in parsed, false);
  assert.equal(parsed['keep'], 1, '未知键仍然保留');
});

test('模型名校验：只接受 name:tag 形态，拒绝 URL/空白/超长', () => {
  assert.equal(isValidModelName('qwen3:4b'), true);
  assert.equal(isValidModelName('library/qwen2.5:7b-instruct'), true);
  assert.equal(isValidModelName('llama3.2:1b-q4_K_M'), true);
  assert.equal(isValidModelName(' http://evil/x '), false);
  assert.equal(isValidModelName(''), false);
  assert.equal(isValidModelName('   '), false);
  assert.equal(isValidModelName(`a:${'x'.repeat(200)}`), false);
  assert.equal(isValidModelName(42), false);
});

// ---------------------------------------------------------------------------
// ADR 0055：llm.providers / llm.activeProvider
// ---------------------------------------------------------------------------

test('config.json：读出提供商列表与生效项，坏项只跳过不阻断', () => {
  const state = parsePanelConfig(
    JSON.stringify({
      version: 1,
      llm: {
        activeProvider: 'oc',
        providers: [
          {
            id: 'oc',
            type: 'opencode-go',
            name: 'OpenCode Go',
            baseUrl: 'https://evil.example.com',
            apiKey: 'sk-test',
            model: 'claude-sonnet-4-20250514',
          },
          {
            id: 'bad',
            type: 'openai',
            name: '坏地址',
            baseUrl: 'http://remote.example.com/v1',
            model: 'm',
          },
          {
            id: 'oc',
            type: 'ollama',
            name: '重复 id',
            baseUrl: 'http://127.0.0.1:11434',
            model: 'qwen3:4b',
          },
        ],
      },
    }),
  );
  assert.equal(state.llmProviders.length, 1);
  assert.equal(state.llmProviders[0]?.id, 'oc');
  // OpenCode Go 的端点被强制成预设，文件里的地址不能改写它
  assert.equal(state.llmProviders[0]?.baseUrl, OPENCODE_GO_BASE_URL);
  assert.equal(state.llmProviders[0]?.apiKey, 'sk-test');
  assert.equal(state.llmActiveProvider, 'oc');
  assert.match(state.error ?? '', /2 项被忽略/);
});

test('config.json：activeProvider 指向不存在的 id → null（运行时会选第一个）', () => {
  const state = parsePanelConfig(
    JSON.stringify({
      llm: {
        activeProvider: 'missing',
        providers: [
          {
            id: 'local',
            type: 'ollama',
            name: '本地',
            baseUrl: 'http://127.0.0.1:11434',
            model: 'qwen3:4b',
          },
        ],
      },
    }),
  );
  assert.equal(state.llmActiveProvider, null);
  assert.equal(state.llmProviders.length, 1);
  assert.match(state.error ?? '', /activeProvider/);
});

test('config.json：写提供商用新格式，保留原 Key 与未知 llm 字段之外的结构', () => {
  const provider = {
    id: 'oc',
    type: 'opencode-go' as const,
    name: 'OpenCode Go',
    baseUrl: OPENCODE_GO_BASE_URL,
    apiKey: 'sk-secret',
    model: 'claude-sonnet-4-20250514',
  };
  const text = serializePanelConfig(
    { values: { ...TUNABLE_DEFAULTS }, llmProviders: [provider], llmActiveProvider: 'oc' },
    '2026-11-08T00:00:00.000Z',
  );
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const llm = parsed['llm'] as Record<string, unknown>;
  assert.equal(llm['activeProvider'], 'oc');
  assert.deepEqual(llm['providers'], [provider]);
  assert.equal('model' in llm, false);
});

test('config.json：providers 为空时回到旧格式；两者都没有则移除 llm', () => {
  const legacy = JSON.parse(
    serializePanelConfig(
      { values: { ...TUNABLE_DEFAULTS }, llmModel: 'qwen3:4b', llmProviders: [] },
      '2026-11-08T00:00:00.000Z',
    ),
  ) as Record<string, unknown>;
  assert.deepEqual(legacy['llm'], { model: 'qwen3:4b' });

  const none = JSON.parse(
    serializePanelConfig({ values: { ...TUNABLE_DEFAULTS }, llmProviders: null }, '2026-11-08T00:00:00.000Z'),
  ) as Record<string, unknown>;
  assert.equal('llm' in none, false);
});
