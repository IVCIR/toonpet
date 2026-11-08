/**
 * 角色卡文件读写的测试（ADR 0053）。
 *
 * 覆盖三条硬约束：
 * 1. 归一化：BOM / CRLF / 首尾空白被吃掉，正文内部的排版不动；
 * 2. 拒绝：空正文、超长、相对路径都不许写盘（"人格不能静默消失"）；
 * 3. 原子写：成功后读回一致，不留 `.tmp`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MINIMAL_CHARACTER_CARD,
  normalizeCardText,
  readCharacterCard,
  writeCharacterCard,
} from './character-card';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'aa3dpet-card-'));
}

test('角色卡：归一化去 BOM/CRLF/首尾空白，保留内部空行', () => {
  assert.equal(normalizeCardText('\uFEFF第一行\r\n\r\n  第二行  \r\n'), '第一行\n\n  第二行');
  assert.equal(normalizeCardText('  单行  '), '单行');
  assert.equal(normalizeCardText(42), '');
  assert.equal(normalizeCardText(undefined), '');
});

test('角色卡：不存在的文件返回 ok:false + exists:false，不抛', () => {
  const dir = tempDir();
  try {
    const read = readCharacterCard(path.join(dir, 'missing.md'));
    assert.equal(read.ok, false);
    assert.equal(read.exists, false);
    assert.equal(read.text, '');
    assert.match(read.error ?? '', /不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('角色卡：读到的字数按码点计（emoji 算 1 个字）', () => {
  const dir = tempDir();
  const file = path.join(dir, 'card.md');
  try {
    writeFileSync(file, '凯伊🫡', 'utf8');
    const read = readCharacterCard(file);
    assert.equal(read.ok, true);
    assert.equal(read.chars, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('角色卡：写盘 → 读回一致，且不留 .tmp', () => {
  const dir = tempDir();
  const file = path.join(dir, 'nested', 'card.md');
  try {
    const write = writeCharacterCard(file, '你是凯伊。\n\n保持简短。');
    assert.equal(write.ok, true);
    assert.equal(write.error, null);
    assert.equal(write.chars, [...'你是凯伊。\n\n保持简短。'].length);
    assert.equal(existsSync(`${file}.tmp`), false);

    const read = readCharacterCard(file);
    assert.equal(read.text, '你是凯伊。\n\n保持简短。');
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('角色卡：空正文被拒绝，原文件不动', () => {
  const dir = tempDir();
  const file = path.join(dir, 'card.md');
  try {
    writeFileSync(file, '原来的设定', 'utf8');
    for (const empty of ['', '   ', '\r\n\t ', 0, null]) {
      const write = writeCharacterCard(file, empty);
      assert.equal(write.ok, false, `输入 ${JSON.stringify(empty)} 应被拒绝`);
      assert.match(write.error ?? '', /不能为空/);
    }
    assert.equal(readCharacterCard(file).text, '原来的设定');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('角色卡：超长被拒绝（上限可注入，用于单测）', () => {
  const dir = tempDir();
  const file = path.join(dir, 'card.md');
  try {
    const write = writeCharacterCard(file, '字'.repeat(11), { maxChars: 10 });
    assert.equal(write.ok, false);
    assert.match(write.error ?? '', /太长/);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('角色卡：相对路径被拒绝（避免写到 cwd 的意外位置）', () => {
  const write = writeCharacterCard('relative/card.md', '内容');
  assert.equal(write.ok, false);
  assert.match(write.error ?? '', /绝对路径/);
});

test('角色卡：缺失时的最小身份行非空且含称呼（降级后仍有基本口吻）', () => {
  assert.ok(MINIMAL_CHARACTER_CARD.length > 0);
  assert.match(MINIMAL_CHARACTER_CARD, /老师/);
});
