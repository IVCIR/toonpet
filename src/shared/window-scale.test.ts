/**
 * 整体缩放的几何测试（ADR 0057 D2）。
 *
 * 这一组断言锁住三件事：
 * 1. **等比**：宽高乘同一个比例，不做非等比拉伸；
 * 2. **底边中心锚点不动**：放大/缩小之后，脚底仍然在原来那条底边中线上；
 * 3. **工作区夹取**：屏幕装不下时按能装下的最大比例生效（`clamped='workarea'`），
 *    并且窗口位置仍然被 D-7 的"至少 80×120 可见"兜住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHARACTER_SCALE_DEFAULT,
  CHARACTER_SCALE_MAX,
  CHARACTER_SCALE_MIN,
} from './constants';
import type { Rect } from './geometry';
import {
  clampCharacterScale,
  effectiveScaleOf,
  maxScaleForWorkArea,
  resolveScaledWindowBounds,
} from './window-scale';

const BASE = { width: 480, height: 720 };
/** 1080p 桌面：工作区 1920×1040，窗口 1.0x 时贴底边居中 */
const WORK_AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const ANCHOR = { x: 960, y: 1040 };

function anchorOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
}

/**
 * 锚点断言：宽/高取整会带来 ±1px 的偏差（奇数宽时中点落在半像素上），
 * 所以按"1px 以内"判定。真机上 1px 的偏差在 480–960 宽的窗口上看不出来。
 */
