import assert from 'node:assert/strict';
import test from 'node:test';
import { TRAY_MENU, buildTrayMenuItems } from './tray-menu';
import type { TrayActions } from './tray-menu';

function recorder(): { actions: TrayActions; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      openInputBar: () => calls.push('open-input-bar'),
      reloadPet: () => calls.push('reload-pet'),
      quit: () => calls.push('quit'),
    },
  };
}

test('托盘菜单：标签与顺序是 呼出输入条 / 重新加载桌宠 / 退出（ADR 0018 D3）', () => {
  assert.deepEqual(
    TRAY_MENU.map((item) => item.label),
    ['呼出输入条', '重新加载桌宠', '退出'],
  );
  const { actions } = recorder();
  assert.deepEqual(
    buildTrayMenuItems(actions).map((item) => [item.id, item.label]),
    [
      ['open-input-bar', '呼出输入条'],
      ['reload-pet', '重新加载桌宠'],
      ['quit', '退出'],
    ],
  );
});

test('托盘菜单：每个菜单项只触发自己的动作', () => {
  const { actions, calls } = recorder();
  const items = buildTrayMenuItems(actions);

  items[0].click();
  assert.deepEqual(calls, ['open-input-bar']);

  items[1].click();
  assert.deepEqual(calls, ['open-input-bar', 'reload-pet']);

  items[2].click();
  assert.deepEqual(calls, ['open-input-bar', 'reload-pet', 'quit']);
});

test('托盘菜单：每次 build 都是新的闭包（重复点击不会累积）', () => {
  const { actions, calls } = recorder();
  const first = buildTrayMenuItems(actions);
  const second = buildTrayMenuItems(actions);
  first[0].click();
  second[0].click();
  assert.deepEqual(calls, ['open-input-bar', 'open-input-bar']);
});
