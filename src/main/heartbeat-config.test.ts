import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHeartbeatGate } from './heartbeat-config';

// ---------------------------------------------------------------------------
// ADR 0033 D1：预热总闸与主动性开关**彻底解耦**
// ---------------------------------------------------------------------------

test('ADR 0033 D1：默认打开（启动后模型就该被热好）', () => {
  assert.deepEqual(resolveHeartbeatGate({}), { enabled: true, reason: 'default' });
});

test('ADR 0033 D1：`PET_PROACTIVE_DISABLE=1` 不影响预热（本轮修的就是这条）', () => {
  // 旧实现（ADR 0032 D3）把预热挂在 idle-drive 节拍上：关掉主动性 = 永远不预热。
  // 现在两者是两条独立节拍，这个断言就是那条解耦的唯一证据。
  const gate = resolveHeartbeatGate({ PET_PROACTIVE_DISABLE: '1' });
  assert.equal(gate.enabled, true);
});

test('ADR 0033 D1：`PET_WARMUP_DISABLE=1` 关闭预热（用户逃生口）', () => {
  assert.deepEqual(resolveHeartbeatGate({ PET_WARMUP_DISABLE: '1' }), {
    enabled: false,
    reason: 'PET_WARMUP_DISABLE=1',
  });
});

test('ADR 0033 D1：`PET_WARMUP_DISABLE` 认 1/true/yes/on，其余（含 0、空串）视为未关', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
    assert.equal(resolveHeartbeatGate({ PET_WARMUP_DISABLE: value }).enabled, false, value);
  }
  for (const value of ['0', '', 'false', 'no', 'off', 'maybe']) {
    assert.equal(resolveHeartbeatGate({ PET_WARMUP_DISABLE: value }).enabled, true, value);
  }
});

test('ADR 0033 D1：自检硬关（零后台推理），且没有任何开关能把它打开', () => {
  const gate = resolveHeartbeatGate({ PET_SELFTEST: '1' });
  assert.equal(gate.enabled, false);
  assert.match(gate.reason, /自检/);

  // 显式写 0 也不能绕过：自检的"零后台推理"是硬保证，不是默认值
  assert.equal(resolveHeartbeatGate({ PET_SELFTEST: '1', PET_WARMUP_DISABLE: '0' }).enabled, false);
  // 主动性开关同样不参与
  assert.equal(resolveHeartbeatGate({ PET_SELFTEST: '1', PET_PROACTIVE_DISABLE: '1' }).enabled, false);
});

test('ADR 0033 D1：两个关闭条件的优先级 = 逃生口 > 自检', () => {
  const gate = resolveHeartbeatGate({ PET_SELFTEST: '1', PET_WARMUP_DISABLE: '1' });
  assert.deepEqual(gate, { enabled: false, reason: 'PET_WARMUP_DISABLE=1' });
});
