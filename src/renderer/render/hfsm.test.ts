import assert from 'node:assert/strict';
import test from 'node:test';
import type { Intent } from '../../shared/types';
import { REACTING_INTENTS, createHfsm, isReactingIntent } from './hfsm';

const PAT_MS = 1100;

function make(): ReturnType<typeof createHfsm> {
  return createHfsm({ patDurationMs: PAT_MS });
}

/** 固定随机源：让"到点必走"可断言（ADR 0024 D1）。 */
function makeDeterministic(seed: number[]): ReturnType<typeof createHfsm> {
  let index = 0;
  return createHfsm({
    patDurationMs: PAT_MS,
    walk: { minIntervalMs: 1000, maxIntervalMs: 1000, minDistancePx: 100, maxDistancePx: 300 },
    random: () => {
      const value = seed[index % seed.length];
      index += 1;
      return value;
    },
  });
}

test('初始：Base=idle、Overlay=null、Physics=null（不产生第六个状态）', () => {
  const hfsm = make();
  const snapshot = hfsm.snapshot();
  assert.equal(snapshot.base, 'idle');
  assert.equal(snapshot.overlay, null);
  assert.equal(snapshot.physics, null);
  assert.equal(snapshot.reaction, null);
});

test('speech_started / speech_ended 驱动 Overlay=speaking（只有事件能进出）', () => {
  const hfsm = make();
  hfsm.speechStarted(0, 'u-1');
  assert.equal(hfsm.snapshot().overlay, 'speaking');
  assert.equal(hfsm.snapshot().speakingUtteranceId, 'u-1');
  hfsm.speechEnded(10);
  assert.equal(hfsm.snapshot().overlay, null);
  assert.equal(hfsm.snapshot().speakingUtteranceId, null);
});

test('head_patted → reacting，到时自动退出（边界：恰好等于时长即退出）', () => {
  const hfsm = make();
  hfsm.headPatted(0);
  assert.equal(hfsm.snapshot().overlay, 'reacting');
  assert.equal(hfsm.snapshot().reaction?.kind, 'head_patted');

  hfsm.tick(PAT_MS - 1);
  assert.equal(hfsm.snapshot().overlay, 'reacting', '未到时不得提前结束');

  hfsm.tick(PAT_MS);
  assert.equal(hfsm.snapshot().overlay, null);
  assert.equal(hfsm.reacting, false);
});

test('说话时被摸头：两个状态并存，overlay 字段投影为 speaking（§5.1 + §7.1）', () => {
  const hfsm = make();
  hfsm.speechStarted(0, 'u-2');
  hfsm.headPatted(10);
  const snapshot = hfsm.snapshot();
  assert.equal(snapshot.overlay, 'speaking');
  assert.equal(snapshot.reaction?.kind, 'head_patted');
  assert.equal(snapshot.speakingUtteranceId, 'u-2');
});

test('同类型新反应替换旧反应，计时从新时刻起算', () => {
  const hfsm = make();
  hfsm.headPatted(0);
  hfsm.headPatted(800);
  hfsm.tick(1500); // 首帧反应已过 1100ms，但新反应只过了 700ms
  assert.equal(hfsm.snapshot().overlay, 'reacting');
  hfsm.tick(1900);
  assert.equal(hfsm.snapshot().overlay, null);
});

test('只有 §4.1 列出的 intent 进入 reacting，其余（none/look_at_user/greet）不动 Overlay', () => {
  for (const intent of REACTING_INTENTS) {
    const hfsm = make();
    assert.equal(hfsm.intent(0, intent, 400), true, intent);
    assert.equal(hfsm.snapshot().overlay, 'reacting', intent);
  }
  for (const intent of ['none', 'look_at_user', 'greet'] as Intent[]) {
    const hfsm = make();
    assert.equal(hfsm.intent(0, intent, 400), false, intent);
    assert.equal(hfsm.snapshot().overlay, null, intent);
  }
});

