import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  GAZE_CURSOR_HOLD_MS,
  GAZE_CURSOR_IDLE_TIMEOUT_MS,
  GAZE_EYE_STIFFNESS,
  GAZE_HEAD_STIFFNESS,
  GAZE_SPINE_STIFFNESS,
} from '../../shared/constants';
import type { BoneOffsetSink } from './bone-arbiter';
import { createGazeController } from './gaze';
import type { ModelBones } from './model-loader';

interface Rig {
  bones: ModelBones;
  head: THREE.Bone;
  eyeL: THREE.Bone;
  eyeR: THREE.Bone;
  spine1: THREE.Bone;
}

/** 一根够用的最小骨架：spine1 → neck → head → eye_L/R（坐标只用于算头在内容区的 CSS 位置）。 */
function makeRig(): Rig {
  const spine1 = new THREE.Bone();
  spine1.name = 'Bip001_Spine1';
  const neck = new THREE.Bone();
  neck.name = 'Bip001_Neck';
  neck.position.set(0, 60, 0);
  spine1.add(neck);
  const head = new THREE.Bone();
  head.name = 'Bip001_Head';
  head.position.set(0, 60, 0);
  neck.add(head);
  const eyeL = new THREE.Bone();
  eyeL.name = 'Bip001_eye_L';
  eyeL.position.set(-10, 5, 10);
  head.add(eyeL);
  const eyeR = new THREE.Bone();
  eyeR.name = 'Bip001_eye_R';
  eyeR.position.set(10, 5, 10);
  head.add(eyeR);
  const bones = { head, eyeL, eyeR, spine1 } as unknown as ModelBones;
  return { bones, head, eyeL, eyeR, spine1 };
}

/** 记录一次 `update()` 里提交的偏移（按骨骼名字取）。 */
function makeSink(): BoneOffsetSink & {
  last: (bone: THREE.Bone) => { yaw: number; pitch: number; roll: number };
} {
  const frames = new Map<string, { yaw: number; pitch: number; roll: number }>();
  return {
    add(bone, yaw, pitch, roll = 0) {
      const previous = frames.get(bone.name) ?? { yaw: 0, pitch: 0, roll: 0 };
      frames.set(bone.name, {
        yaw: previous.yaw + yaw,
        pitch: previous.pitch + pitch,
        roll: previous.roll + roll,
      });
    },
    last(bone) {
      return frames.get(bone.name) ?? { yaw: 0, pitch: 0, roll: 0 };
    },
  };
}

const WIDTH = 400;
const HEIGHT = 600;

/**
 * 推进一帧并返回该帧提交的头部/眼球/躯干偏移。
 * 传 `cursor` 模拟"主进程这一拍还在探"（真实路径里每 16ms 一次 `cmd:probe`）。
 */
function step(
  gaze: NonNullable<ReturnType<typeof createGazeController>>,
  rig: Rig,
  now: number,
  cursor?: { x: number; y: number },
): { head: number; eye: number; spine: number } {
  if (cursor) gaze.setCursor(cursor.x, cursor.y, now);
  const sink = makeSink();
  gaze.update(now, WIDTH, HEIGHT, sink);
  return { head: sink.last(rig.head).yaw, eye: sink.last(rig.eyeL).yaw, spine: sink.last(rig.spine1).yaw };
}

/** 头骨在内容区的位置：(200, 180)（spine1 原点 + neck 60 + head 60） */
const RIGHT = { x: 360, y: 180 };

test('视线：三级阻尼的时间差——眼球先到、头部次之、躯干最慢（ADR 0049 D2）', () => {
  const rig = makeRig();
  const gaze = createGazeController(rig.bones, { random: () => 0.5 })!;

  // 先空转 1s（idle，随机目标为 0）
  for (let t = 0; t <= 1000; t += 16) step(gaze, rig, t);
  // 光标出现在右侧（每拍都探，模拟真实 cmd:probe 节奏）
  const series: Array<{ t: number; head: number; eye: number; spine: number }> = [];
  for (let t = 1016; t <= 2000; t += 16) {
    series.push({ t: (t - 1000) / 1000, ...step(gaze, rig, t, RIGHT) });
  }
  const final = series[series.length - 1]!;
  assert.ok(final.head > 0.2, `头部最终应接近目标：${final.head}`);
  assert.ok(final.eye > 0.05, `眼球最终应有额外量：${final.eye}`);
  assert.ok(final.spine > 0.02, `躯干应轻微跟随：${final.spine}`);

  const t90 = (pick: (row: (typeof series)[number]) => number): number => {
    const target = Math.abs(pick(final));
    for (const row of series) {
      if (Math.abs(pick(row)) >= target * 0.9) return row.t;
    }
    return Number.POSITIVE_INFINITY;
  };
  const eyeT90 = t90((row) => row.eye);
  const headT90 = t90((row) => row.head);
  const spineT90 = t90((row) => row.spine);
  // 明显的时间差：眼 ≤ 头-80ms，头 ≤ 躯干-120ms
  assert.ok(eyeT90 <= headT90 - 0.08, `eye=${eyeT90}s head=${headT90}s`);
  assert.ok(headT90 <= spineT90 - 0.12, `head=${headT90}s spine=${spineT90}s`);
  // 刚度常量的顺序就是"眼 > 头 > 躯干"
  assert.ok(GAZE_EYE_STIFFNESS > GAZE_HEAD_STIFFNESS);
  assert.ok(GAZE_HEAD_STIFFNESS > GAZE_SPINE_STIFFNESS);
});

