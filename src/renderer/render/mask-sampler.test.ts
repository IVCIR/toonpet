import assert from 'node:assert/strict';
import test from 'node:test';
import { MASK_HEIGHT, MASK_WIDTH } from '../../shared/constants';
import { MaskSampler } from './mask-sampler';

const CSS_W = 480;
const CSS_H = 720;

function emptyMask(): Uint8Array {
  return new Uint8Array(MASK_WIDTH * MASK_HEIGHT);
}

/** 下 1/2 高度、中间横向的一块实心区域：bbox = cols 24..103, rows 36..71 */
function bodyMask(): Uint8Array {
  const mask = emptyMask();
  for (let y = 36; y <= 71; y += 1) {
    for (let x = 24; x <= 103; x += 1) {
      mask[y * MASK_WIDTH + x] = 255;
    }
  }
  return mask;
}

test('从未采集过 → cold，走矩形退路并计数', () => {
  const sampler = new MaskSampler();
  const sample = sampler.sample(240, 360, CSS_W, CSS_H, 1000);
  assert.equal(sample.state, 'cold');
  assert.equal(sample.degraded, true);
  assert.equal(sample.hit, true); // 内容区矩形内
  assert.equal(sample.head, null);
  assert.deepEqual(sampler.snapshot(1000).counters, { cold: 1, stale: 0 });
});

test('采集成功 → ready，命中走双线性，头部带按包围盒顶部 22%', () => {
  const sampler = new MaskSampler();
  sampler.recordSuccess(1000, bodyMask());

  // 身体中部：命中，但不在头部带
  const body = sampler.sample(240, 605, CSS_W, CSS_H, 1010);
  assert.equal(body.state, 'ready');
  assert.equal(body.degraded, false);
  assert.equal(body.hit, true);
  assert.equal(body.head, false);

  // 包围盒顶部 22%（rows 36..43.92）：命中且算头部
  const head = sampler.sample(240, 395, CSS_W, CSS_H, 1010);
  assert.equal(head.hit, true);
  assert.equal(head.head, true);

  assert.deepEqual(sampler.snapshot(1010).counters, { cold: 0, stale: 0 });
});

test('ready 时透明区判不命中（证明走的是双线性而不是矩形退路）', () => {
  const sampler = new MaskSampler();
  sampler.recordSuccess(1000, bodyMask());
  const top = sampler.sample(240, 60, CSS_W, CSS_H, 1010);
  assert.equal(top.state, 'ready');
  assert.equal(top.hit, false);
  assert.equal(top.head, false);
});

test('超过 100ms 未刷新 → stale，走矩形退路并计数', () => {
  const sampler = new MaskSampler();
  sampler.recordSuccess(1000, bodyMask());

  const fresh = sampler.sample(240, 60, CSS_W, CSS_H, 1099);
  assert.equal(fresh.state, 'ready');
  assert.equal(fresh.hit, false);

  const stale = sampler.sample(240, 60, CSS_W, CSS_H, 1101);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.degraded, true);
  assert.equal(stale.hit, true); // 矩形退路：内容区内即命中
  assert.equal(stale.head, null);
  assert.deepEqual(sampler.snapshot(1101).counters, { cold: 0, stale: 1 });
});

test('上下文丢失 → 立即 cold（即使刚才成功过），恢复后回到 ready', () => {
  const sampler = new MaskSampler();
  sampler.recordSuccess(1000, bodyMask());
  sampler.recordFailure();

  const lost = sampler.sample(240, 60, CSS_W, CSS_H, 1001);
  assert.equal(lost.state, 'cold');
  assert.equal(lost.degraded, true);
  assert.equal(lost.head, null);

  sampler.recordSuccess(1002, bodyMask());
  const recovered = sampler.sample(240, 60, CSS_W, CSS_H, 1003);
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.hit, false);
});

test('两个降级计数互相独立', () => {
  const sampler = new MaskSampler();
  sampler.sample(10, 10, CSS_W, CSS_H, 0); // cold +1
  sampler.sample(10, 10, CSS_W, CSS_H, 0); // cold +1

  sampler.recordSuccess(1000, bodyMask());
  sampler.sample(10, 10, CSS_W, CSS_H, 1200); // stale +1
  sampler.sample(10, 10, CSS_W, CSS_H, 1200); // stale +1

  assert.deepEqual(sampler.snapshot(1200).counters, { cold: 2, stale: 2 });
});

test('矩形退路在内容区外判不命中', () => {
  const sampler = new MaskSampler();
  const outside = sampler.sample(CSS_W + 10, 10, CSS_W, CSS_H, 0);
  assert.equal(outside.hit, false);
  assert.equal(outside.degraded, true);
});
