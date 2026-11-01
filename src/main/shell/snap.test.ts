import assert from 'node:assert/strict';
import test from 'node:test';
import type { Rect } from '../../shared/geometry';
import type { WindowInfo } from './foreground-window';
import { createSnapController, resolveSnapConfig } from './snap';
import type { SnapDeps } from './snap';

const DISPLAY: Rect = { x: 0, y: 0, width: 1600, height: 1000 };
const WORK_AREA: Rect = { x: 0, y: 0, width: 1600, height: 952 };
const PET: Rect = { x: 500, y: 232, width: 422, height: 720 };

interface Harness {
  deps: SnapDeps;
  positions: { x: number; y: number }[];
  applied: { edge: string; source: string }[];
  released: { reason: string }[];
  notices: string[];
  logs: { level: 'info' | 'warn'; message: string }[];
  setForeground(info: WindowInfo | null): void;
  setHandle(info: WindowInfo | null): void;
  setPet(bounds: Rect): void;
  setBusy(busy: boolean): void;
  setOwnHandles(handles: string[]): void;
}

function windowInfo(overrides: Partial<WindowInfo> = {}, physical = { left: 0, top: 0, right: 2, bottom: 2 }): WindowInfo {
  return {
    handle: '4242',
    title: '记事本',
    className: 'Notepad',
    minimized: false,
    visible: true,
    physical,
    source: 'dwm',
    ...overrides,
  };
}

/** 物理像素 → DIP 的假实现：本用例统一用 1:1，专测换算的用例单独覆盖。 */
function makeHarness(scale = 1): Harness {
  let pet: Rect = { ...PET };
  let foreground: WindowInfo | null = windowInfo({}, { left: 200, top: 200, right: 1100, bottom: 800 });
  let handleInfo: WindowInfo | null = foreground;
  let busy = false;
  let ownHandles: string[] = ['9999'];

  const harness: Harness = {
    positions: [],
    applied: [],
    released: [],
    notices: [],
    logs: [],
    setForeground(info) {
      foreground = info;
    },
    setHandle(info) {
      handleInfo = info;
    },
    setPet(bounds) {
      pet = bounds;
    },
    setBusy(value) {
      busy = value;
    },
    setOwnHandles(handles) {
      ownHandles = handles;
    },
    deps: {
      getPetBounds: () => pet,
      setPetPosition: (x, y) => harness.positions.push({ x, y }),
      getWorkAreas: () => [WORK_AREA],
      getDisplays: () => [DISPLAY],
      getOwnHandles: () => ownHandles,
      readForeground: () => foreground,
      readHandle: () => handleInfo,
      toDip: (physical) => ({
        x: physical.left / scale,
        y: physical.top / scale,
        width: (physical.right - physical.left) / scale,
        height: (physical.bottom - physical.top) / scale,
      }),
      isBusy: () => busy,
      emitApplied: (payload) => harness.applied.push(payload),
      emitReleased: (payload) => harness.released.push(payload),
      notify: (message) => harness.notices.push(message),
      logInfo: (message) => harness.logs.push({ level: 'info', message }),
      logWarn: (message) => harness.logs.push({ level: 'warn', message }),
    },
  };
  return harness;
}

const CONFIG = resolveSnapConfig({});

test('配置：默认下边缘、auto 模式、跟随 120ms、启用', () => {
  assert.deepEqual(resolveSnapConfig({}), {
    enabled: true,
    edge: 'bottom',
    mode: 'auto',
    followIntervalMs: 120,
  });
});

test('配置：env 覆盖（edge/mode/disable/follow），非法值回落默认', () => {
  const top = resolveSnapConfig({ PET_SNAP_EDGE: 'TOP', PET_SNAP_MODE: 'workarea' });
  assert.equal(top.edge, 'top');
  assert.equal(top.mode, 'workarea');
  assert.equal(resolveSnapConfig({ PET_SNAP_DISABLE: '1' }).enabled, false);
  assert.equal(resolveSnapConfig({ PET_SNAP_FOLLOW_MS: '300' }).followIntervalMs, 300);
  assert.equal(resolveSnapConfig({ PET_SNAP_FOLLOW_MS: '3' }).followIntervalMs, 120);
  assert.equal(resolveSnapConfig({ PET_SNAP_FOLLOW_MS: 'abc' }).followIntervalMs, 120);
  assert.equal(resolveSnapConfig({ PET_SNAP_EDGE: 'left' }).edge, 'bottom');
});

