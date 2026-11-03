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

test('dragged 期间同样拒绝摸头与 intent（ADR 0039 D5 严格互斥）', () => {
  const hfsm = make();
  hfsm.dragStarted(0);
  hfsm.headPatted(10);
  assert.equal(hfsm.snapshot().reaction, null, 'dragged 期间摸头不得进入 reacting');
  assert.equal(hfsm.intent(20, 'pat_react', 400), false, 'dragged 期间 pat_react 必须被拒');
  assert.equal(hfsm.intent(30, 'nod', 400), false, 'dragged 期间普通 intent 也必须被拒');
});

test('drag_started / drag_released 清空在播的摸头反应（ADR 0039 D5）', () => {
  const pat = make();
  pat.headPatted(0);
  assert.equal(pat.snapshot().overlay, 'reacting');
  pat.dragStarted(100);
  assert.equal(pat.snapshot().reaction, null, '拖拽开始的同一刻摸头反应必须消失');
  assert.equal(pat.snapshot().overlay, null, 'Overlay 不得残留 reacting');

  // 松手同理：不允许把反应从 dragged 带进 settling
  const released = make();
  released.snapApplied(0); // sitting 允许摸头
  released.headPatted(10);
  assert.equal(released.snapshot().reaction?.kind, 'head_patted');
  released.dragReleased(20); // 直接松手（shell 侧的场景）
  assert.equal(released.snapshot().reaction, null, 'settling 不得带摸头反应');
});

test('pat_react intent 不得重启或截短已在播的摸头反应（ADR 0039 D5）', () => {
  const hfsm = make();
  hfsm.headPatted(0, 2100);
  assert.equal(hfsm.snapshot().reaction?.kind, 'head_patted');
  assert.equal(hfsm.snapshot().reaction?.durationMs, 2100, '官方片段时长');

  assert.equal(hfsm.intent(20, 'pat_react', 900), false, '不得替换已在播的反应');
  assert.equal(hfsm.snapshot().reaction?.kind, 'head_patted', '仍是 head_patted 那条');
  assert.equal(hfsm.snapshot().reaction?.durationMs, 2100, '时长没有被截短');

  // 没有摸头时，pat_react 仍然是一条合法入口（§4.4）
  const fresh = make();
  assert.equal(fresh.intent(0, 'pat_react', 900), true);
  assert.equal(fresh.snapshot().reaction?.intent, 'pat_react');
});

test('拖拽期间：声音继续，摸头被拒（ADR 0039 D5）', () => {
  const hfsm = make();
  hfsm.speechStarted(0, 'u-3');
  hfsm.dragStarted(10);
  hfsm.headPatted(20);
  const snapshot = hfsm.snapshot();
  assert.equal(snapshot.physics, 'dragged');
  assert.equal(snapshot.overlay, 'speaking', '说话不受拖拽影响');
  assert.equal(snapshot.reaction, null, '拖拽期间不得叠加摸头反应');
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

test('吸附接近：snapApproaching 提前进入 sitting 并清空行走排期（ADR 0034 D2）', () => {
  const hfsm = makeDeterministic([0.5, 0.5]);
  hfsm.tick(0);
  hfsm.tick(2000);
  assert.equal(hfsm.snapshot().base, 'walking');
  hfsm.snapApproaching(2100);
  assert.equal(hfsm.snapshot().physics, 'sitting');
  assert.equal(hfsm.snapshot().base, 'idle', '接近阶段也必须打断行走');
  assert.equal(hfsm.nextWalkAt, null, '接近阶段不得再排期行走');
  // 到达后仍然坐在同一状态里，不产生第二个状态
  hfsm.snapApplied(2500);
  assert.equal(hfsm.snapshot().physics, 'sitting');
});

test('吸附：snapApplied → Physics=sitting，并清空行走排期（她坐着不会迈步）', () => {  const hfsm = makeDeterministic([0.5, 0.5, 0.5]);
  hfsm.tick(0);
  hfsm.snapApplied(100);
  assert.equal(hfsm.snapshot().physics, 'sitting');
  assert.equal(hfsm.snapshot().base, 'idle');
  assert.equal(hfsm.nextWalkAt, null, '进入 sitting 必须清空行走排期');

  // 即使时间远超调度间隔，也不得触发行走
  for (const now of [2000, 5000, 60000]) {
    assert.equal(hfsm.tick(now).startWalk, null, `t=${now} 不得开始行走`);
    assert.equal(hfsm.snapshot().physics, 'sitting');
  }
});

test('吸附：snapApplied 打断正在进行的行走', () => {
  const hfsm = makeDeterministic([0.1, 0.1]);
  hfsm.tick(0);
  assert.ok(hfsm.tick(1000).startWalk);
  assert.equal(hfsm.snapshot().base, 'walking');
  hfsm.snapApplied(1100);
  assert.equal(hfsm.snapshot().base, 'idle', '行走被吸附打断（§4.1 退出条件）');
  assert.equal(hfsm.snapshot().physics, 'sitting');
});

test('吸附解除：snapReleased 回 idle 并重新排期；非 sitting 时是空操作', () => {
  const hfsm = makeDeterministic([0.1, 0.1]);
  hfsm.tick(0);
  hfsm.snapApplied(100);
  hfsm.snapReleased(200);
  assert.equal(hfsm.snapshot().physics, null);
  assert.equal(hfsm.snapshot().base, 'idle');

  // 之后 Scheduler 继续正常工作（时间戳按 tick 推进）
  hfsm.tick(300);
  assert.ok(hfsm.tick(1400).startWalk, '解除后仍会按调度行走');

  // dragged 优先：拖拽后再收到 snap_released 不得把状态打回 idle
  const other = makeDeterministic([0.1, 0.1]);
  other.snapApplied(0);
  other.dragStarted(10);
  assert.equal(other.snapshot().physics, 'dragged');
  other.snapReleased(20);
  assert.equal(other.snapshot().physics, 'dragged', 'snap_released 不得覆盖 dragged');
});

test('吸附期间：说话、摸头、intent 仍然可以叠加（只有行走被停掉）', () => {
  const hfsm = make();
  hfsm.snapApplied(0);
  hfsm.speechStarted(10, 'u-sit');
  assert.equal(hfsm.snapshot().overlay, 'speaking');
  hfsm.headPatted(20);
  assert.equal(hfsm.snapshot().reaction?.kind, 'head_patted');
  assert.equal(hfsm.intent(30, 'nod', 400), true);
  assert.equal(hfsm.snapshot().physics, 'sitting', 'Overlay 不得改变 Physics');
});
