import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createModelAnimations } from './animation-controller';

/**
 * ADR 0044 回归：**停帧的 hold 也必须报告权重**。
 *
 * 真机上踩到的现象：坐姿 `playHold` 播完（ADR 0051 后是 2.0s）后 `clampWhenFinished` 把 action
 * 置成 `paused`，`isRunning()` 变 false。旧 `roleWeight()` 用 `isRunning()` 过滤，
 * 于是权重从 1 掉到 0 → 身体平移补偿整块消失 → 她被推到窗口左边只剩半个身子。
 */
test('roleWeight：playHold 停帧后仍然报告权重 1（否则坐姿补偿会整块消失）', () => {
  const root = new THREE.Object3D();
  const bone = new THREE.Object3D();
  bone.name = 'Bip001_Pelvis';
  root.add(bone);
  const clip = new THREE.AnimationClip('CH0335_my_event088_pastmemory_01', 20, [
    new THREE.NumberKeyframeTrack(`${bone.name}.position[y]`, [0, 20], [0, 1]),
  ]);
  const animations = createModelAnimations(root, [clip, new THREE.AnimationClip('CH0335_Cafe_Idle', 1, [])]);
  animations.play('idle', 0);
  assert.equal(animations.playHold('sit', 0), true);
  assert.ok(animations.roleWeight('sit') > 0.99, `刚开播 weight=${animations.roleWeight('sit')}`);

  // 推过片段末尾（ADR 0051 的 sit 窗口是 2.0s）：clampWhenFinished 生效
  for (let i = 0; i < 60; i += 1) animations.update(0.05);
  const hold = animations.hold();
  assert.ok(hold?.done === true, '片段应当已经停在最后一帧');
  assert.equal(hold?.paused, true, 'clampWhenFinished 会把 action 暂停');
  assert.equal(animations.current().running, false, '暂停的 action 不再 isRunning');
  // 但权重仍是 1 —— 姿态还在生效，补偿也必须继续
  assert.ok(animations.roleWeight('sit') > 0.99, `停帧后 weight=${animations.roleWeight('sit')}`);
});

test('roleWeight：没播过的角色恒为 0（不能读到 three 的默认权重 1）', () => {
  const root = new THREE.Object3D();
  const animations = createModelAnimations(root, [
    new THREE.AnimationClip('CH0335_Cafe_Idle', 1, []),
    new THREE.AnimationClip('CH0335_Victory_Start_Random', 1, []),
  ]);
  animations.play('idle', 0);
  assert.equal(animations.roleWeight('pat'), 0);
  assert.equal(animations.roleWeight('sit'), 0);
});
