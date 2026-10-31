import assert from 'node:assert/strict';
import test from 'node:test';
import { REBOUND_SETTLE_MS } from '../../shared/constants';
import { createDragPause } from './drag-pause';

test('R-8：拖拽期间暂停；松手后恰好 500ms 才恢复（边界包含）', () => {
  const pause = createDragPause();
  assert.equal(pause.paused, false);

  assert.equal(pause.onDragStarted(0), 'paused');
  assert.equal(pause.paused, true);
  assert.equal(pause.settle(300), 'none', '拖拽中不恢复');

  assert.equal(pause.onDragReleased(1000), 'none');
  assert.equal(pause.paused, true, '松手后仍在沉降窗口内');

  assert.equal(pause.settle(1000 + REBOUND_SETTLE_MS - 1), 'none', '差 1ms 不恢复');
  assert.equal(pause.paused, true);

  assert.equal(pause.settle(1000 + REBOUND_SETTLE_MS), 'resumed', '边界：恰好 500ms 恢复');
  assert.equal(pause.paused, false);
});

test('R-8：pausedMs 覆盖整段暂停（拖拽 + 沉降），可用于验收断言', () => {
  const pause = createDragPause({ settleMs: 500 });
  pause.onDragStarted(200);
  pause.onDragReleased(260);
  assert.equal(pause.settle(760), 'resumed');
  assert.equal(pause.pausedMs, 560);
});

test('R-8：没暂停过就收到 released 不会伪造暂停/恢复', () => {
  const pause = createDragPause();
  assert.equal(pause.onDragReleased(100), 'none');
  assert.equal(pause.settle(10_000), 'none');
  assert.equal(pause.paused, false);
  assert.equal(pause.pausedMs, null);
});

test('R-8：重复的 drag_started 不重置暂停起点（避免被重复事件无限延长）', () => {
  const pause = createDragPause({ settleMs: 500 });
  assert.equal(pause.onDragStarted(0), 'paused');
  assert.equal(pause.onDragStarted(100), 'none');
  pause.onDragReleased(200);
  assert.equal(pause.settle(700), 'resumed');
  assert.equal(pause.pausedMs, 700);
});
