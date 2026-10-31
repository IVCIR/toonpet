import assert from 'node:assert/strict';
import test from 'node:test';
import type { Rect } from '../../shared/geometry';
import { DragGesture } from './drag-gesture';
import type { GestureStep, ProbeSnapshot } from './drag-gesture';

const WORK_AREA: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const CONTENT: Rect = { x: 720, y: 360, width: 480, height: 720 };

/** 屏幕坐标 = 内容区左上角 + 内容区 CSS 坐标 */
function screenAt(cssX: number, cssY: number): { x: number; y: number } {
  return { x: CONTENT.x + cssX, y: CONTENT.y + cssY };
}

function probeAt(cssX: number, cssY: number, at: number, head: boolean | null = false): ProbeSnapshot {
  return { x: cssX, y: cssY, hit: true, head, at };
}

function down(
  gesture: DragGesture,
  cssX: number,
  cssY: number,
  t: number,
  options: { receivedAt?: number; probe?: ProbeSnapshot | null; interactive?: boolean; content?: Rect } = {},
) {
  return gesture.onPointerDown({
    fact: { x: cssX, y: cssY, t },
    receivedAt: options.receivedAt ?? t,
    contentBounds: options.content ?? CONTENT,
    interactive: options.interactive ?? true,
    probe: options.probe === undefined ? probeAt(cssX, cssY, options.receivedAt ?? t) : options.probe,
  });
}

function up(
  gesture: DragGesture,
  cssX: number,
  cssY: number,
  t: number,
  options: { receivedAt?: number; content?: Rect } = {},
): GestureStep {
  return gesture.onPointerUp({
    fact: { x: cssX, y: cssY, t },
    receivedAt: options.receivedAt ?? t,
    contentBounds: options.content ?? CONTENT,
    workAreas: [WORK_AREA],
  });
}

function tick(gesture: DragGesture, cursor: { x: number; y: number }, now: number): GestureStep {
  return gesture.tick({ cursor, now, contentBounds: CONTENT, workAreas: [WORK_AREA] });
}

/** 一次完整的头部短按：按下 → 抬起（默认位移 0、时长 50ms） */
function pat(gesture: DragGesture, downAt: number, durationMs = 50): GestureStep {
  down(gesture, 240, 400, downAt, { probe: probeAt(240, 400, downAt, true) });
  return up(gesture, 240, 400, downAt + durationMs, { receivedAt: downAt + durationMs });
}

test('D-2：位移恰为 4px 不进入拖拽，超过 4px 才进入', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 570, 0);

  const atFour = tick(gesture, screenAt(244, 570), 16);
  assert.equal(atFour.effects.length, 0, '4px 不越过阈值');
  assert.equal(atFour.moveTo, null);
  assert.equal(gesture.dragging, false);

  const aboveFour = tick(gesture, screenAt(244.5, 570), 32);
  assert.equal(aboveFour.effects[0]?.kind, 'drag-started');
  assert.equal(gesture.dragging, true);
  // 窗口位置写回取整（屏幕坐标是整数 DIP）
  assert.deepEqual(aboveFour.moveTo, { x: Math.round(CONTENT.x + 4.5), y: CONTENT.y });
});

test('D-2：抬手点已 >4px 但一个 tick 都没跑到，仍按拖拽收尾（先 started 再 released）', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 570, 0);
  const result = up(gesture, 245, 570, 10);

  assert.deepEqual(
    result.effects.map((effect) => effect.kind),
    ['drag-started', 'drag-released'],
  );
  assert.deepEqual(result.moveTo, { x: CONTENT.x + 5, y: CONTENT.y });
});

test('4px 边界：抬手位移恰为 4px 不算拖拽', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 570, 0);
  const result = up(gesture, 244, 570, 10);

  assert.equal(result.effects.length, 0);
  assert.equal(result.moveTo, null);
  assert.equal(gesture.pressed, false);
});

test('D-3：头部区短按（≤250ms、≤4px）发出 head_patted 且 patCount 自增', () => {
  const gesture = new DragGesture();

  const first = pat(gesture, 0, 240);
  assert.equal(first.effects.length, 1);
  assert.equal(first.effects[0]?.kind, 'head-patted');
  assert.equal(gesture.headPatCount, 1);

  const second = pat(gesture, 2000, 50);
  assert.equal(second.effects[0]?.kind, 'head-patted');
  assert.equal(gesture.headPatCount, 2);
});

