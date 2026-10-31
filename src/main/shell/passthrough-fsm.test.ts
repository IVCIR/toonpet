import assert from 'node:assert/strict';
import test from 'node:test';
import type { Rect } from '../../shared/geometry';
import { PassthroughFsm } from './passthrough-fsm';

const RECT: Rect = { x: 560, y: 232, width: 480, height: 720 };

function base(now: number, cursor: { x: number; y: number }) {
  return {
    cursor,
    windowRect: RECT,
    probe: null,
    probeInFlight: false,
    dragging: false,
    settling: false,
    pressed: false,
    now,
  } as const;
}

test('初始为穿透态；光标在窗口外保持穿透', () => {
  const fsm = new PassthroughFsm();
  assert.equal(fsm.current, 'passthrough');
  const out = fsm.step({ ...base(0, { x: 0, y: 0 }) });
  assert.equal(out.target, 'passthrough');
  assert.equal(out.changed, false);
  assert.equal(out.reason, 'outside');
  assert.equal(out.probePoint, null);
});

test('进入窗口矩形 → 需要发探针，坐标换算成内容区 CSS', () => {
  const fsm = new PassthroughFsm();
  const out = fsm.step({ ...base(1000, { x: 600, y: 300 }) });
  assert.deepEqual(out.probePoint, { x: 40, y: 68 });
  assert.equal(out.target, 'passthrough');
  assert.equal(out.changed, false);
});

test('探针命中 → 关闭穿透；命中失败 → 恢复穿透（超过冷却后）', () => {
  const fsm = new PassthroughFsm();
  fsm.step(base(0, { x: 0, y: 0 }));
  const hit = fsm.step({ ...base(1000, { x: 600, y: 300 }), probe: { kind: 'hit', hit: true } });
  assert.equal(hit.target, 'interactive');
  assert.equal(hit.changed, true);
  assert.equal(hit.reason, 'hit');

  const miss = fsm.step({ ...base(1200, { x: 600, y: 300 }), probe: { kind: 'hit', hit: false } });
  assert.equal(miss.target, 'passthrough');
  assert.equal(miss.changed, true);
  assert.equal(miss.reason, 'transparent');
});

test('切换冷却 100ms：期间不切并标记 cooled，之后才生效', () => {
  const fsm = new PassthroughFsm();
  fsm.step({ ...base(0, { x: 600, y: 300 }), probe: { kind: 'hit', hit: true } });
  assert.equal(fsm.current, 'interactive');

  const cooled = fsm.step({ ...base(99, { x: 600, y: 300 }), probe: { kind: 'hit', hit: false } });
  assert.equal(cooled.changed, false);
  assert.equal(cooled.cooled, true);
  assert.equal(cooled.target, 'interactive');

  const applied = fsm.step({ ...base(101, { x: 600, y: 300 }), probe: { kind: 'hit', hit: false } });
  assert.equal(applied.changed, true);
  assert.equal(applied.cooled, false);
  assert.equal(applied.target, 'passthrough');
});

test('离开判定外扩 8px：环内保持当前态，环外恢复穿透', () => {
  const fsm = new PassthroughFsm();
  fsm.step({ ...base(0, { x: 600, y: 300 }), probe: { kind: 'hit', hit: true } });
  assert.equal(fsm.current, 'interactive');

  // 左侧外 4px：在 8px 外扩环内 → 保持交互，不发探针
  const ring = fsm.step(base(500, { x: RECT.x - 4, y: 300 }));
  assert.equal(ring.reason, 'hysteresis');
  assert.equal(ring.target, 'interactive');
  assert.equal(ring.probePoint, null);

  // 左侧外 9px：出了外扩环 → 恢复穿透
  const outside = fsm.step(base(500, { x: RECT.x - 9, y: 300 }));
  assert.equal(outside.reason, 'outside');
  assert.equal(outside.target, 'passthrough');
  assert.equal(outside.changed, true);
});

