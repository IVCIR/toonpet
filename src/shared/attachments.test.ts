import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_HIDE_ATTACHMENTS, matchesHiddenAttachment } from './attachments';

test('默认 HIDE_ATTACHMENTS 命中 CH0335 的三件配件网格', () => {
  for (const name of ['CH0335_Weapon', 'CH0335_Prop_Outlline', 'brush_01']) {
    assert.equal(matchesHiddenAttachment(name, DEFAULT_HIDE_ATTACHMENTS), true, name);
  }
});

test('默认 HIDE_ATTACHMENTS 不误伤角色本体与光环', () => {
  for (const name of ['CH0335_Body', 'CH0335_Halo', 'Bip001 Head']) {
    assert.equal(matchesHiddenAttachment(name, DEFAULT_HIDE_ATTACHMENTS), false, name);
  }
});

test('匹配大小写不敏感，空名字/空模式不隐藏', () => {
  assert.equal(matchesHiddenAttachment('WEAPON_01', DEFAULT_HIDE_ATTACHMENTS), true);
  assert.equal(matchesHiddenAttachment('', DEFAULT_HIDE_ATTACHMENTS), false);
  assert.equal(matchesHiddenAttachment(null, DEFAULT_HIDE_ATTACHMENTS), false);
  assert.equal(matchesHiddenAttachment('CH0335_Weapon', ''), false);
});

test('坏正则退回"不隐藏"，绝不抛异常打挂装配', () => {
  assert.equal(matchesHiddenAttachment('CH0335_Weapon', '([a-z'), false);
  assert.equal(matchesHiddenAttachment('CH0335_Weapon', '*weapon'), false);
});

test('显式覆盖可以只隐藏某一件配件', () => {
  assert.equal(matchesHiddenAttachment('CH0335_Weapon', '^CH0335_Weapon$'), true);
  assert.equal(matchesHiddenAttachment('brush_01', '^CH0335_Weapon$'), false);
});
