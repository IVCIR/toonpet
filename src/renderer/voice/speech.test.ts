import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOUTH_FRAME_CLOSED,
  MOUTH_VISEME_SLOT_MS,
} from '../../shared/constants';
import { computeEnvelope, levelAt } from './envelope';
import { createMouthMapper, levelToFrame, visemeFrame, visemeIndex } from './mouth-mapping';

/** 图集帧总数（8×8，与 `CH0335_MOUTH_LAYOUT` 同源） */
const MOUTH_FRAME_COUNT = 64;

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

test('口型映射：静音 = 图集"闭嘴"帧（0，平直细线；不是微张的椭圆）', () => {
  assert.equal(MOUTH_FRAME_CLOSED, 0);
  assert.equal(levelToFrame(0), MOUTH_FRAME_CLOSED);
  assert.equal(levelToFrame(-1), MOUTH_FRAME_CLOSED);
  assert.equal(levelToFrame(Number.NaN), MOUTH_FRAME_CLOSED);
});

test('口型映射：四档元音（闭 / 微张 / 中张 / 大张）落在官方图集帧上', () => {
  // 档位边界 0.12 / 0.40 / 0.72
  assert.equal(visemeIndex(0), 0);
  assert.equal(visemeIndex(0.11), 0);
  assert.equal(visemeIndex(0.12), 1);
  assert.equal(visemeIndex(0.39), 1);
  assert.equal(visemeIndex(0.4), 2);
  assert.equal(visemeIndex(0.71), 2);
  assert.equal(visemeIndex(0.72), 3);
  assert.equal(visemeIndex(1), 3);
  assert.equal(visemeIndex(-1), 0);
  assert.equal(visemeIndex(Number.NaN), 0);

  // 每一档至少两张官方帧（档内轮换才有"嘴在动"）
  for (const level of [0, 0.25, 0.5, 0.9]) {
    const a = visemeFrame(level, 0);
    const b = visemeFrame(level, MOUTH_VISEME_SLOT_MS);
    assert.ok(Number.isInteger(a) && a >= 0 && a < MOUTH_FRAME_COUNT);
    if (level > 0) assert.notEqual(a, b, `level=${level} 同一档必须能换帧`);
  }
  // 大张档用 2 / 9（不同元音），不是永远同一张
  assert.deepEqual([visemeFrame(1, 0), visemeFrame(1, MOUTH_VISEME_SLOT_MS)], [2, 9]);
  // 闭档永远回到 7
  assert.equal(visemeFrame(0, 0), MOUTH_FRAME_CLOSED);
  assert.equal(visemeFrame(0, MOUTH_VISEME_SLOT_MS * 7), MOUTH_FRAME_CLOSED);
});

test('口型映射：上限 30Hz（33ms 内不重复提交）', () => {
  const mapper = createMouthMapper();
  const first = mapper.update(1, 1000);
  assert.equal(first.changed, true);
  assert.equal(first.frame, visemeFrame(1, 1000), '大张档按槽位在 2 / 9 之间轮换');
  assert.ok(first.frame === 2 || first.frame === 9);

  const throttled = mapper.update(0, 1010);
  assert.equal(throttled.changed, false);
  assert.equal(throttled.frame, first.frame, '未到刷新间隔时保持原帧');

  const released = mapper.update(0, 1100);
  assert.equal(released.changed, true);
  assert.equal(released.frame, MOUTH_FRAME_CLOSED, '静音必须回到闭嘴帧');
});

test('说话多帧化：一段"响 → 轻 → 静"的包络至少切换 3 种嘴型（不再只有一张嘴）', () => {
  const mapper = createMouthMapper();
  const frames = new Set<number>();
  let t = 0;
  for (let i = 0; i < 260; i += 1) {
    t += 16;
    const cycle = i % 45;
    const level = cycle < 14 ? 0.02 : cycle < 30 ? 0.3 : 0.95;
    frames.add(mapper.update(level, t).frame);
  }
  assert.ok(frames.size >= 3, `只出现 ${frames.size} 种嘴型：${[...frames].join(',')}`);
  assert.ok(frames.has(MOUTH_FRAME_CLOSED), '静音段必须闭回 0 号帧');
  assert.ok(frames.has(2) || frames.has(9), '高音量必须到大张帧');
  assert.ok(frames.has(6) || frames.has(14) || frames.has(1) || frames.has(3), '低/中音量要有中间帧');
});

test('口型映射：reset 回到闭嘴且允许立即更新', () => {
  const mapper = createMouthMapper();
  mapper.update(1, 1000);
  mapper.reset();
  assert.equal(mapper.frame, MOUTH_FRAME_CLOSED);
  assert.equal(mapper.level, 0);
  const after = mapper.update(1, 1001);
  assert.equal(after.changed, true);
  assert.equal(after.frame, visemeFrame(1, 1001));
});
