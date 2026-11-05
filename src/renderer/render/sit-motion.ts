/**
 * 坐姿的"活体微动"（ADR 0044；节奏与幅度按 ADR 0045 D2/D3、ADR 0046 调整）。
 *
 * 纯数值，不引用 three、不读时钟，可脱离 WebGL 单测。
 *
 * 背景：坐姿姿态来自官方片段**停帧**（`playHold`），停帧之后片段里的呼吸、头发、眨眼
 * 全部冻结。于是"活感"全部由本模块给出，并且**与姿态解耦**：片段只提供骨架基线，
 * 这里只产出"叠加量"，由 `render-module` 通过骨骼仲裁器/根变换加上去。
 *
 * 四件事：
 * 1. **呼吸**：单根 3.6s 正弦，脊柱/颈 ±0.006rad、整体高低 ≤1px；
 * 2. **肩膀呼吸**（ADR 0045 D2.3）：锁骨 ±0.02rad、上臂同幅且相位略领先 ——
 *    停帧后肩线完全不动会让上半身像块板子；
 * 3. **自主张望**（ADR 0045 D2.2）：每 2.2–4.2s 换一个目标，用 **easeInOutCubic**
 *    在 220–420ms 内干脆地转过去；俯仰**偏向抬头**（负 pitch），因为片段自带低头；
 * 4. **悬空晃腿**（ADR 0045 D3）：±0.17rad、2.6rad/s，包络 `lift^0.66/0.82`
 *    （顶部变平 → 抬到位停一下再放下），左右**速度/幅度/包络幂次都不同**
 *    （左腿快 5%、高 11%），小腿带 0.32rad 的跟随滞后 —— 不再像节拍器。
 *
 * **没有眨眼**（ADR 0046 D2）：停帧下用 `bone_eye_D_*` 的平移手写眨眼会"翻白眼"
 * （下眼皮被硬拉上去），整套逻辑已删除；灵动感由呼吸 + 张望承担。
 *
 * 所有幅度/周期都在 `shared/constants.ts` 的「坐姿活体微动」段，方便调参。
 */
import {
  SIT_BREATH_FLOAT_PX,
  SIT_BREATH_NECK_RAD,
  SIT_BREATH_PERIOD_MS,
  SIT_BREATH_SHOULDER_RAD,
  SIT_BREATH_SPINE1_RAD,
  SIT_BREATH_SPINE_RAD,
  SIT_GAZE_DOWN_MAX_RAD,
  SIT_GAZE_EYE_EXTRA,
  SIT_GAZE_HOLD_MAX_MS,
  SIT_GAZE_HOLD_MIN_MS,
  SIT_GAZE_MOVE_MAX_MS,
  SIT_GAZE_MOVE_MIN_MS,
  SIT_GAZE_UP_CHANCE,
  SIT_GAZE_UP_MAX_RAD,
  SIT_GAZE_UP_MIN_RAD,
  SIT_GAZE_YAW_RAD,
  SIT_LEG_AMP_SKEW_R,
  SIT_LEG_CALF_LAG_RAD,
  SIT_LEG_CALF_RAD,
  SIT_LEG_LIFT_POWER_L,
  SIT_LEG_LIFT_POWER_R,
  SIT_LEG_PHASE_RAD,
  SIT_LEG_RAMP_MS,
  SIT_LEG_RATE_SKEW,
  SIT_LEG_SWING_RAD_PER_SEC,
  SIT_LEG_THIGH_RAD,
  SIT_MOTION_RAMP_MS,
} from '../../shared/constants';
import { easeInOutCubic } from './sit-pose';

export interface SitMotionFrame {
  /** 整体包络（0..1）：落座淡入、解除淡出；调用方所有量都要乘它 */
  gain: number;
  /** 呼吸带来的整体高低（px，正 = 向上），幅度 ≤ SIT_BREATH_FLOAT_PX */
  breathFloatPx: number;
  /** 呼吸的脊柱/颈旋转（rad，绕世界 X：正 = 低头） */
  spinePitch: number;
  spine1Pitch: number;
  neckPitch: number;
  /** 肩膀的呼吸起伏（rad，ADR 0045 D2.3）：锁骨 / 上臂，幅度 ±0.02 */
  claviclePitch: number;
  upperArmPitch: number;
  /** 当前视线（rad） */
  gazeYaw: number;
  gazePitch: number;
  /** 当前张望目标（rad，诊断用） */
  targetYaw: number;
  targetPitch: number;
  /** 眼球相对头部的额外量（rad，ADR 0046 D1：眼球基底已被重置为绑定姿态） */
  eyeYaw: number;
  eyePitch: number;
  /** 晃腿包络 0..1（带 SIT_LEG_RAMP_MS 的软启动） */
  legGain: number;
  /** 左右大腿/小腿的叠加旋转（rad，绕世界 X；左右**不再严格反相**，ADR 0045 D3） */
  thighPitchL: number;
  thighPitchR: number;
  calfPitchL: number;
  calfPitchR: number;
  /** 诊断：下一次换注视方向还有多久 */
  nextGazeInMs: number;
}

