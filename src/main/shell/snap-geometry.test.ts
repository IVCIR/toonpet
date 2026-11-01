import assert from 'node:assert/strict';
import test from 'node:test';
import { SNAP_FULLSCREEN_TOLERANCE_PX } from '../../shared/constants';
import {
  computeSnapTarget,
  findWorkAreaForBottomEdgeSnap,
  isFullscreenRect,
  isUsableTargetRect,
  pickWorkArea,
} from './snap-geometry';

/** 本机常见的 1600×1000 DIP 主屏（自检环境实测），任务栏 48px。 */
const DISPLAY = { x: 0, y: 0, width: 1600, height: 1000 };
const WORK_AREA = { x: 0, y: 0, width: 1600, height: 952 };
const PET = { width: 422, height: 720 };

test('下边缘：窗口底边压在边缘线上，水平居中于目标窗口', () => {
  const anchor = { x: 200, y: 200, width: 900, height: 600 };
  const result = computeSnapTarget({ edge: 'bottom', anchor, pet: PET, workAreas: [WORK_AREA] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // 边缘线 = 200 + 600 = 800；窗口 y = 800 - 720 = 80
  assert.equal(result.y, 80);
  // x = 200 + (900 - 422) / 2 = 439
  assert.equal(result.x, 439);
  assert.equal(result.clamped, false);
  assert.equal(result.edge, 'bottom');
});

test('上边缘：同一条公式（窗口底边 = 上边缘线），不额外翻转', () => {
  // 窗口上沿在 y=800：她 720px 高，正好能"坐在上面"（800-720=80）
  const anchor = { x: 300, y: 800, width: 600, height: 150 };
  const result = computeSnapTarget({ edge: 'top', anchor, pet: PET, workAreas: [WORK_AREA] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.y, 800 - 720);
  assert.equal(result.x, Math.round(300 + (600 - 422) / 2));
});

test('整窗可见优先：小幅越界时往下夹（≤40px 仍然吸附）', () => {
  // 边缘线 680 → 期望 y=-40；工作区高 952 → y ∈ [0, 232]，夹 40px 正好在容差边界
  const anchor = { x: 200, y: 140, width: 900, height: 540 };
  const result = computeSnapTarget({ edge: 'bottom', anchor, pet: PET, workAreas: [WORK_AREA] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.y, 0);
  assert.equal(result.clamped, true);
});

test('拒绝：边缘线上方放不下整窗（上沿太靠屏幕顶）', () => {
  // 窗口上沿在 y=100：她要 720px 才坐得上去 → 期望 y=-620，夹回 0 差 620px → 拒绝
  const result = computeSnapTarget({
    edge: 'top',
    anchor: { x: 300, y: 100, width: 600, height: 300 },
    pet: PET,
    workAreas: [WORK_AREA],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'geometry');
});

test('水平钳制：目标窗口贴左边缘时桌宠不跑出工作区（只影响居中，不拒绝）', () => {
  const anchor = { x: -200, y: 200, width: 400, height: 600 };
  const result = computeSnapTarget({ edge: 'bottom', anchor, pet: PET, workAreas: [WORK_AREA] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.x, 0);
  assert.equal(result.clamped, true);
});

test('多显示器（负坐标）：吸附到左侧副屏的窗口', () => {
  const left = { x: -1600, y: 0, width: 1600, height: 1000 };
  const anchor = { x: -1500, y: 300, width: 800, height: 500 };
  const result = computeSnapTarget({ edge: 'bottom', anchor, pet: PET, workAreas: [left, WORK_AREA] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.y, 800 - 720);
  assert.equal(result.x, -1500 + Math.round((800 - 422) / 2));
});

test('拒绝：空尺寸 / NaN / 太小 / 桌宠尺寸异常', () => {
  const zero = computeSnapTarget({
    edge: 'bottom',
    anchor: { x: 10, y: 10, width: 0, height: 600 },
    pet: PET,
    workAreas: [WORK_AREA],
  });
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.equal(zero.reason, 'invalid-rect');

  const nan = computeSnapTarget({
    edge: 'bottom',
    anchor: { x: Number.NaN, y: 10, width: 100, height: 100 },
    pet: PET,
    workAreas: [WORK_AREA],
  });
  assert.equal(nan.ok, false);
  if (!nan.ok) assert.equal(nan.reason, 'invalid-rect');

  const tiny = computeSnapTarget({
    edge: 'bottom',
    anchor: { x: 10, y: 10, width: 60, height: 30 },
    pet: PET,
    workAreas: [WORK_AREA],
  });
  assert.equal(tiny.ok, false);
  if (!tiny.ok) assert.equal(tiny.reason, 'invalid-rect');

  const badPet = computeSnapTarget({
    edge: 'bottom',
    anchor: { x: 10, y: 10, width: 600, height: 600 },
    pet: { width: 0, height: 720 },
    workAreas: [WORK_AREA],
  });
  assert.equal(badPet.ok, false);
  if (!badPet.ok) assert.equal(badPet.reason, 'invalid-pet');
});

test('拒绝：目标完全在所有工作区之外（坐标异常）', () => {
  const result = computeSnapTarget({
    edge: 'bottom',
    anchor: { x: -9000, y: -9000, width: 800, height: 600 },
    pet: PET,
    workAreas: [WORK_AREA],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'geometry');
});

test('全屏判定：盖住整块显示器 bounds（容差 2 DIP），最大化窗口不算', () => {
  assert.equal(isFullscreenRect({ ...DISPLAY }, [DISPLAY]), true);
  // DWM 矩形比显示器大几像素（无边框全屏）：仍然算全屏
  assert.equal(
    isFullscreenRect({ x: -6, y: -6, width: DISPLAY.width + 12, height: DISPLAY.height + 12 }, [DISPLAY]),
    true,
  );
  assert.equal(
    isFullscreenRect(
      { x: SNAP_FULLSCREEN_TOLERANCE_PX, y: 0, width: DISPLAY.width - SNAP_FULLSCREEN_TOLERANCE_PX, height: DISPLAY.height },
      [DISPLAY],
    ),
    true,
  );
  // 最大化窗口（差一个任务栏高度）不是全屏
  assert.equal(isFullscreenRect({ x: 0, y: 0, width: 1600, height: 952 }, [DISPLAY]), false);
  assert.equal(isFullscreenRect({ x: 0, y: 0, width: 1200, height: 800 }, [DISPLAY]), false);
  // 贴左边但只占一半：不是全屏
  assert.equal(isFullscreenRect({ x: 0, y: 0, width: 800, height: 1000 }, [DISPLAY]), false);
});

test('可用目标：坐标有限且不小于 80×40', () => {
  assert.equal(isUsableTargetRect({ x: 0, y: 0, width: 80, height: 40 }), true);
  assert.equal(isUsableTargetRect({ x: 0, y: 0, width: 79, height: 400 }), false);
  assert.equal(isUsableTargetRect({ x: 0, y: 0, width: 400, height: 39 }), false);
  assert.equal(isUsableTargetRect(null), false);
  assert.equal(isUsableTargetRect({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }), false);
});

test('工作区选择：取重叠面积最大者；全在外面时取最近的一个', () => {
  const right = { x: 1600, y: 0, width: 1600, height: 1000 };
  assert.equal(pickWorkArea({ x: 1500, y: 100, width: 422, height: 720 }, [WORK_AREA, right]), right);
  assert.equal(pickWorkArea({ x: 100, y: 100, width: 422, height: 720 }, [WORK_AREA, right])?.x, 0);
  assert.equal(pickWorkArea({ x: 5000, y: 100, width: 422, height: 720 }, [WORK_AREA, right])?.x, 1600);
  assert.equal(pickWorkArea({ x: 0, y: 0, width: 10, height: 10 }, []), null);
});

test('回退贴边：只有窗口底边进入阈值才算"拖到下沿"', () => {
  assert.equal(
    findWorkAreaForBottomEdgeSnap({ x: 100, y: 232, width: 422, height: 720 }, [WORK_AREA], 24)?.y,
    0,
  );
  assert.equal(
    findWorkAreaForBottomEdgeSnap({ x: 100, y: 100, width: 422, height: 720 }, [WORK_AREA], 24),
    null,
  );
  assert.equal(findWorkAreaForBottomEdgeSnap({ x: 100, y: 232, width: 422, height: 720 }, [], 24), null);
});