test('intent 列表与契约 §4.1 的 reacting 入口一致', () => {
  assert.deepEqual([...REACTING_INTENTS].sort(), [
    'happy_hop',
    'nod',
    'pat_react',
    'shake_head',
    'tilt_head',
  ]);
  assert.equal(isReactingIntent('pat_react'), true);
  assert.equal(isReactingIntent('look_at_user'), false);
});

test('drag_started → dragged；drag_released → settling；settleEnded 才回 null（D-6 / ADR 0024 D3）', () => {
  const hfsm = make();
  hfsm.dragStarted(0);
  assert.equal(hfsm.snapshot().physics, 'dragged');
  assert.equal(hfsm.snapshot().base, 'idle', '拖拽不改变 Base 状态本身');
  hfsm.dragReleased(100);
  assert.equal(hfsm.snapshot().physics, 'settling', '松手先进入回弹，不能直接回 idle');
  hfsm.settleEnded(900);
  assert.equal(hfsm.snapshot().physics, null);
  assert.equal(hfsm.snapshot().base, 'idle');
});

test('回弹期间不接受新的动作意图与摸头（唯一例外是重新拖拽）', () => {
  const hfsm = make();
  hfsm.dragStarted(0);
  hfsm.dragReleased(10);
  assert.equal(hfsm.intent(20, 'nod', 400), false, 'settling 期间 intent 必须被拒');
  hfsm.headPatted(30);
  assert.equal(hfsm.snapshot().reaction, null, 'settling 期间摸头不得进入 reacting');
  hfsm.dragStarted(40);
  assert.equal(hfsm.snapshot().physics, 'dragged', '重新拖拽仍然可以接管');
});

test('拖拽期间的声音与摸头仍可叠加（互不打断，§5.3）', () => {
  const hfsm = make();
  hfsm.speechStarted(0, 'u-3');
  hfsm.dragStarted(10);
  hfsm.headPatted(20);
  const snapshot = hfsm.snapshot();
  assert.equal(snapshot.physics, 'dragged');
  assert.equal(snapshot.overlay, 'speaking');
  assert.equal(snapshot.reaction?.kind, 'head_patted');
});

test('行走调度：idle 满 20–40s 才触发，且只触发一次（§4.1）', () => {
  const hfsm = makeDeterministic([0.5, 0.5, 0.5]);
  assert.equal(hfsm.tick(0).startWalk, null, '首个 tick 只排期，不立刻走');
  assert.equal(hfsm.tick(999).startWalk, null, '未到 1000ms 不得触发');
  const plan = hfsm.tick(1000).startWalk;
  assert.ok(plan, '到点必须触发一次');
  assert.equal(plan?.distancePx, 200, '0.5 → 100 + 0.5×200');
  assert.equal(hfsm.snapshot().base, 'walking');
  assert.equal(hfsm.tick(1100).startWalk, null, '行走中不得再触发');
});

test('行走结束回到 idle 并重新排期；被拖拽打断则立即回 idle', () => {
  const hfsm = makeDeterministic([0.1, 0.1, 0.1]);
  hfsm.tick(0);
  assert.ok(hfsm.tick(1000).startWalk);
  hfsm.walkEnded(1500);
  assert.equal(hfsm.snapshot().base, 'idle');
  assert.ok(hfsm.nextWalkAt !== null, '结束后必须重新排期');

  hfsm.tick(1600);
  assert.ok(hfsm.tick(2600).startWalk, '重新排期后到点仍能走');
  hfsm.dragStarted(2700);
  assert.equal(hfsm.snapshot().base, 'idle', '拖拽立即打断行走（§4.1 退出条件）');
  assert.equal(hfsm.snapshot().physics, 'dragged');
});

test('行走方向由随机源决定（0.9 → right，0.1 → left）', () => {
  const right = makeDeterministic([0.9, 0.9]);
  right.tick(0);
  assert.equal(right.tick(1000).startWalk?.direction, 'right');

  const left = makeDeterministic([0.1, 0.1]);
  left.tick(0);
  assert.equal(left.tick(1000).startWalk?.direction, 'left');
});