test('D-3：250ms 边界（250 算短按，251 不算）', () => {
  const boundary = new DragGesture();
  assert.equal(pat(boundary, 0, 250).effects[0]?.kind, 'head-patted');

  const tooLong = new DragGesture();
  const result = pat(tooLong, 0, 251);
  assert.equal(result.effects.length, 0);
  assert.equal(tooLong.headPatCount, 0);
});

test('D-3：时长按渲染侧 t 计算（同一时基）；异常 t 退回主进程收包时刻', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 400, 100, { receivedAt: 100, probe: probeAt(240, 400, 100, true) });
  // 渲染侧 t：100 → 340 = 240ms（≤250）；主进程收包差是 900ms，不得采纳
  const result = up(gesture, 240, 400, 340, { receivedAt: 1000 });
  assert.equal(result.effects[0]?.kind, 'head-patted');

  const fallback = new DragGesture();
  down(fallback, 240, 400, 10, { receivedAt: 10, probe: probeAt(240, 400, 10, true) });
  // 渲染侧 t 回退（up 的 t 小于 down 的 t）→ 用主进程收包差 1000ms > 250ms
  const fallbackResult = up(fallback, 240, 400, 5, { receivedAt: 1010 });
  assert.equal(fallbackResult.effects.length, 0);
});

test('D-4：800ms 冷却内不重复发事件，冷却边界恰好 800ms 放行', () => {
  const gesture = new DragGesture();

  // 第一次：down 0 / up 50 → lastHeadPatAt = 50
  assert.equal(pat(gesture, 0).effects[0]?.kind, 'head-patted');

  // 第二次：up 150 → 距上次 100ms → 冷却拦下
  const suppressed = pat(gesture, 100);
  assert.equal(suppressed.effects.length, 0);
  assert.match(suppressed.note?.message ?? '', /冷却/);
  assert.equal(gesture.headPatCount, 1);

  // 第三次：up 849 → 距上次 799ms → 仍拦下
  assert.equal(pat(gesture, 799).effects.length, 0);

  // 第四次：up 850 → 距上次 800ms → 放行（边界包含）
  const allowed = pat(gesture, 800);
  assert.equal(allowed.effects[0]?.kind, 'head-patted');
  assert.equal(gesture.headPatCount, 2);
});

test('D-2：进入拖拽后本次按下不再判摸头（即使起点在头部区、时长很短）', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 400, 0, { probe: probeAt(240, 400, 0, true) });

  const started = tick(gesture, screenAt(250, 400), 16);
  assert.equal(started.effects[0]?.kind, 'drag-started');

  const released = up(gesture, 250, 400, 100);
  assert.deepEqual(
    released.effects.map((effect) => effect.kind),
    ['drag-released'],
  );
  assert.equal(gesture.headPatCount, 0);
});

test('ADR 0004 D1.6：head 快照的 8px / 100ms / 掩膜可用三个门槛', () => {
  const far = new DragGesture();
  const farDown = down(far, 240, 400, 0, { probe: probeAt(231, 400, 0, true) });
  assert.equal(farDown.accepted, true);
  assert.equal(farDown.headAccepted, false);
  assert.equal(farDown.headRejectedBecause, 'far');

  const stale = new DragGesture();
  const staleDown = down(stale, 240, 400, 200, { probe: probeAt(240, 400, 99, true) });
  assert.equal(staleDown.headAccepted, false);
  assert.equal(staleDown.headRejectedBecause, 'stale');

  const noMask = new DragGesture();
  const noMaskDown = down(noMask, 240, 400, 0, { probe: probeAt(240, 400, 0, null) });
  assert.equal(noMaskDown.headAccepted, false);
  assert.equal(noMaskDown.headRejectedBecause, 'mask-unavailable');

  const noProbe = new DragGesture();
  const noProbeDown = down(noProbe, 240, 400, 0, { probe: null });
  assert.equal(noProbeDown.headAccepted, false);
  assert.equal(noProbeDown.headRejectedBecause, 'no-probe');
});

