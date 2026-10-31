import assert from 'node:assert/strict';
import test from 'node:test';
import { clampRectToWorkAreas, intersectionArea, type Rect } from './geometry';

const LEFT: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const RIGHT: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };
const WINDOW = { width: 480, height: 720 };

test('intersectionArea 计算重叠面积，无重叠时为 0', () => {
  assert.equal(intersectionArea({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }), 2500);
  assert.equal(intersectionArea(LEFT, RIGHT), 0);
});

test('完全在工作区内时不移动', () => {
  const bounds = { ...WINDOW, x: 720, y: 200 };
  assert.deepEqual(clampRectToWorkAreas(bounds, [LEFT]), bounds);
});

test('向右出界时保留 80px 在工作区内', () => {
  const out = clampRectToWorkAreas({ ...WINDOW, x: 1900, y: 200 }, [LEFT]);
  assert.equal(out.x, 1920 - 80);
});

test('向左出界时保留 80px 在工作区内', () => {
  const out = clampRectToWorkAreas({ ...WINDOW, x: -500, y: 200 }, [LEFT]);
  assert.equal(out.x, 0 - (480 - 80));
});

test('向下出界时保留 120px 在工作区内', () => {
  const out = clampRectToWorkAreas({ ...WINDOW, x: 200, y: 2000 }, [LEFT]);
  assert.equal(out.y, 1080 - 120);
});

test('跨显示器时按交集面积选目标，不会被拽回左屏（ADR 0004 D6.2）', () => {
  // x = 1900：与左屏交集 20px，与右屏交集 460px，目标必须选右屏
  const bounds = { ...WINDOW, x: 1900, y: 100 };
  const out = clampRectToWorkAreas(bounds, [LEFT, RIGHT]);
  assert.equal(out.x, 1900);
});

test('完全在所有工作区之外时按中心距离取最近的工作区', () => {
  const out = clampRectToWorkAreas({ ...WINDOW, x: 4000, y: 3000 }, [LEFT, RIGHT]);
  assert.equal(out.x, 3840 - 80);
  assert.equal(out.y, 1080 - 120);
});

test('钳制只改位置，不改尺寸', () => {
  const out = clampRectToWorkAreas({ ...WINDOW, x: 9999, y: 9999 }, [LEFT]);
  assert.equal(out.width, WINDOW.width);
  assert.equal(out.height, WINDOW.height);
});

test('工作区列表为空时原样返回', () => {
  const bounds = { ...WINDOW, x: 4000, y: 3000 };
  assert.deepEqual(clampRectToWorkAreas(bounds, []), bounds);
});
