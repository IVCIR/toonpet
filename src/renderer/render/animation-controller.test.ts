import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { CLIP_RULES, selectRole, trimClip } from './clip-bank';
import { createModelAnimations } from './animation-controller';

/**
 * 片段表的回归护栏（ADR 0041 / ADR 0042 的标定值都在这里锁一遍）。
 *
 * 为什么值得写：这些窗口（0.3–2.05s 的摸头、8.7–9.9s 的鞠躬、14.5–14.92s 的坐姿循环）
 * 是**对着 CH0335 逐帧量出来的**，改错一个数字不会报错，只会让动作变得难看。
 */
test('片段表：摸头/打招呼/鞠躬/小动作/坐姿的裁剪窗口与总时长', () => {
  const pat = CLIP_RULES.pat;
  assert.equal(pat.exact, 'CH0335_Victory_Start_Random');
  assert.equal(pat.startSeconds, 0.3);
  assert.equal(pat.maxSeconds, 2.05);
  assert.equal(pat.fadeOutSeconds, 0.45, '摸头的淡出必须比默认 0.25s 长（ADR 0041 D2）');

  const nod = CLIP_RULES.nod;
  assert.equal(nod.exact, 'CH0335_Cafe_Reaction');
  assert.ok((nod.maxSeconds ?? 0) - (nod.startSeconds ?? 0) <= 1.2 + 1e-9, '契约 §4.4：nod ≤ 1.2s');

  const greet = CLIP_RULES.greet;
  assert.equal(greet.exact, 'CH0335_Cafe_Reaction');
  assert.ok((greet.maxSeconds ?? 99) <= 2.4);

  const shyy = CLIP_RULES['fidget.shy'];
  assert.ok((shyy.maxSeconds ?? 0) > (shyy.startSeconds ?? 0));
  assert.ok((shyy.fadeOutSeconds ?? 0) >= 0.35);

  const sit = CLIP_RULES.sit;
  assert.equal(sit.exact, 'CH0335_my_event088_pastmemory_01');
  assert.equal(sit.startSeconds, 14.5, 'ADR 0044 D1：坐姿回到停帧，窗口取最平稳的一段');
  assert.equal(sit.maxSeconds, 14.7);
  assert.equal(sit.loop, false, 'ADR 0044 D1：停帧（循环会在接缝处读作"抽搐"）');
  assert.ok((sit.maxSeconds ?? 0) - (sit.startSeconds ?? 0) <= 0.6, '窗口要短，才能保证末帧稳定');
});

test('片段表：拖拽只认一个官方悬空片段，且不再按部位分片（ADR 0041 D1）', () => {
  assert.equal(CLIP_RULES.held.exact, 'CH0335_Formation_Pickup');
  assert.equal(CLIP_RULES.held.loop, true);
  // 旧实现给"抓头"单独准备的站姿角色必须已经删除
  assert.equal(Object.hasOwn(CLIP_RULES, 'held.limp'), false);
});

test('片段表：待机姿态池是四个互不相同的正面循环片段', () => {
  const roles = ['idle', 'idle.alt1', 'idle.alt2', 'idle.alt3'] as const;
  const names = roles.map((role) => CLIP_RULES[role].exact);
  assert.equal(new Set(names).size, names.length);
  for (const role of roles) assert.equal(CLIP_RULES[role].loop, true);
});

test('selectRole：精确名优先，其次模式降级，最后 missing', () => {
  const clips = [
    new THREE.AnimationClip('CH0335_Cafe_Idle', 1, []),
    new THREE.AnimationClip('CH0335_Formation_Idle', 1, []),
  ];
  assert.equal(selectRole(clips, 'idle').reason, 'exact');
  assert.equal(selectRole(clips, 'idle').name, 'CH0335_Cafe_Idle');
  assert.equal(selectRole(clips, 'idle.alt1').name, 'CH0335_Formation_Idle');
  const missing = selectRole(clips, 'pat');
  assert.equal(missing.reason, 'missing');
  assert.equal(missing.name, null);
  // 模式降级：名字不完全一致也能命中
  const renamed = [new THREE.AnimationClip('CH0335_Victory_Start_Random_02', 1, [])];
  const fallback = selectRole(renamed, 'pat');
  assert.equal(fallback.reason, 'pattern');
  assert.equal(fallback.name, 'CH0335_Victory_Start_Random_02');
});

test('trimClip：按时间裁关键帧并把时间轴平移到 0', () => {
  const times = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  const values = times.map((t) => t);
  const track = new THREE.NumberKeyframeTrack('.position[y]', times, values);
  const clip = new THREE.AnimationClip('demo', 3, [track]);
  const trimmed = trimClip(clip, 1, 2);
  assert.ok(Math.abs(trimmed.duration - 1) < 1e-9);
  assert.ok(trimmed.name.includes('@1-2s'));
  const outTimes = Array.from(trimmed.tracks[0].times);
  assert.deepEqual(outTimes, [0, 0.5, 1]);
  assert.deepEqual(Array.from(trimmed.tracks[0].values), [1, 1.5, 2]);
});

/**
 * 一次性演出播完要回到**演出前那个动作**，而不是"槽位 idle 对应的片段"。
 *
 * 这是"摸头收尾像被切断"的真正根因（ADR 0041 D2）：待机姿态会轮换，摸头时她在
 * `Formation_Idle`（抱臂）里，若回到 `idle` 槽位就会交叉淡入到 `Cafe_Idle`
 * —— 抱臂的手在 0.25s 内被放下来，读起来就是"动作被打断"。
 */