test('吸附：前台窗口下边缘 → 窗口贴到边缘线并发出 snap_applied', () => {
  const h = makeHarness();
  const snap = createSnapController(h.deps, CONFIG);
  const outcome = snap.snapNow();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // 前台 200..1100 × 200..800（DIP）→ 边缘线 800 → y = 80；x = 200 + (900-422)/2 = 439
  assert.deepEqual(h.positions, [{ x: 439, y: 80 }]);
  assert.deepEqual(h.applied, [{ edge: 'bottom', source: 'foreground' }]);
  assert.equal(snap.sitting, true);
  assert.equal(snap.diagnostics().target?.handle, '4242');
  assert.equal(snap.diagnostics().target?.title, '记事本');
});

test('吸附：自动换算 DIP（200% 缩放）——物理 400..2200 等于 DIP 200..1100', () => {
  const h = makeHarness(2);
  h.setForeground(windowInfo({}, { left: 400, top: 400, right: 2200, bottom: 1600 }));
  const snap = createSnapController(h.deps, CONFIG);
  snap.snapNow();
  assert.deepEqual(h.positions, [{ x: 439, y: 80 }]);
});

test('拒绝：全屏窗口不吸附，且给出托盘提示', () => {
  const h = makeHarness();
  h.setForeground(
    windowInfo({}, { left: DISPLAY.x, top: DISPLAY.y, right: DISPLAY.width, bottom: DISPLAY.height }),
  );
  const snap = createSnapController(h.deps, CONFIG);
  const outcome = snap.snapNow();
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, 'fullscreen');
  assert.deepEqual(h.positions, []);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] ?? '', /全屏/);
  assert.equal(snap.sitting, false);
});

test('拒绝：前台是自己的窗口 / 桌面外壳窗口 / 不可见 / 太小', () => {
  const cases: { info: WindowInfo; reason: string }[] = [
    { info: windowInfo({ handle: '9999' }), reason: 'own-window' },
    { info: windowInfo({ className: 'Progman' }), reason: 'shell-window' },
    { info: windowInfo({ className: 'Shell_TrayWnd' }), reason: 'shell-window' },
    { info: windowInfo({ minimized: true }), reason: 'hidden-window' },
    { info: windowInfo({ visible: false }), reason: 'hidden-window' },
    {
      info: windowInfo({}, { left: 10, top: 10, right: 50, bottom: 30 }),
      reason: 'invalid-rect',
    },
  ];
  for (const item of cases) {
    const h = makeHarness();
    h.setForeground(item.info);
    const snap = createSnapController(h.deps, CONFIG);
    const outcome = snap.snapNow();
    assert.equal(outcome.ok, false, item.reason);
    if (!outcome.ok) assert.equal(outcome.reason, item.reason);
    assert.deepEqual(h.positions, [], item.reason);
    assert.equal(h.applied.length, 0, item.reason);
  }
});

test('拒绝：拿不到前台窗口（auto 模式）→ 回退到工作区贴边', () => {
  const h = makeHarness();
  h.setForeground(null);
  const snap = createSnapController(h.deps, CONFIG);
  const outcome = snap.snapNow();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.source, 'workarea');
  // 工作区 0..952 → y = 952 - 720 = 232；x 在 1600 宽的工作区居中 = 589
  assert.deepEqual(h.positions, [{ x: 589, y: 232 }]);
  assert.deepEqual(h.applied, [{ edge: 'bottom', source: 'workarea' }]);
});

test('跳过：行走/回弹/拖拽期间不抢窗口位置，且不打扰用户', () => {
  const h = makeHarness();
  h.setBusy(true);
  const snap = createSnapController(h.deps, CONFIG);
  const outcome = snap.snapNow();
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, 'busy');
  assert.deepEqual(h.positions, []);
  assert.equal(h.notices.length, 0);
});

test('跟随：目标窗口移动后窗口跟着走（节流 120ms）', () => {
  const h = makeHarness();
  const snap = createSnapController(h.deps, CONFIG);
  snap.snapNow();
  assert.equal(h.positions.length, 1);

  // 第一个 tick 只校准节流起点，不做窗口查询
  snap.tick(100);
  assert.equal(h.positions.length, 1);
  // 还没到 120ms → 不重算
  snap.tick(130);
  assert.equal(h.positions.length, 1);

  // 目标窗口右移 100、下移 40；到点后重算并写回位置
  h.setHandle(windowInfo({}, { left: 300, top: 240, right: 1200, bottom: 840 }));
  snap.tick(250);
  assert.equal(h.positions.length, 2);
  assert.deepEqual(h.positions[1], { x: 539, y: 120 });
  assert.equal(snap.diagnostics().followChecks, 1);

  // 矩形没变 → 不产生新的位置写入
  snap.tick(420);
  assert.equal(h.positions.length, 2);
});

