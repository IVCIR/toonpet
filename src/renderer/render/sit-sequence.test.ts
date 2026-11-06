import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIT_CLIP_HOLD_SECONDS,
  SIT_CLIP_STAGE_B_SECONDS,
  SIT_CLIP_START_SECONDS,
  SIT_STAGE_B_FADE_MS,
} from '../../shared/constants';
import {
  sitHoldLocalSeconds,
  sitStageAt,
  sitStageBBlend,
  sitStageBLocalSeconds,
} from './sit-sequence';

test('窗口：14.2 → 16.0（A）→ 16.2（B 停帧），本地时间 0 / 1.8 / 2.0', () => {
  assert.equal(SIT_CLIP_START_SECONDS, 14.2);
  assert.equal(SIT_CLIP_STAGE_B_SECONDS, 16.0);
  assert.equal(SIT_CLIP_HOLD_SECONDS, 16.2);
  assert.ok(Math.abs(sitStageBLocalSeconds() - 1.8) < 1e-9);
  assert.ok(Math.abs(sitHoldLocalSeconds() - 2.0) < 1e-9);
});

test('阶段判定：1.799s 还是 A，1.8s 起进 B；非法输入按 A', () => {
  assert.equal(sitStageAt(0), 'a');
  assert.equal(sitStageAt(1.799), 'a');
  assert.equal(sitStageAt(1.8), 'b');
  assert.equal(sitStageAt(2.0), 'b');
  assert.equal(sitStageAt(Number.NaN), 'a');
});

test('阶段 B 覆盖权重：0 → 0、0.5 → 0.5、300ms → 1，且单调不过冲', () => {
  assert.equal(SIT_STAGE_B_FADE_MS, 300);
  assert.equal(sitStageBBlend(0), 0);
  assert.equal(sitStageBBlend(SIT_STAGE_B_FADE_MS / 2), 0.5);
  assert.equal(sitStageBBlend(SIT_STAGE_B_FADE_MS), 1);
  assert.equal(sitStageBBlend(SIT_STAGE_B_FADE_MS * 2), 1);

  let previous = 0;
  for (let t = 0; t <= 400; t += 10) {
    const value = sitStageBBlend(t);
    assert.ok(value >= previous - 1e-9, `t=${t}`);
    assert.ok(value >= 0 && value <= 1);
    previous = value;
  }
  // 两端速度 0：前 10ms 的变化远小于线性（10/300=0.033）
  assert.ok(sitStageBBlend(10) < 0.01, `blend(10)=${sitStageBBlend(10)}`);
});