function assertAnchorClose(rect: Rect, expected: { x: number; y: number }, label = ''): void {
  const actual = anchorOf(rect);
  assert.ok(
    Math.abs(actual.x - expected.x) <= 1 && Math.abs(actual.y - expected.y) <= 1,
    `${label} 锚点必须在 1px 以内：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

test('缩放：1.0x 时矩形与基准一致，且锚点就是底边中点', () => {
  const result = resolveScaledWindowBounds({
    base: BASE,
    scale: 1,
    anchor: ANCHOR,
    workArea: WORK_AREA,
  });
  assert.equal(result.width, 480);
  assert.equal(result.height, 720);
  assert.equal(result.x, 720);
  assert.equal(result.y, 320);
  assertAnchorClose(result, ANCHOR);
  assert.equal(result.clamped, 'none');
  assert.equal(result.effectiveScale, 1);
});

test('缩放：等比 + 底边中心锚点不动（1.2x / 0.6x）', () => {
  for (const scale of [1.2, 0.6]) {
    const result = resolveScaledWindowBounds({
      base: BASE,
      scale,
      anchor: ANCHOR,
      workArea: WORK_AREA,
    });
    assert.equal(result.width, Math.round(480 * scale));
    assert.equal(result.height, Math.round(720 * scale));
    assertAnchorClose(result, ANCHOR, `scale=${scale}`);
    assert.equal(result.clamped, 'none');
  }
});

test('缩放：超出 0.5–2.0 的比例被夹住（clamped=range），非法值退回 1.0', () => {
  const tooBig = resolveScaledWindowBounds({
    base: BASE,
    scale: 5,
    anchor: ANCHOR,
    // 给一个够大的工作区，确保夹的是"范围"而不是"屏幕"
    workArea: { x: 0, y: 0, width: 8000, height: 8000 },
  });
  assert.equal(tooBig.requestedScale, CHARACTER_SCALE_MAX);
  assert.equal(tooBig.effectiveScale, CHARACTER_SCALE_MAX);
  assert.equal(tooBig.clamped, 'range');
  assert.equal(tooBig.height, 1440);

  const tooSmall = resolveScaledWindowBounds({
    base: BASE,
    scale: 0.1,
    anchor: { x: 4000, y: 8000 },
    workArea: { x: 0, y: 0, width: 8000, height: 8000 },
  });
  assert.equal(tooSmall.requestedScale, CHARACTER_SCALE_MIN);
  assert.equal(tooSmall.height, 360);

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 'x']) {
    assert.equal(clampCharacterScale(bad), CHARACTER_SCALE_DEFAULT, `bad=${String(bad)}`);
  }
  assert.equal(clampCharacterScale('1.5'), CHARACTER_SCALE_DEFAULT, '字符串不猜，直接退回默认');
});

test('缩放：屏幕装不下时按工作区夹（clamped=workarea），窗口仍然完整在工作区内', () => {
  // 720 × 2 = 1440 > 工作区 1040：实际只能到 1040/720 ≈ 1.444
  const result = resolveScaledWindowBounds({
    base: BASE,
    scale: 2,
    anchor: ANCHOR,
    workArea: WORK_AREA,
  });
  assert.equal(result.clamped, 'workarea');
  assert.equal(result.requestedScale, 2);
  assert.ok(result.effectiveScale > 1.4 && result.effectiveScale < 1.45);
  assert.ok(result.height <= WORK_AREA.height, '高度必须装得进工作区');
  assert.ok(result.width <= WORK_AREA.width, '宽度必须装得进工作区');
  assert.ok(result.y >= WORK_AREA.y, '窗口顶边不能跑到工作区上方');
  assertAnchorClose(result, ANCHOR, '夹取之后');
});

test('缩放：工作区太窄时按宽度夹（等比，不拉扁）', () => {
  const narrow: Rect = { x: 0, y: 0, width: 640, height: 1200 };
  const result = resolveScaledWindowBounds({
    base: BASE,
    scale: 2,
    anchor: { x: 320, y: 1200 },
    workArea: narrow,
  });
  assert.equal(result.clamped, 'workarea');
  // 640 / 480 = 1.333 是宽度上限，比高度上限 1200/720 = 1.667 小
  assert.ok(Math.abs(result.width / result.height - BASE.width / BASE.height) < 0.02, '宽高比不变');
  assert.ok(result.width <= narrow.width);
});

test('缩放：窗口被拖出工作区时仍然保留 80×120 可见（D-7 兜底）', () => {
  const result = resolveScaledWindowBounds({
    base: BASE,
    scale: 1,
    // 锚点远在屏幕右侧外
    anchor: { x: 5000, y: 1040 },
    workArea: WORK_AREA,
  });
  assert.ok(result.x + result.width >= WORK_AREA.x + 80, '至少要留 80px 宽在屏内');
  assert.ok(result.y + result.height >= WORK_AREA.y + 120, '至少要留 120px 高在屏内');
});

test('缩放：基准尺寸非法时原样返回（不假装成功，调用方据此跳过 setBounds）', () => {
  const result = resolveScaledWindowBounds({
    base: { width: 0, height: 0 },
    scale: 1.5,
    anchor: ANCHOR,
    workArea: WORK_AREA,
  });
  assert.equal(result.width, 0);
  assert.equal(result.height, 0);
  assert.equal(result.effectiveScale, CHARACTER_SCALE_DEFAULT);
});

test('maxScaleForWorkArea / effectiveScaleOf：反算比例与诊断口径', () => {
  assert.equal(maxScaleForWorkArea(BASE, WORK_AREA), 1040 / 720);
  // 工作区非法（0 尺寸）时等于"不额外夹"——不能让一次坏的显示器信息把窗口缩成 0
  assert.equal(maxScaleForWorkArea(BASE, { x: 0, y: 0, width: 0, height: 0 }), Number.POSITIVE_INFINITY);
  // 足够大的工作区也不额外夹（返回有限值，调用方取 min）
  assert.ok(Number.isFinite(maxScaleForWorkArea(BASE, { x: 0, y: 0, width: 1920, height: 2000 })));
  assert.equal(effectiveScaleOf({ x: 0, y: 0, width: 600, height: 900 }, BASE), 1.25);
  assert.equal(effectiveScaleOf({ x: 0, y: 0, width: 600, height: 900 }, { width: 0, height: 0 }), 1);
});
