import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FRAME_EXCLUDE,
  MAX_MODEL_WINDOW_WIDTH_PX,
  MIN_MODEL_WINDOW_WIDTH_PX,
  computeWindowSize,
  frameHeight,
  frameWidth,
  matchesFrameExclude,
  mergeBounds,
  pixelsPerUnitFor,
  type Bounds3,
} from './model-frame';

/** 实测数据：CH0335 的 body + halo 取景包围盒（ADR 0009 D3）。 */
const BODY_HALO: Bounds3 = {
  minX: -0.00319,
  minY: 0,
  minZ: -0.00343,
  maxX: 0.00319,
  maxY: 0.01088,
  maxZ: 0.00145,
};

const BODY: Bounds3 = {
  minX: -0.00319,
  minY: 0,
  minZ: -0.00308,
  maxX: 0.00319,
  maxY: 0.00926,
  maxZ: 0.00145,
};

const HALO: Bounds3 = {
  minX: -0.00141,
  minY: 0.00907,
  minZ: -0.00343,
  maxX: 0.00141,
  maxY: 0.01088,
  maxZ: -0.00141,
};

test('取景排除正则：命中配件，不误伤角色网格', () => {
  assert.equal(matchesFrameExclude('CH0335_Weapon', DEFAULT_FRAME_EXCLUDE), true);
  assert.equal(matchesFrameExclude('CH0335_Prop_Outlline', DEFAULT_FRAME_EXCLUDE), true);
  assert.equal(matchesFrameExclude('brush_01', DEFAULT_FRAME_EXCLUDE), true);
  assert.equal(matchesFrameExclude('CH0335_Body', DEFAULT_FRAME_EXCLUDE), false);
  assert.equal(matchesFrameExclude('CH0335_Halo', DEFAULT_FRAME_EXCLUDE), false);
  assert.equal(matchesFrameExclude(undefined, DEFAULT_FRAME_EXCLUDE), false);
  // 非法正则不能打挂加载
  assert.equal(matchesFrameExclude('CH0335_Weapon', '(('), false);
  assert.equal(matchesFrameExclude('CH0335_Weapon', ''), false);
});

test('mergeBounds：并集与空集', () => {
  const merged = mergeBounds([BODY, HALO]);
  assert.ok(merged);
  assert.equal(merged?.minX, -0.00319);
  assert.equal(merged?.maxY, 0.01088);
  assert.equal(merged?.minZ, -0.00343);
  assert.equal(mergeBounds([]), null);
});

test('取景尺寸与像素定标', () => {
  assert.ok(Math.abs(frameWidth(BODY_HALO) - 0.00638) < 1e-9);
  assert.ok(Math.abs(frameHeight(BODY_HALO) - 0.01088) < 1e-9);

  const ppm = pixelsPerUnitFor(frameHeight(BODY_HALO), 720);
  assert.ok(Math.abs(ppm - 720 / (0.01088 * 1.15)) < 1e-6);

  // 模型单位不是米：必须放大三个数量级以上
  assert.ok(ppm > 50_000);
});

test('窗口尺寸：高度沿用 720，宽度按包围盒比例（CH0335 应为 422×720）', () => {
  const size = computeWindowSize(BODY_HALO, 720);
  assert.equal(size.height, 720);
  assert.equal(size.width, 422);
  assert.equal(size.clampedWidth, false);
  // 与"bbox × 1.15"等价：宽高比一致
  assert.ok(Math.abs(size.width / size.height - 0.00638 / 0.01088) < 0.005);
});

test('窗口宽度护栏：过宽/过窄都被夹住并标记', () => {
  const wide: Bounds3 = { ...BODY_HALO, minX: -0.02, maxX: 0.02 };
  const wideSize = computeWindowSize(wide, 720);
  assert.equal(wideSize.width, MAX_MODEL_WINDOW_WIDTH_PX);
  assert.equal(wideSize.clampedWidth, true);

  const narrow: Bounds3 = { ...BODY_HALO, minX: -0.001, maxX: 0.001 };
  const narrowSize = computeWindowSize(narrow, 720);
  assert.equal(narrowSize.width, MIN_MODEL_WINDOW_WIDTH_PX);
  assert.equal(narrowSize.clampedWidth, true);
});

test('退化输入：零高度/零宽度返回安全值而不是 NaN', () => {
  const flat: Bounds3 = { ...BODY_HALO, minY: 5, maxY: 5 };
  const size = computeWindowSize(flat, 720);
  assert.ok(Number.isFinite(size.width));
  assert.ok(Number.isFinite(size.height));
  assert.equal(size.pixelsPerUnit, 0);

  assert.equal(pixelsPerUnitFor(0, 720), 0);
  assert.equal(pixelsPerUnitFor(1, 0), 0);
});
