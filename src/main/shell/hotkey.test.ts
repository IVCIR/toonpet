import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_HOTKEY_DEFAULT,
  INPUT_HOTKEY_FALLBACK,
  registerInputHotkey,
} from './hotkey';
import type { HotkeyLogLevel } from './hotkey';

interface LogEntry {
  level: HotkeyLogLevel;
  message: string;
}

function makeDeps(registered: Set<string>, throwOn: Set<string> = new Set()) {
  const logs: LogEntry[] = [];
  return {
    logs,
    deps: {
      register(accelerator: string): boolean {
        if (throwOn.has(accelerator)) throw new Error('invalid accelerator');
        return registered.has(accelerator);
      },
      log(level: HotkeyLogLevel, message: string): void {
        logs.push({ level, message });
      },
    },
  };
}

test('默认热键可用：不降级', () => {
  const { deps, logs } = makeDeps(new Set([INPUT_HOTKEY_DEFAULT, INPUT_HOTKEY_FALLBACK]));
  const result = registerInputHotkey(deps);
  assert.equal(result.accelerator, INPUT_HOTKEY_DEFAULT);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.defaultFailed, false);
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, 0);
});

test('默认热键被占用：降级到 Ctrl+Alt+B 并留 WARN（ADR 0016 D4）', () => {
  const { deps, logs } = makeDeps(new Set([INPUT_HOTKEY_FALLBACK]));
  const result = registerInputHotkey(deps);
  assert.equal(result.accelerator, INPUT_HOTKEY_FALLBACK);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.defaultFailed, true);
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message.includes('降级')));
});

test('两个热键都不可用：不抛错、accelerator 为 null、记 ERROR', () => {
  const { deps, logs } = makeDeps(new Set());
  const result = registerInputHotkey(deps);
  assert.equal(result.accelerator, null);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.defaultFailed, true);
  assert.ok(logs.some((entry) => entry.level === 'error'));
});

test('register 抛错按注册失败处理（accelerator 语法非法时不拖垮启动）', () => {
  const { deps, logs } = makeDeps(
    new Set([INPUT_HOTKEY_FALLBACK]),
    new Set([INPUT_HOTKEY_DEFAULT]),
  );
  const result = registerInputHotkey(deps);
  assert.equal(result.accelerator, INPUT_HOTKEY_FALLBACK);
  assert.equal(result.defaultFailed, true);
  assert.ok(logs.some((entry) => entry.level === 'warn'));
});

test('允许调用方覆盖两个加速键（配置化前的逃生口）', () => {
  const { deps } = makeDeps(new Set(['F9']));
  const result = registerInputHotkey(deps, 'F8', 'F9');
  assert.equal(result.accelerator, 'F9');
  assert.equal(result.fallbackUsed, true);
});
