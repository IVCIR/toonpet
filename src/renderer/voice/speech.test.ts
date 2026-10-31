import assert from 'node:assert/strict';
import test from 'node:test';
import { computeEnvelope, levelAt } from './envelope';
import { createMouthMapper, levelToFrame } from './mouth-mapping';

const SAMPLE_RATE = 16000;

function sine(ms: number, amplitude = 0.8): Float32Array {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const data = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    data[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * amplitude;
  }
  return data;
}

test('包络：正弦波每窗 RMS 接近 1（按 95 分位峰值归一化）', () => {
  const envelope = computeEnvelope([sine(240)], SAMPLE_RATE);
  assert.ok(envelope.values.length >= 8, `窗数 ${envelope.values.length}`);
  for (const value of envelope.values) {
    assert.ok(value > 0.85 && value <= 1, `value=${value}`);
  }
  assert.equal(Math.round(envelope.windowMs), 30);
  assert.equal(Math.round(envelope.hopMs), 15);
  assert.ok(envelope.durationMs >= 239 && envelope.durationMs <= 241);
});

test('包络：静音全部为 0（噪声门）', () => {
  const envelope = computeEnvelope([new Float32Array(SAMPLE_RATE / 2)], SAMPLE_RATE);
  assert.ok(envelope.values.length > 0);
  for (const value of envelope.values) assert.equal(value, 0);
  assert.equal(envelope.peak, 0);
});

test('包络：多声道按能量平均（同相双声道不会把归一化电平翻倍）', () => {
  const left = sine(120, 0.4);
  const right = sine(120, 0.4);
  const stereo = computeEnvelope([left, right], SAMPLE_RATE);
  const mono = computeEnvelope([left], SAMPLE_RATE);
  assert.equal(stereo.values.length, mono.values.length);
  for (let index = 0; index < stereo.values.length; index += 1) {
    assert.ok(Math.abs((stereo.values[index] ?? 0) - (mono.values[index] ?? 0)) < 1e-4);
  }
});

test('包络：levelAt 按播放位置取样并钳边', () => {
  const envelope = computeEnvelope([sine(240)], SAMPLE_RATE);
  const first = levelAt(envelope, 0);
  assert.ok(first > 0.5);
  assert.equal(levelAt(envelope, -100), first, '负位置钳到首窗');
  assert.equal(levelAt(envelope, 999999), levelAt(envelope, envelope.durationMs));
  assert.equal(levelAt({ ...envelope, values: new Float32Array(0) }, 10), 0);
});

test('口型映射：0 → 闭嘴帧，1 → 最大帧，中间线性量化', () => {
  assert.equal(levelToFrame(0), 0);
  assert.equal(levelToFrame(1), 7);
  assert.equal(levelToFrame(0.5), 4);
  assert.equal(levelToFrame(-1), 0);
  assert.equal(levelToFrame(2), 7);
});

test('口型映射：上限 30Hz（33ms 内不重复提交）', () => {
  const mapper = createMouthMapper();
  const first = mapper.update(1, 1000);
  assert.equal(first.changed, true);
  assert.equal(first.frame, 7);

  const throttled = mapper.update(0, 1010);
  assert.equal(throttled.changed, false);
  assert.equal(throttled.frame, 7, '未到刷新间隔时保持原帧');

  const released = mapper.update(0, 1100);
  assert.equal(released.changed, true);
  assert.ok(released.frame < 7, `释放后应降帧，实际 ${released.frame}`);
});

test('口型映射：reset 回到闭嘴且允许立即更新', () => {
  const mapper = createMouthMapper();
  mapper.update(1, 1000);
  mapper.reset();
  assert.equal(mapper.frame, 0);
  assert.equal(mapper.level, 0);
  const after = mapper.update(1, 1001);
  assert.equal(after.changed, true);
  assert.equal(after.frame, 7);
});
