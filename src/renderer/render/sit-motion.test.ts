import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIT_BREATH_FLOAT_PX,
  SIT_BREATH_NECK_RAD,
  SIT_BREATH_PERIOD_MS,
  SIT_BREATH_SHOULDER_RAD,
  SIT_BREATH_SPINE1_RAD,
  SIT_BREATH_SPINE_RAD,
  SIT_GAZE_DOWN_MAX_RAD,
  SIT_GAZE_HOLD_MAX_MS,
  SIT_GAZE_HOLD_MIN_MS,
  SIT_GAZE_MOVE_MAX_MS,
  SIT_GAZE_MOVE_MIN_MS,
  SIT_GAZE_UP_MAX_RAD,
  SIT_GAZE_UP_MIN_RAD,
  SIT_GAZE_YAW_RAD,
  SIT_LEG_AMP_SKEW_R,
  SIT_LEG_CALF_LAG_RAD,
  SIT_LEG_CALF_RAD,
  SIT_LEG_CALF_RATIO,
  SIT_LEG_LIFT_POWER_L,
  SIT_LEG_LIFT_POWER_R,
  SIT_LEG_PHASE_RAD,
  SIT_LEG_RATE_SKEW,
  SIT_LEG_SWING_RAD_PER_SEC,
  SIT_LEG_THIGH_RAD,
  SIT_MOTION_RAMP_MS,
} from '../../shared/constants';
import { breathAt, createSitMotion, legSwingAt } from './sit-motion';

