import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createBoneArbiter } from './bone-arbiter';

/**
 * 极简假骨骼：仲裁器只用到 `quaternion` / `parent` / `name`。
 * `parent = null` 时 endFrame 用单位四元数当父空间（等价于"世界轴 = 局部轴"）。
 */
function fakeBone(name = 'Bip001_Head'): THREE.Bone {
  return {
    name,
    quaternion: new THREE.Quaternion(),
    position: new THREE.Vector3(),
    parent: null,
  } as unknown as THREE.Bone;
}

/** 两个四元数之间的夹角（rad） */
function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const dot = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(dot);
}

/**
 * 回归：**片段停帧后 mixer 不再写骨骼**（three 的 `PropertyMixer.apply()` 会跳过
 * 与上一个 accu 相同的写入）时，仲裁器必须沿用缓存的动画基底，
 * 不能把我们上一帧写出的偏移当成新基底 —— 那会让偏移逐帧累积（"头在打转"）。
 */
test('mixer 停写时：偏移不得逐帧累积（100 帧后仍停在一次偏移的量级）', () => {
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

/**
 * 基底覆写（ADR 0046 D1：坐姿眼球回到"绑定姿态"，再叠张望）。
 *
 * 停帧后 Mixer 不再写眼骨，片段里那份"向下看"会永远留着。`overrideBase()` 让
 * `endFrame()` 从这个固定基底开始合成，而不是从动画基底开始。
 */
test('基底覆写：合成起点换成绑定姿态，且不影响"mixer 有没有重写"的判定', () => {
  const arbiter = createBoneArbiter();
  const bone = fakeBone('Bip001_eye_L');
  const sitLocal = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.25);
  const bindLocal = new THREE.Quaternion();
  bone.quaternion.copy(sitLocal);
  arbiter.register(bone);
  arbiter.overrideBase(bone, bindLocal);

  // 停帧：mixer 不写；覆写基底 = 单位四元数（平视）
  for (let frame = 0; frame < 50; frame += 1) {
    arbiter.capture();
    arbiter.beginFrame();
    arbiter.endFrame();
  }
  assert.ok(angleBetween(bone.quaternion, bindLocal) < 1e-9, '必须回到绑定姿态');
  const state = arbiter.snapshot().find((item) => item.bone === 'Bip001_eye_L');
  assert.equal(state?.overridden, true);
  assert.equal(state?.baseFrom, 'cache');

  // 叠一个张望偏移：在绑定基底之上转，而不是在片段姿态之上转
  arbiter.capture();
  arbiter.beginFrame();
  arbiter.add(bone, 0.2, 0);
  arbiter.endFrame();
  const expected = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2)
    .multiply(bindLocal);
  assert.ok(angleBetween(bone.quaternion, expected) < 1e-6);

  // 取消覆写 → 回到动画基底（片段里的 0.25rad 低头）
  arbiter.overrideBase(bone, null);
  arbiter.capture();
  arbiter.beginFrame();
  arbiter.add(bone, 0.2, 0);
  arbiter.endFrame();
  const expectedFromAnimation = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2)
    .multiply(sitLocal);
  assert.ok(
    angleBetween(bone.quaternion, expectedFromAnimation) < 1e-6,
    '取消覆写后回到动画姿态',
  );
});

test('基底覆写：未登记骨骼会被登记；override 传 null 不报错', () => {
  const arbiter = createBoneArbiter();
  const bone = fakeBone('Bip001_eye_R');
  arbiter.overrideBase(bone, null);
  assert.equal(arbiter.size, 1);
  assert.equal(arbiter.snapshot()[0]?.overridden, false);
});

/**
 * 位置覆写（ADR 0057 D3：坐姿停帧后把眼皮放回"睁眼"基线）。
 *
 * 与旋转基底覆写同一套语义：**绝对**值、每帧写、传 `null` 就放手。
 * 这条通道存在的唯一理由是"停帧后 mixer 不再写这根骨，而它被冻在了一个半闭的姿态上"。
 */
test('位置覆写：绝对值每帧写回，取消覆写后立即放手（不再写）', () => {
  const arbiter = createBoneArbiter();
  const bone = fakeBone('Bip001 bone_eye_D_L');
  const clipPos = new THREE.Vector3(0.00028, 0.1, 0.2);
  const openPos = new THREE.Vector3(0, 0.1, 0.2);
  bone.position.copy(clipPos);
  arbiter.register(bone);

  // 覆写为"睁眼"基线：即使没有旋转偏移，endFrame 也必须写位置
  arbiter.overridePosition(bone, openPos);
  for (let frame = 0; frame < 10; frame += 1) {
    arbiter.capture();
    arbiter.beginFrame();
    arbiter.endFrame();
  }
  assert.ok(bone.position.distanceTo(openPos) < 1e-9, '位置必须回到睁眼基线');
  assert.equal(arbiter.positionOverridden(bone), true);
  assert.equal(arbiter.snapshot()[0]?.positionOverridden, true);

  // 逐帧写回：有人在两帧之间改了它（等价于 mixer 又写了一帧片段值），下一帧仍然被覆写
  bone.position.copy(clipPos);
  arbiter.capture();
  arbiter.beginFrame();
  arbiter.endFrame();
  assert.ok(bone.position.distanceTo(openPos) < 1e-9, '覆写是每帧生效的，不是一次性');

  // 取消覆写：之后仲裁器不再碰位置（值停在最后一次写入，由 mixer 自己接管）
  arbiter.overridePosition(bone, null);
  bone.position.copy(clipPos);
  arbiter.capture();
  arbiter.beginFrame();
  arbiter.endFrame();
  assert.ok(bone.position.distanceTo(clipPos) < 1e-9, '取消覆写后不得再写位置');
  assert.equal(arbiter.positionOverridden(bone), false);

  // reset 也会清掉位置覆写
  arbiter.overridePosition(bone, openPos);
  arbiter.reset();
  assert.equal(arbiter.positionOverridden(bone), false);
});
