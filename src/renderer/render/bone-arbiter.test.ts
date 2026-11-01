import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createBoneArbiter } from './bone-arbiter';

/**
 * 极简假骨骼：仲裁器只用到 `quaternion` / `parent` / `name`。
 * `parent = null` 时 endFrame 用单位四元数做父空间（等价于"世界轴 = 局部轴"）。
 */
function fakeBone(name = 'Bip001_Head'): THREE.Bone {
  return { name, quaternion: new THREE.Quaternion(), parent: null } as unknown as THREE.Bone;
}

/** 两个四元数之间的夹角（rad）。 */
function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(dot);
}

/**
 * 回归：**片段停帧后 mixer 不再写骨骼**（three 的 `PropertyMixer.apply()` 会跳过
 * 与上一个 accu 相同的写入）时，仲裁器必须沿用缓存的动画基底，
 * 不能把我们上一帧写出的偏移当成新基底 —— 那会让偏移逐帧累积（"头在打转"）。
 */
test('mixer 停写时：偏移不得逐帧累积（100 帧后仍停留在一次偏移的量级）', () => {
  const arbiter = createBoneArbiter();
  const bone = fakeBone();
  arbiter.register(bone);

  const yaw = 0.15;
  const pitch = -0.08;

  for (let frame = 0; frame < 100; frame += 1) {
    arbiter.capture(); // mixer.update 之前
    // 模拟"片段停帧"：mixer 这一帧没有写任何东西
    arbiter.beginFrame();
    arbiter.add(bone, yaw, pitch);
    arbiter.endFrame();
  }

  const state = arbiter.snapshot()[0];
  assert.equal(state?.baseFrom, 'cache', '没有动画写入时必须走缓存基底');
  // 基准：一帧偏移本身的量级（≈0.17 rad）；累积的话 100 帧会到 17 rad（转好几圈）
  const applied = angleBetween(new THREE.Quaternion(), bone.quaternion);
  assert.ok(applied < 0.4, `100 帧后偏移应停在一次的量级，实际 ${applied.toFixed(3)} rad`);
  assert.ok(applied > 0.05, '偏移仍然要被应用（不是被吞掉）');
});

test('mixer 写回时：基底跟随动画，不叠加历史偏移', () => {
  const arbiter = createBoneArbiter();
  const bone = fakeBone();
  arbiter.register(bone);

  const animated = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3);

  // 第 1 帧：动画写入 0.3 rad，我们叠加 0.15
  arbiter.capture();
  bone.quaternion.copy(animated);
  arbiter.beginFrame();
  assert.equal(arbiter.snapshot()[0]?.baseFrom, 'mixer');
  arbiter.add(bone, 0.15, 0);
  arbiter.endFrame();
  const afterFirst = bone.quaternion.clone();

  // 第 2 帧：动画仍然写同一个值 → 基底回到动画值，结果应与第 1 帧完全相同
  arbiter.capture();
  bone.quaternion.copy(animated);
  arbiter.beginFrame();
  arbiter.add(bone, 0.15, 0);
  arbiter.endFrame();
  assert.ok(angleBetween(afterFirst, bone.quaternion) < 1e-6, '同样的输入必须得到同样的结果');
});

test('mixer 与停写交替：只在动画写入时刷新基底，停写时保持稳定', () => {
  const arbiter = createBoneArbiter();
  const bone = fakeBone();
  arbiter.register(bone);
  const animated = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2);

  // 动画写 1 帧
  arbiter.capture();
  bone.quaternion.copy(animated);
  arbiter.beginFrame();
  arbiter.add(bone, 0.1, 0);
  arbiter.endFrame();
  const stable = bone.quaternion.clone();

  // 之后 30 帧都不写
  for (let frame = 0; frame < 30; frame += 1) {
    arbiter.capture();
    arbiter.beginFrame();
    arbiter.add(bone, 0.1, 0);
    arbiter.endFrame();
    assert.ok(angleBetween(stable, bone.quaternion) < 1e-6, `第 ${frame} 帧不该继续转`);
  }
  assert.equal(arbiter.snapshot()[0]?.baseFrom, 'cache');
});

test('零偏移帧不写骨骼（written=false），随后恢复偏移仍然稳定', () => {
  const arbiter = createBoneArbiter();
  const bone = fakeBone();
  arbiter.register(bone);

  for (const yaw of [0, 0, 0.2, 0, 0, 0.2, 0]) {
    arbiter.capture();
    arbiter.beginFrame();
    if (yaw !== 0) arbiter.add(bone, yaw, 0);
    arbiter.endFrame();
  }
  const applied = angleBetween(new THREE.Quaternion(), bone.quaternion);
  assert.ok(applied < 0.5, `偏移不得累积，实际 ${applied.toFixed(3)} rad`);
});