/** 可复现的伪随机（LCG）：同一个 seed 两次跑结果一致 */
function seededRandom(seed = 12345): () => number {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

test('呼吸：单根 3.6s 正弦、≤1px、三根脊柱同相且幅度递减（不许高频抖动）', () => {
  assert.ok(SIT_BREATH_PERIOD_MS >= 3000 && SIT_BREATH_PERIOD_MS <= 4000);
  assert.ok(SIT_BREATH_FLOAT_PX > 0 && SIT_BREATH_FLOAT_PX <= 1, `float=${SIT_BREATH_FLOAT_PX}`);

  // 四分之一周期 = 峰值
  const quarter = breathAt(SIT_BREATH_PERIOD_MS / 4);
  assert.ok(Math.abs(quarter.floatPx - SIT_BREATH_FLOAT_PX) < 1e-9);
  assert.ok(Math.abs(quarter.spinePitch - SIT_BREATH_SPINE_RAD) < 1e-9);
  assert.ok(Math.abs(quarter.spine1Pitch - SIT_BREATH_SPINE1_RAD) < 1e-9);
  assert.ok(Math.abs(quarter.neckPitch - SIT_BREATH_NECK_RAD) < 1e-9);

  // 半周期 = 零点；四分之三周期 = 负峰（呼气到底），整周期回到 0
  const half = breathAt(SIT_BREATH_PERIOD_MS / 2);
  assert.ok(Math.abs(half.floatPx) < 1e-9);
  const threeQuarter = breathAt((SIT_BREATH_PERIOD_MS * 3) / 4);
  assert.ok(Math.abs(threeQuarter.floatPx + SIT_BREATH_FLOAT_PX) < 1e-9);
  assert.ok(Math.abs(breathAt(SIT_BREATH_PERIOD_MS).floatPx) < 1e-9);

  // 全程有界、连续（相邻 10ms 的变化量远小于幅度 → 不可能是高频抖动）
  let previous = breathAt(0).floatPx;
  let maxStep = 0;
  for (let t = 10; t <= SIT_BREATH_PERIOD_MS * 2; t += 10) {
    const value = breathAt(t).floatPx;
    maxStep = Math.max(maxStep, Math.abs(value - previous));
    assert.ok(Math.abs(value) <= SIT_BREATH_FLOAT_PX + 1e-9, `t=${t}`);
    previous = value;
  }
  assert.ok(maxStep < SIT_BREATH_FLOAT_PX * 0.05, `maxStep=${maxStep}`);
});

test('肩膀呼吸：锁骨 ±0.02rad、上臂同幅但相位领先 90°（不是刚体平移，ADR 0045 D2.3）', () => {
  // 幅度必须"看得到但说不出"：0.015–0.03rad
  assert.ok(
    SIT_BREATH_SHOULDER_RAD >= 0.015 && SIT_BREATH_SHOULDER_RAD <= 0.03,
    `shoulder=${SIT_BREATH_SHOULDER_RAD}`,
  );
  // t=0：sin=0 → 锁骨在 0；cos=1 → 上臂在正峰
  const zero = breathAt(0);
  assert.ok(Math.abs(zero.claviclePitch) < 1e-9);
  assert.ok(Math.abs(zero.upperArmPitch - SIT_BREATH_SHOULDER_RAD) < 1e-9);
  // 四分之一周期：锁骨到峰、上臂回 0
  const quarter = breathAt(SIT_BREATH_PERIOD_MS / 4);
  assert.ok(Math.abs(quarter.claviclePitch - SIT_BREATH_SHOULDER_RAD) < 1e-9);
  assert.ok(Math.abs(quarter.upperArmPitch) < 1e-9);
  // 全程有界
  for (let t = 0; t <= SIT_BREATH_PERIOD_MS; t += 25) {
    const breath = breathAt(t);
    assert.ok(Math.abs(breath.claviclePitch) <= SIT_BREATH_SHOULDER_RAD + 1e-9);
    assert.ok(Math.abs(breath.upperArmPitch) <= SIT_BREATH_SHOULDER_RAD + 1e-9);
  }
});

test('停帧不眨眼：帧里没有任何眼皮/眨眼字段（ADR 0046 D2）', () => {
  const motion = createSitMotion({ random: () => 0.5 });
  for (let t = 16; t <= 1200; t += 16) motion.update(t, 0.016, true);
  const frame = motion.frame();
  assert.ok(frame);
  const keys = Object.keys(frame as unknown as Record<string, unknown>);
  assert.ok(!keys.some((key) => /blink/i.test(key)), `不允许有眨眼字段：${keys.join(',')}`);
  assert.ok(!('blinkNow' in motion), '不允许有 blinkNow 接口');
});

test('晃腿：幅度 0.15–0.18rad（真机"晃得明显"），小腿跟随 ≥0.75，且只往抬的方向走', () => {
  assert.ok(SIT_LEG_THIGH_RAD >= 0.15 && SIT_LEG_THIGH_RAD <= 0.18, `thigh=${SIT_LEG_THIGH_RAD}`);
  assert.ok(SIT_LEG_CALF_RATIO >= 0.75, `calfRatio=${SIT_LEG_CALF_RATIO}`);
  assert.ok(Math.abs(SIT_LEG_CALF_RAD - SIT_LEG_THIGH_RAD * SIT_LEG_CALF_RATIO) < 1e-9);

  // t=0：左腿在低位（sin 包络 = 0）、右腿抬到最高（相位差 π）
  const a = legSwingAt(0, 1);
  assert.ok(Math.abs(a.thighPitchL) < 1e-9, `thighL=${a.thighPitchL}`);
  assert.ok(
    Math.abs(a.thighPitchR + SIT_LEG_THIGH_RAD * SIT_LEG_AMP_SKEW_R) < 1e-9,
    `thighR=${a.thighPitchR}`,
  );

  // 全程：thigh 只往"抬"的方向走（≤0）、幅度有界；calf 只往"折"的方向走（≥0）
  let maxThighL = 0;
  let maxThighR = 0;
  let maxCalf = 0;
  for (let t = 0; t <= 30000; t += 17) {
    const swing = legSwingAt(t, 1);
    assert.ok(swing.thighPitchL <= 1e-12 && swing.thighPitchR <= 1e-12, `t=${t} 不允许往下踢`);
    assert.ok(swing.calfPitchL >= -1e-12 && swing.calfPitchR >= -1e-12, `t=${t} 膝盖只往后折`);
    assert.ok(Math.abs(swing.thighPitchL) <= SIT_LEG_THIGH_RAD + 1e-9);
    assert.ok(Math.abs(swing.thighPitchR) <= SIT_LEG_THIGH_RAD * SIT_LEG_AMP_SKEW_R + 1e-9);
    assert.ok(Math.abs(swing.calfPitchL) <= SIT_LEG_CALF_RAD + 1e-9);
    assert.ok(Math.abs(swing.calfPitchR) <= SIT_LEG_CALF_RAD + 1e-9);
    maxThighL = Math.max(maxThighL, Math.abs(swing.thighPitchL));
    maxThighR = Math.max(maxThighR, Math.abs(swing.thighPitchR));
    maxCalf = Math.max(maxCalf, Math.abs(swing.calfPitchL));
  }
  // 幅度真的到了标称值（不是被包络吃掉一半）
  assert.ok(maxThighL > SIT_LEG_THIGH_RAD * 0.95, `maxThighL=${maxThighL}`);
  assert.ok(maxThighR > SIT_LEG_THIGH_RAD * SIT_LEG_AMP_SKEW_R * 0.95, `maxThighR=${maxThighR}`);
  // 小腿跟得很明显（≥ 大腿的 70%）
  assert.ok(maxCalf > SIT_LEG_THIGH_RAD * 0.7, `maxCalf=${maxCalf}`);

  const stopped = legSwingAt(1234, 0);
  assert.ok(Math.abs(stopped.thighPitchL) < 1e-12);
  assert.ok(Math.abs(stopped.thighPitchR) < 1e-12);
  assert.ok(Math.abs(stopped.calfPitchL) < 1e-12);
});

test('晃腿：左右**不对称**（速度 / 幅度 / 包络幂次），不是节拍器（ADR 0045 D3）', () => {
  // 参数层面：三项不对称都必须真的配上了
  assert.ok(SIT_LEG_RATE_SKEW > 0 && SIT_LEG_RATE_SKEW < 0.15, `rateSkew=${SIT_LEG_RATE_SKEW}`);
  assert.ok(SIT_LEG_AMP_SKEW_R > 0.8 && SIT_LEG_AMP_SKEW_R < 1, `ampSkew=${SIT_LEG_AMP_SKEW_R}`);
  assert.ok(Math.abs(SIT_LEG_LIFT_POWER_L - SIT_LEG_LIFT_POWER_R) > 0.05);
  assert.ok(SIT_LEG_CALF_LAG_RAD > 0.1 && SIT_LEG_CALF_LAG_RAD < 0.6, `lag=${SIT_LEG_CALF_LAG_RAD}`);

  // 行为层面：任何一帧左右都不是镜像（除非恰好过零）
  let asymmetricFrames = 0;
  let dominantLeft = 0;
  let dominantRight = 0;
  for (let t = 0; t <= 30000; t += 17) {
    const swing = legSwingAt(t, 1);
    const left = Math.abs(swing.thighPitchL);
    const right = Math.abs(swing.thighPitchR);
    if (Math.abs(left - right) > 0.004) asymmetricFrames += 1;
    if (left - right > 0.02) dominantLeft += 1;
    if (right - left > 0.02) dominantRight += 1;
  }
  assert.ok(asymmetricFrames > 1500, `asymmetricFrames=${asymmetricFrames}`);
  assert.ok(dominantLeft > 0 && dominantRight > 0, '两条腿都要各自当过一次"主导"');

  // 相位漂移：左右相位差不是恒定的 π（速度差会把它慢慢拉开）
  const phaseGap = (t: number): number => {
    const left = legSwingAt(t, 1).thighPitchL;
    const right = legSwingAt(t, 1).thighPitchR;
    return Math.abs(Math.abs(left) - Math.abs(right));
  };
  // 8 秒后两条腿的"谁更高"关系与起点不同（漂移发生了）
  const gapAt0 = phaseGap(0);
  const gapAt8s = phaseGap(8000);
  assert.ok(Math.abs(gapAt8s - gapAt0) > 0.01, `gap0=${gapAt0} gap8=${gapAt8s}`);

  // 小腿滞后：大腿到顶的瞬间，小腿还没到顶（≠ 焊死）
  const period = (2 * Math.PI) / (SIT_LEG_SWING_RAD_PER_SEC * (1 + SIT_LEG_RATE_SKEW));
  const peakMs = (period / 2) * 1000;
  const atPeak = legSwingAt(peakMs, 1);
  assert.ok(
    atPeak.calfPitchL < SIT_LEG_CALF_RAD * 0.999,
    `膝盖不该和大腿同相到顶：calf=${atPeak.calfPitchL}`,
  );
});

test('调度器：落座后包络软启动（0 → 1），呼吸/张望/眨眼都从 0 开始', () => {
  const motion = createSitMotion({ random: () => 0.5 });
  const start = motion.update(0, 0.016, true);
  // 第一帧 dt 无效（lastUpdateAt 未初始化）→ 包络仍是 0，不会"啪"地开始
  assert.equal(start.gain, 0);

  let frame = start;
  for (let t = 16; t <= 1200; t += 16) frame = motion.update(t, 0.016, true);
  assert.ok(frame.gain > 0.99, `gain=${frame.gain}`);
  assert.ok(Math.abs(frame.breathFloatPx) <= SIT_BREATH_FLOAT_PX + 1e-9);
  assert.ok(Math.abs(frame.gazeYaw) <= SIT_GAZE_YAW_RAD + 1e-9);
  assert.ok(Math.abs(frame.gazePitch) <= SIT_GAZE_UP_MAX_RAD + 1e-9);
  // 肩膀呼吸跟着包络一起开
  assert.ok(Math.abs(frame.claviclePitch) <= SIT_BREATH_SHOULDER_RAD + 1e-9);
  // 总包络走完后晃腿包络也该开启
  assert.ok(frame.legGain > 0.99, `legGain=${frame.legGain}`);
});

test('调度器：解除坐姿（active=false）时包络平滑退到 0，不清零跳变', () => {
  const motion = createSitMotion({ random: () => 0.5 });
  for (let t = 16; t <= 1200; t += 16) motion.update(t, 0.016, true);
  const before = motion.frame();
  assert.ok(before && before.gain > 0.99);

  // 淡出：SIT_MOTION_RAMP_MS 之后到 0，中间必须经过 (0,1)
  let t = 1200;
  let sawMiddle = false;
  for (let i = 0; i < 40; i += 1) {
    t += 16;
    const frame = motion.update(t, 0.016, false);
    if (frame.gain > 0.05 && frame.gain < 0.95) sawMiddle = true;
  }
  assert.ok(sawMiddle, '淡出必须经过中间值');
  const after = motion.frame();
  assert.ok(after && after.gain < 0.01);
  // 包络为 0 时所有叠加量都归零（浮点可能出现 -0，按绝对值判）
  assert.ok(Math.abs(after?.breathFloatPx ?? 1) < 1e-12);
  assert.ok(Math.abs(after?.gazeYaw ?? 1) < 1e-12);
  assert.ok(Math.abs(after?.thighPitchL ?? 1) < 1e-12);
  assert.ok(Math.abs(after?.claviclePitch ?? 1) < 1e-12);
});

test('自主张望：目标含抬头/低头、在 ±0.36 / +0.06 / -0.22 内，easeInOutCubic 干脆走完（ADR 0045 D2.2）', () => {
  const motion = createSitMotion({ random: seededRandom(20261104) });
  let t = 0;
  // 先让包络起来
  for (; t <= 1200; t += 16) motion.update(t, 0.016, true);
  let previous = motion.frame();
  assert.ok(previous);

  let maxStepPerFrame = 0;
  let targetChanges = 0;
  let lastTargetYaw = previous.targetYaw;
  let sawUp = false;
  let sawDown = false;
  /** 最近一次换目标：时刻 + 换之前的位置 + 新目标 */
  let transition: { at: number; fromYaw: number; fromPitch: number; toYaw: number; toPitch: number } | null =
    null;
  let settledBy: number | null = null;

  for (let i = 0; i < 60 * 60; i += 1) {
    t += 16;
    const frame = motion.update(t, 0.016, true);
    if (frame.targetYaw !== lastTargetYaw) {
      targetChanges += 1;
      lastTargetYaw = frame.targetYaw;
      assert.ok(Math.abs(frame.targetYaw) <= SIT_GAZE_YAW_RAD + 1e-9);
      assert.ok(frame.targetPitch <= SIT_GAZE_DOWN_MAX_RAD + 1e-9);
      assert.ok(frame.targetPitch >= -SIT_GAZE_UP_MAX_RAD - 1e-9);
      if (frame.targetPitch < -SIT_GAZE_UP_MIN_RAD) sawUp = true;
      if (frame.targetPitch > 0) sawDown = true;
      transition = {
        at: t,
        fromYaw: frame.gazeYaw,
        fromPitch: frame.gazePitch,
        toYaw: frame.targetYaw,
        toPitch: frame.targetPitch,
      };
      settledBy = null;
    }
    if (transition && settledBy === null) {
      // 换目标后 450ms（> 最大 move 420ms）必须已经精确到位 —— 指数阻尼做不到
      if (t - transition.at >= SIT_GAZE_MOVE_MAX_MS + 34) {
        const dy = Math.abs(frame.gazeYaw - transition.toYaw);
        const dp = Math.abs(frame.gazePitch - transition.toPitch);
        assert.ok(dy < 1e-6 && dp < 1e-6, `t=${t} 未在 450ms 内到位 dy=${dy} dp=${dp}`);
        settledBy = t;
      }
    }
    maxStepPerFrame = Math.max(
      maxStepPerFrame,
      Math.abs(frame.gazeYaw - (previous?.gazeYaw ?? 0)),
      Math.abs(frame.gazePitch - (previous?.gazePitch ?? 0)),
    );
    previous = frame;
  }
  // 60 秒里至少换 8 次方向（2.2–4.2s 保持 + 220–420ms 过渡）
  assert.ok(targetChanges >= 8, `targetChanges=${targetChanges}`);
  // 抬头和低头都出现过（"四处看"不是一直仰头）
  assert.ok(sawUp, '必须有抬头目标');
  assert.ok(sawDown, '偶尔也要低头看一眼');
  // 单帧最大转动远小于目标幅度：不是瞬移（easeInOutCubic 的最陡斜率 1.5，220ms 走完
  // 0.72rad 时单帧 ≈0.08rad；瞬移会是 0.72rad）
  assert.ok(maxStepPerFrame < SIT_GAZE_YAW_RAD * 0.3, `maxStepPerFrame=${maxStepPerFrame}`);
  // 但也不能"慢慢飘"：一次 0.36rad 的转头必须在 ~0.3s 内出现明显位移
  assert.ok(SIT_GAZE_MOVE_MIN_MS >= 200 && SIT_GAZE_MOVE_MAX_MS <= 450);
  assert.ok(SIT_GAZE_HOLD_MIN_MS >= 2000 && SIT_GAZE_HOLD_MAX_MS <= 5000);
});

test('异常入参：NaN / 负 dt / 乱序时钟不产生 NaN，也不抖动', () => {
  const motion = createSitMotion({ random: () => Number.NaN });
  let frame = motion.update(Number.NaN, Number.NaN, true);
  assert.ok(Number.isFinite(frame.gain));
  frame = motion.update(1000, -5, true);
  assert.ok(Number.isFinite(frame.gain));
  for (let t = 1000; t <= 3000; t += 16) {
    frame = motion.update(t, 1, true); // dt 被钳到 0.1
    assert.ok(Number.isFinite(frame.breathFloatPx));
    assert.ok(Number.isFinite(frame.gazeYaw));
    assert.ok(Number.isFinite(frame.eyeYaw));
    assert.ok(Number.isFinite(frame.thighPitchL));
  }
  assert.ok(Math.abs(frame.breathFloatPx) <= SIT_BREATH_FLOAT_PX + 1e-9);
  // 重置后回到"刚开始"的状态
  motion.reset(4000);
  const reset = motion.update(4016, 0.016, true);
  assert.equal(reset.gain, 0);
});
