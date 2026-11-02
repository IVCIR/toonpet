import assert from 'node:assert/strict';
import test from 'node:test';
import { MASK_HEIGHT, MASK_WIDTH } from './constants';
import {
  alphaAt,
  alphaBoundingBox,
  cssToMask,
  grabBandAt,
  headBandBottomRow,
  hitTest,
  isInHeadRegion,
  isInsideContent,
  rgbaToAlpha,
} from './mask';

const CSS_W = 480;
const CSS_H = 720;

function emptyMask(): Uint8Array {
  return new Uint8Array(MASK_WIDTH * MASK_HEIGHT);
}

function filledMask(value = 255): Uint8Array {
  const mask = emptyMask();
  mask.fill(value);
  return mask;
}

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );
}

test('cssToMask 把内容区几何中心映射到掩膜几何中心', () => {
  const { mx, my } = cssToMask(CSS_W / 2, CSS_H / 2, CSS_W, CSS_H);
  assertClose(mx, 63.5);
  assertClose(my, 35.5);
});

test('cssToMask 的角点对应半个单元的偏移', () => {
  assert.deepEqual(cssToMask(0, 0, CSS_W, CSS_H), { mx: -0.5, my: -0.5 });
  assert.deepEqual(cssToMask(CSS_W, CSS_H, CSS_W, CSS_H), { mx: 127.5, my: 71.5 });
});

test('isInsideContent 用左闭右开判定，退化为 0 尺寸时不抛异常', () => {
  assert.equal(isInsideContent(0, 0, CSS_W, CSS_H), true);
  assert.equal(isInsideContent(CSS_W, CSS_H, CSS_W, CSS_H), false);
  assert.equal(isInsideContent(-1, 10, CSS_W, CSS_H), false);
  assert.equal(isInsideContent(10, 10, 0, CSS_H), false);
});

test('全不透明掩膜在内容区内处处 alpha 为 1', () => {
  const mask = filledMask();
  assertClose(alphaAt(mask, MASK_WIDTH, MASK_HEIGHT, 63.5, 35.5), 1);
  assertClose(alphaAt(mask, MASK_WIDTH, MASK_HEIGHT, 0, 0), 1);
});

test('全透明掩膜处处为 0', () => {
  const mask = emptyMask();
  assertClose(alphaAt(mask, MASK_WIDTH, MASK_HEIGHT, 63.5, 35.5), 0);
});

test('单元中心采样得到该单元自身的值', () => {
  const mask = emptyMask();
  mask[10 * MASK_WIDTH + 10] = 255;
  assertClose(alphaAt(mask, MASK_WIDTH, MASK_HEIGHT, 10, 10), 1);
});

test('两单元之间的中点按双线性取半值', () => {
  const mask = emptyMask();
  mask[10 * MASK_WIDTH + 10] = 255;
  assertClose(alphaAt(mask, MASK_WIDTH, MASK_HEIGHT, 10.5, 10), 0.5);
});

test('非有限坐标按 0 处理，不抛异常', () => {
  const mask = filledMask();
  assert.equal(alphaAt(mask, MASK_WIDTH, MASK_HEIGHT, Number.NaN, 0), 0);
  assert.equal(alphaAt(mask, MASK_WIDTH, MASK_HEIGHT, 0, Number.POSITIVE_INFINITY), 0);
});

test('rgbaToAlpha 取每像素第 4 个字节', () => {
  const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(rgbaToAlpha(rgba, 2, 1)), [4, 8]);
});

test('rgbaToAlpha 支持垂直翻转（WebGL 帧缓冲原点在左下）', () => {
  const rgba = new Uint8Array(2 * 2 * 4);
  [10, 20, 30, 40].forEach((alpha, index) => {
    rgba[index * 4 + 3] = alpha;
  });
  assert.deepEqual(Array.from(rgbaToAlpha(rgba, 2, 2, false)), [10, 20, 30, 40]);
  assert.deepEqual(Array.from(rgbaToAlpha(rgba, 2, 2, true)), [30, 40, 10, 20]);
});