test('跟随：目标窗口消失 / 变成全屏 → 立即解除吸附并发出 snap_released', () => {
  const gone = makeHarness();
  const snapGone = createSnapController(gone.deps, CONFIG);
  snapGone.snapNow();
  gone.setHandle(null);
  snapGone.tick(200);
  snapGone.tick(400);
  assert.deepEqual(gone.released, [{ reason: 'window-gone' }]);
  assert.equal(snapGone.sitting, false);

  const fullscreen = makeHarness();
  const snapFull = createSnapController(fullscreen.deps, CONFIG);
  snapFull.snapNow();
  fullscreen.setHandle(
    windowInfo({}, { left: 0, top: 0, right: DISPLAY.width, bottom: DISPLAY.height }),
  );
  snapFull.tick(200);
  snapFull.tick(400);
  assert.deepEqual(fullscreen.released, [{ reason: 'fullscreen' }]);
});

test('解除：幂等（没有吸附时不发事件），解除后跟随停止', () => {
  const h = makeHarness();
  const snap = createSnapController(h.deps, CONFIG);
  snap.release('command');
  assert.deepEqual(h.released, []);

  snap.snapNow();
  snap.release('clicked');
  snap.release('clicked');
  assert.deepEqual(h.released, [{ reason: 'clicked' }]);

  h.setHandle(null);
  snap.tick(500);
  assert.deepEqual(h.released, [{ reason: 'clicked' }], '解除后不得再发事件');
});

test('重复吸附：允许改吸到新的前台窗口（旧目标不残留）', () => {
  const h = makeHarness();
  const snap = createSnapController(h.deps, CONFIG);
  snap.snapNow();
  // 第二扇窗：DIP 0..800 × 700..900 → 边缘线 900 → y=180
  const second = windowInfo({ handle: '777' }, { left: 0, top: 700, right: 800, bottom: 900 });
  h.setForeground(second);
  h.setHandle(second);
  const outcome = snap.snapNow();
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.y, 180);
  assert.equal(snap.diagnostics().target?.handle, '777');
  assert.equal(h.applied.length, 2);
});

test('工作区模式（无 Win32）：按工作区边缘吸附，不读前台窗口', () => {
  const h = makeHarness();
  h.setForeground(windowInfo({}, { left: 200, top: 200, right: 1100, bottom: 800 }));
  const snap = createSnapController(h.deps, { ...CONFIG, mode: 'workarea' });
  const outcome = snap.snapNow();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.source, 'workarea');
  assert.deepEqual(h.positions, [{ x: 589, y: 232 }]);
  assert.equal(snap.sitting, true);
});

test('工作区模式：上沿放不下坐姿 → 自动退回下沿（PET_SNAP_EDGE=top 也不报错）', () => {
  const h = makeHarness();
  const snap = createSnapController(h.deps, { ...CONFIG, mode: 'workarea', edge: 'top' });
  const outcome = snap.snapNow();
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.edge, 'bottom');
  assert.deepEqual(h.positions, [{ x: 589, y: 232 }]);
});

test('工作区模式：拖到下沿附近松手 → 坐在边上；太远或 auto 模式不吸附', () => {
  const h = makeHarness();
  const snap = createSnapController(h.deps, { ...CONFIG, mode: 'workarea' });
  h.setPet({ x: 100, y: 230, width: 422, height: 720 });
  const outcome = snap.trySnapOnRelease();
  assert.ok(outcome && outcome.ok);
  if (outcome && outcome.ok) assert.equal(outcome.edge, 'bottom');
  assert.deepEqual(h.positions, [{ x: 589, y: 232 }]);

  // 离下沿太远 → 不吸附（照常回弹到地面线）
  const far = makeHarness();
  const farSnap = createSnapController(far.deps, { ...CONFIG, mode: 'workarea' });
  far.setPet({ x: 100, y: 0, width: 422, height: 720 });
  assert.equal(farSnap.trySnapOnRelease(), null);

  // auto（有 Win32）模式：拖拽贴边不接管，交给 settling
  const auto = makeHarness();
  const autoSnap = createSnapController(auto.deps, CONFIG);
  auto.setPet({ x: 100, y: 230, width: 422, height: 720 });
  assert.equal(autoSnap.trySnapOnRelease(), null);
});

test('禁用：PET_SNAP_DISABLE=1 时热键路径直接跳过', () => {
  const h = makeHarness();
  const snap = createSnapController(h.deps, { ...CONFIG, enabled: false });
  const outcome = snap.snapNow();
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, 'disabled');
  assert.deepEqual(h.positions, []);
  assert.equal(h.notices.length, 0);
});
