import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRAY_MENU,
  TRAY_STAT_IDS,
  buildTrayMenuItems,
  buildTrayStatItems,
  buildTrayStatLabels,
  formatProactiveCount,
  formatProactiveSkip,
  formatSkipReason,
} from './tray-menu';
import type { ProactiveSilenceReason } from '../proactive-stats';
import type { TrayActions, TrayStatsView } from './tray-menu';

function recorder(): { actions: TrayActions; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      openInputBar: () => calls.push('open-input-bar'),
      snapForeground: () => calls.push('snap-foreground'),
      releaseSnap: () => calls.push('release-snap'),
      reloadPet: () => calls.push('reload-pet'),
      quit: () => calls.push('quit'),
    },
  };
}

const STATS: TrayStatsView = { firedCount: 3, lastReason: 'budget' };

test('托盘菜单：顶部两行只读诊断 + 五个动作项（ADR 0032 D4、ADR 0018 D3、ADR 0028 D4）', () => {
  const { actions } = recorder();
  assert.deepEqual(
    buildTrayMenuItems(actions, STATS).map((item) => [item.id, item.label, item.enabled]),
    [
      ['stat-proactive-count', '今天主动交互: 3 次', false],
      ['stat-proactive-skip', '上次未主动原因: budget（本次会话的打扰预算已用完）', false],
      ['open-input-bar', '呼出输入条', true],
      ['snap-foreground', '吸附到前台窗口（Ctrl+Shift+S）', true],
      ['release-snap', '离开窗口边缘', true],
      ['reload-pet', '重新加载桌宠', true],
      ['quit', '退出', true],
    ],
  );

  // 动作项规格表本身不因诊断项而改变顺序
  assert.deepEqual(
    TRAY_MENU.map((item) => item.label),
    ['呼出输入条', '吸附到前台窗口（Ctrl+Shift+S）', '离开窗口边缘', '重新加载桌宠', '退出'],
  );
  assert.deepEqual(TRAY_STAT_IDS, ['stat-proactive-count', 'stat-proactive-skip']);
});

test('托盘菜单：不传 stats 时是"零 + 尚未评估"（orchestrator 还没跑过一拍）', () => {
  const { actions } = recorder();
  assert.deepEqual(buildTrayStatLabels({ firedCount: 0, lastReason: null }), [
    '今天主动交互: 0 次',
    '上次未主动原因: （尚未评估）',
  ]);
  assert.deepEqual(
    buildTrayMenuItems(actions).slice(0, 2).map((item) => item.label),
    ['今天主动交互: 0 次', '上次未主动原因: （尚未评估）'],
  );
});

test('托盘菜单：只读项 enabled=false 且点击无副作用（不会误触任何动作）', () => {
  const { actions, calls } = recorder();
  const items = buildTrayStatItems(STATS);
  for (const item of items) {
    assert.equal(item.enabled, false);
    item.click();
  }
  assert.deepEqual(calls, [], '只读项点不出任何行为');
});

test('托盘菜单：每个动作项只触发自己的动作（诊断项不移位）', () => {
  const { actions, calls } = recorder();
  const items = buildTrayMenuItems(actions, STATS);
  const expected = ['open-input-bar', 'snap-foreground', 'release-snap', 'reload-pet', 'quit'];
  for (const [index, action] of expected.entries()) {
    items[index + 2]?.click();
    assert.deepEqual(calls.at(-1), action);
  }
  assert.deepEqual(calls, expected);
});

test('托盘菜单：每次 build 都是新的闭包（重复点击不会累积）', () => {
  const { actions, calls } = recorder();
  const first = buildTrayMenuItems(actions, STATS);
  const second = buildTrayMenuItems(actions, STATS);
  first[2]?.click();
  second[2]?.click();
  assert.deepEqual(calls, ['open-input-bar', 'open-input-bar']);
});

test('托盘诊断：次数是内存计数，非法/负数一律显示 0（不显示 NaN 次）', () => {
  assert.equal(formatProactiveCount(0), '今天主动交互: 0 次');
  assert.equal(formatProactiveCount(12), '今天主动交互: 12 次');
  assert.equal(formatProactiveCount(-3), '今天主动交互: 0 次');
  assert.equal(formatProactiveCount(Number.NaN), '今天主动交互: 0 次');
  assert.equal(formatProactiveCount(2.7), '今天主动交互: 2 次');
});

test('托盘诊断："上次未主动原因"保留 idle-drive 的英文原词，并在括号里给人话', () => {
  const reasons: ProactiveSilenceReason[] = [
    'ok',
    'disabled',
    'busy',
    'no-presence',
    'user-active',
    'user-away',
    'gap',
    'budget',
    'cooldown',
    'no-lines',
    'llm-failed',
  ];
  for (const reason of reasons) {
    const label = formatSkipReason(reason);
    assert.ok(label.length > 0, `${reason} 必须有可读文案`);
    if (reason !== 'ok') {
      assert.ok(label.startsWith(reason), `${reason} 必须以原词开头：${label}`);
    }
  }
  assert.equal(formatSkipReason(null), '（尚未评估）');
  assert.equal(formatProactiveSkip('user-active'), '上次未主动原因: user-active（先生正在操作）');
  assert.equal(formatProactiveSkip('ok'), '上次未主动原因: （上次已开口）');
  assert.equal(formatProactiveSkip(null), '上次未主动原因: （尚未评估）');
  // 判定通过但最终没开口：不能显示"已开口"（ADR 0032 D4 的两条静默诊断值）
  assert.match(formatProactiveSkip('no-lines'), /^上次未主动原因: no-lines/);
  assert.match(formatProactiveSkip('llm-failed'), /^上次未主动原因: llm-failed/);
});
