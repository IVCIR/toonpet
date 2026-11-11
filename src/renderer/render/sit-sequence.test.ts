import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIT_CLIP_HOLD_SECONDS,
  SIT_CLIP_STAGE_B_SECONDS,
  SIT_CLIP_START_SECONDS,
  SIT_EXIT_CROSSFADE_SECONDS,
  SIT_STAGE_B_FADE_MS,
  SIT_UPPER_HANDOVER_MS,
} from '../../shared/constants';
import {
  sitHoldLocalSeconds,
  sitStageAt,
  sitStageBBlend,
  sitStageBLocalSeconds,
  sitUpperExitBlend,
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

/**
 * ADR 0057 D1：退出坐姿的 0.3s 交接。
 *
 * 需求口径是"所有坐姿残留都在 0.3s 内平滑归零"，这段曲线就是那个"平滑"：
 * 0 → 0、150ms → 0.5、300ms → 1，两端速度为 0（不会把"放手"读成被拽一下）。
 */
test('退出交接：0 → 0、150ms → 0.5、300ms → 1，单调且两端速度为 0', () => {
  assert.equal(SIT_UPPER_HANDOVER_MS, 300);
  assert.equal(sitUpperExitBlend(0), 0);
  assert.equal(sitUpperExitBlend(SIT_UPPER_HANDOVER_MS / 2), 0.5);
  assert.equal(sitUpperExitBlend(SIT_UPPER_HANDOVER_MS), 1);
  assert.equal(sitUpperExitBlend(SIT_UPPER_HANDOVER_MS * 3), 1);
  // 非法输入按 0（还没开始走），不会让交接瞬间完成
  assert.equal(sitUpperExitBlend(Number.NaN), 0);
  assert.equal(sitUpperExitBlend(-50), 0);

  let previous = 0;
  for (let t = 0; t <= 320; t += 10) {
    const value = sitUpperExitBlend(t);
    assert.ok(value >= previous - 1e-9, `t=${t}`);
    assert.ok(value >= 0 && value <= 1);
    previous = value;
  }
  // 两端慢：前 10ms 与最后 10ms 的变化都远小于线性的 1/30
  assert.ok(sitUpperExitBlend(10) < 0.01, `blend(10)=${sitUpperExitBlend(10)}`);
  assert.ok(1 - sitUpperExitBlend(290) < 0.01, `1-blend(290)=${1 - sitUpperExitBlend(290)}`);
});

test('退出：片段交叉淡出的时长**短于**交接窗口（补偿不会在最后一帧掉一块）', () => {
  assert.ok(SIT_EXIT_CROSSFADE_SECONDS > 0);
  assert.ok(
    SIT_EXIT_CROSSFADE_SECONDS * 1000 < SIT_UPPER_HANDOVER_MS,
    `片段淡出 ${SIT_EXIT_CROSSFADE_SECONDS}s 必须早于交接 ${SIT_UPPER_HANDOVER_MS}ms 结束`,
  );
});