test('D-3：head 快照被丢弃时不发事件，但留一条可诊断的日志事实', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 400, 0, { probe: probeAt(240, 400, 0, null) });
  const result = up(gesture, 240, 400, 50);

  assert.equal(result.effects.length, 0);
  assert.match(result.note?.message ?? '', /head 快照未采信/);
  assert.equal(result.note?.data['because'], 'mask-unavailable');
});

test('D-5：拖拽位移 = 按下点起的累计位移（不是增量），窗口不漂移', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 570, 0);

  const first = tick(gesture, screenAt(260, 570), 16);
  assert.deepEqual(first.moveTo, { x: CONTENT.x + 20, y: CONTENT.y });

  const second = tick(gesture, screenAt(300, 560), 32);
  assert.deepEqual(second.moveTo, { x: CONTENT.x + 60, y: CONTENT.y - 10 });

  // 光标回到按下点 → 窗口回到原始位置（累计视角，不是增量累加）
  const back = tick(gesture, screenAt(240, 570), 48);
  assert.deepEqual(back.moveTo, { x: CONTENT.x, y: CONTENT.y });
});

test('D-7：拖到屏幕外时窗口矩形被钳制，至少 80×120 留在工作区且尺寸不变', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 570, 0);

  const result = tick(gesture, { x: 5000, y: 5000 }, 16);
  assert.equal(result.effects[0]?.kind, 'drag-started');
  assert.deepEqual(result.moveTo, { x: 1920 - 80, y: 1080 - 120 });

  // 抬手点用屏幕坐标反推的内容区局部坐标（内容区左上角 + 局部 = 屏幕点）
  const released = up(gesture, 5000 - CONTENT.x, 5000 - CONTENT.y, 100);
  assert.equal(released.effects[0]?.kind, 'drag-released');
  // 抬手时的收尾写回同样走钳制（位置不越界）
  assert.deepEqual(released.moveTo, { x: 1920 - 80, y: 1080 - 120 });
});

test('D-6：末速度只取抬手前 ≤100ms 的光标采样（px/s）', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 570, 0);

  tick(gesture, screenAt(260, 570), 0); // 越过阈值，进入拖拽；采样 (980, 0)
  tick(gesture, screenAt(310, 570), 50); // 采样 (1030, 50)
  tick(gesture, screenAt(410, 570), 160); // 采样 (1130, 160)，窗口外
  const released = up(gesture, 490, 570, 200, { receivedAt: 180 });

  const effect = released.effects[0];
  assert.equal(effect?.kind, 'drag-released');
  if (effect?.kind !== 'drag-released') return;

  // 窗口 [80, 180] 只剩 t=160 (1130) 与抬手 t=180 (1210)
  assert.equal(Math.round(effect.vx), 4000);
  assert.equal(Math.round(effect.vy), 0);
});

test('D-2：非交互态或内容区外的按下被拒绝，且不留下按下状态', () => {
  const gesture = new DragGesture();

  const notInteractive = down(gesture, 240, 400, 0, { interactive: false });
  assert.equal(notInteractive.accepted, false);
  assert.equal(notInteractive.reason, 'not-interactive');
  assert.equal(gesture.pressed, false);

  const outside = down(gesture, 999, 400, 10);
  assert.equal(outside.accepted, false);
  assert.equal(outside.reason, 'outside-content');
  assert.equal(gesture.pressed, false);
});

test('未收到抬起的旧按下会被新按下替换（不改变事件语义）', () => {
  const gesture = new DragGesture();
  down(gesture, 240, 570, 0);
  const replaced = down(gesture, 240, 500, 40);
  assert.equal(replaced.accepted, true);
  assert.equal(replaced.reason, 'replaced-press');

  // 只有最后一次按下会被收尾；体型区、位移 0 → 什么事件都不发
  const released = up(gesture, 240, 500, 60);
  assert.equal(released.effects.length, 0);
  assert.equal(gesture.pressed, false);
});

test('D-2：未按下时 tick 与抬起都是空操作', () => {
  const gesture = new DragGesture();
  assert.deepEqual(tick(gesture, { x: 5000, y: 5000 }, 16), {
    effects: [],
    moveTo: null,
    note: null,
  });
  assert.equal(up(gesture, 300, 500, 20).effects.length, 0);
});