export interface SitMotionOptions {
  /** 注入随机源（测试用）；缺省 Math.random */
  random?: () => number;
  /** 起始时刻（ms）：通常传进入坐姿那一刻，用来把相位对齐到"刚开始呼吸" */
  startAt?: number;
}

export interface SitMotion {
  /**
   * 推进一帧。
   * @param nowMs 单调时钟（performance.now）
   * @param dtSeconds 距上一帧的秒数（用于阻尼缓动；NaN/负值按 0 处理）
   * @param active 是否处于"应该活着"的状态（落座后 true；解除后 false → 包络淡出）
   */
  update(nowMs: number, dtSeconds: number, active: boolean): SitMotionFrame;
  /** 最近一帧（诊断用；没跑过返回 null） */
  frame(): SitMotionFrame | null;
  /** 重置（重新落座时调用：相位归零、包络从 0 开始） */
  reset(nowMs: number): void;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 呼吸相位对应的量（纯函数，供单测直接驱动） */
export function breathAt(elapsedMs: number): {
  floatPx: number;
  spinePitch: number;
  spine1Pitch: number;
  neckPitch: number;
  claviclePitch: number;
  upperArmPitch: number;
} {
  const t = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const phase = (t / SIT_BREATH_PERIOD_MS) * Math.PI * 2;
  // 用 sin 的"正值段"当吸气：sin 在 [0,π] 为正 → 吸气，[π,2π] 为呼气。
  // 不取绝对值、不做平方，保证是**一条平滑曲线**（高频抖动是上一版被否的原因）。
  const s = Math.sin(phase);
  /**
   * 肩膀（ADR 0045 D2.3）：锁骨跟 sin 同相、上臂用 cos（相位领先 90°）。
   *
   * 为什么错开相位：肩和上臂如果同相，整条手臂像一块刚体在上下平移（读作"耸肩"）；
   * 错开 1/4 周期后，吸气时肩先起、手臂随后跟上，才像"呼吸带动"。
   */
  return {
    floatPx: s * SIT_BREATH_FLOAT_PX,
    spinePitch: s * SIT_BREATH_SPINE_RAD,
    spine1Pitch: s * SIT_BREATH_SPINE1_RAD,
    neckPitch: s * SIT_BREATH_NECK_RAD,
    claviclePitch: s * SIT_BREATH_SHOULDER_RAD,
    upperArmPitch: Math.cos(phase) * SIT_BREATH_SHOULDER_RAD,
  };
}

/** 晃腿相位对应的四条腿骨旋转（纯函数） */
export function legSwingAt(elapsedMs: number, gain = 1): {
  thighPitchL: number;
  thighPitchR: number;
  calfPitchL: number;
  calfPitchR: number;
} {
  const t = (Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0) / 1000;
  const g = clamp01(gain);
  /**
   * 为什么不是纯 `sin`（ADR 0044 D5）：
   *
   * 坐姿把**身体最低点钉在窗口底边**（`sitOffsetPx`），她的靴底正好贴着窗口下沿。
   * 纯正弦的"负半周"会把脚**甩到窗口外面**（被窗口裁掉），违反"微动不能破坏吸附锚点"。
   * 所以摆动只做在"抬起来"的方向上：`0.5 - 0.5·cos` 是 0→1→0 的单峰包络，
   * 左脚抬起、落下、右脚抬起、落下 —— 视觉上就是小女孩坐在高处交替晃腿，
   * 且**任何时刻都不会低于静止姿态**。
   *
   * ADR 0045 D3（本轮）：上一版左右完全对称、严格反相 → 读作"节拍器"。现在三处不对称：
   * 1. **速度**：左 = 基准 × 1.05、右 = 基准 × 0.95 —— 相位缓慢漂移，不会一直反相；
   * 2. **幅度/包络幂次**：左 0.17rad / k=0.66（快起快落、顶部更平），右 0.153rad / k=0.82；
   * 3. **小腿滞后** `SIT_LEG_CALF_LAG_RAD`：膝盖比大腿晚约 70ms 折起来，去掉"焊死"感。
   *
   * 小腿只往"折"的方向走（正 pitch），所以滞后不会让脚低于静止姿态。
   */
  const rateL = SIT_LEG_SWING_RAD_PER_SEC * (1 + SIT_LEG_RATE_SKEW);
  const rateR = SIT_LEG_SWING_RAD_PER_SEC * (1 - SIT_LEG_RATE_SKEW);
  const phaseL = t * rateL;
  const phaseR = t * rateR + SIT_LEG_PHASE_RAD;
  const lift = (phase: number, power: number): number =>
    (0.5 - 0.5 * Math.cos(phase)) ** power;
  const liftLeft = lift(phaseL, SIT_LEG_LIFT_POWER_L);
  const liftRight = lift(phaseR, SIT_LEG_LIFT_POWER_R);
  // 膝盖：同一条包络、滞后一点点
  const kneeLeft = lift(phaseL - SIT_LEG_CALF_LAG_RAD, SIT_LEG_LIFT_POWER_L);
  const kneeRight = lift(phaseR - SIT_LEG_CALF_LAG_RAD, SIT_LEG_LIFT_POWER_R);
  return {
    // 负 pitch = 腿往前抬（ADR 0035 D5 的标定）
    thighPitchL: -SIT_LEG_THIGH_RAD * liftLeft * g,
    thighPitchR: -SIT_LEG_THIGH_RAD * SIT_LEG_AMP_SKEW_R * liftRight * g,
    // 小腿正 pitch = 小腿往后折（膝盖弯）：抬腿时脚往回收，不会往下伸
    calfPitchL: SIT_LEG_CALF_RAD * kneeLeft * g,
    calfPitchR: SIT_LEG_CALF_RAD * SIT_LEG_AMP_SKEW_R * kneeRight * g,
  };
}

function randomIn(range: { min: number; max: number }, random: () => number): number {
  const r = sampleUnit(random);
  return range.min + r * (range.max - range.min);
}

/**
 * 取一个 [0,1] 的随机数；注入的随机源返回 NaN / ±Infinity / 越界时**钳到安全值**。
 *
 * 为什么必须在这里挡：调度器把随机数直接乘进角度（`(r*2-1)·YAW`），
 * 一个 NaN 会顺着 `gazeYaw` → 头骨四元数 → 整条渲染链一路传播
 * （单测 `异常入参` 就是按这个场景写的）。随机源是外部注入的，不能信。
 */
function sampleUnit(random: () => number): number {
  const sample = random();
  return Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
}

export function createSitMotion(options: SitMotionOptions = {}): SitMotion {
  const random = options.random ?? Math.random;

  let startedAt = Number.isFinite(options.startAt) ? (options.startAt as number) : Number.NaN;
  let lastUpdateAt = Number.NaN;
  let lastFrame: SitMotionFrame | null = null;

  /** 总包络（落座淡入 / 解除淡出），线性趋近，500ms 走完 */
  let gain = 0;
  /** 晃腿的子包络（比总包络更慢，600ms） */
  let legGain = 0;

  let gazeYaw = 0;
  let gazePitch = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  /** 本次转头从哪出发（easeInOutCubic 的起点） */
  let gazeFromYaw = 0;
  let gazeFromPitch = 0;
  let gazeMoveStartedAt = 0;
  let gazeMoveMs = 1;
  /** 是否已经排过一次张望（激活后的第一件事：立刻转一次，而不是先盯 3 秒） */
  let gazeStarted = false;
  let nextGazeAt = 0;

  function ensureStarted(nowMs: number): void {
    if (Number.isFinite(startedAt)) return;
    startedAt = nowMs;
    nextGazeAt = nowMs + randomIn({ min: SIT_GAZE_HOLD_MIN_MS, max: SIT_GAZE_HOLD_MAX_MS }, random);
  }

  /**
   * 选一个新的张望目标并开始一次"干脆的转头"（ADR 0045 D2.2）。
   *
   * 三条与旧实现的差别：
   * 1. **俯仰偏向抬头**：她坐的那一帧自带低头（14.5–14.7s），程序化量叠在低头之上，
   *    所以新目标以负 pitch（抬头）为主，偶尔才往下瞄一眼；
   * 2. **固定时长的 easeInOutCubic**：`SIT_GAZE_MOVE_MIN/MAX_MS` 内走完，不用指数阻尼；
   * 3. **到达之后再开始计时**下一轮（hold 从 `now + moveMs` 起算），不会"还没转过去就换目标"。
   */
  function pickGazeTarget(nowMs: number): void {
    gazeFromYaw = gazeYaw;
    gazeFromPitch = gazePitch;
    targetYaw = (sampleUnit(random) * 2 - 1) * SIT_GAZE_YAW_RAD;
    if (sampleUnit(random) < SIT_GAZE_UP_CHANCE) {
      // 抬头：负 pitch（与 `BoneArbiter` 的"正 = 低头"同口径）
      targetPitch = -(
        SIT_GAZE_UP_MIN_RAD +
        sampleUnit(random) * (SIT_GAZE_UP_MAX_RAD - SIT_GAZE_UP_MIN_RAD)
      );
    } else {
      targetPitch = sampleUnit(random) * SIT_GAZE_DOWN_MAX_RAD;
    }
    gazeMoveStartedAt = nowMs;
    gazeMoveMs = randomIn({ min: SIT_GAZE_MOVE_MIN_MS, max: SIT_GAZE_MOVE_MAX_MS }, random);
    nextGazeAt =
      nowMs + gazeMoveMs + randomIn({ min: SIT_GAZE_HOLD_MIN_MS, max: SIT_GAZE_HOLD_MAX_MS }, random);
  }

  /** 按 easeInOutCubic 把当前视线推到目标（每次 update 调用一次）。 */
  function stepGaze(nowMs: number): void {
    const p = clamp01((nowMs - gazeMoveStartedAt) / Math.max(1, gazeMoveMs));
    const eased = easeInOutCubic(p);
    gazeYaw = gazeFromYaw + (targetYaw - gazeFromYaw) * eased;
    gazePitch = gazeFromPitch + (targetPitch - gazeFromPitch) * eased;
  }

  function buildFrame(nowMs: number): SitMotionFrame {
    ensureStarted(nowMs);
    const elapsed = Math.max(0, nowMs - startedAt);

    const breath = breathAt(elapsed);
    const legs = legSwingAt(elapsed, legGain * gain);

    return {
      gain,
      breathFloatPx: breath.floatPx * gain,
      spinePitch: breath.spinePitch * gain,
      spine1Pitch: breath.spine1Pitch * gain,
      neckPitch: breath.neckPitch * gain,
      claviclePitch: breath.claviclePitch * gain,
      upperArmPitch: breath.upperArmPitch * gain,
      gazeYaw: gazeYaw * gain,
      gazePitch: gazePitch * gain,
      targetYaw,
      targetPitch,
      eyeYaw: gazeYaw * SIT_GAZE_EYE_EXTRA * gain,
      eyePitch: gazePitch * SIT_GAZE_EYE_EXTRA * gain,
      legGain,
      thighPitchL: legs.thighPitchL,
      thighPitchR: legs.thighPitchR,
      calfPitchL: legs.calfPitchL,
      calfPitchR: legs.calfPitchR,
      nextGazeInMs: Math.max(0, Math.round(nextGazeAt - nowMs)),
    };
  }

  return {
    update(nowMs: number, dtSeconds: number, active: boolean): SitMotionFrame {
      ensureStarted(nowMs);
      const dt = Number.isFinite(dtSeconds) ? Math.min(0.1, Math.max(0, dtSeconds)) : 0;
      if (Number.isFinite(lastUpdateAt) && dt > 0) {
        // 总包络：目标 1（active）或 0；SIT_MOTION_RAMP_MS 走完
        const target = active ? 1 : 0;
        const step = dt * 1000 / Math.max(1, SIT_MOTION_RAMP_MS);
        gain = target > gain ? Math.min(target, gain + step) : Math.max(target, gain - step);

        // 晃腿包络：只在"在坐 + 总包络已经开了大半"时才升，收尾更慢
        const legTarget = active && gain > 0.5 ? 1 : 0;
        const legStep = (dt * 1000) / Math.max(1, SIT_LEG_RAMP_MS);
        legGain =
          legTarget > legGain ? Math.min(legTarget, legGain + legStep) : Math.max(legTarget, legGain - legStep);

        /**
         * 自主张望（ADR 0045 D2.2）：
         * - **激活后立刻转一次**（`!gazeStarted`），不再"先盯 3 秒"；
         * - 之后每 `nextGazeAt` 到期换一个目标，用 `easeInOutCubic` 在 220–420ms 内走完；
         * - 绝不做瞬时赋值（`gazeYaw` 每帧从 `from` 插到 `target`）。
         */
        if (active && gain > 0.12 && (!gazeStarted || nowMs >= nextGazeAt)) {
          gazeStarted = true;
          pickGazeTarget(nowMs);
        }
        stepGaze(nowMs);
      }
      lastUpdateAt = nowMs;
      lastFrame = buildFrame(nowMs);
      return lastFrame;
    },

    frame(): SitMotionFrame | null {
      return lastFrame;
    },

    reset(nowMs: number): void {
      startedAt = nowMs;
      lastUpdateAt = Number.NaN;
      lastFrame = null;
      gain = 0;
      legGain = 0;
      gazeYaw = 0;
      gazePitch = 0;
      targetYaw = 0;
      targetPitch = 0;
      gazeFromYaw = 0;
      gazeFromPitch = 0;
      gazeMoveStartedAt = nowMs;
      gazeMoveMs = 1;
      gazeStarted = false;
      // 第一次张望由 `update()` 在激活时立刻排（不在这里等一个 HOLD 区间）
      nextGazeAt = nowMs;
    },
  };
}
