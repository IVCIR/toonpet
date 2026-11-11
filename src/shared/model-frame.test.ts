import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE_CONTENT_HEIGHT_PX, MODEL_VIEW_PADDING_PX, MODEL_VIEW_PADDING_X_PX } from './constants';
import {
  DEFAULT_FRAME_EXCLUDE,
  MAX_MODEL_WINDOW_WIDTH_PX,
  MIN_MODEL_WINDOW_WIDTH_PX,
  computeWindowSize,
  fallbackWindowSize,
  frameHeight,
  frameWidth,
  matchesFrameExclude,
  mergeBounds,
  pixelsPerUnitFor,
  viewPaddingShare,
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

test('窗口尺寸：高度 = 720 + 头顶边距，宽度按包围盒比例 + 左右边距（CH0335 应为 550×756）', () => {
  const size = computeWindowSize(BODY_HALO, 720);
  assert.equal(size.height, BASE_CONTENT_HEIGHT_PX);
  assert.equal(size.height, 756);
  assert.equal(size.width, 550);
  assert.equal(size.clampedWidth, false);
});

test('视口边距是加法：1.0x 的像素定标与加边距之前完全一样（ADR 0058 D1）', () => {
  const size = computeWindowSize(BODY_HALO, 720);
  // 旧口径（无安全边距）：720 / (高 × 1.15)
  const legacy = pixelsPerUnitFor(frameHeight(BODY_HALO), 720);
  assert.ok(Math.abs(size.pixelsPerUnit - legacy) < 1e-6, `${size.pixelsPerUnit} vs ${legacy}`);
  // 她的像素高度（包围盒 × ppu）与旧窗口一样是 626px，多出来的 36px 是空白
  const modelHeightPx = frameHeight(BODY_HALO) * size.pixelsPerUnit;
  assert.ok(Math.abs(modelHeightPx - 720 / 1.15) < 0.05);
  // 左右各 MODEL_VIEW_PADDING_X_PX、头顶 MODEL_VIEW_PADDING_PX（叠在原有 15% 留白之上）；
  // 底边 0（脚底贴窗口底边，锚点不变）
  const modelWidthPx = frameWidth(BODY_HALO) * size.pixelsPerUnit;
  const legacyWidth = Math.round(modelWidthPx * 1.15);
  assert.equal(size.width - legacyWidth, 2 * MODEL_VIEW_PADDING_X_PX);
  const legacyTopMargin = 720 - 720 / 1.15;
  assert.ok(Math.abs(size.height - modelHeightPx - legacyTopMargin - MODEL_VIEW_PADDING_PX) < 0.5);
});

test('边距份额：与内容区高度同比，2.0x 时像素定标严格翻倍', () => {
  const share = viewPaddingShare(720);
  assert.ok(Math.abs(share - 36 / 756) < 1e-9);
  const one = pixelsPerUnitFor(frameHeight(BODY_HALO), 756, 1.15, share);
  const two = pixelsPerUnitFor(frameHeight(BODY_HALO), 1512, 1.15, share);
  assert.ok(Math.abs(two / one - 2) < 1e-9);
});

test('模型缺失时的兜底窗口同样带边距（480×720 → 608×756）', () => {
  const size = fallbackWindowSize();
  assert.equal(size.width, 608);
  assert.equal(size.height, 756);
  assert.equal(size.pixelsPerUnit, 0);
});

test('窗口宽度护栏：过宽/过窄都被夹住并标记', () => {
  const wide: Bounds3 = { ...BODY_HALO, minX: -0.02, maxX: 0.02 };
  const wideSize = computeWindowSize(wide, 720);
  assert.equal(wideSize.width, MAX_MODEL_WINDOW_WIDTH_PX);
  assert.equal(wideSize.clampedWidth, true);

  // 极窄模型：包围盒只有 0.001 单位宽（≈58px）+ 左右边距 128 → 仍低于 240 的下限
  const narrow: Bounds3 = { ...BODY_HALO, minX: -0.0005, maxX: 0.0005 };
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