test('探针超时按未命中处理（ADR 0004 D4）', () => {
  const fsm = new PassthroughFsm();
  fsm.step({ ...base(0, { x: 600, y: 300 }), probe: { kind: 'hit', hit: true } });
  const out = fsm.step({ ...base(500, { x: 600, y: 300 }), probe: { kind: 'timeout' } });
  assert.equal(out.reason, 'timeout');
  assert.equal(out.target, 'passthrough');
  assert.equal(out.changed, true);
});

test('拖拽期间强制非穿透且不探测（R-8）', () => {
  const fsm = new PassthroughFsm();
  const out = fsm.step({ ...base(0, { x: 0, y: 0 }), dragging: true });
  assert.equal(out.target, 'interactive');
  assert.equal(out.changed, true);
  assert.equal(out.probePoint, null);
  assert.equal(out.reason, 'dragging');

  // 拖到窗口外也不恢复穿透
  const stillDragging = fsm.step({ ...base(1000, { x: 5000, y: 5000 }), dragging: true });
  assert.equal(stillDragging.target, 'interactive');
  assert.equal(stillDragging.changed, false);
});

test('回弹沉降窗口内同样保持非穿透（ADR 0004 D3）', () => {
  const fsm = new PassthroughFsm();
  fsm.step({ ...base(0, { x: 600, y: 300 }), probe: { kind: 'hit', hit: true } });
  const out = fsm.step({ ...base(300, { x: 5000, y: 5000 }), settling: true });
  assert.equal(out.reason, 'settling');
  assert.equal(out.target, 'interactive');
  assert.equal(out.changed, false);
});

test('探针在飞时不重复发探针', () => {
  const fsm = new PassthroughFsm();
  const out = fsm.step({ ...base(0, { x: 600, y: 300 }), probeInFlight: true });
  assert.equal(out.reason, 'awaiting-probe');
  assert.equal(out.probePoint, null);
});

test('按下保持位：按下期间不切穿透，且仍按 R-5 发探针（D-2 / R-8 不冲突）', () => {
  const fsm = new PassthroughFsm();
  fsm.step({ ...base(0, { x: 600, y: 300 }), probe: { kind: 'hit', hit: true } });
  assert.equal(fsm.current, 'interactive');

  // 按下：即使上一发探针的结果是 miss（或没有结果），也不得切穿透
  const pressed = fsm.step({ ...base(200, { x: 600, y: 300 }), pressed: true });
  assert.equal(pressed.target, 'interactive');
  assert.equal(pressed.reason, 'pressed');
  assert.equal(pressed.changed, false);
  assert.deepEqual(pressed.probePoint, { x: 40, y: 68 }, '按下期间掩膜刷新不暂停');

  // 探针在飞 → 不重复发
  const inFlight = fsm.step({ ...base(216, { x: 600, y: 300 }), pressed: true, probeInFlight: true });
  assert.equal(inFlight.probePoint, null);

  // 按下期间探针说 miss，仍然保持交互（否则 pointerup 会落到桌面）
  const missWhilePressed = fsm.step({
    ...base(232, { x: 600, y: 300 }),
    pressed: true,
    probe: { kind: 'hit', hit: false },
  });
  assert.equal(missWhilePressed.target, 'interactive');
  assert.equal(missWhilePressed.changed, false);

  // 抬起后恢复正常判定（冷却已过 → 直接按 miss 恢复穿透）
  const afterRelease = fsm.step({
    ...base(500, { x: 600, y: 300 }),
    probe: { kind: 'hit', hit: false },
  });
  assert.equal(afterRelease.target, 'passthrough');
  assert.equal(afterRelease.changed, true);
});

test('拖拽优先于按下保持位（dragging 永远胜出，且不探测）', () => {
  const fsm = new PassthroughFsm();
  const out = fsm.step({
    ...base(0, { x: 5000, y: 5000 }),
    dragging: true,
    pressed: true,
  });
  assert.equal(out.reason, 'dragging');
  assert.equal(out.target, 'interactive');
  assert.equal(out.probePoint, null);
});