test('视线：躯干只在偏航超过阈值时跟随（小幅注视不动肩膀）', () => {
  const rig = makeRig();
  const gaze = createGazeController(rig.bones, { random: () => 0.5 })!;
  for (let t = 0; t <= 500; t += 16) step(gaze, rig, t);

  // 目标 yaw = 0.04（低于 0.08 阈值）：头会动，躯干必须一动不动
  // 头在 (200,180)，光标 x = 200 + 0.04/0.32 × 200 = 225
  const NEAR = { x: 225, y: 180 };
  for (let t = 516; t <= 2000; t += 16) step(gaze, rig, t, NEAR);
  const small = step(gaze, rig, 2016, NEAR);
  assert.ok(Math.abs(small.head) > 0.03, `头部应跟随：${small.head}`);
  assert.ok(Math.abs(small.spine) < 1e-3, `阈值以下躯干不该动：${small.spine}`);

  // 大幅偏航：躯干开始跟随
  for (let t = 2032; t <= 4000; t += 16) step(gaze, rig, t, RIGHT);
  const large = step(gaze, rig, 4016, RIGHT);
  assert.ok(Math.abs(large.spine) > 0.03, `大幅偏航时躯干应跟随：${large.spine}`);
});

test('视线：光标离开先保持 150ms，再用更慢的刚度缓出回正（不是立即回弹）', () => {
  const rig = makeRig();
  const gaze = createGazeController(rig.bones, { random: () => 0.5 })!;
  for (let t = 0; t <= 500; t += 16) step(gaze, rig, t);

  // 跟随到右侧并收敛（每拍都探，最后一条光标事实在 2500）
  let settled = { head: 0, eye: 0, spine: 0 };
  for (let t = 516; t <= 2500; t += 16) settled = step(gaze, rig, t, RIGHT);
  assert.ok(settled.head > 0.25);
  const lastSeen = 2500;

  // 保持窗口内（≤150ms）：目标不被清零，头也基本不动
  let held = settled;
  for (let t = 2516; t <= lastSeen + GAZE_CURSOR_HOLD_MS; t += 16) held = step(gaze, rig, t);
  assert.ok(held.head > settled.head * 0.99, `保持窗口内不该回弹：${held.head} vs ${settled.head}`);

  // 刚进入 release：目标归零，但只走了很小一段（不是弹回）
  const early = step(gaze, rig, lastSeen + GAZE_CURSOR_HOLD_MS + 17);
  assert.ok(early.head > settled.head * 0.9, `release 第一拍不该跳回：${early.head}`);
  assert.ok(early.head < settled.head + 1e-6);

  // 400ms 后明显回落，但仍有残余
  let mid = early;
  for (let t = lastSeen + 200; t <= lastSeen + 700; t += 16) mid = step(gaze, rig, t);
  assert.ok(mid.head < settled.head * 0.5, `缓出应明显回落：${mid.head}`);
  assert.ok(mid.head > 0.01, `缓出不该一步到零：${mid.head}`);

  // 静默超过 1500ms → idle（替代眨眼的随机微动）
  for (let t = lastSeen + 716; t <= lastSeen + GAZE_CURSOR_IDLE_TIMEOUT_MS + 20; t += 16) {
    step(gaze, rig, t);
  }
  const state = gaze.state();
  assert.equal(state.idle, true);
  assert.equal(state.phase, 'idle');
  assert.ok(Math.abs(state.yaw) < 0.05, `回正后应接近 0：${state.yaw}`);
});

test('视线：idle 每 5s 换一个随机目标（替代眨眼，ADR 0010 D1）', () => {
  const rig = makeRig();
  let sample = 0;
  const values = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7];
  const gaze = createGazeController(rig.bones, { random: () => values[sample++ % values.length]! })!;
  step(gaze, rig, 0);
  const first = gaze.state();
  for (let t = 16; t <= 5100; t += 16) step(gaze, rig, t);
  const second = gaze.state();
  assert.notEqual(first.targetYaw, second.targetYaw);
  assert.ok(Math.abs(second.targetYaw) <= 0.2 + 1e-9);
  assert.ok(Math.abs(second.targetPitch) <= 0.1 + 1e-9);
});

test('视线：缺头且缺眼时返回 null（不制造空转控制器）', () => {
  const bones = {} as unknown as ModelBones;
  assert.equal(createGazeController(bones), null);
});
