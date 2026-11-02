import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STARTLE_CLICKED_MS,
  STARTLE_COMMAND_MS,
  STARTLE_LOST_MS,
} from '../../shared/constants';
import { startleDurationMs, startlePose } from './startle';

test('惊跳时长：clicked < command < lost', () => {
  assert.equal(startleDurationMs('clicked'), STARTLE_CLICKED_MS);
  assert.equal(startleDurationMs('command'), STARTLE_COMMAND_MS);
  assert.equal(startleDurationMs('window-gone'), STARTLE_LOST_MS);
  assert.equal(startleDurationMs('fullscreen'), STARTLE_LOST_MS);
  assert.ok(STARTLE_CLICKED_MS < STARTLE_COMMAND_MS);
  assert.ok(STARTLE_COMMAND_MS < STARTLE_LOST_MS);
});

test('惊跳姿态：中途 active，结束回中立；数值全部有限', () => {
  for (const reason of ['clicked', 'command', 'window-gone', 'fullscreen'] as const) {
    const mid = startlePose(reason, startleDurationMs(reason) / 2);
    assert.equal(mid.active, true);
    for (const value of Object.values(mid)) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `${reason} ${value}`);
    }
    const end = startlePose(reason, startleDurationMs(reason));
    assert.equal(end.active, false);
    assert.equal(end.rootX, 0);
    assert.equal(end.rootY, 0);
    assert.equal(end.surprised, false);
  }
});

test('惊跳：丢失型（window-gone/fullscreen）比点击型幅度更大，并短暂 surprised', () => {
  const lost = startlePose('window-gone', STARTLE_LOST_MS / 2);
  const clicked = startlePose('clicked', STARTLE_CLICKED_MS / 2);
  assert.ok(Math.abs(lost.rootY) > Math.abs(clicked.rootY));
  assert.ok(Math.abs(lost.armRoll) > Math.abs(clicked.armRoll));
  assert.equal(lost.surprised, true);
  assert.equal(startlePose('window-gone', STARTLE_LOST_MS - 1).surprised, false);
  assert.equal(clicked.surprised, false);
});
