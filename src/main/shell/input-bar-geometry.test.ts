import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_BAR_GAP_PX,
  INPUT_BAR_HEIGHT_PX,
  INPUT_BAR_WIDTH_PX,
} from '../../shared/constants';
import type { Rect } from '../../shared/geometry';
import { computeInputBarBounds, rectsOverlap } from './input-bar-geometry';

const WORK_AREA: Rect = { x: 0, y: 0, width: 1600, height: 952 };
// 主窗口默认：宽按模型包围盒校正（422），高 720，贴合工作区底边
const WINDOW: Rect = { x: 560, y: 232, width: 422, height: 720 };

test('默认：主窗口顶边上方 8px、水平居中（ADR 0003 §2）', () => {
  const bounds = computeInputBarBounds(WINDOW, WORK_AREA);
  assert.equal(bounds.placement, 'above');
  assert.equal(bounds.y, WINDOW.y - INPUT_BAR_GAP_PX - INPUT_BAR_HEIGHT_PX);
  assert.equal(bounds.x, Math.round(WINDOW.x + (WINDOW.width - INPUT_BAR_WIDTH_PX) / 2));
  assert.equal(bounds.width, INPUT_BAR_WIDTH_PX);
  assert.equal(bounds.height, INPUT_BAR_HEIGHT_PX);
  assert.equal(bounds.clampedX, false);
  assert.equal(bounds.clampedY, false);
});

test('贴屏幕顶边：上方空间不足 → 改到顶边下方 8px（ADR 0004 D8.2）', () => {
  const bounds = computeInputBarBounds({ ...WINDOW, y: 0 }, WORK_AREA);
  assert.equal(bounds.placement, 'below');
  assert.equal(bounds.y, INPUT_BAR_GAP_PX);
});

test('边界：恰好容得下（content.y = 44 + 8）仍在上方', () => {
  const exact = INPUT_BAR_HEIGHT_PX + INPUT_BAR_GAP_PX;
  const bounds = computeInputBarBounds({ ...WINDOW, y: exact }, WORK_AREA);
  assert.equal(bounds.placement, 'above');
  assert.equal(bounds.y, 0);
  // 差 1px 就放不下
  assert.equal(computeInputBarBounds({ ...WINDOW, y: exact - 1 }, WORK_AREA).placement, 'below');
});

test('工作区顶边不为 0（副屏 / 任务栏在上）时按 workArea.y 判定', () => {
  const area: Rect = { x: 0, y: 100, width: 1600, height: 800 };
  // content.y - 52 = 108 ≥ 100 → 仍可放在上方
  const bounds = computeInputBarBounds({ ...WINDOW, y: 160 }, area);
  assert.equal(bounds.placement, 'above');
  assert.equal(bounds.y, 160 - INPUT_BAR_GAP_PX - INPUT_BAR_HEIGHT_PX);
  // content.y - 52 = 88 < 100 → 落到下方
  assert.equal(computeInputBarBounds({ ...WINDOW, y: 140 }, area).placement, 'below');
});

test('水平方向钳制在工作区内（窗口被拖到左/右边缘时）', () => {
  const left = computeInputBarBounds({ ...WINDOW, x: -200 }, WORK_AREA);
  assert.equal(left.x, 0);
  assert.equal(left.clampedX, true);

  const right = computeInputBarBounds({ ...WINDOW, x: 1500 }, WORK_AREA);
  assert.equal(right.x, WORK_AREA.width - INPUT_BAR_WIDTH_PX);
  assert.equal(right.clampedX, true);
});

test('钳制只改位置，不改尺寸', () => {
  const bounds = computeInputBarBounds({ ...WINDOW, x: 9999, y: 9999 }, WORK_AREA);
  assert.equal(bounds.width, INPUT_BAR_WIDTH_PX);
  assert.equal(bounds.height, INPUT_BAR_HEIGHT_PX);
});

test('下落模式下仍不压到工作区底部（窗口贴近底边时的兜底）', () => {
  const area: Rect = { x: 0, y: 0, width: 1600, height: 60 };
  const bounds = computeInputBarBounds({ x: 0, y: 0, width: 422, height: 720 }, area);
  assert.equal(bounds.placement, 'below');
  // 下方 8px 仍在工作区内（8 + 44 = 52 ≤ 60），因此不触发钳制
  assert.equal(bounds.y, INPUT_BAR_GAP_PX);
  assert.equal(bounds.clampedY, false);
});

test('rectsOverlap：相交为真，边贴边为假', () => {
  const a = { x: 0, y: 0, width: 100, height: 44 };
  assert.equal(rectsOverlap(a, { x: 50, y: 20, width: 100, height: 44 }), true);
  assert.equal(rectsOverlap(a, { x: 100, y: 0, width: 100, height: 44 }), false);
  assert.equal(rectsOverlap(a, { x: 0, y: 44, width: 100, height: 44 }), false);
});