test('playOnce：播完淡回"演出前正在播的那个动作"（姿势连续，ADR 0041 D2）', () => {
  const root = new THREE.Object3D();
  const bone = new THREE.Object3D();
  bone.name = 'Bip001_Spine';
  root.add(bone);
  const make = (name: string) =>
    new THREE.AnimationClip(name, 1, [
      new THREE.NumberKeyframeTrack(`${bone.name}.position[y]`, [0, 1], [0, 1]),
    ]);
  const animations = createModelAnimations(root, [
    make('CH0335_Cafe_Idle'),
    make('CH0335_Formation_Idle'),
    make('CH0335_Victory_Start_Random'),
  ]);

  assert.equal(animations.play('idle', 0), true);
  assert.equal(animations.playRole('idle.alt1', 0.05, 'idle'), true);
  assert.equal(animations.current().name, 'CH0335_Formation_Idle');

  assert.equal(animations.playOnce('pat'), true);
  const one = animations.oneShot();
  assert.ok(one);
  assert.equal(one?.role, 'pat');
  // 摸头的裁剪窗口 0.3–2.05s → 片段时长 1.75s
  assert.ok(Math.abs((one?.duration ?? 0) - 1.75) < 1e-6, `duration=${one?.duration}`);

  // 推到片段结束：mixer 的 finished 事件应把动作交还给"抱臂站姿"
  for (let i = 0; i < 40; i += 1) animations.update(0.05);
  assert.equal(animations.oneShot(), null);
  assert.equal(animations.current().name, 'CH0335_Formation_Idle');
  assert.equal(animations.current().slot, 'idle');
});

test('playOnce：片段缺失时返回 false（调用方走程序化降级）', () => {
  const root = new THREE.Object3D();
  const animations = createModelAnimations(root, [
    new THREE.AnimationClip('CH0335_Cafe_Idle', 1, []),
  ]);
  animations.play('idle', 0);
  assert.equal(animations.playOnce('greet'), false);
  assert.equal(animations.playOnce('pat'), false);
  // 缺失角色的降级候选也不能凭空造出台词片段
  assert.equal(animations.roles.greet.name, null);
});

test('语义角色同样按窗口裁剪：坐姿的停帧片段只保留 14.5–14.7s（ADR 0044 D1）', () => {
  const root = new THREE.Object3D();
  const bone = new THREE.Object3D();
  bone.name = 'Bip001_Pelvis';
  root.add(bone);
  // 造一段 20s 的"回忆演出"：只有一条轨道，便宜且足够验证窗口
  const times: number[] = [];
  const values: number[] = [];
  for (let t = 0; t <= 20; t += 0.1) {
    times.push(Number(t.toFixed(2)));
    values.push(Math.sin(t));
  }
  const long = new THREE.AnimationClip('CH0335_my_event088_pastmemory_01', 20, [
    new THREE.NumberKeyframeTrack(`${bone.name}.position[y]`, times, values),
  ]);
  const animations = createModelAnimations(root, [long, new THREE.AnimationClip('CH0335_Cafe_Idle', 1, [])]);
  animations.play('idle', 0);

  // 停帧播放（`playHold`）：与运行时同一条路径
  assert.equal(animations.playHold('sit', 0), true);
  const current = animations.current();
  // 名字带裁剪后缀、时长 = 14.7-14.5 = 0.2s（旧实现会把 20s 整段绑上去）
  assert.ok(current.name?.includes('@14.5-14.7s'), `name=${String(current.name)}`);
  assert.ok(Math.abs((animations.roles.sit.name ? 0.2 : 0) - 0.2) < 1e-9);
  // 坐姿片段的权重是"坐姿混合权重"的来源（ADR 0043 D3）
  assert.ok(animations.roleWeight('sit') > 0.99, `weight=${animations.roleWeight('sit')}`);
  // 没在跑的角色必须是 0（three 未播放 action 的默认权重是 1，不能直接读）
  assert.equal(animations.roleWeight('pat'), 0);
});

test('roleWeight：交叉淡出时平滑下降（退场补偿不会硬切，ADR 0043 D3）', () => {
  const root = new THREE.Object3D();
  const bone = new THREE.Object3D();
  bone.name = 'Bip001_Pelvis';
  root.add(bone);
  const make = (name: string) =>
    new THREE.AnimationClip(name, 1, [
      new THREE.NumberKeyframeTrack(`${bone.name}.position[y]`, [0, 1], [0, 1]),
    ]);
  const animations = createModelAnimations(root, [
    make('CH0335_Cafe_Idle'),
    make('CH0335_my_event088_pastmemory_01'),
  ]);
  animations.play('idle', 0);
  animations.playHold('sit', 0);
  assert.ok(animations.roleWeight('sit') > 0.99);

  // 淡回 Idle（0.35s）：权重必须在中间是 (0,1)，而不是 1→0 的瞬间跳变
  animations.play('idle', 0.35);
  animations.update(0.1);
  const mid = animations.roleWeight('sit');
  assert.ok(mid > 0 && mid < 1, `mid=${mid}`);
  // 注意 `update()` 把 dt 钳到 0.1s（MAX_UPDATE_SECONDS），所以要多次推进
  for (let i = 0; i < 6; i += 1) animations.update(0.1);
  assert.ok(animations.roleWeight('sit') < 0.05, `end=${animations.roleWeight('sit')}`);
});
