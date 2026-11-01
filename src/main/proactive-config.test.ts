import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProactiveEnabled, resolveProactiveThresholds } from './proactive-config';

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

test('主动性开关：默认开启', () => {
  const gate = resolveProactiveEnabled(env({}));
  assert.equal(gate.enabled, true);
  assert.equal(gate.reason, 'default');
});

test('主动性开关：PET_PROACTIVE_DISABLE=1 一律关闭（连自检专用开关也压不过它）', () => {
  assert.equal(resolveProactiveEnabled(env({ PET_PROACTIVE_DISABLE: '1' })).enabled, false);
  assert.equal(
    resolveProactiveEnabled(
      env({ PET_PROACTIVE_DISABLE: 'true', PET_SELFTEST: '1', PET_SELFTEST_PROACTIVE: '1' }),
    ).enabled,
    false,
  );
});

test('主动性开关：PET_SELFTEST=1 默认硬关（自检对时序与截图有强断言）', () => {
  const gate = resolveProactiveEnabled(env({ PET_SELFTEST: '1' }));
  assert.equal(gate.enabled, false);
  assert.match(gate.reason, /自检默认硬关/);
});

test('主动性开关：PET_SELFTEST=1 + PET_SELFTEST_PROACTIVE=1 才启用', () => {
  const gate = resolveProactiveEnabled(env({ PET_SELFTEST: '1', PET_SELFTEST_PROACTIVE: '1' }));
  assert.equal(gate.enabled, true);
  assert.match(gate.reason, /PET_SELFTEST_PROACTIVE/);
});

test('主动性开关：布尔值大小写与空白不敏感，非法值算关', () => {
  assert.equal(resolveProactiveEnabled(env({ PET_SELFTEST: '1', PET_SELFTEST_PROACTIVE: 'TRUE' })).enabled, true);
  assert.equal(resolveProactiveEnabled(env({ PET_SELFTEST: '1', PET_SELFTEST_PROACTIVE: ' on ' })).enabled, true);
  assert.equal(resolveProactiveEnabled(env({ PET_SELFTEST: '1', PET_SELFTEST_PROACTIVE: '0' })).enabled, false);
  assert.equal(resolveProactiveEnabled(env({ PET_SELFTEST: '1', PET_SELFTEST_PROACTIVE: 'yes please' })).enabled, false);
});

// ---------------------------------------------------------------------------
// 阈值覆盖（PET_PROACTIVE_*）
// ---------------------------------------------------------------------------

test('阈值：默认一个都不覆盖（空对象 = 全用 constants.ts 的默认值）', () => {
  assert.deepEqual(resolveProactiveThresholds(env({})), {});
  // 开关本身也带上阈值字段，缺省仍是空的
  assert.deepEqual(resolveProactiveEnabled(env({})).thresholds, {});
});

test('阈值：五个键都能覆盖，且按区间钳制', () => {
  const parsed = resolveProactiveThresholds(
    env({
      PET_PROACTIVE_MIN_IDLE_MS: '5000',
      PET_PROACTIVE_MAX_IDLE_MS: '600000',
      PET_PROACTIVE_COOLDOWN_MS: '30000',
      PET_PROACTIVE_MIN_GAP_MS: '2000',
      PET_PROACTIVE_BUDGET: '3',
    }),
  );
  assert.deepEqual(parsed, {
    minUserIdleMs: 5000,
    maxUserIdleMs: 600000,
    cooldownMs: 30000,
    minInteractionGapMs: 2000,
    sessionBudget: 3,
  });

  // 0 会被抬到下限：不允许把"打扰抑制"整段关掉
  assert.equal(resolveProactiveThresholds(env({ PET_PROACTIVE_MIN_IDLE_MS: '0' })).minUserIdleMs, 1000);
  assert.equal(resolveProactiveThresholds(env({ PET_PROACTIVE_BUDGET: '0' })).sessionBudget, 1);
  assert.equal(resolveProactiveThresholds(env({ PET_PROACTIVE_BUDGET: '999' })).sessionBudget, 100);
});

test('阈值：上下界写反时以更保守的一侧为准（宁可她少说话）', () => {
  const parsed = resolveProactiveThresholds(
    env({ PET_PROACTIVE_MIN_IDLE_MS: '600000', PET_PROACTIVE_MAX_IDLE_MS: '120000' }),
  );
  assert.equal(parsed.minUserIdleMs, 600000);
  assert.equal(parsed.maxUserIdleMs, 601000);
});

test('阈值：非法值与非数字被忽略（不覆盖，留给默认值）', () => {
  assert.deepEqual(
    resolveProactiveThresholds(env({ PET_PROACTIVE_MIN_IDLE_MS: 'abc', PET_PROACTIVE_COOLDOWN_MS: '' })),
    {},
  );
});