test('包围盒只统计达到命中阈值的单元', () => {
  const mask = emptyMask();
  for (let y = 36; y <= 71; y += 1) {
    for (let x = 24; x <= 103; x += 1) {
      mask[y * MASK_WIDTH + x] = 255;
    }
  }
  // 稀疏噪声不应影响包围盒
  mask[0] = 100;

  const bbox = alphaBoundingBox(mask, MASK_WIDTH, MASK_HEIGHT);
  assert.deepEqual(bbox, { minX: 24, minY: 36, maxX: 103, maxY: 71 });
});

test('空掩膜的包围盒为 null', () => {
  assert.equal(alphaBoundingBox(emptyMask(), MASK_WIDTH, MASK_HEIGHT), null);
});

test('头部区是包围盒顶部 22% 的横带（R-10）', () => {
  const mask = emptyMask();
  for (let y = 36; y <= 71; y += 1) {
    for (let x = 24; x <= 103; x += 1) {
      mask[y * MASK_WIDTH + x] = 255;
    }
  }
  const bbox = alphaBoundingBox(mask, MASK_WIDTH, MASK_HEIGHT);
  assert.ok(bbox);
  assertClose(headBandBottomRow(bbox), 43.92); // 36 + 36 * 0.22

  assert.equal(isInHeadRegion(bbox, 60, 36), true);
  assert.equal(isInHeadRegion(bbox, 60, 40), true);
  assert.equal(isInHeadRegion(bbox, 60, 44), false);
  assert.equal(isInHeadRegion(bbox, 60, 50), false);
  assert.equal(isInHeadRegion(bbox, 10, 40), false); // 横向在包围盒外
  assert.equal(isInHeadRegion(bbox, 104, 40), false); // maxX + 1 为开边界
  assert.equal(isInHeadRegion(null, 60, 40), false);
});

test('抓取带：顶部 22% 为头、底部 20% 为脚、中间为身体（ADR 0035）', () => {
  const mask = emptyMask();
  for (let y = 36; y <= 71; y += 1) {
    for (let x = 24; x <= 103; x += 1) {
      mask[y * MASK_WIDTH + x] = 255;
    }
  }
  const bbox = alphaBoundingBox(mask, MASK_WIDTH, MASK_HEIGHT);
  assert.ok(bbox);
  // 36 行高：头部 < 43.92，脚部 >= 64.8
  assert.equal(grabBandAt(bbox, 60, 36), 'head');
  assert.equal(grabBandAt(bbox, 60, 43), 'head');
  assert.equal(grabBandAt(bbox, 60, 44), 'body');
  assert.equal(grabBandAt(bbox, 60, 64), 'body');
  assert.equal(grabBandAt(bbox, 60, 65), 'foot');
  assert.equal(grabBandAt(bbox, 60, 71), 'foot');
  // 越界 / 无包围盒
  assert.equal(grabBandAt(bbox, 60, 35), null);
  assert.equal(grabBandAt(bbox, 60, 72), null);
  assert.equal(grabBandAt(bbox, 10, 50), null);
  assert.equal(grabBandAt(null, 60, 50), null);
});

test('hitTest 在内容区外一律不命中（即使掩膜不透明）', () => {
  const mask = filledMask();
  const outside = hitTest(mask, MASK_WIDTH, MASK_HEIGHT, CSS_W + 5, 10, CSS_W, CSS_H);
  assert.equal(outside.inside, false);
  assert.equal(outside.hit, false);
});

test('hitTest 在内容区内按 alpha 阈值判定', () => {
  const opaque = hitTest(filledMask(), MASK_WIDTH, MASK_HEIGHT, 240, 360, CSS_W, CSS_H);
  assert.equal(opaque.inside, true);
  assert.equal(opaque.hit, true);

  const transparent = hitTest(emptyMask(), MASK_WIDTH, MASK_HEIGHT, 240, 360, CSS_W, CSS_H);
  assert.equal(transparent.inside, true);
  assert.equal(transparent.hit, false);
});

test('hitTest 在内容区尺寸退化为 0 时不抛异常', () => {
  const sample = hitTest(emptyMask(), MASK_WIDTH, MASK_HEIGHT, 0, 0, 0, 0);
  assert.equal(sample.inside, false);
  assert.equal(sample.hit, false);
});
