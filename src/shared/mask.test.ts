import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BASE_CONTENT_HEIGHT_PX,
  MASK_HEIGHT,
  MASK_SCALE_MAX,
  MASK_SCALE_MIN,
  MASK_WIDTH,
  WINDOW_HEIGHT_PX,
} from './constants';
import {
  alphaAt,
  alphaBoundingBox,
  cssToMask,
  grabBandAt,
  headBandBottomRow,
  hitTest,
  isInHeadRegion,
  isInsideContent,
  maskSizeFor,
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

// ---------------------------------------------------------------------------
// ADR 0057 D2.5：掩膜分辨率随整体缩放自适应
// ---------------------------------------------------------------------------

test('maskSizeFor：1.0x（带边距的 756 高）就是契约基准 128×72；比例夹在 [0.5x, 2x]', () => {
  // ADR 0058 D1：1.0x 的内容区高度是 720 + 36 = 756，掩膜基准跟着它走
  assert.deepEqual(maskSizeFor(494, BASE_CONTENT_HEIGHT_PX), { width: 128, height: 72 });
  // 2x 窗口 → 2 倍分辨率（每个单元覆盖的 CSS 面积不变）
  assert.deepEqual(maskSizeFor(988, BASE_CONTENT_HEIGHT_PX * 2), { width: 256, height: 144 });
  // 0.5x → 半分辨率
  assert.deepEqual(maskSizeFor(247, BASE_CONTENT_HEIGHT_PX * 0.5), { width: 64, height: 36 });
  // 超出上限/下限都夹住（不无限放大 readPixels 的负担）
  const huge = maskSizeFor(3840, BASE_CONTENT_HEIGHT_PX * 4);
  assert.equal(huge.width, MASK_WIDTH * MASK_SCALE_MAX);
  assert.equal(huge.height, MASK_HEIGHT * MASK_SCALE_MAX);
  const tiny = maskSizeFor(120, BASE_CONTENT_HEIGHT_PX * 0.2);
  assert.ok(tiny.width >= 8 && tiny.height >= 8, '最小 8×8，不能退化成 0');
  assert.ok(MASK_SCALE_MIN < MASK_SCALE_MAX);
  // 非法输入退回基准（不抛）
  assert.deepEqual(maskSizeFor(0, 0), { width: 128, height: 72 });
  assert.deepEqual(maskSizeFor(Number.NaN, Number.NaN), { width: 128, height: 72 });
  // 边距只改变窗口尺寸，不改变"每单元覆盖多少 CSS 面积"：1.0x 仍是 128×72
  assert.deepEqual(maskSizeFor(494, WINDOW_HEIGHT_PX + 36), { width: 128, height: 72 });
});

test('cssToMask：显式尺寸生效，且几何中心仍然映射到掩膜几何中心', () => {
  const half = cssToMask(480 / 2, 720 / 2, 480, 720, 256, 144);
  assertClose(half.mx, 127.5);
  assertClose(half.my, 71.5);
  // 缺省仍是契约的 128×72
  assert.deepEqual(cssToMask(240, 360, 480, 720), { mx: 63.5, my: 35.5 });
});

test('hitTest：掩膜分辨率换了之后，命中点按新网格映射（同一 CSS 点仍命中同一块身体）', () => {
  // 2x 掩膜（256×144）里把右半区涂满：CSS 右半区应该命中、左半区不命中
  const width = 256;
  const height = 144;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = width / 2; x < width; x += 1) mask[y * width + x] = 255;
  }
  assert.equal(hitTest(mask, width, height, 800, 700, 960, 1440).hit, true);
  assert.equal(hitTest(mask, width, height, 100, 700, 960, 1440).hit, false);
  // 同一个 CSS 点在 1x 掩膜上的等价映射也对得上（按 CSS 比例，而不是按像素）
  const oneX = new Uint8Array(MASK_WIDTH * MASK_HEIGHT);
  for (let y = 0; y < MASK_HEIGHT; y += 1) {
    for (let x = MASK_WIDTH / 2; x < MASK_WIDTH; x += 1) oneX[y * MASK_WIDTH + x] = 255;
  }
  assert.equal(hitTest(oneX, MASK_WIDTH, MASK_HEIGHT, 800, 700, 960, 1440).hit, true);
  assert.equal(hitTest(oneX, MASK_WIDTH, MASK_HEIGHT, 100, 700, 960, 1440).hit, false);
});
