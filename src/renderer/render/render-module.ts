/**
 * render 模块（第 1/3 轮重建：骨架与加载）。
 *
 * 契约：§3.2（窗口/画布）、§3.3（掩膜 R-2/R-4/R-9）、§7.3（handleIntent / getState / modelReady）、
 * §11（缺失降级）；ADR 0009（GLB 加载、骨骼归一化、包围盒取景）、ADR 0010（口型/表情降级）、
 * ADR 0014（HFSM 三层与骨骼仲裁）、ADR 0023（官方片段）、ADR 0024（行走/回弹）、ADR 0026（表情贴图）。
 *
 * 本轮只做「装得起来、看得见、诊断对」：
 *   1. 渲染器 / 场景 / 正交相机 / 占位胶囊体 / 掩膜采集 / RAF 主循环；
 *   2. `model-loader` 加载 GLB（取景排除、配件隐藏、骨骼归一化名），失败回退占位体；
 *   3. `getState()` 与 `getDiagnostics()` 的完整字段（动画/表情相关先返回空值，第 2/3 轮接线）。
 *
 * 每帧固定顺序（ADR 0014 D1，第 2/3 轮补齐 2–5 步）：
 *   1. AnimationMixer.update → 2. 骨骼仲裁 beginFrame → 3. 视线叠加
 *   → 4. 反应叠加 → 5. 仲裁 endFrame → 6. Physics 根变换 → renderer.render
 */
import * as THREE from 'three';
import { DEFAULT_HIDE_ATTACHMENTS } from '../../shared/attachments';
import {
  DRAG_POSE_RAMP_MS,
  DRAG_RELEASE_POSE_FADE_MS,
  DRAG_SUPPORT_ACCEL_DEADBAND,
  DRAG_SUPPORT_ACCEL_EMA_MS,
  DRAG_SUPPORT_ACCEL_MAX,
  DRAG_SUPPORT_VELOCITY_EMA_MS,
  HEAD_PAT_RADIUS_RATIO,
  IDLE_MICRO_POOL,
  IDLE_TILT_HEAD_ROLL_RAD,
  IDLE_TILT_HEAD_YAW_RAD,
  IDLE_TILT_NECK_SHARE,
  IDLE_VARIATION_FADE_SECONDS,
  LANDING_DURATION_MS,
  LANDING_MAX_SQUASH,
  MASK_HEIGHT,
  MICRO_POOL_MAX_MS,
  MICRO_POOL_MIN_MS,
  MICRO_POOL_TRANSITION_RATE,
  MOUTH_FRAME_CLOSED,
  REBOUND_SETTLE_MS,
  SIT_BODY_YAW_RAD,
  SIT_CLIP_HOLD_SECONDS,
  SIT_CLIP_START_SECONDS,
  SIT_GAZE_EYE_EXTRA,
  SIT_HEAD_TUNE_RAD,
  SIT_PHASE_A_HEAD_TUNE_RAD,
  SIT_SPINE_OVERLAY_WEIGHT,
  SIT_MICRO_FAR_HEAD_PITCH_RAD,
  SIT_MICRO_FAR_HEAD_YAW_RAD,
  SIT_MICRO_FAR_LEG_SCALE,
  SIT_MICRO_FAR_SPINE_PITCH_RAD,
  SIT_MICRO_HANDS_HEAD_PITCH_RAD,
  SIT_MICRO_HANDS_HEAD_YAW_RAD,
  SIT_MICRO_HANDS_LEG_SCALE,
  SIT_MICRO_HANDS_SPINE_PITCH_RAD,
  SIT_MICRO_POOL,
} from '../../shared/constants';
import type { IdleMicroKind, SitMicroKind } from '../../shared/constants';
import type { BroadcastEvent } from '../../shared/events';
import { isIntent } from '../../shared/intents';
import { cssToMask, grabBandAt, headBandBottomRow } from '../../shared/mask';
import type { Bounds3 } from '../../shared/model-frame';
import { DEFAULT_FRAME_EXCLUDE } from '../../shared/model-frame';
import type { Emotion, Intent, RenderState } from '../../shared/types';
import { createModelAnimations } from './animation-controller';
import type { ActionStatus, AnimationSlot, ModelAnimations, OneShotStatus } from './animation-controller';
import { createBoneArbiter } from './bone-arbiter';
import type { BoneArbiter } from './bone-arbiter';
import type { ClipRole } from './clip-bank';
import { createDragPendulum, pivotCompensation, stepDragPendulum, struggleOffset } from './drag-motion';
import type { DragBand, DragPendulumState } from './drag-motion';
import { approach, walkYawFor, EMOTION_FACE, EMOTION_FADE_MS, fadeProgress, resolveMouthOwner } from './emotion-face';
import type { BlushLevel, EmotionFace, EyeAssetKey, MouthOwner, MouthShape } from './emotion-face';
import { loadExpressionAssets } from './expression-assets';
import type { ExpressionAssets, PixelImage } from './expression-assets';
import { collectFacialGeometry } from './facial-geometry';
import {
  CH0335_MOUTH_LAYOUT,
  createBlushChannel,
  createFacialChannel,
  loadMouthAtlas,
} from './facial-texture';import type {
  BlushChannel,
  FacialChannel,
  FacialChannelDiagnostics,
  MouthLayer,
  Rect,
} from './facial-texture';
import { createGazeController } from './gaze';
import type { GazeController, GazeState } from './gaze';
import { createHfsm, isPatReaction } from './hfsm';
import type { Hfsm, HfsmSnapshot, WalkPlan } from './hfsm';
import { createIdleVariation } from './idle-variation';
import type { IdleVariationSnapshot } from './idle-variation';
import { impactFromDownVelocity, landingPose } from './landing';
import { createMaskCapture } from './mask-capture';
import type { MaskCapture } from './mask-capture';
import {
  inspectMeshMaterials,
  replaceMaterialByName,
  restoreVertexColorDiagnostics,
  tintSkinVertices,
} from './material-diagnostics';
import type { MeshMaterialFacts } from './material-diagnostics';
import { loadModel, measureAnimatedMinY, measureAnimatedBounds, placeModel } from './model-loader';
import type { LoadedModel, ModelBones } from './model-loader';
import { createMicroPool } from './micro-pool';
import type { MicroPoolSnapshot } from './micro-pool';
import { createCapsulePlaceholder, PLACEHOLDER_BOTTOM_MARGIN_PX } from './placeholder';
import type { PlaceholderModel } from './placeholder';
import { createSitMotion } from './sit-motion';
import type { SitMotionFrame } from './sit-motion';
import { createSitDrop } from './sit-drop';
import { sitStageBBlend, sitStageBLocalSeconds } from './sit-sequence';
import { headTiltFromBind, headWorldPitch, headWorldYaw } from './sit-head';
import { sitPose } from './sit-pose';
import { startleDurationMs, startlePose } from './startle';
import type { StartleReason } from './startle';
import { ToonShading } from './toon-shading';
import type { ToonShadingDiagnostics } from './toon-shading';
import { OutlineSet } from './outline';
import type { OutlineDiagnostics } from './outline';

/** 契约 §7.3 / §12：同一 intent 200ms 内只执行一次。 */
export const INTENT_DEDUPE_MS = 200;

/** Base ↔ Physics 的交叉淡入（ADR 0014 D3.2）。 */
const DRAG_IN_CROSSFADE_SECONDS = 0.25;
const DRAG_OUT_CROSSFADE_SECONDS = 0.3;
/** 行走的进出淡入（ADR 0024 D1） */
const WALK_IN_FADE_SECONDS = 0.3;
const WALK_OUT_FADE_SECONDS = 0.35;
/** 回弹过程中从悬空姿态淡回 Idle（ADR 0024 D3） */
const SETTLE_FADE_SECONDS = 0.45;
/** 坐姿的进出淡入（ADR 0028 D8）：进 0.45s（片段本身也正"坐下去"），出 0.35s */
const SIT_IN_FADE_SECONDS = 0.45;
const SIT_OUT_FADE_SECONDS = 0.35;
/** 加载期"临时切到坐姿采样"用的淡入（不能是 0：three 的权重插值需要正时长） */
const CALIBRATION_FADE_SECONDS = 0.001;

/**
 * 官方片段接线表（ADR 0023 D2、ADR 0041 D3）：列出会用模型自带片段的 intent。
 * 没列出的（`shake_head` / `tilt_head` / `look_at_user` / `pat_react`）不走这张表。
 */
const INTENT_CLIP: Partial<Record<Intent, ClipRole>> = {
  greet: 'greet',
  nod: 'nod',
  happy_hop: 'happy',
};

interface ReactionSpec {
  durationMs: number;
  hopPx?: number;
  /** 整身绕 z 的倾角（rad）；`oscillate` 时是摆动幅度 */
  tilt?: number;
  /** 摆动型（摇头）而非保持型（歪头） */
  oscillate?: boolean;
  look?: number;
  /** 低头角度（rad，走骨骼仲裁；`nod` 用它替代整身 `scale.y`） */
  headPitch?: number;
}

/**
 * 非摸头的程序化反应：只用位移/旋转/骨骼偏移表达，不引入新状态名或 intent。
 *
 * 摸头**不在**这里（ADR 0039 D2）：它只播官方片段 + `shy` 表情投影，
 * 任何"为摸头服务的骨骼偏移 / `scale` / squash"都已删除。
 * `nod` 也从"整身竖向压扁"改成"头骨低头"——压扁是 `animationRoot.scale.y`，
 * 会连脚底一起缩，读起来就是"被按了一下"（同一个"生硬压缩"的毛病）。
 */
const REACTIONS: Record<Exclude<Intent, 'none' | 'pat_react'>, ReactionSpec> = {
  greet: { durationMs: 700, hopPx: 18, look: 0.18 },
  nod: { durationMs: 380, headPitch: 0.26 },
  shake_head: { durationMs: 460, tilt: 0.13, oscillate: true },
  tilt_head: { durationMs: 1400, tilt: 0.2 },
  look_at_user: { durationMs: 600, look: 0.22 },
  happy_hop: { durationMs: 720, hopPx: 34 },
};

/** 0..1 夹取（微动作池权重用；NaN / 越界一律当 0/1，绝不把 NaN 送进四元数）。 */
function unitWeight(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value as number));
}

/**
 * 摸头反应在**没有可用官方片段**时的表情窗口（毫秒）。
 * 它只决定 `reacting` 什么时候退出，不产生任何骨骼动作（ADR 0039 D4）。
 */
const PAT_FACIAL_FALLBACK_MS = 1100;

/** 加载成功但缺少这些骨骼时，按 §7.3 视为"骨骼缺失"整体回退（ADR 0009 D6）。 */
const REQUIRED_BONES = ['head', 'eyeL', 'eyeR'] as const;

/** 嘴型图集帧数（8×8；官方眼/嘴差分的 frameCount 参数）。 */
const MOUTH_FRAME_COUNT = CH0335_MOUTH_LAYOUT.columns * CH0335_MOUTH_LAYOUT.rows;

/**
 * 表情嘴型用的**官方图集帧**（High 图集 8×8，行优先）。全部来自
 * `Character_Mouth_High-BgFqI_9W.png`，不是画出来的（ADR 0046 D3.2 逐帧复核）：
 *   0 = 平直细线（抿嘴）/ 7 = 上扬小弧（微笑）/ 8 = 下垂弧（不满）/
 *   2 = 宽张（白齿，惊讶用）/ 9 = 圆张（**不再用**：会被看成"常驻微张"的小圆）。
 *
 * 为什么 `small` 从 9 改成 0：9 是一张**大圆张口**，在 0.62 底板宽下就是一个明显的
 * 小圆 —— 真机"嘴巴还是微张"就是这个（害羞/无表情时都挂在这里）。
 */
const EMOTION_MOUTH_FRAMES: Record<MouthShape, number> = {
  none: 0,
  smile: 7,
  frown: 8,
  open: 2,
  small: 0,
};



export interface AnimationDiagnostics {
  clipCount: number;
  clips: string[];
  idle: { name: string | null; reason: string; preferred: string };
  held: { name: string | null; reason: string; preferred: string };
  walk: { name: string | null; reason: string; preferred: string };
  current: { name: string | null; slot: string | null; time: number; weight: number; running: boolean };
  actions: { name: string; weight: number; time: number; running: boolean }[];
  groundCorrectionPx: number | null;
}

export interface PatDiagnostics {
  /** 是否有摸头反应在播（HFSM 的 reaction 未到期） */
  active: boolean;
  /** 本帧身体通道是否由官方片段接管（§5.3 的表：只有站着的 idle 才接管） */
  body: boolean;
  /** 官方片段名（裁剪后带时间窗后缀）；没播为 null */
  clip: string | null;
  /** 身体没接管的原因；null = 接管了，或压根没有摸头反应（ADR 0039 D4） */
  blockedBy: 'dragged' | 'settling' | 'sitting' | 'walking' | 'speaking' | 'missing' | null;
}

/**
 * 视线三级阻尼的**骨骼级**诊断（ADR 0049 D2；真机问题一取证）。
 *
 * 控制器里的 `spineYaw` 只是"提交量"，不代表骨骼真的转了。这里从
 * `BoneArbiter.animationBase(spine1)`（本帧动画基底）与 `spine1.quaternion`（本帧最终值）
 * 反解出实际写进骨骼的旋转，并投影到**世界 Y 轴**上 —— 这就是"Spine1 的实时 rotation.y"。
 */
export interface GazeBoneDiagnostics {
  /** 本帧 Spine1 实际被写入的偏航（rad，绕世界 Y 的分量） */
  spineYawRad: number;
  /** 同上，角度制（诊断面板直接看这个） */
  spineYawDeg: number;
  /** 旋转轴在世界 Y 上的分量（±1 附近 = 纯偏航；0 = 旋转在别的轴上） */
  axisY: number;
  /** 控制器本帧提交量（rad；与 `spineYawRad` 对照可判断"是不是被覆盖了"） */
  submittedYawRad: number;
}

export interface GazeDiagnostics extends GazeState {
  /** 骨骼真的转了多少；骨骼/仲裁器缺失时为 null */
  spineBone: GazeBoneDiagnostics | null;
}

/**
 * 微动作池的只读快照（ADR 0049 D1；内部诊断，不进 `RenderState`）。
 *
 * `weights` 是"每个条目当前淡入到多少"，调用方按它做交叉混合；`active` 是这一段时间
 * 抽中的主打条目。`holdRemainingMs` 是非默认条目的自动回正倒计时（-1 = 默认/强制）。
 * `forced` 只在自检取证时出现（生产路径恒为 null）。
 */
export interface MicroPoolDiag {
  active: string;
  weights: Record<string, number>;
  nextSwitchInMs: number;
  switches: number;
  /** 非默认条目到时/上下文失效 → 回到默认条目的次数 */
  releases: number;
  activeForMs: number;
  /** 距当前非默认条目自动回正还有多久（ms）；-1 = 默认条目 / 强制中 / 不设 hold */
  holdRemainingMs: number;
  forced: string | null;
}

/**
 * 头部区几何事实（内部诊断，**ADR 0039 排查用**）。
 *
 * 为什么需要它：`head_patted` 的入口是主进程的 `cmd:interactive.head`，而 `head` 由
 * **掩膜 alpha 包围盒顶部 22%** 推出（R-10）。本资产的光环（`HaloRoot` 的粉色方块）
 * 在掩膜里同样有不透明像素，会把包围盒顶部顶到光环上沿——头部带的实际下边界可能
 * 落在"头发上方"，于是点在脸上也判 `head=false`。这组事实就是用来量这条边界的。
 */
export interface HeadBandDiagnostics {
  maskState: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 降级口径的头部带下边界（掩膜行坐标） */
  bandBottomRow: number | null;
  /** 降级口径的头部带下边界（内容区 CSS y） */
  bandBottomCssY: number | null;
  /** 首选口径：头骨半径判定的圆心（内容区 CSS） */
  headBoneCss: { x: number; y: number } | null;
  /** 首选口径：半径（px）= HEAD_PAT_RADIUS_RATIO × 内容区高度 */
  headRadiusPx: number | null;
  /** 当前生效口径 */
  source: 'bone' | 'mask-bbox' | 'none';
  contentHeight: number;
  /** 当前停帧姿态的片段（sitting 会改变轮廓） */
  holdClip: string | null;
}

/**
 * 一次头部判定的结果（ADR 0040）。
 *
 * `source` 是诊断用的：`bone` = 头骨半径（首选），`mask-bbox` = R-10 的 22% 降级，
 * `none` = 两者都不可用（`head = null`，主进程保守丢弃，不判摸头）。
 */
export interface HeadSample {
  head: boolean | null;
  source: 'bone' | 'mask-bbox' | 'none';
}

/** 面部贴图通道诊断（ADR 0026 D4；不进 RenderState） */
export interface FacialDiagnostics {
  emotion: Emotion;
  effective: Emotion;
  eyes: string | null;
  mouthShape: MouthShape;
  mouthOwner: MouthOwner;
  blush: number;
  alpha: number;
  fading: boolean;
  repaints: number;
  lastRepaintMs: number | null;
  channel: {
    calibrated: boolean;
    eyeCalibrated: boolean;
    eyePixels: number;
    mouthPixels: number;
    textureDigest: string | null;
    faceDistance: number | null;
  } | null;
  blushChannel: {
    calibrated: boolean;
    mouthPixels: number;
    textureDigest: string | null;
    faceDistance: number | null;
  } | null;
  assets: {
    loadedEyes: string[];
    blushLoaded: boolean;
    missing: string[];
    eyeImageLabel: string | null;
  };
}

/**
 * 内部（ADR 0051）：极轻的坐姿两段式快照（自检 16ms 采样用，不含面部摘要）。
 */
export interface SitSequenceDiagnostics {
  stage: 'a' | 'b';
  /** 片段本地时间（秒；0 = 14.2s） */
  holdTimeSeconds: number | null;
  holdDurationSeconds: number | null;
  /** 阶段 B 覆盖权重 0..1（0.3s 淡入） */
  stageBBlend: number;
  /** 距阶段 B 开始多久（ms）；未到为 null */
  stageBInMs: number | null;
  /** 下坐弹簧 0..1 */
  sitDrop: number;
  /** 实际施加到补偿/姿态上的增益 = sitGain × sitDrop */
  sitPoseGain: number;
  /** 实际施加到上半身覆盖上的权重 = stageBBlend × sitPoseGain */
  upperOverride: number;
  /** ADR 0051 D7：阶段 A 抬头补偿的实际施加值（rad） */
  phaseAHeadAppliedRad: number;
  /** ADR 0051 D7：下背覆盖的配置值 / 实际权重 */
  spineOverlayWeight: number;
  spineOverlayApplied: number;
  headQuat: [number, number, number, number] | null;
  headWorld: { x: number; y: number } | null;
}

export interface RenderDiagnostics {
  ready: boolean;
  loading: boolean;
  error: string | null;
  modelId: string | null;
  loadMs: number | null;
  frame: Bounds3 | null;
  scene: Bounds3 | null;
  pixelsPerUnit: number | null;
  content: { width: number; height: number };
  bones: { head: string | null; eyeL: string | null; eyeR: string | null; pelvis: string | null };
  hasMorphTargets: boolean;
  meshNames: string[];
  materialNames: string[];
  hiddenMeshes: string[];
  triangles: number;
  mouth: {
    materialName: string | null;
    sourceTexture: string | null;
    atlasLoaded: boolean;
    calibrated: boolean;
  };
  gaze: GazeDiagnostics;
  animation: AnimationDiagnostics | null;
  /** 面部贴图通道（ADR 0026）；null = 未启用 */
  facial: FacialDiagnostics | null;
  hfsm: HfsmSnapshot;
  /** ADR 0024：行走 / 回弹状态 + ADR 0026 D1 的行走朝向 */
  motion: {
    base: string;
    physics: string | null;
    walking: { direction: string; distancePx: number } | null;
    nextWalkInMs: number | null;
    walkYaw: number;
    walkYawTarget: number;
  };
  /** ADR 0035：拖拽抓取点、受迫摆、落地分级（内部诊断，不进 `RenderState`） */
  drag: {
    phase: 'idle' | 'dragged' | 'settling';
    band: DragBand | null;
    /** 抓取点在内容区 CSS 坐标中的位置 */
    pivot: { x: number; y: number };
    angle: number;
    omega: number;
    gain: number;
    supportAcceleration: { x: number; y: number };
    landingImpact: number | null;
    /** 本帧实际减掉的 scale.y（0..0.08） */
    landingSquash: number;
    /** 最近一次落地冲击的 impact / 峰值压扁（缓冲只有 220ms，事后断言用） */
    lastLandingImpact: number;
    lastLandingSquash: number;
    /** 落地次数（自检确认"这一次"真的落地） */
    landingCount: number;
    startle: StartleReason | null;
  };
  /** ADR 0028：前台窗口吸附与坐姿（内部诊断，不进 `RenderState`） */
  sit: {
    sitting: boolean;
    /** ADR 0034：false = 接近阶段，true = 已落座 */
    arrived: boolean;
    /** ADR 0034：接近阶段的模式/时长/进度（未接近为 null） */
    approach: { mode: 'walk' | 'leap'; durationMs: number; progress: number } | null;
    /** 吸附在哪条边；未吸附为 null */
    edge: 'top' | 'bottom' | null;
    /** 官方坐姿片段缺失 → 程序化降级（下沉 + 弯腿） */
    procedural: boolean;
    /** 实际在播的坐姿片段名（裁剪后带时间窗后缀） */
    clip: string | null;
    /** ADR 0044 D1：`playHold` 停帧——true = 片段已经停在最后一帧 */
    done: boolean | null;
    /** ADR 0043 D2 的"循环坐姿"已在 ADR 0044 废止，恒为 false（字段保留只为不破坏诊断形状） */
    looping: boolean;
    /** ADR 0043 D3：坐姿混合权重 0..1（补偿与姿态共用这个插值因子） */
    blend: number;
    /** 坐姿片段自身的权重（程序化降级时 0） */
    clipWeight: number;
    dropPx: number;
    /** ADR 0042：坐下过渡（半蹲）的进度 0..1；过渡结束后恒为 1 */
    transition: number;
    /** ADR 0051：当前两段式阶段 */
    stage: 'a' | 'b';
    /** ADR 0051：阶段 B 上半身覆盖权重（0.3s 淡入） */
    stageBBlend: number;
    /** ADR 0051：下坐弹簧 0..1 */
    sitDrop: number;
    /** ADR 0051：实际施加到补偿/姿态上的增益（sitGain × sitDrop） */
    sitPoseGain: number;
    /** ADR 0051：实际施加到上半身覆盖上的权重（stageBBlend × sitPoseGain） */
    upperOverride: number;
    /** ADR 0051 D7：阶段 A 抬头补偿的配置值 / 实际施加值（rad） */
    phaseAHeadTuneRad: number;
    phaseAHeadAppliedRad: number;
    /** ADR 0051 D7：下背覆盖权重配置值 / 实际施加值 */
    spineOverlayWeight: number;
    spineOverlayApplied: number;
    /** ADR 0051：停帧基准（片段绝对秒，固定 16.2） */
    holdAtSeconds: number;
    /** ADR 0051：片段本地时间（秒；null = 没有 hold） */
    holdTimeSeconds: number | null;
    /** ADR 0042：坐下过渡本帧抬高的像素（14 → 0） */
    transitionLiftPx: number;
    /** 身体平移补偿（px）：抵消片段把角色搬去长椅的偏移 */
    offsetPx: { x: number; y: number };
    /** 片段给出的**原始**补偿量（未乘混合权重；诊断"要补多少"用） */
    rawOffsetPx: { x: number; y: number };
    /** ADR 0046 D3.1：当前微侧身偏航（rad，0 = 正面） */
    bodyYaw: number;
    /** ADR 0044：活体微动（呼吸 / 自主张望 / 晃腿）的当前值；未坐时 null */
    motion: {
      gain: number;
      breathPx: number;
      spinePitch: number;
      /** ADR 0045 D2.3：肩膀呼吸（锁骨 / 上臂，rad） */
      claviclePitch: number;
      upperArmPitch: number;
      gaze: {
        yaw: number;
        pitch: number;
        targetYaw: number;
        targetPitch: number;
        nextInMs: number;
      };
      /** ADR 0046 D1：眼球在头部张望之上的额外量（rad） */
      eye: { yaw: number; pitch: number };
      legs: { gain: number; thighL: number; thighR: number; calfL: number; calfR: number };
    } | null;
    /** ADR 0048 D2：当前人工微调量（rad，正 = 低头） */
    headTune: number;
    /** ADR 0048 D1：站立上半身姿态（下背/胸/颈/头的局部四元数）是否已记录 */
    idleUpperCaptured: boolean;
    /** 头骨**当前**相对绑定姿态的 pitch / yaw（含张望；用来判断"头有没有在动"） */
    headOrientation: { pitch: number; yaw: number } | null;
    /** ADR 0046 D1：眼球**当前**相对头骨的 pitch / yaw（含张望） */
    eyeOrientation: { pitch: number; yaw: number } | null;
    /** 头骨本地四元数（[x,y,z,w]，诊断"头在慢慢转"这类累积 bug 用） */
    headQuat: [number, number, number, number] | null;
    /** 头骨世界坐标（px，内容区坐标系） */
    headWorld: { x: number; y: number } | null;
    /** 骨骼仲裁器对头骨的最近一帧记录（基底来源 / 提交的偏移） */
    headBase: { baseFrom: 'mixer' | 'cache' | null; yaw: number; pitch: number; roll: number } | null;
  };
  pat: PatDiagnostics;
  /**
   * ADR 0050：待机静态站姿轮换（内部诊断，不进 `RenderState`）。
   * `Cafe_Reaction` 的一次性小动作已删除，这里只剩"当前站姿 / 下一次换姿势倒计时 / 次数"。
   */
  idleVariation: IdleVariationSnapshot;
  /**
   * ADR 0049 D1：微动作池（idle / sitting 各一个）。
   * `weights` 是每个条目当前交叉淡入的比例；`active` 是这一段时间抽中的主打条目。
   */
  microPool: { idle: MicroPoolDiag | null; sit: MicroPoolDiag | null };
  speech: { frame: number; driven: boolean };
  /** ADR 0037：全局光照 + Toon 材质（内部诊断，不进 `RenderState`） */
  toon: ToonShadingDiagnostics;
  /** ADR 0038：背面法描边（内部诊断，不进 `RenderState`） */
  outline: OutlineDiagnostics;
  /** ADR 0038：上一帧的 draw call / 三角形数与帧时间 EMA（"描边有没有拖慢"的可读口径） */
  render: { calls: number; triangles: number; frameMs: number };
  probePoints: { head: { x: number; y: number } | null; body: { x: number; y: number } | null };
}

export interface RenderModule {
  /** 命令：立即执行动作意图。未知值降级 `none` 并告警（契约 §4.4、§7.3）。 */
  handleIntent(intent: string): void;
  /** 事实拉取：同步返回，不得触发渲染或 IO（契约 §7.3）。 */
  getState(): RenderState;
  resize(width: number, height: number): void;
  dispose(): void;
  /** 内部：`cmd:probe` 的光标位置，用于视线跟随（不跨进程暴露） */
  setCursor(cssX: number, cssY: number, at?: number): void;
  /**
   * 内部（ADR 0035 D1）：`pointerdown` 的抓取事实。只留在渲染进程，
   * 不跨 IPC；在 `drag_started` 到达时消费。
   */
  noteGrabPoint(cssX: number, cssY: number, at?: number): void;
  /** 内部：语音播放器的口型驱动入口（ADR 0015 D4） */
  setMouthFrame(frame: number): void;
  /** 内部：交还闭嘴帧（`speech_ended` / 打断时调用） */
  resetMouthFrame(): void;
  /**
   * 内部（ADR 0047 取证）：在 `EyeMouth` 贴图上叠加准星探针。
   *
   * 判据（这就是本方法存在的唯一理由）：
   * - 准星正落在眼眶中心、瞳孔却偏下 → **贴图/UV** 问题，改画法（FaceDecal / UV 偏移）；
   * - 准星自己就偏出眼眶 → **骨骼/蒙皮**问题，改姿态。
   *
   * 返回值是标定出来的眼区矩形，便于把截图里的绿色方框对上号。
   */
  setEyeProbe(enabled: boolean): { eyeRects: Rect[]; texture: { width: number; height: number } } | null;  /**
   * 内部（ADR 0048 D2）：坐姿头部微调（rad，正 = 低头）。键盘 ↑/↓ 与自检都走这里。
   */
  setSitHeadTune(rad: number): number;  /**
   * 内部（ADR 0047 取证）：正交相机缩到脸上拍特写（`size` 是方框边长，CSS 像素；
   * `0` 关闭）。只改视锥，不改模型/姿态/材质。
   */
  setFaceZoom(size: number): { x: number; y: number; size: number } | null;
  /** 内部：`evt:broadcast` 的渲染侧入口（§6.3 白名单已由 preload 校验） */
  handleEvent(event: BroadcastEvent): void;
  /** 内部：自检/诊断用（不属于 §7.3） */
  getDiagnostics(): RenderDiagnostics;
  /**
   * 内部（ADR 0039 排查）：头部区几何事实——掩膜包围盒、头部带下边界、头骨位置。
   * 只读，不触发渲染；用来判断"点这里为什么不算摸头"。
   */
  headBandDiagnostics(): HeadBandDiagnostics;
  /**
   * 内部（契约 §3.3 R-10 / §3.5，ADR 0040）：判定某点是否落在头部区。
   *
   * 首选"以头骨为圆心、`HEAD_PAT_RADIUS_RATIO × 内容区高度`为半径"；
   * 头骨缺失或掩膜不可用时退回"掩膜 bbox 顶部 22%"（`maskHead` 由调用方传入，
   * 即 `cmd:probe` 的原始结果）。两者都不可用 → `head = null`。
   */
  headSampleAt(x: number, y: number, maskHead: boolean | null, hit: boolean): HeadSample;
  /** 内部：自检把 20–40s 的行走调度压到 1.5–2s */
  setWalkInterval(minIntervalMs: number, maxIntervalMs: number): void;
  /**
   * 内部（标定用，ADR 0035 D5）：给单根骨骼叠加一个持久偏移。
   * 用于确认 3ds Max 导出的骨骼"哪个方向是低头/抬手"，**不是**生产姿态入口。
   */
  setDebugBoneOffset(boneName: string, yaw: number, pitch: number, roll: number): boolean;
  clearDebugBoneOffsets(): void;
  listBones(): string[];
  /** 标定辅助：骨骼当前世界坐标（three 场景坐标） */
  getBoneWorld(boneName: string): { x: number; y: number; z: number } | null;
  /**
   * 内部（阶段 14 手部发白诊断）：
   * 遍历场景所有 SkinnedMesh，报告材质/贴图/色彩空间/手部顶点数。
   */
  inspectMaterials(): MeshMaterialFacts[];
  /** 内部（诊断）：把"手/小臂主导"的顶点临时染成指定颜色（保留贴图）。 */
  tintSkinVertices(
    scope: 'none' | 'hand' | 'both',
    color?: [number, number, number],
  ): { meshes: number; handVertices: number; forearmVertices: number };
  /** 内部（诊断）：把 Body 材质整体换成纯色，确认"手是不是在这块网格上"。 */
  testHandMaterial(color?: number): { materialName: string; meshes: string[] } | null;
  /**
   * 内部（诊断/截图对照，ADR 0037）：开/关全局光照 + Toon。
   * 关闭 = 摘灯 + 还原原始无光照 `MeshBasicMaterial`（= 本轮修改前的样子）。
   */
  setToonShading(enabled: boolean): ToonShadingDiagnostics;
  /**
   * 内部（诊断/截图对照，ADR 0038）：开/关背面法描边。
   * 关闭 = 隐藏所有描边壳（模型本身不动、材质不动）。
   */
  setOutline(enabled: boolean): OutlineDiagnostics;
  /**
   * 内部（诊断，ADR 0038 任务二）：把光环临时换成 `MeshToonMaterial`，
   * 用来判断"发光体吃光会不会变脏"。返回是否找到光环网格。
   */
  setHaloToon(enabled: boolean): { enabled: boolean; meshes: string[]; material: string | null };
  /** 内部（诊断）：恢复材质与顶点色。 */
  resetMaterialDiagnostics(): void;
  /** 内部（诊断）：双手骨骼在内容区 CSS 坐标里的位置（用于截图取样）。 */
  handScreenPoints(): { left: { x: number; y: number } | null; right: { x: number; y: number } | null } | null;
  /**
   * 内部（诊断/取证，ADR 0044）：**只读、极轻**的坐姿微动快照。
   *
   * 为什么单独开一个：`getDiagnostics()` 单次约 300ms（含面部贴图摘要），
   * 而张望/晃腿的瞬态变化只有几百毫秒。这个接口只返回
   * `sit-motion` 的一帧数值，供自检以 ~16ms 间隔连续采样。
   */
  sitMotionDiagnostics(): SitMotionFrame | null;
  /** 内部（ADR 0051）：极轻的坐姿两段式快照（阶段 / 弹簧 / 头骨） */
  sitSequenceDiagnostics(): SitSequenceDiagnostics;
  /** 内部（ADR 0051，自检取证）：立刻把张望目标切到 camera / wander */
  forceSitGaze(kind: 'camera' | 'wander'): 'camera' | 'wander';
  /**
   * 内部（ADR 0049 D2）：**只读、极轻**的视线三级阻尼快照（不含面部贴图摘要）。
   * 自检要以 16ms 间隔采样"眼球 / 头部 / 躯干"的时间差，`getDiagnostics()` 太慢。
   * `spineBone` 是本帧 **Spine1 骨骼实际被写入**的偏航（真机问题一取证）。
   */
  gazeDiagnostics(): GazeDiagnostics | null;
  /** 内部（ADR 0049 D1）：两个微动作池的只读快照（同样不走 `getDiagnostics` 的面部摘要） */
  microPoolDiagnostics(): { idle: MicroPoolDiag | null; sit: MicroPoolDiag | null };
  /**
   * 内部（ADR 0049 D1，自检取证）：强制某个池的条目（`null` = 解除）。
   * 非法条目名被忽略并返回 null；**不是**生产接口，不进 IPC。
   */
  forceMicroPool(pool: 'idle' | 'sit', kind: string | null): string | null;
  /** 内部（ADR 0049 D1，自检压缩时序）：覆盖池的切换间隔（ms） */
  setMicroPoolInterval(pool: 'idle' | 'sit', minIntervalMs: number, maxIntervalMs: number): void;
  /** 内部（ADR 0050）：待机静态站姿轮换的只读快照 */
  idleVariationDiagnostics(): IdleVariationSnapshot;
  /** 内部（ADR 0050，自检取证）：强制下一个 tick 换到某个站姿（`null` = 解除） */
  forceIdleVariation(role: ClipRole | null): ClipRole | null;
  /** 内部（ADR 0050，自检压缩时序）：覆盖站姿轮换间隔（ms） */
  setIdleVariationInterval(minIntervalMs: number, maxIntervalMs: number): void;
}

export interface RenderModuleOptions {
  /** 取景排除正则（与主进程同一份，经 loadFile query 传入） */
  frameExclude?: string;
  /** 装配期配件隐藏正则（ADR 0014 D5；缺省与取景排除同源） */
  hideAttachments?: string;
  /** 模型标识（文件名），用于 `model_ready` */
  modelId?: string;
  /** 加载成功且首帧已渲染后回调一次；由渲染页负责发出 model_ready */
  onModelReady?: (payload: { modelId: string; loadMs: number }) => void;
  /** ADR 0024 D5：把"要往哪边走"转成 `cmd:walk` */
  onWalkRequest?: (command: {
    phase: 'start';
    direction: 'left' | 'right';
    distancePx: number;
  }) => void;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pickNearestPoint(
  point: { x: number; y: number },
  candidates: Array<{ x: number; y: number } | null>,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const d = distance(point, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

class StageRender implements RenderModule {  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  /** ADR 0047 取证：>0 时正交视锥缩成这么大的方框并跟随头骨（0 = 正常铺满窗口） */
  private faceZoomSize = 0;
  /** Physics/Overlay 的位移与旋转挂在这里；它的原点 = 内容区底边中心（脚底） */
  private readonly animationRoot = new THREE.Group();
  private readonly options: RenderModuleOptions;

  private placeholder: PlaceholderModel | null;
  private model: LoadedModel | null = null;
  private readonly hfsm: Hfsm;
  private animations: ModelAnimations | null = null;
  private arbiter: BoneArbiter | null = null;
  private gaze: GazeController | null = null;
  /** 当前行走计划（`walking` 期间非空） */
  private walkingPlan: WalkPlan | null = null;

  /** ADR 0028 D5/D8：吸附（`sitting`）与坐姿 */
  private sitting = false;
  /** ADR 0034：false = 接近阶段，true = 已落座 */
  private sitArrived = false;
  private sitStartedAt = 0;
  /** ADR 0034：接近阶段的播放信息（诊断用，不进 RenderState） */
  private sitApproach: { mode: 'walk' | 'leap'; durationMs: number; startedAt: number } | null = null;
  /** 官方坐姿片段缺失 → 程序化降级（悬空姿态下沉 + 大腿弯曲） */
  private sitProcedural = false;
  private sitEdge: 'top' | 'bottom' | null = null;
  /**
   * ADR 0043 D3：坐姿混合权重（0..1）。**所有**坐姿相关量（身体平移补偿、下沉、呼吸、
   * 重心偏移、后倾、大腿弯曲）都乘它，所以进场/退场与片段的交叉淡入同步，不会硬切。
   */
  private sitGain = 0;
  /**
   * ADR 0051：下坐弹簧（0 → 1）。所有坐姿补偿/姿态/覆盖都乘它。
   *
   * 它和 `sitGain` 是两件事：`sitGain` 是片段交叉淡入的权重（站位↔坐姿），
   * `sitDrop` 是"落座"本身（座面上方 → 座面）。两者相乘才是最终施加量。
   */
  private readonly sitDropSpring = createSitDrop();
  /**
   * ADR 0051：阶段 B 的开始时刻（`performance.now`）；null = 还在阶段 A。
   *
   * 片段本地 1.8s（绝对 16.0s）时置位；从这一刻起用 0.3s 淡入站立上半身覆盖
   * 与程序化微动。片段继续播到本地 2.0s（绝对 16.2s）后 clamp 停帧。
   */
  private sitStageBStartedAt: number | null = null;
  /** ADR 0051：阶段 B 覆盖权重 0..1（`sitStageBBlend` 的输出） */
  private sitStageBGain = 0;
  /** ADR 0051：本帧实际施加的坐姿增益（sitGain × sitDrop；诊断用） */
  private sitPoseGain = 0;
  /** ADR 0051：本帧实际施加的上半身覆盖权重（stageB × sitPoseGain；诊断用） */
  private sitUpperOverride = 0;
  /** ADR 0051 D7：阶段 A 抬头补偿的**实际施加量**（rad；已乘 phaseA 权重） */
  private sitPhaseAHeadApplied = 0;
  /** ADR 0051 D7：下背覆盖的**实际权重**（upperOverride × SIT_SPINE_OVERLAY_WEIGHT） */
  private sitSpineOverlay = 0;
  /** 坐姿角色此刻的权重（诊断用；程序化降级时恒为 0） */
  private sitRoleWeight = 0;
  /** 程序化降级路径的替代包络（没有片段权重可用时） */
  private sitFallbackGain = 0;
  /** 是否处于"坐姿会话"里（落座后置 true，补偿完全退到 0 后置 false；标定期必须是 false） */
  private sitPoseActive = false;
  /**
   * ADR 0044：坐姿活体微动（呼吸 / 自主张望 / 悬空晃腿）。
   * 纯数值控制器，每帧产出一组"叠加量"，由 `applySitMotion()` 提交给骨骼仲裁器。
   */
  private readonly sitMotion = createSitMotion();
  /**
   * ADR 0049 D1：两个**微动作池**（纯调度器，不引用 three）。
   *
   * - idle 池：`browse`（现有待机）× 3 : `headTilt`（偶尔歪头）× 1；
   * - sitting 池：`legs`（现有晃腿）× 3 : `hands`（低头看手）× 1 : `far`（抬头看远处）× 1。
   *
   * 池只负责"这一段时间主打哪个条目 + 每个条目淡入到多少"，具体姿态在
   * `updateFrame`（idle 歪头）与 `applySitMotion`（坐姿变奏）里按权重相加。
   * 换条目由池内的 15–30s 抽签驱动，过渡用同一套指数插值 —— 不新增状态。
   */
  private readonly idlePool = createMicroPool<IdleMicroKind>({
    entries: IDLE_MICRO_POOL,
    minIntervalMs: MICRO_POOL_MIN_MS,
    maxIntervalMs: MICRO_POOL_MAX_MS,
    transitionRatePerSecond: MICRO_POOL_TRANSITION_RATE,
  });
  private readonly sitPool = createMicroPool<SitMicroKind>({
    entries: SIT_MICRO_POOL,
    minIntervalMs: MICRO_POOL_MIN_MS,
    maxIntervalMs: MICRO_POOL_MAX_MS,
    transitionRatePerSecond: MICRO_POOL_TRANSITION_RATE,
  });
  /**
   * 绑定姿态下头骨的世界朝向（模型加载时、`setupAnimations()` 之前采一次）。
   * 仅供 `headOrientation`（相对绑定，量"头有没有在动"）使用；**不再参与坐姿姿态补偿**。
   */
  private headBindWorld: THREE.Quaternion | null = null;
  /**
   * 绑定姿态下眼球的**本地**四元数（ADR 0046 D1）。
   *
   * 坐姿停帧后眼骨不再被 Mixer 驱动，片段里那份"向下看"会永远留着。把眼球的旋转基底
   * 换成这个值（平视），再叠张望 —— 眼球回到绑定姿态并跟着头转，死鱼眼消失。
   * 左右眼在绑定姿态下朝向一致，共用一个值。
   */
  private eyeBindLocal: THREE.Quaternion | null = null;
  /**
   * ADR 0048 / ADR 0051：**站立待机时上半身四根骨骼的局部四元数**（下背 / 胸 / 颈 / 头）。
   *
   * 这是"平视的答案"——站姿是她看镜头的样子，玩家已经认可。
   * 坐姿停帧后直接把这三个值**覆盖**上去（不叠任何偏移），上半身的相对姿态就和站立一致。
   */
  private idleUpperLocals: {
    spine: THREE.Quaternion | null;
    chest: THREE.Quaternion | null;
    neck: THREE.Quaternion | null;
    head: THREE.Quaternion | null;
  } | null = null;
  /**
   * ADR 0048 D2：坐姿头部的**人工微调**（rad，正 = 低头）。
   *
   * 来源不是公式，而是键盘 ↑/↓ 现场调出来的一个数，再把调好的值写死成默认值。
   * 会随 `sitGain` 淡入。
   */
  private sitHeadTune = SIT_HEAD_TUNE_RAD;
  /** 当前坐姿的**微侧身**偏航（rad，ADR 0046 D3.1；`SIT_BODY_YAW_RAD × sitGain`） */
  private sitBodyYaw = 0;
  /**
   * ADR 0028 D8：坐姿片段的**身体包围盒**（root 局部单位，加载时采一次）。
   * 回忆片段把角色搬到长椅上（身体 cx≈-0.0035、minY≈+0.0058 单位），直接用会让她
   * 悬在窗口左上角；这里把测量值换算成像素补偿："身体中心 → 窗口中线、最低点 → 窗口底边"。
   */
  private sitBounds: { minX: number; maxX: number; minY: number } | null = null;
  /** 光环相对头骨的偏移（光环不在骨骼层级里，必须每帧手动跟随头骨） */
  private haloOffset: THREE.Vector3 | null = null;
  private readonly haloHeadWorld = new THREE.Vector3();

  /** 内部接口：掩膜采集（由 RenderBundle 持有，不属于 §7.3） */
  readonly maskCapture: MaskCapture;

  private readonly startedAt = performance.now();
  private frameHandle: number | null = null;
  private width = 0;
  private height = 0;
  private lastFrameAt = performance.now();
  /** 帧时间 EMA（ms，α=0.05；ADR 0038 性能口径） */
  private frameMsEma = 16.7;

  private readonly lastIntentAt = new Map<string, number>();
  private emotion: Emotion = 'neutral';

  /** Idle 姿态下可见网格的最低点（root 局部单位）；null = 未校正 */
  private groundMinYLocal: number | null = null;

  /** ADR 0026 D1：行走朝向（rad）与目标 */
  private walkYaw = 0;
  private walkYawTarget = 0;

  /** 非 pat_react 的程序化反应（视觉），与 HFSM 的 reacting 同源计时 */
  private reaction: { spec: ReactionSpec; startedAt: number } | null = null;
  private dragStartedAt: number | null = null;
  private dragging = false;

  /** ADR 0035：待定抓取事实（pointerdown 记录，drag_started 消费） */
  private pendingGrab: { band: DragBand; cssX: number; cssY: number; at: number } | null = null;
  private dragBand: DragBand = 'body';
  private dragPendulum: DragPendulumState = createDragPendulum();
  /** 抓取点在 animationRoot 局部坐标中的位置（绕它旋转） */
  private dragPivot = { x: 0, y: 0 };
  /** 抓取点在内容区 CSS 坐标中的位置（诊断/标定用） */
  private dragPivotCss = { x: 0, y: 0 };
  /** 姿态增益：拖拽淡入、松手淡出 */
  private dragPoseGain = 0;
  /** 本帧实际提交给根节点的摆角（诊断用） */
  private dragAngle = 0;
  /** 支撑点（窗口 screenX/Y）的运动滤波 */
  private supportSample: { x: number; y: number; at: number } | null = null;
  private supportVelocity = { x: 0, y: 0 };
  private supportAcceleration = { x: 0, y: 0 };
  /** settling 期间窗口向下的峰值速度（px/s），用于落地分级 */
  /**
   * 松手瞬间的竖直速度（px/s，+y 向下）。落地冲击的唯一输入（ADR 0040 D3）。
   * 原实现用 settling 期间窗口向下峰值速度，自由落体时必然饱和，已废弃。
   */
  private releaseDownVelocity = 0;
  /** 落地缓冲：motion_ended{settle} 之后的一段短姿态 */
  private landing: { startedAt: number; impact: number } | null = null;
  /** 本帧实际减掉的 scale.y（诊断用） */
  private landingSquash = 0;
  /** 惊跳起身：snap_released 之后的一段短姿态（不新增状态） */
  private startle: { reason: StartleReason; startedAt: number; durationMs: number } | null = null;
  /** 惊跳把表情临时投影为 surprised（ADR 0034 D5） */
  private startleSurprised = false;

  /** 标定用：单根骨骼的持久偏移（ADR 0035 D5，不是生产姿态入口） */
  private readonly debugBoneOffsets = new Map<string, { yaw: number; pitch: number; roll: number }>();
  /** ADR 0037：全局光照 + Toon（身体/头发）；灯在构造时挂上，材质在模型加载后替换 */
  private readonly toon: ToonShading;
  /** ADR 0038：背面法描边（身体/头发/脸）；同样在模型加载后装配 */
  private readonly outline: OutlineSet;
  /** 诊断（ADR 0038 任务二）：光环临时换成 Toon 的原始材质句柄 */
  private haloToonRestore: Map<THREE.Mesh, THREE.Material | THREE.Material[]> | null = null;
  /** 诊断用：Body 材质替换的恢复句柄 */
  private diagnosticMaterialRestore: (() => void) | null = null;
  /** 上一次看到的摸头反应状态（只在它变化时重画表情；applyFacial 是事件驱动的） */
  private lastPatActive = false;
  /** ADR 0039 排查：摸头片段启动后 150ms 的一次权重回报（时间戳；null = 不查） */
  private patWeightCheckAt: number | null = null;
  /** 落地缓冲的峰值压扁（诊断"拖完弹一下"到底是不是它） */
  private landingPeakSquash = 0;
  /** 最近一次落地冲击的 impact 与峰值压扁（取证用：缓冲只有 220ms，诊断读不到时靠它） */
  private lastLandingImpact = 0;
  private lastLandingSquash = 0;
  /** 落地次数（自检用来确认"这一次"真的落地了，而不是读到上一次的留存值） */
  private landingCount = 0;
  /**
   * ADR 0050：待机**静态站姿轮换**调度器（纯逻辑在 `idle-variation.ts`）。
   *
   * 它只回答"现在该不该换、换成谁"；换姿势仍走 `animation-controller.playRole()`
   * 的 0.8s 交叉淡入。不是新状态：`getState().base` 恒为 `idle`。
   */
  private readonly idleVariation = createIdleVariation();
  /** 语音口型（ADR 0015 D4）：帧号由播放器按包络推进 */
  private lipSyncFrame = MOUTH_FRAME_CLOSED;
  private lipSyncDriven = false;

  /** EyeMouth 贴图通道：官方眼型差分 + 表情嘴型 + 图层仲裁后的重绘（ADR 0026 D3/D6） */
  private facial: FacialChannel | null = null;
  /** Face 贴图通道：红晕（与眼睛/嘴不是同一张贴图） */
  private blushChannel: BlushChannel | null = null;
  /** 官方表情差分（`data/expressions/`）；缺失项置空并降级，不阻断 */
  private expressions: ExpressionAssets | null = null;
  private atlasLoaded = false;
  /** 表情淡入起点；emotion 变化时重置 */
  private emotionFadeStartedAt = 0;
  /** 上一次实际生效的 emotion（判断是否需要重新开始淡入） */
  private appliedEmotion: Emotion = 'neutral';
  private facialRepaints = 0;
  private facialLastRepaintMs: number | null = null;
  /** 上一次重绘的状态指纹（避免无变化时重复上传贴图） */
  private facialKey = '';


  private ready = false;
  private loading = true;
  private error: string | null = null;
  private readyPending = false;

  constructor(canvas: HTMLCanvasElement, options: RenderModuleOptions = {}) {
    this.options = options;
    this.hfsm = createHfsm({ patDurationMs: 1100 });

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      // 契约 §3.3 R-2 / §3.6 P-2：禁止开启 preserveDrawingBuffer
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x00000000, 0);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);

    // 正交相机：内容区 1 CSS px = 1 世界单位（ADR 0009 D4）
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera.position.z = 100;
    this.scene.add(this.animationRoot);

    // ADR 0037：全局光照（主方向光 + 极低环境光）+ 3 阶 Toon 色阶。
    // 这里只建灯与渐变贴图；材质替换发生在模型加载完成之后（`attachToon`）。
    this.toon = new ToonShading(this.scene);
    // ADR 0038：描边材质也只建一次（所有描边网格共享），装配在模型加载之后
    this.outline = new OutlineSet();

    this.placeholder = createCapsulePlaceholder();
    this.animationRoot.add(this.placeholder.group);

    this.maskCapture = createMaskCapture({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
    });
    this.maskCapture.start();

    this.frameHandle = requestAnimationFrame(this.handleFrame);
    void this.loadRealModel();
  }

  private async loadRealModel(): Promise<void> {
    try {
      const loaded = await loadModel({
        modelId: this.options.modelId ?? 'model',
        frameExclude: this.options.frameExclude ?? DEFAULT_FRAME_EXCLUDE,
        hideAttachments: this.options.hideAttachments ?? DEFAULT_HIDE_ATTACHMENTS,
        contentHeight: Math.max(1, this.height),
      });

      const missing = REQUIRED_BONES.filter((key) => !loaded.bones[key]);
      if (missing.length > 0) {
        loaded.dispose();
        throw new Error(
          `骨骼缺失：${missing.join(', ')}（§7.3：modelReady=false，回退占位胶囊体）`,
        );
      }

      this.model = loaded;

      // ADR 0037：身体/衣服 + 头发换成 MeshToonMaterial（3 阶硬边色阶），面部保持无光照。
      // ADR 0036 的"手/小臂顶点色烘焙"在此废止：手现在像其它部位一样接受真光照。
      const toonCount = this.toon.attach(loaded.root);
      const toonDiagnostics = this.toon.diagnostics();
      console.log(
        `[render] Toon 光照已启用（ADR 0037） materials=${toonCount} ` +
          `meshes=${toonDiagnostics.litMeshes.join('|') || '(none)'} ` +
          `steps=[${toonDiagnostics.gradientSteps.join(',')}] ` +
          `ambient=${toonDiagnostics.ambient} directional=${toonDiagnostics.directional}`,
      );

      // ADR 0038：背面法描边（身体/头发/脸）。必须放在 Toon 之后——按材质名挑目标，
      // 而 Toon 是"换材质"不是"改名字"，顺序其实无所谓，但放在这里可以保证
      // 描边读到的是最终材质。描边壳共享同一 Skeleton，跟着骨骼一起动。
      const outlineCount = this.outline.attach(loaded.root);
      const outlineDiagnostics = this.outline.diagnostics();
      console.log(
        `[render] 描边已启用（ADR 0038） meshes=${outlineCount} ` +
          `sources=${outlineDiagnostics.sources.join('|') || '(none)'} ` +
          `width=${outlineDiagnostics.width}px color=${outlineDiagnostics.color} ` +
          `depthBias=${outlineDiagnostics.depthBias}`,
      );

      if (this.placeholder) {
        this.animationRoot.remove(this.placeholder.group);
        this.placeholder.dispose();
        this.placeholder = null;
      }
      this.animationRoot.add(loaded.root);
      this.applyPlacement();
      /**
       * ADR 0045 D2.1：采"绑定姿态"的头骨世界朝向作为**平视参照**。
       * 必须在 `setupAnimations()` 之前：之后 Mixer 就开始写骨骼，绑定姿态就没了。
       * 之后所有"她低了多少头"都相对这一帧计算（骨骼 rest 朝向是任意的，
       * 绝对欧拉角不能用，见 `sit-head.ts`）。
       */
      loaded.root.updateMatrixWorld(true);
      this.headBindWorld = loaded.bones.head
        ? loaded.bones.head.getWorldQuaternion(new THREE.Quaternion())
        : null;
      // ADR 0046 D1：眼球的绑定姿态本地旋转（坐姿把它当旋转基底，回到"平视"）
      const bindEye = loaded.bones.eyeL ?? loaded.bones.eyeR;
      this.eyeBindLocal = bindEye ? bindEye.quaternion.clone() : null;
      console.log(
        `[render] 绑定姿态基准 head=${this.headBindWorld ? 'ok' : '-'} ` +
          `eye=${this.eyeBindLocal ? 'ok' : '-'}（ADR 0045 D2.1 / ADR 0046 D1）`,
      );

      this.setupAnimations(loaded);
      this.calibrateGround();
      this.calibrateHalo();
      this.calibrateSitPose();

      this.arbiter = createBoneArbiter();
      // 所有会接收程序化偏移的骨骼都登记进来（ADR 0035：悬挂/落地/坐姿/惊跳）
      for (const bone of Object.values(loaded.bones)) {
        if (bone) this.arbiter.register(bone);
      }
      this.gaze = createGazeController(loaded.bones);

      void this.attachFacialChannel();

      this.ready = true;
      this.readyPending = true;
      this.error = null;

      console.log(
        `[render] 模型已加载 modelId=${loaded.modelId} loadMs=${Math.round(loaded.loadMs)} ` +
          `meshes=${loaded.meshNames.length} triangles=${loaded.triangleCount} ` +
          `morphTargets=${String(loaded.hasMorphTargets)} ` +
          `bones=head:${String(Boolean(loaded.bones.head))},eyeL:${String(Boolean(loaded.bones.eyeL))},` +
          `eyeR:${String(Boolean(loaded.bones.eyeR))},pelvis:${String(Boolean(loaded.bones.pelvis))} ` +
          `hidden=${loaded.hiddenMeshes.join('|') || '(none)'} ` +
          `ppm=${Math.round(loaded.pixelsPerUnit)}`,
      );
    } catch (error) {
      this.error = String(error);
      this.ready = false;
      // §7.3 / §11：模型缺失/解析失败/骨骼缺失 → 占位胶囊体，不白屏、不抛异常
      console.warn('[render] 模型加载失败，回退占位胶囊体（§7.3/§11）', error);
    } finally {
      this.loading = false;
    }
  }

  /** 枚举 44 段动画 + 选中 idle/held/walk + 起播 Idle（ADR 0014 D3、ADR 0023）。 */
  private setupAnimations(model: LoadedModel): void {
    const animations = createModelAnimations(model.root, model.animations);
    this.animations = animations;

    console.log(`[render] 模型自带动画 ${animations.clipNames.length} 段：${animations.clipNames.join(', ')}`);
    const selection = animations.selection;
    console.log(
      `[render] 动画选择 idle=${String(selection.idle.name)}(${selection.idle.reason}) ` +
        `held=${String(selection.held.name)}(${selection.held.reason}) ` +
        `walk=${String(selection.walk.name)}(${selection.walk.reason})`,
    );
    const roleReport = Object.values(animations.roles)
      .map((role) => `${role.role}=${role.name ?? '(missing)'}${role.reason === 'pattern' ? '(pattern)' : ''}`)
      .join(' ');
    console.log(`[render] 语义角色：${roleReport}`);

    for (const slot of ['idle', 'held', 'walk'] as AnimationSlot[]) {
      if (selection[slot].reason === 'missing') {
        console.warn(`[render] 未找到 ${slot} 片段（首选 ${selection[slot].preferred}），该槽位保持空转`);
      }
    }

    if (!animations.play('idle', 0)) {
      console.warn('[render] Idle 片段缺失：Base 层没有动画驱动（ADR 0014 D3）');
      return;
    }
    this.idleVariation.reset(performance.now());
    // 让首帧动作权重生效，随后才能做地面校正的蒙皮采样
    animations.update(0);
    model.root.updateMatrixWorld(true);
  }

  private playAnimation(slot: AnimationSlot, fadeSeconds: number, reason: string): void {
    if (!this.animations) return;
    const ok = this.animations.play(slot, fadeSeconds);
    const current = this.animations.current();
    if (ok && slot === 'idle') {
      // 槽位 idle 用的是 `CH0335_Cafe_Idle` 的 action；同步调度器的"当前站姿"，
      // 避免下一次轮换抽到 `idle` 时又从片段 0s 重播一次同样的姿势（ADR 0050）。
      this.idleVariation.noteCurrent('idle');
    }
    if (ok) {
      console.log(`[render] 动作切换 ${reason} → ${slot}=${String(current.name)}（crossFade ${fadeSeconds}s）`);
    } else {
      console.warn(`[render] 动作切换失败 ${reason} → ${slot}（片段缺失，保持当前动作）`);
    }
  }

  /** ADR 0023：优先播官方片段；返回 false 表示调用方应走程序化降级。 */
  private playOfficial(role: ClipRole, returnTo: AnimationSlot, reason: string): boolean {
    const animations = this.animations;
    if (!animations) return false;
    const ok = animations.playOnce(role, { returnTo });
    const one = animations.oneShot();
    if (ok) {
      console.log(
        `[render] 官方片段 ${reason} → ${role}=${String(one?.name)}` +
          `（${one ? one.duration.toFixed(2) : '?'}s，播完回 ${returnTo}）`,
      );
    } else {
      console.log(`[render] 官方片段缺失 ${reason} → ${role}，走程序化降级`);
    }
    return ok;
  }

  /** 一次性片段的时长（毫秒）；用于让 HFSM 的 reacting 与动画同寿命。 */
  private oneShotDurationMs(): number {
    const one = this.animations?.oneShot();
    return one ? one.duration * 1000 : 0;
  }

  /**
   * ADR 0050：待机**静态站姿轮换**（每帧）。
   *
   * 与旧实现的区别：
   * - 不再有一次性小动作（`fidget.shy` / `Cafe_Reaction` 已整体删除）；
   * - 候选池是 7 个**正面、静态、循环**的官方待机片段，每 20–45s 换一个；
   * - 换姿势条件是"纯站立待机"：不能在拖拽 / 坐姿 / 行走 / 说话 / 一次性演出期间换。
   *   到点但条件不满足时，调度器把排期顺延到恢复的那一刻（不会"忙完立刻换"）。
   *
   * 呼吸与视线不在这里：呼吸由每个待机片段自己带，视线由 `gaze.ts` 每帧叠加在
   * 动画姿态之上——换姿势只换"基底"，两条常驻通道照常工作。
   */
  private updateIdleVariation(now: number, snapshot: HfsmSnapshot, oneShotActive: boolean): void {
    if (!this.ready || !this.animations) return;
    const active =
      snapshot.base === 'idle' &&
      snapshot.physics === null &&
      snapshot.speakingUtteranceId === null &&
      !oneShotActive &&
      !this.dragging &&
      this.dragPoseGain < 0.001 &&
      !this.sitting;
    const role = this.idleVariation.tick(
      now,
      active,
      (candidate) => this.animations?.roles[candidate].name !== null,
    );
    if (role === null) return;
    const animations = this.animations;
    if (animations.playRole(role, IDLE_VARIATION_FADE_SECONDS, 'idle')) {
      console.log(
        `[render] 待机站姿轮换 → ${role}=${String(animations.roles[role].name)}` +
          `（crossFade ${IDLE_VARIATION_FADE_SECONDS}s）`,
      );
    } else {
      // 片段在加载期被判定缺失：调度器已经把它排除，正常不会走到这里
      console.warn(`[render] 待机站姿轮换失败 → ${role}（片段缺失，保持当前站姿）`);
      this.idleVariation.noteCurrent('idle');
    }
  }

  /**
   * ADR 0024 D1：进入 `walking`。
   * 位移**不使用动画里的 root motion**——窗口位置由 `cmd:walk` 交给 shell 的纯函数物理，
   * 这里只负责换动作与记录计划。
   */
  private beginWalk(plan: WalkPlan, now: number): void {
    this.walkingPlan = plan;
    this.walkYawTarget = walkYawFor(plan.direction);
    const played = this.animations?.playRole('walk', WALK_IN_FADE_SECONDS, 'walk') ?? false;
    this.options.onWalkRequest?.({
      phase: 'start',
      direction: plan.direction,
      distancePx: plan.distancePx,
    });
    console.log(
      `[render] walking 开始 direction=${plan.direction} distance=${plan.distancePx}px ` +
        `clip=${played ? String(this.animations?.roles.walk.name) : '(缺失，原地不动)'}`,
    );
  }

  /** 收步：请求 shell 停下，并淡回 Idle（到达 / 撞边 / 被拖拽打断都走这里）。 */
  private stopWalk(reason: string): void {
    if (!this.walkingPlan) return;
    this.walkingPlan = null;
    this.walkYawTarget = 0;
    this.playAnimation('idle', WALK_OUT_FADE_SECONDS, `stopWalk(${reason})`);
  }

  /**
   * 摸头反应的当前状态（ADR 0039）。
   *
   * **没有任何姿态计算**：这里只回答三件事——反应在不在播、身体通道有没有被官方片段接管、
   * 没接管时被哪条规则挡下。所有骨骼/根变换都来自 `clip-bank` 的 `pat` 片段本身。
   */
  private patState(now: number): PatDiagnostics {
    const snapshot = this.hfsm.snapshot();
    const reaction = snapshot.reaction;
    const active =
      isPatReaction(reaction) &&
      reaction !== null &&
      now - reaction.startedAt < reaction.durationMs;
    const one = this.animations?.oneShot() ?? null;
    const clip = one && one.role === 'pat' ? one.name : null;
    if (!active) return { active: false, body: false, clip, blockedBy: null };

    let blockedBy: PatDiagnostics['blockedBy'] = null;
    if (snapshot.physics === 'dragged' || snapshot.physics === 'settling') blockedBy = snapshot.physics;
    else if (snapshot.physics === 'sitting') blockedBy = 'sitting';
    else if (snapshot.speakingUtteranceId !== null) blockedBy = 'speaking';
    else if (snapshot.base !== 'idle') blockedBy = 'walking';
    else if (!clip) blockedBy = 'missing';
    return { active: true, body: blockedBy === null, clip, blockedBy };
  }

  /**
   * 摸头能不能接管身体通道（§5.3 的表 / ADR 0039 D4）：
   * 只有"站着待机、没有 Physics 接管、不在说话"时才播整身片段。
   */
  private patBodyAllowed(snapshot: HfsmSnapshot): boolean {
    return (
      snapshot.physics === null &&
      snapshot.base === 'idle' &&
      snapshot.speakingUtteranceId === null
    );
  }

  /** 摸头不接管身体时的可读原因（日志/诊断用）。 */
  private patBlockReason(snapshot: HfsmSnapshot, played: boolean): PatDiagnostics['blockedBy'] {
    if (played) return null;
    if (snapshot.physics === 'dragged' || snapshot.physics === 'settling') return snapshot.physics;
    if (snapshot.physics === 'sitting') return 'sitting';
    if (snapshot.speakingUtteranceId !== null) return 'speaking';
    if (snapshot.base !== 'idle') return 'walking';
    return 'missing';
  }

  /**
   * 头部区几何事实（ADR 0039 排查）。
   *
   * 只回答"R-10 的头部带到底落在哪儿"：掩膜包围盒从哪一行开始、22% 的下边界换算成
   * 内容区 CSS y 是多少、真正的头骨在哪个 y。点击点的 y 小于 `bandBottomCssY` 才算头部。
   */
  headBandDiagnostics(): HeadBandDiagnostics {
    const snapshot = this.maskCapture.snapshot();
    const bbox = snapshot.bbox;
    const bandBottomRow = bbox ? headBandBottomRow(bbox) : null;
    const hold = this.animations?.hold() ?? null;
    const headBoneCss = this.headCssNow();
    return {
      maskState: snapshot.state,
      bbox: bbox ? { ...bbox } : null,
      bandBottomRow: bandBottomRow === null ? null : Number(bandBottomRow.toFixed(2)),
      bandBottomCssY:
        bandBottomRow === null ? null : Number(((bandBottomRow / MASK_HEIGHT) * this.height).toFixed(1)),
      headBoneCss,
      headRadiusPx: this.headRadiusPx(),
      source: headBoneCss ? 'bone' : snapshot.state === 'ready' && bbox ? 'mask-bbox' : 'none',
      contentHeight: this.height,
      holdClip: hold?.name ?? null,
    };
  }

  /** 首选口径的半径（CSS px）。 */
  private headRadiusPx(): number {
    return Number((HEAD_PAT_RADIUS_RATIO * Math.max(1, this.height)).toFixed(1));
  }

  /**
   * 头骨在内容区 CSS 坐标里的位置（不额外 `scene.updateMatrixWorld`）。
   *
   * 为什么能不更新：`updateHalo()` 每帧已经 `root.updateMatrixWorld(true)`；
   * `getWorldPosition` 自身也会沿父链 `updateWorldMatrix`，因此这里读到的是最新姿态。
   */
  private headCssNow(): { x: number; y: number } | null {
    const head = this.model?.bones.head ?? null;
    if (!head) return null;
    const world = new THREE.Vector3();
    head.getWorldPosition(world);
    return {
      x: Number((this.width / 2 + world.x).toFixed(1)),
      y: Number((this.height / 2 - world.y).toFixed(1)),
    };
  }

  /**
   * 头部区判定（ADR 0040）：头骨半径优先，掩膜 bbox 22% 兜底。
   *
   * 为什么不再用 bbox：本资产的光环在掩膜里不透明，会把包围盒顶部顶到光环上沿，
   * 22% 的下边界落在发顶之上（实测 y≈228–275），脸（y≈340–420）整块在外。
   * 判据只在 `hit` 为真时有意义（R-10：`head` 只在命中时才有意义）。
   */
  headSampleAt(x: number, y: number, maskHead: boolean | null, hit: boolean): HeadSample {
    const headCss = this.headCssNow();
    if (headCss) {
      if (!hit) return { head: false, source: 'bone' };
      const radius = HEAD_PAT_RADIUS_RATIO * Math.max(1, this.height);
      const distance = Math.hypot(x - headCss.x, y - headCss.y);
      return { head: distance <= radius, source: 'bone' };
    }
    if (maskHead === null) return { head: null, source: 'none' };
    return { head: hit && maskHead, source: 'mask-bbox' };
  }

  /**
   * 面部贴图通道（ADR 0026 D2/D6）：EyeMouth（眼型+嘴）+ Face（红晕）两条通道。
   * 两张贴图是两个材质，所以是两条通道；"用哪张图"由 `applyFacial` 决定。
   */
  private async attachFacialChannel(): Promise<void> {
    const mouthTarget = this.model?.mouthMaterial ?? null;
    if (!mouthTarget) {
      console.warn('[render] 未找到 EyeMouth 材质，口型/表情不可用（§11 记录一次告警）');
      return;
    }
    const geometry = this.model ? collectFacialGeometry(this.model) : null;
    const [atlas, expressions] = await Promise.all([loadMouthAtlas(), loadExpressionAssets()]);
    this.atlasLoaded = Boolean(atlas);
    this.expressions = expressions;

    if (geometry?.mouth) {
      this.facial = createFacialChannel({
        material: geometry.mouth.material,
        sourceTexture: geometry.mouth.sourceTexture,
        triangles: geometry.mouth.triangles,
        skinColor: this.model?.skinColor ?? null,
        atlas,
      });
    } else {
      // §11：没有可用几何时退回"只有嘴、没有眼型/红晕"的路径（仍然不白屏）
      this.facial = createFacialChannel({
        material: mouthTarget,
        sourceTexture: this.model?.mouthSourceTexture ?? null,
        triangles: [],
        skinColor: this.model?.skinColor ?? null,
        atlas,
      });
    }

    if (geometry?.face) {
      this.blushChannel = createBlushChannel({
        material: geometry.face.material,
        sourceTexture: geometry.face.sourceTexture,
        triangles: geometry.face.triangles,
        skinColor: this.model?.skinColor ?? null,
        eyes: this.facial.eyes,
      });
    }

    const mouthDiag = this.facial.diagnostics();
    console.log(
      `[render] 面部贴图通道 material=${String(mouthDiag.materialName)} ` +
        `atlasLoaded=${String(this.atlasLoaded)} calibrated=${String(mouthDiag.calibrated)} ` +
        `eyeCalibrated=${String(mouthDiag.eyeCalibrated)} ` +
        `blush=${String(this.blushChannel?.calibrated ?? false)} ` +
        `expressions=${Object.keys(expressions.eyes).join(',') || '(none)'} ` +
        `missing=${expressions.missing.join('|') || '(none)'}`,
    );

    // 首帧把静态闭嘴 + 当前 emotion 画上去
    this.applyFacial(performance.now(), true);
  }

  /** 每帧/每次状态变化时合成面部贴图（只在状态指纹变化时真正重绘）。 */
  private applyFacial(now: number, force = false): void {
    const facial = this.facial;
    if (!facial) return;

    const snapshot = this.hfsm.snapshot();
    const speaking = snapshot.speakingUtteranceId !== null;
    // ADR 0039 D3：摸头只把 emotion 投影成 shy（官方差分），不再单独切嘴型帧
    const patActive = this.patState(now).active;
    // ADR 0034 D5：惊跳时临时投影 surprised（优先于摸头的 shy）
    const effective: Emotion = this.startleSurprised
      ? 'surprised'
      : patActive
        ? 'shy'
        : this.emotion;

    if (effective !== this.appliedEmotion) {
      this.appliedEmotion = effective;
      this.emotionFadeStartedAt = now;
    }
    const alpha = fadeProgress(now - this.emotionFadeStartedAt, EMOTION_FADE_MS);
    const face: EmotionFace = EMOTION_FACE[effective] ?? EMOTION_FACE.neutral;

    const eyeKey: EyeAssetKey | null = face.eyes;
    const eyeImage: PixelImage | null = eyeKey ? (this.expressions?.eyes[eyeKey] ?? null) : null;

    const owner: MouthOwner = resolveMouthOwner({
      speaking,
      lipSyncDriven: this.lipSyncDriven,
      emotionMouth: face.mouth,
      alpha,
    });

    let layer: MouthLayer;
    if (owner === 'lip-sync') {
      layer = { kind: 'atlas', frame: this.lipSyncFrame, frameCount: MOUTH_FRAME_COUNT };
    } else if (owner === 'emotion') {
      // 表情嘴型改用**官方高清图集帧**，不再用 Canvas 画的 `glyph`
      // （ADR 0026 D6.6：嘴型/眼型/腮红的每个像素都必须来自图片）
      layer = {
        kind: 'atlas',
        frame: EMOTION_MOUTH_FRAMES[face.mouth] ?? 0,
        frameCount: MOUTH_FRAME_COUNT,
      };
    } else {
      layer = { kind: 'static' };
    }

    const key = `${eyeKey ?? '-'}|${owner}|${JSON.stringify(layer)}|${alpha.toFixed(2)}|${face.blush}`;
    if (!force && key === this.facialKey) return;
    this.facialKey = key;

    const startedAt = performance.now();
    let painted = 0;
    if (eyeKey === null || alpha <= 0.001) {
      // 没有眼型差分（或淡出到 0）→ 精确还原到"原贴图 + 肤色底板 + 静态闭嘴"
      facial.clearEmotion();
      painted = -1;
    } else {
      facial.setEyes(eyeImage, alpha);
      facial.setMouth(layer);
      painted = facial.repaint();
    }

    if (this.blushChannel) {
      const level: BlushLevel = face.blush;
      if (level === 0 || alpha <= 0.001 || !this.expressions?.blush) {
        this.blushChannel.clear();
      } else {
        this.blushChannel.setBlush(this.expressions.blush, level, alpha);
        this.blushChannel.repaint();
      }
    }
    this.facialRepaints += 1;
    this.facialLastRepaintMs = Number((performance.now() - startedAt).toFixed(2));

    console.log(
      `[render] emotion ${this.appliedEmotion === effective ? '=' : '→'} ${effective} ` +
        `（eyes=${eyeKey ? `${eyeKey}:${eyeImage ? 'loaded' : 'missing'}` : '-'} ` +
        `mouth=${owner} blush=${face.blush} painted=${painted} ` +
        `dist=${facial.diagnostics().faceDistance?.toFixed(4) ?? '-'}）`,
    );
  }

  private facialDiagnostics(now: number, patActive: boolean): FacialDiagnostics | null {
    const facial = this.facial;
    if (!facial) return null;
    const snapshot = this.hfsm.snapshot();
    const speaking = snapshot.speakingUtteranceId !== null;
    const effective: Emotion = this.startleSurprised ? 'surprised' : patActive ? 'shy' : this.emotion;
    const face: EmotionFace = EMOTION_FACE[effective] ?? EMOTION_FACE.neutral;
    const alpha = fadeProgress(now - this.emotionFadeStartedAt, EMOTION_FADE_MS);
    const owner = resolveMouthOwner({
      speaking,
      lipSyncDriven: this.lipSyncDriven,
      emotionMouth: face.mouth,
      alpha,
    });

    const channel: FacialChannelDiagnostics = facial.diagnostics();
    const blushDiag = this.blushChannel?.diagnostics() ?? null;
    return {
      emotion: this.emotion,
      effective,
      eyes: face.eyes,
      mouthShape: face.mouth,
      mouthOwner: owner,
      blush: face.blush,
      alpha,
      fading: alpha < 0.999,
      repaints: this.facialRepaints,
      lastRepaintMs: this.facialLastRepaintMs,
      channel: {
        calibrated: channel.calibrated,
        eyeCalibrated: channel.eyeCalibrated,
        eyePixels: channel.eyePixels,
        mouthPixels: channel.mouthPixels,
        textureDigest: channel.textureDigest,
        faceDistance: channel.faceDistance,
      },
      blushChannel: blushDiag
        ? {
            calibrated: blushDiag.calibrated,
            mouthPixels: blushDiag.mouthPixels,
            textureDigest: blushDiag.textureDigest,
            faceDistance: blushDiag.faceDistance,
          }
        : null,
      assets: {
        loadedEyes: Object.keys(this.expressions?.eyes ?? {}),
        blushLoaded: Boolean(this.expressions?.blush),
        missing: this.expressions?.missing ?? [],
        eyeImageLabel: facial.eyeImageLabel,
      },
    };
  }

  /**
   * ADR 0014 D4：按 Idle 姿态做一次 CPU 蒙皮采样，把最低点对齐内容区底边。
   * 只在加载与 resize 后执行，不逐帧。
   */
  private calibrateGround(): void {
    const model = this.model;
    if (!model) return;
    const minY = measureAnimatedMinY(model.root, model.meshes);
    if (minY === null || !Number.isFinite(minY)) {
      console.warn('[render] 地面校正采样失败，保留绑定姿态放置（ADR 0014 D4）');
      return;
    }
    const beforePx = model.root.position.y;
    this.groundMinYLocal = minY;
    this.applyPlacement();
    const afterPx = model.root.position.y;
    console.log(
      `[render] 地面校正 minY=${minY.toFixed(6)} 单位 rootY ${beforePx.toFixed(1)} → ${afterPx.toFixed(1)}px ` +
        `(${(afterPx - beforePx).toFixed(1)}px)`,
    );
  }

  /** 模型定标：脚底中心 = 内容区底边中心（ADR 0009 D4）。 */
  private applyPlacement(): void {
    if (this.model) {
      this.model.pixelsPerUnit = placeModel(this.model.root, this.model.frame, this.height);
      // 地面校正（ADR 0014 D4）：最低点对齐内容区底边；未校正时用绑定姿态
      if (this.groundMinYLocal !== null) {
        this.model.root.position.y = -this.groundMinYLocal * this.model.pixelsPerUnit;
      }
    }
    if (this.placeholder) {
      // animationRoot 的原点已经是内容区底边（见 resize），占位体只需要保留白边距。
      // 写成 `-height/2 + margin` 会把胶囊体推到窗口下方（实测：只剩 1px 露在底边，
      // 掩膜几乎全空 → 缺失模型自检的"占位体可命中"失败）。
      this.placeholder.group.position.y = PLACEHOLDER_BOTTOM_MARGIN_PX;
    }
  }

  /**
   * ADR 0028 D8：记下"光环相对头骨"的偏移。
   *
   * 资产事实：`HaloRoot` 是普通节点（不是骨骼），不在骨架层级里，任何片段都不会驱动它。
   * 大多数片段身体原地不动，所以看不出来；一旦片段把角色搬走（回忆片段坐到长椅上），
   * 光环就会留在原地。这里把空闲姿态下的相对偏移记下来，之后每帧把光环挂回头骨。
   */
  private calibrateHalo(): void {
    const halo = this.model?.halo ?? null;
    const head = this.model?.bones.head ?? null;
    if (!halo || !head || !halo.parent) {
      if (this.ready) console.warn('[render] 未找到 HaloRoot/头骨：光环不会跟随（只影响视觉）');
      return;
    }
    this.model?.root.updateMatrixWorld(true);
    head.getWorldPosition(this.haloHeadWorld);
    halo.parent.worldToLocal(this.haloHeadWorld);
    this.haloOffset = halo.position.clone().sub(this.haloHeadWorld);
    console.log('[render] 光环跟随已标定', {
      offset: this.haloOffset.toArray().map((value) => Number(value.toFixed(5))),
    });
  }

  /** 每帧把光环挂到头骨上（`calibrateHalo` 失败时是空操作）。 */
  private updateHalo(): void {
    const halo = this.model?.halo ?? null;
    const head = this.model?.bones.head ?? null;
    const offset = this.haloOffset;
    if (!halo || !head || !offset || !halo.parent) return;
    // 骨骼世界矩阵在 mixer.update 之后还是旧的：这里补一次（约 0.2ms，远小于一帧预算）
    this.model?.root.updateMatrixWorld(true);
    head.getWorldPosition(this.haloHeadWorld);
    halo.parent.worldToLocal(this.haloHeadWorld);
    halo.position.copy(this.haloHeadWorld.add(offset));
  }

  /**
   * ADR 0028 D8 / ADR 0042 D3.2：加载时采一次**坐姿停帧那一帧的身体包围盒**。
   *
   * 做法：临时切到坐姿片段（淡入 1ms），用 `holdSeek` 直接**定位到片段末尾**
   * （= `playHold` 停住的那一帧），采完立刻切回 Idle。
   *
   * 为什么必须定位到末尾：ADR 0051 的进入窗口（14.2–16.2s）里，14.2–14.7 还在落位、
   * 14.95 有一次转头；**16.2s 才是阶段 B 的停帧基准**（身体/头的姿态参考点）。
   * 按第一帧量补偿，身体会偏一两厘米；按 16.2 量才是她真正坐住的姿态。
   * 为什么不在进入 `sitting` 时采：那一刻动作还在淡入（权重 0→1），采样到的是
   * "站姿与坐姿的混合"，补偿量会错；加载时 CPU 采样一次（约几毫秒）最干净。
   */
  private calibrateSitPose(): void {
    const model = this.model;
    const animations = this.animations;
    if (!model || !animations) return;
    if (!animations.playHold('sit', CALIBRATION_FADE_SECONDS)) {
      this.sitBounds = null;
      console.log('[render] 坐姿片段缺失：sitting 走程序化降级（下沉 + 弯腿）');
      return;
    }
    const liveHold = animations.hold();
    const duration = liveHold?.duration ?? 0;
    // ADR 0051：停帧基准 = 片段末尾（本地 2.0s = 绝对 16.2s）。不再留 20ms 余量，
    // 因为 `holdSeek` 自己会夹到 duration，且 16.2s 就是我们要的"身体/头姿态参考点"。
    animations.holdSeek(duration);
    animations.update(0.016);
    model.root.updateMatrixWorld(true);
    this.sitBounds = measureAnimatedBounds(model.root, model.meshes, 4096);
    // 还原空闲姿态（1ms 淡入 → 下一帧就是纯 Idle）
    animations.clearHold(CALIBRATION_FADE_SECONDS);
    animations.play('idle', CALIBRATION_FADE_SECONDS);
    animations.update(0.016);
    model.root.updateMatrixWorld(true);
    console.log('[render] 坐姿标定', {
      sampledAtSeconds: Number(duration.toFixed(2)),
      absoluteSeconds: Number((duration + SIT_CLIP_START_SECONDS).toFixed(2)),
      clipSeconds: Number(duration.toFixed(2)),
      bounds: this.sitBounds
        ? {
            centerX: Number(((this.sitBounds.minX + this.sitBounds.maxX) / 2).toFixed(5)),
            minY: Number(this.sitBounds.minY.toFixed(5)),
          }
        : null,
      ppm: Math.round(model.pixelsPerUnit),
    });
  }

  /**
   * ADR 0043 D3：算本帧的坐姿混合权重。
   *
   * 为什么用**片段权重**而不是时间包络：坐姿片段的交叉淡入本身就是 0→1，而片段自带的
   * 身体平移是"整段搬走 (+265,-287)px"。只要补偿与权重同源，站姿时补偿恒为 0、
   * 完全坐姿时补偿满值，中间是同一根曲线 —— 视觉上她只是"平滑地坐到位"。
   * 退场时片段权重 1→0（`playAnimation('idle')` 的交叉淡入），补偿跟着退到 0。
   *
   * 程序化降级（没有坐姿片段）没有权重可读，用指数包络兜底（180ms 时间常数）。
   */
  private updateSitGain(dtSeconds: number): void {
    const dt = Number.isFinite(dtSeconds) ? Math.min(0.1, Math.max(0, dtSeconds)) : 0;
    const weight = this.animations?.roleWeight('sit') ?? 0;
    this.sitRoleWeight = weight;

    const fallbackTarget = this.sitting && this.sitArrived && this.sitProcedural ? 1 : 0;
    const alpha = 1 - Math.exp(-dt / 0.18);
    this.sitFallbackGain += (fallbackTarget - this.sitFallbackGain) * alpha;
    if (this.sitFallbackGain < 0.001) this.sitFallbackGain = 0;

    // 只有"落座过"才允许应用补偿：接近阶段（还在走路/跳跃）与标定期一律为 0，
    // 否则会带着 380px 的偏移走过去（真机"乱平移"的另一个来源）。
    if (this.sitting && this.sitArrived) this.sitPoseActive = true;

    const gain = Math.max(weight, this.sitFallbackGain);
    this.sitGain = this.sitPoseActive ? Math.min(1, Math.max(0, gain)) : 0;

    // 退场收尾：已经离开 sitting 且权重衰减到接近 0 时，关掉整个坐姿通道
    if (this.sitPoseActive && !this.sitting && this.sitGain < 0.002) {
      this.sitPoseActive = false;
      this.sitGain = 0;
      this.sitFallbackGain = 0;
      this.sitStageBStartedAt = null;
      this.sitStageBGain = 0;
      this.sitDropSpring.reset();
    }
  }

  /**
   * ADR 0051：推进**下坐弹簧**与**两段式阶段**。
   *
   * 顺序：先算 `sitDrop`（落座本身），再看片段本地时间是否到 1.8s（绝对 16.0s）。
   * 到点后阶段 B 的覆盖权重从 0 用 0.3s 升到 1；片段继续播到本地 2.0s（16.2s）后 clamp。
   *
   * 为什么用"首次观测到到点"的时刻而不是绝对片段时钟：帧率抖动/掉帧时，
   * 片段可能一步跨过 1.8s；此时从这一帧开始 0.3s 淡入，仍然不会跳。
   */
  private updateSitStage(now: number, dtSeconds: number): void {
    if (!this.sitting || !this.sitArrived) return;
    this.sitDropSpring.update(dtSeconds, 1);

    if (this.sitStageBStartedAt === null) {
      const hold = this.animations?.hold() ?? null;
      const localSeconds = hold?.time ?? 0;
      const due = this.sitProcedural || (hold !== null && localSeconds >= sitStageBLocalSeconds());
      if (!due) return;
      this.sitStageBStartedAt = now;
      console.log(
        `[render] 坐姿阶段 B 开始（片段本地 ${localSeconds.toFixed(2)}s / 绝对 ` +
          `${(localSeconds + SIT_CLIP_START_SECONDS).toFixed(2)}s；` +
          `停留到 ${SIT_CLIP_HOLD_SECONDS.toFixed(1)}s 后停帧）`,
      );
    }
    this.sitStageBGain = sitStageBBlend(now - this.sitStageBStartedAt);
  }

  /** 坐姿的像素补偿：身体中心 → 窗口中线，身体最低点 → 窗口底边。 */
  private sitOffsetPx(): { x: number; y: number } {
    const model = this.model;
    const bounds = this.sitBounds;
    if (!model || !bounds) return { x: 0, y: 0 };
    const pixelsPerUnit = model.pixelsPerUnit;
    const centerX = ((bounds.minX + bounds.maxX) / 2) * pixelsPerUnit + model.root.position.x;
    const bottomY = bounds.minY * pixelsPerUnit + model.root.position.y;
    return { x: -centerX, y: -bottomY };
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.applyCameraFrustum();
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(this.width, this.height, false);
    this.animationRoot.position.y = -this.height / 2;
    this.applyPlacement();
  }

  /**
   * 内部（ADR 0047 取证）：把正交相机缩到脸上，拍"脸部特写"。
   *
   * 为什么不是裁剪截图：脸部在窗口里只有 60–80px 宽，裁剪再放大只是把模糊放大——
   * 而这一轮要判断的正是"瞳孔到底朝哪"，必须是真的像素。正交相机把视锥收到
   * `size×size` 的方框（CSS 像素），像素密度直接提高 4–6 倍，且不改模型/姿态。
   *
   * `size <= 0` 关闭。返回方框（CSS 坐标，左上原点），供自检断言"框里确实是脸"。
   */
  setFaceZoom(size: number): { x: number; y: number; size: number } | null {
    const clamped = Number.isFinite(size) && size > 0 ? Math.min(720, size) : 0;
    this.faceZoomSize = clamped;
    this.applyCameraFrustum();
    if (clamped <= 0) {
      console.log('[render] 脸部特写相机：关（ADR 0047 取证）');
      return null;
    }
    const center = this.faceZoomCenter();
    console.log(
      `[render] 脸部特写相机：开 ${clamped.toFixed(0)}px ` +
        `中心=(${center.x.toFixed(0)}, ${center.y.toFixed(0)})（ADR 0047 取证）`,
    );
    return { x: center.x - clamped / 2, y: center.y - clamped / 2, size: clamped };
  }

  /** 脸部特写的中心：坐姿时用头骨；站姿没有落座就用模型包围盒上 1/4 处。 */
  private faceZoomCenter(): { x: number; y: number } {
    const head = this.model?.bones.head ?? null;
    if (head) {
      const css = this.boneCss(head);
      if (css) {
        // 头骨中心在颅腔里，脸（眼/嘴那张卡片）比它低一点点，取 12% 方框下移
        return { x: css.x, y: css.y + this.faceZoomSize * 0.12 };
      }
    }
    return { x: this.width / 2, y: this.height / 2 };
  }

  /**
   * 视锥：默认铺满窗口；特写时缩成 `faceZoomSize` 的方框并**每帧跟随头骨**
   * （张望/呼吸会让头移动，固定方框会把她拍出画面）。
   */
  private applyCameraFrustum(): void {
    if (this.faceZoomSize > 0) {
      const center = this.faceZoomCenter();
      const half = this.faceZoomSize / 2;
      const cx = center.x - this.width / 2;
      const cy = this.height / 2 - center.y;
      this.camera.left = cx - half;
      this.camera.right = cx + half;
      this.camera.top = cy + half;
      this.camera.bottom = cy - half;
    } else {
      this.camera.left = -this.width / 2;
      this.camera.right = this.width / 2;
      this.camera.top = this.height / 2;
      this.camera.bottom = -this.height / 2;
    }
    this.camera.updateProjectionMatrix();
  }

  /**
   * 内部（ADR 0048 D2）：坐姿头部微调 —— **键盘 ↑/↓ 现场拧出来的那个数**。
   *
   * 正 = 低头、负 = 抬头，夹在 ±0.4rad（超过就明显是在点头/仰望，不再是"平视"）。
   * 不写进任何状态机：它只是一个常量偏移，跟着 `sitGain` 淡入。
   */
  setSitHeadTune(rad: number): number {
    const clamped = Number.isFinite(rad) ? Math.max(-0.4, Math.min(0.4, rad)) : 0;
    this.sitHeadTune = clamped;
    console.log(`[render] 坐姿头部微调 ${clamped.toFixed(3)}rad（ADR 0048 D2）`);
    return clamped;
  }

  handleIntent(intent: string): void {
    if (!isIntent(intent)) {
      // 契约 §4.4：降级为 none，写告警，不抛异常、不随机播别的动作
      console.warn(`[render] 未知 intent "${String(intent)}"，已降级为 none（契约 §4.4）`);
      return;
    }
    if (intent === 'none') return;

    const now = performance.now();
    const last = this.lastIntentAt.get(intent) ?? Number.NEGATIVE_INFINITY;
    if (now - last < INTENT_DEDUPE_MS) return;
    this.lastIntentAt.set(intent, now);

    // ADR 0024 D3 / ADR 0039 D5：回弹与拖拽期间不接受新的动作意图（唯一例外是重新拖拽）
    const physics = this.hfsm.snapshot().physics;
    if (physics === 'settling' || physics === 'dragged') {
      console.log(`[render] ${physics} 期间忽略 intent=${intent}（ADR 0024 D3 / ADR 0039 D5）`);
      return;
    }

    if (intent === 'pat_react') {
      // §4.4 / ADR 0039：摸头只走官方片段 + shy 表情，没有任何程序化姿态。
      // 这里刻意做成"幂等"：伴台词的 `pat_react` 常常紧跟 `head_patted` 到达，
      // 若已在播就不重启（否则 2.1s 的官方片段会被截成 1.1s 的表情窗口）。
      const snapshot = this.hfsm.snapshot();
      if (this.patState(now).active) {
        console.log('[render] pat_react（intent 命令）：摸头反应已在播，不重启');
        return;
      }
      const played = this.patBodyAllowed(snapshot)
        ? this.playOfficial('pat', 'idle', 'intent pat_react')
        : false;
      const clipMs = played ? this.oneShotDurationMs() : 0;
      const why = this.patBlockReason(snapshot, played);
      this.hfsm.intent(now, intent, clipMs > 0 ? clipMs : PAT_FACIAL_FALLBACK_MS);
      this.applyFacial(now, true);
      console.log(
        `[render] pat_react（intent 命令）→ reacting（${played ? `官方片段 ${String(this.animations?.oneShot()?.name)}` : `仅表情：${String(why)}`}）`,
      );
      return;
    }

    const spec = REACTIONS[intent];
    if (!spec) return;
    // ADR 0023 D2 / ADR 0041 D3：有官方片段就整身播，没有就退回程序化位移/缩放
    const role = INTENT_CLIP[intent];
    const played = role ? this.playOfficial(role, 'idle', `intent ${intent}`) : false;
    const clipMs = played ? this.oneShotDurationMs() : 0;
    // `happy_hop` 的"有位移的小跳"（§4.4）是根变换，不是骨骼姿态：即使官方片段在播，
    // 也保留一个**更小**的 22px 跳跃包络（片段负责庆祝、根变换负责那一下弹起）。
    // 其余 intent 一旦有官方片段接管身体，就不再叠任何程序化位移/旋转。
    this.reaction =
      played && intent !== 'happy_hop'
        ? null
        : { spec: played ? { ...spec, hopPx: 22, look: 0 } : spec, startedAt: now };
    this.hfsm.intent(now, intent, clipMs > 0 ? clipMs : spec.durationMs);
  }

  /**
   * 内部：`evt:broadcast` 的渲染侧入口。契约 §7.3 的订阅集合：
   * speech_*、drag_*、head_patted、intent_resolved、motion_ended。
   */
  handleEvent(event: BroadcastEvent): void {
    const now = performance.now();
    switch (event.name) {
      case 'speech_started': {
        const payload = event.payload as { utteranceId: string };
        this.hfsm.speechStarted(now, payload.utteranceId);
        // 口型通道最高优先：说话开始时表情/嘴型让位（§5.2）
        this.applyFacial(now, true);
        this.lipSyncDriven = true;
        console.log(`[render] speaking 开始 utteranceId=${payload.utteranceId}`);
        break;
      }
      case 'speech_ended': {
        const payload = event.payload as { utteranceId: string; reason: string };
        this.hfsm.speechEnded(now);
        this.resetMouthFrame();
        console.log(`[render] speaking 结束 utteranceId=${payload.utteranceId} reason=${payload.reason}`);
        break;
      }
      case 'head_patted': {
        const payload = event.payload as { patCount: number };
        const snapshot = this.hfsm.snapshot();
        // ADR 0039 排查打点（只读）：事件到了以后，HFSM 此刻到底是什么状态。
        console.log(
          `[render] 收到 head_patted，当前 HFSM 状态=${JSON.stringify({
            base: snapshot.base,
            overlay: snapshot.overlay,
            physics: snapshot.physics,
            speaking: snapshot.speakingUtteranceId !== null,
          })} patCount=${payload.patCount}`,
        );
        // ADR 0039 D5：拖拽与回弹期间一律拒绝（shell 侧也在沉降窗口内拦截，这里是第二道闸）
        if (snapshot.physics === 'dragged' || snapshot.physics === 'settling') {
          console.log(
            `[render] 忽略 head_patted（physics=${snapshot.physics}，ADR 0039 D5 严格互斥）`,
          );
          break;
        }
        // §5.3 的表 / ADR 0039 D4：只有站着的 idle 才让官方片段接管身体，
        // 说话 / 走路 / 坐着时身体通道一动不动，只有表情投影 shy。
        const played = this.patBodyAllowed(snapshot)
          ? this.playOfficial('pat', 'idle', 'head_patted')
          : false;
        // 没有可用片段时用表情窗口兜住 reacting 的生命周期（不产生任何骨骼动作）
        const clipMs = played ? this.oneShotDurationMs() : 0;
        this.hfsm.headPatted(now, clipMs > 0 ? clipMs : undefined);
        this.applyFacial(now, true);
        const why = this.patBlockReason(snapshot, played);
        console.log(
          `[render] head_patted → reacting patCount=${payload.patCount}`
            + `（${played ? `官方片段 ${String(this.animations?.oneShot()?.name)}` : `仅表情：${String(why)}`}）`,
        );
        // 150ms 后回报一次"片段真的在跑、权重真的是 1"（排查被 hold/crossFade 盖住）
        if (played) this.patWeightCheckAt = now + 150;
        break;
      }
      case 'drag_started': {
        // §4.1：`walking` 的退出条件之一是被拖拽打断
        this.stopWalk('drag_started');
        // ADR 0039 D5：拖拽开始的那一刻，在播的摸头片段与 reaction 必须立刻消失。
        // 顺序是先取消一次性演出、再进 Physics——否则 `playAnimation('held')` 之后
        // 再淡出 one-shot 会留下两个整身 action 抢同一批骨骼。
        this.animations?.cancelOneShot(DRAG_IN_CROSSFADE_SECONDS);
        // ADR 0028 D9：拖走她就离开窗口边缘（shell 也会发 snap_released，这里同时兜底）
        this.sitting = false;
        this.sitArrived = false;
        this.sitApproach = null;
        this.sitEdge = null;
        this.sitProcedural = false;
        // ADR 0048：拖走她就不再是坐姿；上半身覆盖跟着 `frame.gain` 的 500ms 淡出
        // 自动退场（不需要在这里清任何缓存）。
        this.hfsm.dragStarted(now);
        this.dragStartedAt = now;
        this.dragging = true;
        this.beginDrag(now);
        // ADR 0039 D5：摸头的表情投影也一并收走（回到 intent_resolved 给的 emotion）
        this.applyFacial(now, true);
        // ADR 0041 D1：**播什么与抓取带无关** —— 抓头 / 抓身 / 抓脚统一播官方悬空片段
        // `Formation_Pickup`（`held`）。抓取带只影响单摆物理（摆长/阻尼/限幅/挣扎）。
        // 片段从第 0 秒起播，正好获得"被拎起来"的那一下；任何程序化骨骼姿态都已删除。
        this.playAnimation('held', DRAG_IN_CROSSFADE_SECONDS, `drag_started（band=${this.dragBand}）`);
        break;
      }
      case 'drag_released': {
        // D-6 / ADR 0024 D3：松手先进入 settling，回弹过程中淡回 Idle
        const payload = event.payload as { vx?: unknown; vy?: unknown };
        // ADR 0040 D3：落地冲击改用**松手瞬间的竖直速度**（+y 向下），不再用弹簧自由落体的峰值。
        // 后者在 settling 里必然饱和（实测 1500–1716px/s），于是每次都按"重摔"压满。
        this.releaseDownVelocity = Math.max(
          0,
          typeof payload.vy === 'number' && Number.isFinite(payload.vy) ? payload.vy : 0,
        );
        this.hfsm.dragReleased(now);
        this.dragging = false;
        this.playAnimation('idle', SETTLE_FADE_SECONDS, 'drag_released → settling（回弹中）');
        console.log(
          `[render] 松手：竖直速度 vy=${Math.round(this.releaseDownVelocity)}px/s ` +
            `（落地冲击只看它，ADR 0040 D3）`,
        );
        break;
      }
      case 'motion_ended': {
        const payload = event.payload as { kind?: unknown; reason?: unknown };
        const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
        if (payload.kind === 'walk') {
          this.walkingPlan = null;
          this.walkYawTarget = 0;
          this.hfsm.walkEnded(now);
          this.playAnimation('idle', WALK_OUT_FADE_SECONDS, `motion_ended(walk,${reason})`);
          break;
        }
        if (payload.kind === 'settle') {
          this.hfsm.settleEnded(now);
          // 落地缓冲：冲击只看**松手瞬间的竖直速度**（ADR 0040 D3；原口径见 ADR 0035 D4）
          const impact = impactFromDownVelocity(this.releaseDownVelocity);
          this.landing = { startedAt: now, impact };
          // 自检取证：落地缓冲只活 220ms，而 `getDiagnostics()` 单次约 300ms，
          // 读得稍晚就只剩 null（2026-11-04 复现）。留一份"最近一次冲击"给事后断言。
          this.lastLandingImpact = impact;
          this.lastLandingSquash = 0;
          this.landingCount += 1;
          this.landingPeakSquash = 0;
          this.dragPendulum = { angle: this.dragPendulum.angle, angularVelocity: 0 };
          console.log(
            `[render] 回弹结束（${reason}）→ 落地缓冲 impact=${impact.toFixed(2)} ` +
              `releaseVy=${Math.round(this.releaseDownVelocity)}px/s ` +
              `squashMax=${(LANDING_MAX_SQUASH * impact).toFixed(4)} durationMs=${LANDING_DURATION_MS} ` +
              `（ADR 0040 D3；与摸头无关）`,
          );
          this.releaseDownVelocity = 0;
        }
        break;
      }
      case 'snap_approach_started': {
        // ADR 0034 D2/D5：吸附生命周期进入接近阶段（Physics 仍是 sitting）
        const payload = event.payload as {
          edge?: unknown;
          source?: unknown;
          mode?: unknown;
          durationMs?: unknown;
        };
        const edge: 'top' | 'bottom' = payload.edge === 'top' ? 'top' : 'bottom';
        const source = typeof payload.source === 'string' ? payload.source : 'foreground';
        const mode: 'walk' | 'leap' = payload.mode === 'leap' ? 'leap' : 'walk';
        const durationMs =
          typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs)
            ? Math.max(1, payload.durationMs)
            : 400;
        this.enterApproach(now, edge, source, mode, durationMs);
        break;
      }
      case 'snap_applied': {
        // ADR 0028 D5/D8：窗口已经贴到边缘 → Physics=sitting、停住坐姿
        const payload = event.payload as { edge?: unknown; source?: unknown };
        const edge: 'top' | 'bottom' = payload.edge === 'top' ? 'top' : 'bottom';
        const source = typeof payload.source === 'string' ? payload.source : 'foreground';
        this.enterSit(now, edge, source);
        break;
      }
      case 'snap_released': {
        const payload = event.payload as { reason?: unknown };
        const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
        // ADR 0042 D4：`window-gone` / `fullscreen` 时 shell 会把她从窗沿落回桌面。
        // render 侧**不**给这次下落伪造冲击速度：ADR 0040 D3 的口径是"轻放不缩"，
        // 而从窗沿落回桌面的落差只有几十到几百像素、落地时也没有"松手瞬间竖直速度"这个事实，
        // 所以这次落地只由 `startle`（惊跳）+ 回弹弹簧本身表达，不叠下蹲。
        this.exitSit(now, reason);
        break;
      }
      case 'intent_resolved': {
        const payload = event.payload as { emotion: Emotion };
        this.emotion = payload.emotion;
        // 立刻合成一次：自检在读诊断前不等下一帧（表情切换是事件驱动，不是逐帧轮询）
        this.applyFacial(performance.now(), true);
        break;
      }
      default:
        break;
    }
  }

  setCursor(cssX: number, cssY: number, at: number = performance.now()): void {
    this.gaze?.setCursor(cssX, cssY, at);
  }

  /** ADR 0035：消费 `pendingGrab`，确定抓取带/支点，重置单摆与支撑运动。 */
  private beginDrag(now: number): void {
    const grab = this.pendingGrab;
    const fresh = grab !== null && now - grab.at <= 1500;
    this.dragBand = fresh ? grab.band : 'body';
    const cssX = fresh ? grab.cssX : this.width / 2;
    const cssY = fresh ? grab.cssY : this.height * 0.45;
    const pivot = this.computeDragPivot(this.dragBand, cssX, cssY);
    this.dragPivot = pivot.local;
    this.dragPivotCss = pivot.css;
    this.dragPendulum = createDragPendulum();
    this.dragPoseGain = 0;
    this.supportSample = null;
    this.supportVelocity = { x: 0, y: 0 };
    this.supportAcceleration = { x: 0, y: 0 };
    this.releaseDownVelocity = 0;
    this.pendingGrab = null;
    console.log(
      `[render] 拖拽抓取 band=${this.dragBand} pivot=(${Math.round(pivot.css.x)},${Math.round(pivot.css.y)}) ` +
        `local=(${Math.round(pivot.local.x)},${Math.round(pivot.local.y)})`,
    );
  }

  /**
   * ADR 0034 D2/D5：`snap_approach_started` → 进入 `sitting` 的接近阶段。
   * 不播坐姿，只播走路/跳跃；`snap_applied` 到达后才 `playHold('sit')`。
   */
  private enterApproach(
    now: number,
    edge: 'top' | 'bottom',
    source: string,
    mode: 'walk' | 'leap',
    durationMs: number,
  ): void {
    this.stopWalk('snap_approach_started');
    this.hfsm.snapApproaching(now);
    this.sitting = true;
    this.sitArrived = false;
    this.sitStartedAt = now;
    this.sitEdge = edge;
    // 注意：**不要**在这里把 `sitProcedural` 清掉——如果是"降级路径退场途中又重新接近"，
    // 清掉会让下沉量瞬间归零（跳一下）。它由下一次 `enterSit` 按片段是否可用重新决定。
    this.sitApproach = { mode, durationMs, startedAt: now };
    // 接近阶段用行走循环；leap 的窗口弧线由 shell 负责，模型不自己位移
    this.playAnimation('walk', 0.2, `snap_approach_started(${mode}, ${Math.round(durationMs)}ms)`);
    console.log(
      `[render] sitting 接近 edge=${edge} source=${source} mode=${mode} ` +
        `duration=${Math.round(durationMs)}ms`,
    );
  }

  /**
   * ADR 0044：把一帧坐姿微动提交给骨骼仲裁器。
   *
   * 只提交**增量**：旋转走四元数叠加（与视线同一套父空间/世界轴），眼皮走位置偏移
   * （本资产的眨眼是骨骼平移，不是 blendshape）。所有量已经由 `sit-motion` 乘过它的总包络，
   * 这里不再缩放，避免"包络套包络"。
   */
  private applySitMotion(frame: SitMotionFrame, poolWeights: Record<SitMicroKind, number>): void {
    const arbiter = this.arbiter;
    const model = this.model;
    if (!arbiter || !model) return;
    /**
     * ADR 0051：上半身覆盖用**阶段 B 的 0.3s 权重**，不是 `frame.gain` 的 0.5s 微动包络。
     *
     * 两者分开：头部必须在 16.2s 停帧后 0.3s 内回到站立姿态（慢了会读成"头还在飘"），
     * 而呼吸/晃腿可以 0.5s 慢慢起来。再乘 `sitGain × sitDrop`，退场/落座都不会硬切。
     */
    const upperBlend = Math.min(
      1,
      Math.max(0, this.sitStageBGain * this.sitGain * this.sitDropSpring.value()),
    );
    if (frame.gain <= 0.0005 && upperBlend <= 0.0005) return;
    const bones = model.bones;
    const gain = frame.gain;
    /**
     * ADR 0049 D1：**坐姿微动作池**的权重（`legs` / `hands` / `far`）。
     *
     * 三个条目不是三套动作，而是"同一套坐姿微动 + 不同的偏置"：
     * - `legs`（晃腿）：当前行为，随机张望照常；
     * - `hands`（低头看手）：晃腿停下、头/颈/眼低头并略偏向手，随机张望淡出；
     * - `far`（抬头看远处）：晃腿放慢到三成，头/眼抬起并偏向一侧。
     *
     * 每个条目都有 0..1 的权重（池负责 15–30s 抽签与指数过渡），所以换条目时是
     * 平滑交叉混合，不会"啪"地换一个姿势。全部量都再乘 `frame.gain`（坐姿总包络），
     * 落座/起身时不会硬切。
     */
    const legsW = unitWeight(poolWeights.legs);
    const handsW = unitWeight(poolWeights.hands);
    const farW = unitWeight(poolWeights.far);
    // 随机张望在 `legs` 条目下完全生效；hands/far 把它淡出，换成各自的固定朝向
    const wander = legsW;
    const gazeYaw =
      frame.gazeYaw * wander +
      gain * (handsW * SIT_MICRO_HANDS_HEAD_YAW_RAD + farW * SIT_MICRO_FAR_HEAD_YAW_RAD);
    const gazePitch =
      frame.gazePitch * wander +
      gain * (handsW * SIT_MICRO_HANDS_HEAD_PITCH_RAD + farW * SIT_MICRO_FAR_HEAD_PITCH_RAD);
    const legScale =
      legsW + handsW * SIT_MICRO_HANDS_LEG_SCALE + farW * SIT_MICRO_FAR_LEG_SCALE;
    const spineBias =
      gain * (handsW * SIT_MICRO_HANDS_SPINE_PITCH_RAD + farW * SIT_MICRO_FAR_SPINE_PITCH_RAD);
    /**
     * ADR 0048 D1：**上半身直接照抄站立姿态**。
     *
     * 胸（`Spine1`）/颈/头**以及下背 `Spine`**的**局部四元数**在站立待机时采了一次，
     * 这里原样覆盖为旋转基底 —— 不做任何"相对绑定姿态的差值"、不加任何偏移量。
     * 为什么必须带下背：16.2s 的片段下背比 14.7s 更前倾，只覆盖后三根时整条上链会继承
     * 这个前倾，头看起来仍然低（真机 A/B 实测）；四根一起覆盖，上半身才真正与站姿一致。
     *
     * 用 `slerp(片段姿态 → 站立姿态, upperBlend)` 淡入；`upperBlend` 是阶段 B 的
     * 0.3s 权重（不是微动的 0.5s 包络），所以 16.2s 停帧后头会在 0.3s 内回正。
     */
    const idle = this.idleUpperLocals;
    const upper = [
      { bone: bones.spine, target: idle?.spine ?? null },
      { bone: bones.spine1, target: idle?.chest ?? null },
      { bone: bones.neck, target: idle?.neck ?? null },
      { bone: bones.head, target: idle?.head ?? null },
    ];
    const spineWeight = Math.min(1, Math.max(0, SIT_SPINE_OVERLAY_WEIGHT));
    for (const { bone, target } of upper) {
      if (!bone) continue;
      if (!target) continue;
      // ADR 0051 D7：下背可以单独放松（0.85 = 保留 15% 片段前倾），其余三根不变。
      const blend = bone === bones.spine ? upperBlend * spineWeight : upperBlend;
      if (blend <= 0.0005) continue;
      const base = arbiter.animationBase(bone) ?? bone.quaternion;
      const blended = base.clone().slerp(target, blend);
      // 基底被覆盖后，下面的 `add` 都是绕世界轴叠在这份"站立姿态"上的呼吸/张望
      arbiter.overrideBase(bone, blended);
    }
    // 呼吸：脊柱/颈的微小前屈（正 = 低头，ADR 0035 D5 的标定）
    if (bones.spine) arbiter.add(bones.spine, 0, frame.spinePitch);
    if (bones.spine1) arbiter.add(bones.spine1, 0, frame.spine1Pitch + spineBias);
    if (bones.neck) arbiter.add(bones.neck, 0, frame.neckPitch);
    // 肩膀呼吸（ADR 0045 D2.3）：锁骨 + 上臂各 ±0.02rad，相位已由 sit-motion 错开。
    // 只给 pitch（世界 X）——roll 会变成"耸肩"，yaw 会让手臂前后甩。
    for (const clavicle of [bones.clavicleL, bones.clavicleR]) {
      if (clavicle) arbiter.add(clavicle, 0, frame.claviclePitch);
    }
    for (const arm of [bones.upperArmL, bones.upperArmR]) {
      if (arm) arbiter.add(arm, 0, frame.upperArmPitch);
    }
    // 自主张望（或池条目的固定朝向）：头 + 眼球。
    // ADR 0048 D2：`sitHeadTune` 是键盘 ↑/↓ 现场调出来的固定微调（正 = 低头），
    // 一起按包络淡入；它和"张望"是两件事，后者每 2–4s 换方向。
    if (bones.head) {
      arbiter.add(bones.head, gazeYaw, gazePitch + this.sitHeadTune * upperBlend);
    }
    // ADR 0046 D1：**接管眼球**。停帧后 Mixer 不再写眼骨，片段里那份"向下看"会永远留着
    // （死鱼眼）。把眼球的旋转基底换成**绑定姿态**（平视），再叠张望的额外量 ——
    // 眼球从此跟着头一起转，不再呆滞看地。
    const eyeBase = this.eyeBindLocal;
    const eyeYaw = gazeYaw * SIT_GAZE_EYE_EXTRA;
    const eyePitch = gazePitch * SIT_GAZE_EYE_EXTRA;
    for (const eye of [bones.eyeL, bones.eyeR]) {
      if (!eye) continue;
      if (eyeBase && upperBlend > 0.0005) {
        const clipBase = arbiter.animationBase(eye) ?? eye.quaternion;
        // 从片段自带的眼位（阶段 A 的"四处张望"）平滑过渡到绑定姿态 + 张望
        arbiter.overrideBase(eye, clipBase.clone().slerp(eyeBase, upperBlend));
      }
      arbiter.add(eye, eyeYaw, eyePitch);
    }
    // 悬空晃腿：左右反相（相位差 π），大腿带小腿。ADR 0049 D1：按池条目的 `legScale`
    // 平滑停下/放慢（看手时完全停、看远处时剩三成），不是"啪"地停。
    if (bones.thighL) arbiter.add(bones.thighL, 0, frame.thighPitchL * legScale);
    if (bones.thighR) arbiter.add(bones.thighR, 0, frame.thighPitchR * legScale);
    if (bones.calfL) arbiter.add(bones.calfL, 0, frame.calfPitchL * legScale);
    if (bones.calfR) arbiter.add(bones.calfR, 0, frame.calfPitchR * legScale);
    // ADR 0046 D2：**停帧不再眨眼**。眼皮骨（`bone_eye_D_*`）的平移手写眨眼已整套删除：
    // 停帧时没有动画混合与联动，只推平移会把下眼皮硬拉上去（真机"翻白眼"）。
  }

  /** 内部（ADR 0044）：只读的坐姿微动快照（不含面部诊断，~微秒级）。 */
  sitMotionDiagnostics(): SitMotionFrame | null {
    return this.sitMotion.frame();
  }

  /**
   * 内部（ADR 0051）：极轻的坐姿两段式快照（自检 16ms 采样用）。
   * 只读 `sitDrop` / 阶段 / 头骨，不触发面部摘要。
   */
  sitSequenceDiagnostics(): SitSequenceDiagnostics {
    const hold = this.animations?.hold() ?? null;
    const head = this.model?.bones.head ?? null;
    let headQuat: [number, number, number, number] | null = null;
    let headWorld: { x: number; y: number } | null = null;
    if (head) {
      headQuat = [
        Number(head.quaternion.x.toFixed(5)),
        Number(head.quaternion.y.toFixed(5)),
        Number(head.quaternion.z.toFixed(5)),
        Number(head.quaternion.w.toFixed(5)),
      ];
      const world = new THREE.Vector3();
      head.getWorldPosition(world);
      headWorld = { x: Number(world.x.toFixed(1)), y: Number(world.y.toFixed(1)) };
    }
    return {
      stage: this.sitStageBStartedAt === null ? 'a' : 'b',
      holdTimeSeconds: hold ? Number(hold.time.toFixed(3)) : null,
      holdDurationSeconds: hold ? Number(hold.duration.toFixed(3)) : null,
      stageBBlend: Number(this.sitStageBGain.toFixed(3)),
      stageBInMs:
        this.sitStageBStartedAt === null
          ? null
          : Math.max(0, Math.round(performance.now() - this.sitStageBStartedAt)),
      sitDrop: Number(this.sitDropSpring.value().toFixed(3)),
      sitPoseGain: Number(this.sitPoseGain.toFixed(3)),
      upperOverride: Number(this.sitUpperOverride.toFixed(3)),
      phaseAHeadAppliedRad: Number(this.sitPhaseAHeadApplied.toFixed(4)),
      spineOverlayWeight: SIT_SPINE_OVERLAY_WEIGHT,
      spineOverlayApplied: Number(this.sitSpineOverlay.toFixed(3)),
      headQuat,
      headWorld,
    };
  }

  /**
   * 内部（ADR 0051，自检取证）：立刻把坐姿张望目标切到 camera / wander。
   * 生产路径不调用；下一次自然抽签仍按 1/3 概率。
   */
  forceSitGaze(kind: 'camera' | 'wander'): 'camera' | 'wander' {
    this.sitMotion.forceGaze(kind, performance.now());
    return kind;
  }

  /** 内部（ADR 0049 D2）：极轻的视线三级阻尼快照（自检 16ms 采样用）。 */
  gazeDiagnostics(): GazeDiagnostics | null {
    const state = this.gaze?.state();
    if (!state) return null;
    return { ...state, spineBone: this.spineBoneDiagnostics(state.spineYaw) };
  }

  /**
   * ADR 0049 D2 取证：**Spine1 骨骼实际转了多少**（不是控制器提交量）。
   *
   * `final = q_roll · q_pitch · q_yaw · base`（`BoneArbiter.endFrame`），所以
   * `delta = final · base⁻¹` 就是本帧仲裁器写进这根骨骼的旋转（父空间）；
   * 再把 delta 的轴转到世界空间、取它在世界 Y 上的分量，就是"实时 rotation.y"。
   */
  private spineBoneDiagnostics(submittedYaw: number): GazeBoneDiagnostics | null {
    /**
     * 坐姿期间 Spine1 的基底被"照抄站立姿态"覆盖（ADR 0048 D1），此时的骨骼旋转增量
     * 来自坐姿姿态而不是视线；返回 null，避免把坐姿姿态误读成"躯干跟随"。
     */
    if (this.sitPoseActive && this.sitGain > 0.01) return null;
    const spine = this.model?.bones.spine1 ?? null;
    const base = spine ? this.arbiter?.animationBase(spine) ?? null : null;
    if (!spine || !base) return null;
    const delta = spine.quaternion.clone().multiply(base.clone().invert());
    const w = Math.min(1, Math.abs(delta.w));
    const angle = 2 * Math.acos(w);
    if (angle < 1e-7) {
      return { spineYawRad: 0, spineYawDeg: 0, axisY: 0, submittedYawRad: Number(submittedYaw.toFixed(5)) };
    }
    const axis = new THREE.Vector3(delta.x, delta.y, delta.z);
    if (axis.lengthSq() < 1e-12) {
      return { spineYawRad: 0, spineYawDeg: 0, axisY: 0, submittedYawRad: Number(submittedYaw.toFixed(5)) };
    }
    axis.normalize();
    const parentWorld = spine.parent
      ? spine.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    axis.applyQuaternion(parentWorld).normalize();
    // 我们的 yaw 是绕世界 Y 的纯旋转；投影到世界 Y 才不会被呼吸/动画的其它轴污染
    const yawRad = angle * Math.sign(axis.y || 1) * Math.abs(axis.y);
    return {
      spineYawRad: Number(yawRad.toFixed(5)),
      spineYawDeg: Number(THREE.MathUtils.radToDeg(yawRad).toFixed(2)),
      axisY: Number(axis.y.toFixed(3)),
      submittedYawRad: Number(submittedYaw.toFixed(5)),
    };
  }

  /** 内部（ADR 0049 D1）：两个微动作池的只读快照。 */
  microPoolDiagnostics(): { idle: MicroPoolDiag | null; sit: MicroPoolDiag | null } {
    const toDiag = <K extends string>(snap: MicroPoolSnapshot<K> | null): MicroPoolDiag | null => {
      if (!snap) return null;
      const weights: Record<string, number> = {};
      for (const [kind, value] of Object.entries(snap.weights)) {
        weights[kind] = Number((value as number).toFixed(4));
      }
      return {
        active: snap.active,
        weights,
        nextSwitchInMs: snap.nextSwitchInMs,
        switches: snap.switches,
        releases: snap.releases,
        activeForMs: snap.activeForMs,
        holdRemainingMs: snap.holdRemainingMs,
        forced: snap.forced,
      };
    };
    return { idle: toDiag(this.idlePool.snapshot()), sit: toDiag(this.sitPool.snapshot()) };
  }

  /** 内部（ADR 0049 D1，自检取证）：强制某个池的条目（`null` = 解除）。 */
  forceMicroPool(pool: 'idle' | 'sit', kind: string | null): string | null {
    return pool === 'idle' ? this.idlePool.force(kind) : this.sitPool.force(kind);
  }

  /** 内部（ADR 0049 D1，自检压缩时序）：覆盖池的切换间隔（ms）。 */
  setMicroPoolInterval(pool: 'idle' | 'sit', minIntervalMs: number, maxIntervalMs: number): void {
    if (pool === 'idle') this.idlePool.setInterval(minIntervalMs, maxIntervalMs);
    else this.sitPool.setInterval(minIntervalMs, maxIntervalMs);
  }

  /** 内部（ADR 0050）：待机站姿轮换的只读快照（极轻，可 100ms 采样）。 */
  idleVariationDiagnostics(): IdleVariationSnapshot {
    return this.idleVariation.snapshot(
      performance.now(),
      (role) => this.animations?.roles[role].name !== null,
    );
  }

  /**
   * 内部（ADR 0050，自检取证）：强制下一个 tick 换到某个站姿（`null` = 解除）。
   * 非法角色返回 null；**不是**生产接口，不进 IPC。
   */
  forceIdleVariation(role: ClipRole | null): ClipRole | null {
    return this.idleVariation.force(role, performance.now());
  }

  /** 内部（ADR 0050，自检压缩时序）：覆盖站姿轮换间隔（ms）；生产路径不调用。 */
  setIdleVariationInterval(minIntervalMs: number, maxIntervalMs: number): void {
    this.idleVariation.setIdleInterval(minIntervalMs, maxIntervalMs, performance.now());
  }

  /**
   * ADR 0048 D1 / ADR 0051：采一次**站立待机时上半身四根骨骼的局部四元数**
   * （下背 `Spine` / 胸 `Spine1` / 颈 / 头）。
   *
   * 这就是"平视的答案"：站立待机是她看着镜头、玩家也认可的样子。坐姿停帧后直接把这三个
   * **局部**值覆盖上去，上半身的相对姿态即与站立一致——不做差值、不做欧拉分解。
   *
   * 采的条件：纯待机的一帧（没有拖拽/坐姿/一次性演出、朝向回正、Idle 权重 ≥0.9）。
   * 采到就不再更新（她可能换待机变体，但"平视"只认第一次）。
   */
  private captureIdleUpperPose(
    snapshot: HfsmSnapshot,
    oneShot: OneShotStatus | null,
    idleTiltWeight: number,
  ): void {
    if (this.idleUpperLocals !== null) return;
    if (this.sitting || this.sitGain > 0.001 || this.dragging) return;
    if (snapshot.base !== 'idle' || snapshot.physics !== null || oneShot) return;
    if (Math.abs(this.walkYaw) > 0.05) return;
    // ADR 0049 D1：歪头权重非零时采到的头骨带着 roll，不能拿它当"站立姿态"
    if (Number.isFinite(idleTiltWeight) && idleTiltWeight > 0.001) return;
    const bones = this.model?.bones ?? null;
    if (!bones?.head || !bones.neck || !bones.spine1 || !bones.spine) return;
    const idleWeight = (this.animations?.actions() ?? [])
      .filter((action) => action.running)
      .reduce((max, action) => Math.max(max, action.weight), 0);
    if (idleWeight < 0.9) return;
    this.idleUpperLocals = {
      // 必须取**动画基底**，不能取 `bone.quaternion`：后者含上一帧的视线偏移
      // （启动时光标可能停在某个方向），会把"站立平视"采成一个歪头/低头的姿态。
      // `animationBase()` 是 `beginFrame()` 判定的 mixer 产物，不含任何叠加量。
      // 基底链：Spine（下背）→ Spine1（胸）→ Neck → Head。
      // 只覆盖后三根不够：16.2s 的片段下背比 14.7s 更前倾，整条上链会继承这个前倾，
      // 头看起来仍然低（真机 A/B 实测）。下背一起覆盖，上半身才真正"照抄站立"。
      spine: (this.arbiter?.animationBase(bones.spine) ?? bones.spine.quaternion).clone(),
      chest: (this.arbiter?.animationBase(bones.spine1) ?? bones.spine1.quaternion).clone(),
      neck: (this.arbiter?.animationBase(bones.neck) ?? bones.neck.quaternion).clone(),
      head: (this.arbiter?.animationBase(bones.head) ?? bones.head.quaternion).clone(),
    };
    console.log(
      `[render] 站立上半身姿态已记录（下背/胸/颈/头的局部四元数；ADR 0048/0051）`,
    );
  }

  /**
   * ADR 0028 D8：进入 `sitting` 的落座阶段。
   *
   * 顺序是刻意的：先收步（正在走的话立即停），再让 HFSM 进 Physics（这会清空行走排期），
   * 最后播坐姿——`sitting` 期间 Base 层不再有任何调度，她不会在窗口边缘上迈步。
   *
   * ADR 0051：坐姿是**两段式**——`playHold` 播放 14.2–16.2s（`LoopOnce`）：
   * 阶段 A（14.2–16.0s）正常播放，让她自己演"坐下 + 第一次张望"；
   * 阶段 B（16.0–16.2s）继续播到 16.2s 后 clamp，从 16.0s 起 0.3s 淡入站立上半身覆盖
   * 与程序化微动。身体平移补偿仍由 `updateSitGain()` 按 `sitGain × sitDrop` 缩放。
   */
  private enterSit(now: number, edge: 'top' | 'bottom', source: string): void {
    const wasSitting = this.sitting;
    const wasArrived = this.sitArrived;
    this.stopWalk('snap_applied');
    this.hfsm.snapApplied(now);
    this.sitting = true;
    this.sitArrived = true;
    // 首次落座才重置"过渡计时"；改吸另一扇窗时保持当前坐姿（不重播"坐下去"）
    this.sitStartedAt = wasArrived ? this.sitStartedAt : now;
    this.sitEdge = edge;
    this.sitApproach = null;
    if (wasSitting && wasArrived) {
      console.log(`[render] sitting 目标更新 edge=${edge} source=${source}（保持坐姿）`);
      return;
    }
    const held = this.animations?.playHold('sit', SIT_IN_FADE_SECONDS) ?? false;
    this.sitProcedural = !held;
    // ADR 0051：每次首次落座都从 0 开始压弹簧；阶段 A 从片段本地 0（绝对 14.2s）起播。
    this.sitDropSpring.reset();
    this.sitStageBStartedAt = null;
    this.sitStageBGain = 0;
    if (!held) {
      // 降级：悬空姿态 + 下沉 24px + 大腿弯曲 0.45rad（用户原始建议的路径）
      this.playAnimation('held', SIT_IN_FADE_SECONDS, 'snap_applied（无坐姿片段 → 程序化降级）');
      // 没有官方片段就没有阶段 A 可看：直接进阶段 B，让程序化微动立刻接管
      this.sitStageBStartedAt = now;
    }
    // 每次落座都从"刚刚坐好"开始：呼吸相位归零、晃腿/张望重新排期（都带软启动）
    this.sitMotion.reset(now);
    console.log(
      `[render] sitting 开始 edge=${edge} source=${source} ` +
        `clip=${held ? String(this.analogSitClipName()) : '(缺失，程序化降级)'} ` +
        `阶段A=${held ? `${SIT_CLIP_START_SECONDS.toFixed(1)}→16.0s（正放）` : '无'} ` +
        `+ 阶段B 16.0→${SIT_CLIP_HOLD_SECONDS.toFixed(1)}s（0.3s 覆盖淡入）+ 活体微动（ADR 0051）`,
    );
  }

  /** 坐姿片段名（日志用；hold 里是裁剪后的独立 action） */
  private analogSitClipName(): string {
    return this.animations?.roles.sit.name ?? '(missing)';
  }

  /** ADR 0028 D9 / ADR 0034 D5：离开 `sitting` —— 淡出坐姿、站回 Idle，并重新排期行走。 */
  private exitSit(now: number, reason: string): void {
    if (!this.sitting) return;
    this.sitting = false;
    this.sitArrived = false;
    this.sitApproach = null;
    this.sitEdge = null;
    // ADR 0048：上半身覆盖不在这里清 —— 它和呼吸/张望一样乘 `frame.gain`，跟着坐姿微动的
    // 500ms 包络一起淡出；硬清空会让头在起身瞬间"啪"地低下去。
    this.hfsm.snapReleased(now);
    // ADR 0043 D3：不在这里把补偿清零——`playAnimation('idle')` 会交叉淡出坐姿片段，
    // `updateSitGain()` 读到的权重 1→0 就是补偿的退场曲线。
    // ADR 0034 D5：按解除原因播"惊跳/起身"；拖拽由 drag_started 接管，不叠惊跳
    if (reason !== 'dragged') {
      const mapped: StartleReason =
        reason === 'clicked' || reason === 'window-gone' || reason === 'fullscreen'
          ? reason
          : 'command';
      this.startle = {
        reason: mapped,
        startedAt: now,
        durationMs: startleDurationMs(mapped),
      };
      this.startleSurprised = false;
    }
    this.playAnimation('idle', SIT_OUT_FADE_SECONDS, `snap_released(${reason}) → 站立`);
    console.log(`[render] sitting 结束 reason=${reason}`);
  }

  setMouthFrame(frame: number): void {
    const count = MOUTH_FRAME_COUNT;
    const clamped = Math.max(0, Math.min(count - 1, Math.round(frame)));
    if (clamped === this.lipSyncFrame && this.lipSyncDriven) return;
    this.lipSyncFrame = clamped;
    this.lipSyncDriven = true;
    this.applyFacial(performance.now());
  }

  resetMouthFrame(): void {
    this.lipSyncFrame = MOUTH_FRAME_CLOSED;
    this.lipSyncDriven = false;
    this.applyFacial(performance.now());
  }

  setEyeProbe(enabled: boolean): { eyeRects: Rect[]; texture: { width: number; height: number } } | null {
    const facial = this.facial;
    if (!facial) return null;
    const result = facial.debugProbe(enabled);
    console.log(`[render] 眼部准星探针 ${enabled ? '开' : '关'}（ADR 0047 取证）`);
    return result;
  }

  setWalkInterval(minIntervalMs: number, maxIntervalMs: number): void {
    if (!Number.isFinite(minIntervalMs) || !Number.isFinite(maxIntervalMs)) return;
    if (minIntervalMs <= 0 || maxIntervalMs < minIntervalMs) return;
    this.hfsm.setWalkSchedule({ minIntervalMs, maxIntervalMs }, performance.now());
    console.log(`[render] 行走调度间隔改为 ${minIntervalMs}–${maxIntervalMs}ms（自检用）`);
  }

  /** 标定：列出模型里实际存在的骨骼名（归一化前的 three 名字）。 */
  listBones(): string[] {
    const model = this.model;
    if (!model) return [];
    const names: string[] = [];
    for (const bone of Object.values(model.bones)) {
      if (bone) names.push(bone.name);
    }
    return names;
  }

  private findBone(name: string): THREE.Bone | null {
    const model = this.model;
    if (!model || typeof name !== 'string') return null;
    const lower = name.toLowerCase();
    for (const bone of Object.values(model.bones)) {
      if (!bone) continue;
      if (bone.name === name || bone.name.toLowerCase() === lower) return bone;
    }
    return null;
  }

  setDebugBoneOffset(boneName: string, yaw: number, pitch: number, roll: number): boolean {
    const bone = this.findBone(boneName);
    if (!bone) return false;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(roll)) return false;
    this.debugBoneOffsets.set(bone.name, { yaw, pitch, roll });
    console.log(
      `[render] 标定骨骼 ${bone.name}: yaw=${yaw.toFixed(3)} pitch=${pitch.toFixed(3)} roll=${roll.toFixed(3)}`,
    );
    return true;
  }

  clearDebugBoneOffsets(): void {
    if (this.debugBoneOffsets.size > 0) console.log('[render] 清除标定骨骼偏移');
    this.debugBoneOffsets.clear();
  }

  getBoneWorld(boneName: string): { x: number; y: number; z: number } | null {
    const bone = this.findBone(boneName);
    if (!bone) return null;
    this.scene.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    bone.getWorldPosition(world);
    return { x: world.x, y: world.y, z: world.z };
  }

  /**
   * 诊断（阶段 14）：遍历场景里所有 Mesh/SkinnedMesh，回答"手在哪块网格、
   * 材质是不是 Basic、贴图在不在、贴图色彩空间是什么、手部 UV 采到什么颜色"。
   * 只读，不改变渲染状态。
   */
  inspectMaterials(): MeshMaterialFacts[] {
    return inspectMeshMaterials(this.model ? this.model.root : this.scene);
  }

  /** 诊断：只把手/小臂的顶点染色（保留贴图），用来证明"红的那块就是手"。 */
  tintSkinVertices(
    scope: 'none' | 'hand' | 'both',
    color: [number, number, number] = [1, 0, 0],
  ): { meshes: number; handVertices: number; forearmVertices: number } {
    const root = this.model ? this.model.root : this.scene;
    const result = tintSkinVertices(root, scope, color);
    console.log(
      `[render] 诊断：顶点染色 scope=${scope} meshes=${result.meshes} ` +
        `hand=${result.handVertices} forearm=${result.forearmVertices}`,
    );
    return result;
  }

  /** 诊断：把 Body 材质整体换成纯红（证明手与衣服/腿共用同一块网格与材质）。 */
  testHandMaterial(color = 0xff0000): { materialName: string; meshes: string[] } | null {
    if (!this.model) return null;
    const name =
      this.model.materialNames.find((candidate) => /^CH0335_Body$/i.test(candidate)) ??
      this.model.materialNames.find((candidate) => /body/i.test(candidate)) ??
      null;
    if (!name) return null;
    this.diagnosticMaterialRestore?.();
    const replacement = replaceMaterialByName(this.model.root, name, color);
    this.diagnosticMaterialRestore = replacement.restore;
    console.log(`[render] 诊断：材质 ${name} → 纯色 #${color.toString(16)}，覆盖网格=${replacement.meshes.join('|')}`);
    return { materialName: name, meshes: replacement.meshes };
  }

  /**
   * 诊断（ADR 0037）：开/关全局光照 + Toon。
   * 关闭 = 摘掉两盏灯并把身体/头发还原成原始 `MeshBasicMaterial` —— 这就是
   * "引入光照之前"的样子，可直接用于 before/after 截图对照。
   */
  setToonShading(enabled: boolean): ToonShadingDiagnostics {
    this.toon.setEnabled(enabled);
    const diagnostics = this.toon.diagnostics();
    console.log(
      `[render] 诊断：Toon ${enabled ? '开' : '关'} materials=${diagnostics.materials.length} ` +
        `steps=[${diagnostics.gradientSteps.join(',')}]`,
    );
    return diagnostics;
  }

  /**
   * 诊断（ADR 0038）：开/关背面法描边。
   * 关闭只是把描边壳 `visible=false`——主体、材质、骨骼一律不动，所以可以
   * 在同一姿态下拍到"有描边 / 无描边"两张只差轮廓线的图。
   */
  setOutline(enabled: boolean): OutlineDiagnostics {
    this.outline.setEnabled(enabled);
    const diagnostics = this.outline.diagnostics();
    console.log(
      `[render] 诊断：描边 ${enabled ? '开' : '关'} meshes=${diagnostics.meshes.length} ` +
        `width=${diagnostics.width}px color=${diagnostics.color}`,
    );
    return diagnostics;
  }

  /**
   * 诊断（ADR 0038 任务二）：把光环换成 Toon，看"发光体吃光"是否更好看。
   *
   * 只在同页诊断里用；`false` 会还原成原始 `MeshBasicMaterial`。
   */
  setHaloToon(enabled: boolean): { enabled: boolean; meshes: string[]; material: string | null } {
    const model = this.model;
    if (!model) return { enabled: false, meshes: [], material: null };

    if (!enabled) {
      const restore = this.haloToonRestore;
      if (restore) {
        for (const [mesh, material] of restore) mesh.material = material;
        this.haloToonRestore = null;
      }
      console.log('[render] 诊断：光环还原为无光照材质');
      return { enabled: false, meshes: restore ? [...restore.keys()].map((mesh) => mesh.name) : [], material: null };
    }

    if (!this.haloToonRestore) {
      const restore = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
      model.root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material || mesh.name.endsWith('__outline')) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (!materials.some((material) => /halo/i.test(material.name || ''))) return;
        restore.set(mesh, mesh.material);
        const source = materials[0]!;
        const toonMaterial = this.toon.toToonMaterial(source);
        mesh.material = Array.isArray(mesh.material) ? [toonMaterial] : toonMaterial;
      });
      this.haloToonRestore = restore;
    }

    const meshes = [...this.haloToonRestore.keys()].map((mesh) => mesh.name);
    console.log(`[render] 诊断：光环换成 Toon meshes=${meshes.join('|') || '(none)'}`);
    return { enabled: true, meshes, material: meshes.length > 0 ? 'MeshToonMaterial' : null };
  }

  /** 诊断：恢复生产材质与顶点色（必须在诊断结束后调用）。 */
  resetMaterialDiagnostics(): void {
    this.diagnosticMaterialRestore?.();
    this.diagnosticMaterialRestore = null;
    if (this.model) restoreVertexColorDiagnostics(this.model.root);
    console.log('[render] 诊断：材质与顶点色已恢复');
  }

  /** 诊断：双手骨骼的内容区 CSS 坐标（截图取样用；窗口坐标原点在左上角）。 */
  handScreenPoints(): {
    left: { x: number; y: number } | null;
    right: { x: number; y: number } | null;
  } | null {
    if (!this.model) return null;
    return {
      left: this.boneCss(this.model.bones.handL),
      right: this.boneCss(this.model.bones.handR),
    };
  }

  noteGrabPoint(cssX: number, cssY: number, at: number = performance.now()): void {
    if (!Number.isFinite(cssX) || !Number.isFinite(cssY)) return;
    const band = this.classifyGrab(cssX, cssY);
    this.pendingGrab = { band, cssX, cssY, at };
    console.log(`[render] 抓取候选 band=${band} at=(${Math.round(cssX)},${Math.round(cssY)})`);
  }

  /** 抓取分类（ADR 0035 D1）：骨骼最近点优先，掩膜 bbox 三段带兜底。 */
  private classifyGrab(cssX: number, cssY: number): DragBand {
    const model = this.model;
    const bbox = this.maskCapture.snapshot().bbox;
    const width = Math.max(1, this.width);
    const height = Math.max(1, this.height);
    if (model) {
      const head = this.boneCss(model.bones.head);
      const pelvis = this.boneCss(model.bones.pelvis ?? model.bones.spine ?? model.bones.spine1);
      const footL = this.boneCss(model.bones.footL);
      const footR = this.boneCss(model.bones.footR);
      const foot = pickNearestPoint({ x: cssX, y: cssY }, [footL, footR]);
      if (head && pelvis && foot) {
        const point = { x: cssX, y: cssY };
        const dHead = distance(point, head);
        const dBody = distance(point, pelvis);
        const dFoot = distance(point, foot);
        // 头部：接近头骨，且不低到胸口以下
        if (point.y <= head.y + height * 0.08 && dHead <= height * 0.18) return 'head';
        // 脚部：接近脚骨，且落在下半身
        if (point.y >= foot.y - height * 0.12 && dFoot <= height * 0.16) return 'foot';
        if (dFoot < dBody * 0.75 && point.y > height * 0.72) return 'foot';
        if (dHead < dBody * 0.6 && point.y < height * 0.45) return 'head';
        return 'body';
      }
    }
    if (bbox) {
      const { mx, my } = cssToMask(cssX, cssY, width, height);
      return grabBandAt(bbox, mx, my) ?? 'body';
    }
    return 'body';
  }

  private boneCss(bone: THREE.Bone | null): { x: number; y: number } | null {
    if (!bone) return null;
    this.scene.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    bone.getWorldPosition(world);
    return {
      x: this.width / 2 + world.x,
      y: this.height / 2 - world.y,
    };
  }

  /**
   * 抓取点为支点（ADR 0035 D2）：**用真实按下点**而不是骨骼中心。
   *
   * 按下点已经过掩膜命中（alpha ≥ 0.5），就是"手抓住的那个像素"；用骨骼中心会让
   * 抓头发时支点跑到头部中心（实测差 140px），看起来像"站在光标旁边"。
   * `band` 只决定姿态，不决定支点。
   */
  private computeDragPivot(band: DragBand, cssX: number, cssY: number): {
    local: { x: number; y: number };
    css: { x: number; y: number };
  } {
    void band;
    return {
      // animationRoot 的常态原点 = 内容区底边中心：local = (x - W/2, y - 0) with y up
      local: { x: cssX - this.width / 2, y: this.height - cssY },
      css: { x: cssX, y: cssY },
    };
  }

  /**
   * 支撑点运动（ADR 0035 D3）：窗口 screenX/Y → 速度 → 加速度。
   * 两级 EMA + 死区 + 限幅，压住 1px 量化噪声；只在拖拽/回弹时被消费。
   */
  private updateSupportMotion(now: number): void {
    const x = window.screenX;
    const y = window.screenY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const previous = this.supportSample;
    if (!previous) {
      this.supportSample = { x, y, at: now };
      return;
    }
    const dtMs = now - previous.at;
    if (!(dtMs > 0) || dtMs > 250) {
      this.supportSample = { x, y, at: now };
      this.supportVelocity = { x: 0, y: 0 };
      return;
    }

    const rawVx = ((x - previous.x) / dtMs) * 1000;
    const rawVy = ((y - previous.y) / dtMs) * 1000;
    const velocityAlpha = 1 - Math.exp(-dtMs / DRAG_SUPPORT_VELOCITY_EMA_MS);
    const previousVx = this.supportVelocity.x;
    const previousVy = this.supportVelocity.y;
    const vx = previousVx + (rawVx - previousVx) * velocityAlpha;
    const vy = previousVy + (rawVy - previousVy) * velocityAlpha;

    const rawAx = ((vx - previousVx) / dtMs) * 1000;
    const rawAy = ((vy - previousVy) / dtMs) * 1000;
    const accelAlpha = 1 - Math.exp(-dtMs / DRAG_SUPPORT_ACCEL_EMA_MS);
    let ax = this.supportAcceleration.x + (rawAx - this.supportAcceleration.x) * accelAlpha;
    let ay = this.supportAcceleration.y + (rawAy - this.supportAcceleration.y) * accelAlpha;
    if (Math.abs(ax) < DRAG_SUPPORT_ACCEL_DEADBAND) ax = 0;
    if (Math.abs(ay) < DRAG_SUPPORT_ACCEL_DEADBAND) ay = 0;
    ax = Math.max(-DRAG_SUPPORT_ACCEL_MAX, Math.min(DRAG_SUPPORT_ACCEL_MAX, ax));
    ay = Math.max(-DRAG_SUPPORT_ACCEL_MAX, Math.min(DRAG_SUPPORT_ACCEL_MAX, ay));

    this.supportVelocity = { x: vx, y: vy };
    this.supportAcceleration = { x: ax, y: ay };
    this.supportSample = { x, y, at: now };
  }

  getState(): RenderState {
    const snapshot = this.hfsm.snapshot();
    return {
      base: snapshot.base,
      overlay: snapshot.overlay,
      physics: snapshot.physics,
      emotion: this.emotion,
      speakingUtteranceId: snapshot.speakingUtteranceId,
      // 契约 §7.1（ADR 0008）：Orch.idle = 编排层没有在途话语
      orchestrator: 'idle',
      // §7.3：只有真实模型加载成功（且关键骨骼齐全）才是 ready
      modelReady: this.ready,
    };
  }

  getDiagnostics(): RenderDiagnostics {
    const model = this.model;
    const now = performance.now();
    const snapshot = this.hfsm.snapshot();
    const pat = this.patState(now);

    return {
      ready: this.ready,
      loading: this.loading,
      error: this.error,
      modelId: model?.modelId ?? null,
      loadMs: model?.loadMs ?? null,
      frame: model?.frame ?? null,
      scene: model?.scene ?? null,
      pixelsPerUnit: model?.pixelsPerUnit ?? null,
      content: { width: this.width, height: this.height },
      bones: {
        head: model?.bones.head?.name ?? null,
        eyeL: model?.bones.eyeL?.name ?? null,
        eyeR: model?.bones.eyeR?.name ?? null,
        pelvis: model?.bones.pelvis?.name ?? null,
      },
      hasMorphTargets: model?.hasMorphTargets ?? false,
      meshNames: model?.meshNames ?? [],
      materialNames: model?.materialNames ?? [],
      hiddenMeshes: model?.hiddenMeshes ?? [],
      triangles: model?.triangleCount ?? 0,
      mouth: {
        materialName: model?.mouthMaterialName ?? null,
        sourceTexture: model?.mouthSourceTexture?.name ?? null,
        atlasLoaded: this.atlasLoaded,
        calibrated: this.facial?.calibrated ?? false,
      },
      gaze: this.gazeDiagnostics() ?? {
        yaw: 0,
        pitch: 0,
        targetYaw: 0,
        targetPitch: 0,
        idle: true,
        submitted: false,
        eyeYaw: 0,
        eyePitch: 0,
        spineYaw: 0,
        phase: 'idle',
        sinceCursorMs: Number.POSITIVE_INFINITY,
        spineBone: null,
      },
      animation: this.animations
        ? {
            clipCount: this.animations.clipNames.length,
            clips: this.animations.clipNames,
            idle: {
              name: this.animations.selection.idle.name,
              reason: this.animations.selection.idle.reason,
              preferred: this.animations.selection.idle.preferred,
            },
            held: {
              name: this.animations.selection.held.name,
              reason: this.animations.selection.held.reason,
              preferred: this.animations.selection.held.preferred,
            },
            walk: {
              name: this.animations.selection.walk.name,
              reason: this.animations.selection.walk.reason,
              preferred: this.animations.selection.walk.preferred,
            },
            current: this.animations.current(),
            actions: this.animations.actions(),
            groundCorrectionPx:
              model && this.groundMinYLocal !== null
                ? Number((-this.groundMinYLocal * model.pixelsPerUnit).toFixed(1))
                : null,
          }
        : null,
      facial: this.facialDiagnostics(now, pat.active),
      hfsm: snapshot,
      motion: {
        base: snapshot.base,
        physics: snapshot.physics,
        walking: this.walkingPlan,
        nextWalkInMs:
          this.hfsm.nextWalkAt === null ? null : Math.max(0, Math.round(this.hfsm.nextWalkAt - now)),
        walkYaw: this.walkYaw,
        walkYawTarget: this.walkYawTarget,
      },
      drag: {
        phase: this.dragging
          ? 'dragged'
          : snapshot.physics === 'settling'
            ? 'settling'
            : 'idle',
        band: this.dragPoseGain > 0.001 ? this.dragBand : null,
        pivot: {
          x: Number(this.dragPivotCss.x.toFixed(1)),
          y: Number(this.dragPivotCss.y.toFixed(1)),
        },
        angle: Number(this.dragAngle.toFixed(4)),
        omega: Number(this.dragPendulum.angularVelocity.toFixed(4)),
        gain: Number(this.dragPoseGain.toFixed(3)),
        supportAcceleration: {
          x: Number(this.supportAcceleration.x.toFixed(1)),
          y: Number(this.supportAcceleration.y.toFixed(1)),
        },
        landingImpact: this.landing?.impact ?? null,
        landingSquash: Number(this.landingSquash.toFixed(4)),
        /** 最近一次落地冲击（缓冲只有 220ms，`getDiagnostics` 读不到时用它事后断言） */
        lastLandingImpact: Number(this.lastLandingImpact.toFixed(3)),
        lastLandingSquash: Number(this.lastLandingSquash.toFixed(4)),
        landingCount: this.landingCount,
        startle: this.startle?.reason ?? null,
      },
      sit: (() => {
        const weight = this.sitRoleWeight;
        const held = this.animations?.hold() ?? null;
        const sitDrop = this.sitDropSpring.value();
        const pose = this.sitPoseGain > 0.001 ? sitPose(sitDrop, this.sitProcedural) : null;
        const shift = this.sitOffsetPx();
        return {
          sitting: this.sitting,
          arrived: this.sitArrived,
          approach: this.sitApproach
            ? {
                mode: this.sitApproach.mode,
                durationMs: this.sitApproach.durationMs,
                progress: Number(
                  Math.min(1, (now - this.sitApproach.startedAt) / this.sitApproach.durationMs).toFixed(3),
                ),
              }
            : null,
          edge: this.sitEdge,
          procedural: this.sitProcedural,
          // ADR 0044 D1：坐姿回到"停帧"（`playHold`）——姿态来自官方片段，
          // 运动全部来自 `sit-motion`；片段名从 hold 取。
          clip: held?.name ?? null,
          done: held ? held.done : null,
          /** ADR 0044 D1：不再循环（停帧），字段保留只为不破坏诊断形状 */
          looping: false,
          /** ADR 0043 D3：坐姿混合权重（补偿与姿态都用它插值；0 = 完全站姿） */
          blend: Number(this.sitGain.toFixed(3)),
          /** 片段自身的权重（诊断用：与 `blend` 对照可看出降级路径） */
          clipWeight: Number(weight.toFixed(3)),
          dropPx: Number(((pose?.dropPx ?? 0) * this.sitPoseGain).toFixed(2)),
          transition: Number((pose?.transition ?? 1).toFixed(3)),
          /** ADR 0051：两段式与弹簧的状态（自检/真机取证） */
          stage: this.sitStageBStartedAt === null ? 'a' : 'b',
          stageBBlend: Number(this.sitStageBGain.toFixed(3)),
          sitDrop: Number(sitDrop.toFixed(3)),
          sitPoseGain: Number(this.sitPoseGain.toFixed(3)),
          upperOverride: Number(this.sitUpperOverride.toFixed(3)),
          phaseAHeadTuneRad: SIT_PHASE_A_HEAD_TUNE_RAD,
          phaseAHeadAppliedRad: Number(this.sitPhaseAHeadApplied.toFixed(4)),
          spineOverlayWeight: SIT_SPINE_OVERLAY_WEIGHT,
          spineOverlayApplied: Number(this.sitSpineOverlay.toFixed(3)),
          holdAtSeconds: SIT_CLIP_HOLD_SECONDS,
          holdTimeSeconds: held ? Number(held.time.toFixed(3)) : null,
          transitionLiftPx: Number(((pose?.transitionLiftPx ?? 0) * this.sitPoseGain).toFixed(2)),
          offsetPx: {
            x: Number((shift.x * this.sitPoseGain).toFixed(1)),
            y: Number((shift.y * this.sitPoseGain).toFixed(1)),
          },
          rawOffsetPx: { x: Number(shift.x.toFixed(1)), y: Number(shift.y.toFixed(1)) },
          /** ADR 0046 D3.1：当前微侧身偏航（rad） */
          bodyYaw: Number(this.sitBodyYaw.toFixed(4)),
          /** ADR 0044：活体微动（呼吸/张望/晃腿）的当前值 */
          motion: (() => {
            const frame = this.sitMotion.frame();
            if (!frame) return null;
            return {
              gain: Number(frame.gain.toFixed(3)),
              breathPx: Number(frame.breathFloatPx.toFixed(3)),
              spinePitch: Number(frame.spinePitch.toFixed(5)),
              claviclePitch: Number(frame.claviclePitch.toFixed(5)),
              upperArmPitch: Number(frame.upperArmPitch.toFixed(5)),
              gaze: {
                yaw: Number(frame.gazeYaw.toFixed(4)),
                pitch: Number(frame.gazePitch.toFixed(4)),
                targetYaw: Number(frame.targetYaw.toFixed(4)),
                targetPitch: Number(frame.targetPitch.toFixed(4)),
                targetKind: frame.targetKind,
                nextInMs: frame.nextGazeInMs,
              },
              eye: {
                yaw: Number(frame.eyeYaw.toFixed(4)),
                pitch: Number(frame.eyePitch.toFixed(4)),
              },
              legs: {
                gain: Number(frame.legGain.toFixed(3)),
                thighL: Number(frame.thighPitchL.toFixed(4)),
                thighR: Number(frame.thighPitchR.toFixed(4)),
                calfL: Number(frame.calfPitchL.toFixed(4)),
                calfR: Number(frame.calfPitchR.toFixed(4)),
              },
            };
          })(),
          /** ADR 0048 D2：当前人工微调量（rad，正 = 低头；键盘 ↑/↓ 现场调） */
          headTune: Number(this.sitHeadTune.toFixed(4)),
          /** ADR 0048 D1 / ADR 0051：站立上半身姿态是否已记录（下背/胸/颈/头四根） */
          idleUpperCaptured: this.idleUpperLocals !== null,
          /**
           * 头骨**当前**相对绑定姿态的 pitch / yaw（含张望）。
           * 用途：判断"头有没有在动"（范围）。绝对世界欧拉角在 y≈±90° 附近会退化，
           * 拿它量摆动幅度会把 0.24rad 的张望读成 0.02rad（ADR 0047 踩过）。
           */
          headOrientation: (() => {
            const head = this.model?.bones.head ?? null;
            const bind = this.headBindWorld;
            if (!head || !bind) return null;
            const world = head.getWorldQuaternion(new THREE.Quaternion());
            const delta = headTiltFromBind(world, bind);
            return {
              pitch: Number(headWorldPitch(delta).toFixed(4)),
              yaw: Number(headWorldYaw(delta).toFixed(4)),
            };
          })(),
          headQuat: (() => {
            const head = this.model?.bones.head ?? null;
            if (!head) return null;
            const q = head.quaternion;
            return [
              Number(q.x.toFixed(5)),
              Number(q.y.toFixed(5)),
              Number(q.z.toFixed(5)),
              Number(q.w.toFixed(5)),
            ] as [number, number, number, number];
          })(),
          /**
           * 眼球**相对头骨**的 pitch / yaw（含张望）。
           *
           * ADR 0047 D3：这才是"她眼神有没有跟上头"的口径。眼骨基底已被换成绑定姿态，
           * 所以这个值 ≈ 张望量本身；如果它明显非零，说明眼球与头的朝向不一致（斜视/死鱼眼）。
           * 旧口径（相对绑定姿态）把"头的姿态"也算进眼球里，取证时看不出问题在哪。
           */
          eyeOrientation: (() => {
            const eye = this.model?.bones.eyeL ?? this.model?.bones.eyeR ?? null;
            const head = this.model?.bones.head ?? null;
            if (!eye || !head) return null;
            const eyeWorld = eye.getWorldQuaternion(new THREE.Quaternion());
            const headWorld = head.getWorldQuaternion(new THREE.Quaternion());
            const delta = headWorld.invert().multiply(eyeWorld);
            return {
              pitch: Number(headWorldPitch(delta).toFixed(4)),
              yaw: Number(headWorldYaw(delta).toFixed(4)),
            };
          })(),
          /** 头骨世界坐标（px，内容区坐标系） */
          headWorld: (() => {
            const head = this.model?.bones.head ?? null;
            if (!head) return null;
            const world = new THREE.Vector3();
            head.getWorldPosition(world);
            return { x: Number(world.x.toFixed(1)), y: Number(world.y.toFixed(1)) };
          })(),
          headBase: (() => {
            const head = this.model?.bones.head ?? null;
            const entry = head
              ? this.arbiter?.snapshot().find((item) => item.bone === head.name) ?? null
              : null;
            return entry
              ? {
                  baseFrom: entry.baseFrom,
                  yaw: Number(entry.yaw.toFixed(4)),
                  pitch: Number(entry.pitch.toFixed(4)),
                  roll: Number(entry.roll.toFixed(4)),
                }
              : null;
          })(),
        };
      })(),
      pat,
      /** ADR 0050：待机静态站姿轮换（当前角色 / 下一次倒计时 / 候选池） */
      idleVariation: this.idleVariation.snapshot(now, (role) => this.animations?.roles[role].name !== null),
      speech: { frame: this.lipSyncFrame, driven: this.lipSyncDriven },
      /** ADR 0049 D1：微动作池（idle / sitting）的只读快照 */
      microPool: this.microPoolDiagnostics(),
      toon: this.toon.diagnostics(),
      outline: this.outline.diagnostics(),
      render: {
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        frameMs: Math.round(this.frameMsEma * 10) / 10,
      },
      probePoints: this.computeProbePoints(),
    };
  }

  /**
   * 自检用的探针点（不是生产路径）：
   * - head：**头骨位置 + 少量下偏**（ADR 0040 的圆心；占位/无骨骼时退回取景包围盒顶部 17%）；
   * - body：优先用 Pelvis 骨骼的世界位置，缺失时退回取景包围盒 45% 高度。
   */
  private computeProbePoints(): {
    head: { x: number; y: number } | null;
    body: { x: number; y: number } | null;
  } {
    const model = this.model;
    if (!model) return { head: null, body: null };

    const frame = model.frame;
    const frameHeight = Math.max(1e-9, frame.maxY - frame.minY);
    const pixelsPerUnit = model.pixelsPerUnit;
    const centerX = this.width / 2;

    // ADR 0040：摸头点位改成"头骨 + 下偏"，这样自检点与生产判据（头骨半径）同一基准。
    // 下偏 1% 窗口高度（≈7px）只是为了让点位落在"脸"上而不是骨骼原点（颈根）。
    const headCss = this.headCssNow();
    const headPoint = headCss
      ? { x: headCss.x, y: Number((headCss.y + this.height * 0.01).toFixed(1)) }
      : {
          x: centerX,
          y: this.height - (frame.maxY - frameHeight * 0.17 - frame.minY) * pixelsPerUnit,
        };

    let bodyY = this.height - (frame.minY + frameHeight * 0.45) * pixelsPerUnit;
    if (model.bones.pelvis) {
      model.root.updateMatrixWorld(true);
      const world = new THREE.Vector3();
      model.bones.pelvis.getWorldPosition(world);
      bodyY = this.height / 2 - world.y;
    }

    return {
      head: headPoint,
      body: { x: centerX, y: bodyY },
    };
  }

  dispose(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.maskCapture.stop();
    this.model?.dispose();
    this.placeholder?.dispose();
    this.toon.dispose();
    this.outline.dispose();
    this.renderer.dispose();
  }

  private handleFrame = (): void => {
    const now = performance.now();
    this.updateFrame(now);
    // 特写相机每帧重新对焦（张望/呼吸会动头）；关闭时是空操作
    if (this.faceZoomSize > 0) this.applyCameraFrustum();
    this.renderer.render(this.scene, this.camera);

    // ADR 0039 排查打点（只读）：摸头片段真的在跑吗？权重真的是 1 吗？
    // 这一条专门用来排除"被 playHold / crossFade / 残留 settle 权重盖住"的说法。
    if (this.patWeightCheckAt !== null && now >= this.patWeightCheckAt) {
      this.patWeightCheckAt = null;
      const one = this.animations?.oneShot() ?? null;
      const running = (this.animations?.actions() ?? []).filter((action) =>
        action.name.includes('Victory_Start_Random'),
      );
      console.log(
        `[render] 摸头片段回报：oneShot=${String(one?.name ?? null)} ` +
          `time=${one ? one.time.toFixed(2) : '-'}/${one ? one.duration.toFixed(2) : '-'} ` +
          `weight=${one ? one.weight.toFixed(2) : '-'} paused=${String(one?.paused ?? null)} ` +
          `enabled=${String(one?.enabled ?? null)} ` +
          `（byName 里的同名 action 不计入：pat 用的是裁剪后的独立 action，running=${running.length}） ` +
          `hold=${String(this.animations?.hold()?.name ?? null)} ` +
          `physics=${String(this.hfsm.snapshot().physics)}`,
      );
    }

    // 首帧渲染完成后再发 model_ready（§6.3："加载完成且首帧可渲染"）
    if (this.readyPending && this.model) {
      this.readyPending = false;
      const payload = { modelId: this.model.modelId, loadMs: this.model.loadMs };
      this.options.onModelReady?.(payload);
      console.log(
        `[render] model_ready modelId=${payload.modelId} loadMs=${Math.round(payload.loadMs)}`,
      );
    }

    this.frameHandle = requestAnimationFrame(this.handleFrame);
  };

  private updateFrame(now: number): void {
    const dt = Math.min(100, Math.max(0, now - this.lastFrameAt)) / 1000;
    // ADR 0038：帧时间 EMA（α=0.05）——给"描边有没有拖慢帧率"一个可读的数
    this.frameMsEma += ((dt * 1000) - this.frameMsEma) * 0.05;
    this.lastFrameAt = now;
    this.updateSupportMotion(now);

    // 拖拽姿态增益：进入 180ms 淡入、松手 420ms 淡出（ADR 0035 D2）
    const dragTarget = this.dragging ? 1 : 0;
    const dragRamp = this.dragging ? DRAG_POSE_RAMP_MS : DRAG_RELEASE_POSE_FADE_MS;
    const dragAlpha = 1 - Math.exp((-dt * 1000) / Math.max(1, dragRamp));
    this.dragPoseGain += (dragTarget - this.dragPoseGain) * dragAlpha;
    if (!this.dragging && this.dragPoseGain < 0.001) this.dragPoseGain = 0;

    // HFSM：一次性反应自愈 + Base 层行走调度（§4.1 / ADR 0024 D1）
    const hfsmTick = this.hfsm.tick(now);
    if (hfsmTick.startWalk) this.beginWalk(hfsmTick.startWalk, now);

    // ADR 0026 D1：行走朝向指数逼近（与 look 共用 Y 轴通道，见第 6 步）
    this.walkYaw = approach(this.walkYaw, this.walkYawTarget, dt, 9);

    const oneShot = this.animations?.oneShot() ?? null;
    const snapshot = this.hfsm.snapshot();

    // ADR 0050：待机站姿轮换（20–45s，0.8s 交叉淡入）。旧的一次性小动作已删除。
    this.updateIdleVariation(now, snapshot, oneShot !== null);

    /**
     * ADR 0049 D1：微动作池抽签（15–30s 一次，过渡用指数插值）。
     *
     * - idle 池只在"纯站立待机"时计时（拖拽 / 坐姿 / 行走 / 一次性演出 / 空闲小动作都不算），
     *   不满足时权重平滑归零，回到待机再从 15–30s 重新计时；
     * - sitting 池只在"已落座"时计时（接近阶段不算——那一段她还在走/跳）。
     */
    const idlePoolActive =
      !this.dragging &&
      !this.sitting &&
      !oneShot &&
      snapshot.base === 'idle' &&
      snapshot.physics === null &&
      // ADR 0049 D1：说话不属于"纯站立待机"（ADR 0050 顺手补上这条漏判）
      snapshot.speakingUtteranceId === null;
    const idlePool = this.idlePool.update(now, dt, idlePoolActive);
    const sitPoolActive = this.sitting && this.sitArrived && !this.dragging;
    const sitPool = this.sitPool.update(now, dt, sitPoolActive);

    // ADR 0048 D1：站立待机时把下背/胸/颈/头的**动画基底**记下来（"平视的答案"）。
    // 为什么放在 `beginFrame()` 之后：`animationBase()` 只有在这一步才是本帧 mixer 的产物；
    // 放在 mixer 之前会读到绑定姿态/上一帧基底，坐姿覆盖就会把"T-pose 的头"抄过去。
    // ADR 0049 D1：**歪头进行中不采**——否则坐姿会把"歪着的头"当成站立姿态照抄。
    this.captureIdleUpperPose(snapshot, oneShot, idlePool.weights.headTilt ?? 0);

    // 0) 仲裁器在 mixer.update **之前**记下受控骨骼的四元数：第 2 步靠"这中间变没变"
    //    判断动画有没有重写该骨骼。three 的 `PropertyMixer.apply()` 在片段停帧后会
    //    跳过冗余写入，旧的"比较我上次写的值"判据在浮点噪声下会误判 → 偏移逐帧累积
    //    （真机表现：坐姿时头疯狂打转，实测 2.5 rad/s）。
    this.arbiter?.capture();

    // 1) AnimationMixer（ADR 0014 D1：全帧只允许在这里 update）
    this.animations?.update(dt);

    // 1.5) ADR 0028 D8：光环挂在头骨上（它不在骨骼层级里，任何片段都不会驱动它）
    this.updateHalo();

    // 2) 骨骼仲裁：抓取本帧动画基底并清零叠加量
    this.arbiter?.beginFrame();

    // 2.0) ADR 0048 D1：站立待机的下背/胸/颈/头基底（必须在 `beginFrame()` 之后采，
    //      才能拿到本帧 mixer 的干净产物；见 `captureIdleUpperPose()` 的注释）。
    this.captureIdleUpperPose(snapshot, oneShot, idlePool.weights.headTilt ?? 0);

    // 2.1) ADR 0048 D1 / ADR 0051：坐姿时**直接用站立姿态的局部四元数覆盖**
    //      下背/胸/颈/头，在 `applySitMotion()` 里按阶段 B 的 0.3s 权重完成。

    // 3) 视线通道叠加（合成在动画姿态之上，而不是覆盖绑定姿态）
    //
    // ADR 0044 D3：**坐姿期间彻底关闭光标视线**。她坐着的时候会自己左右张望
    // （`sit-motion` 的自主张望调度器负责），不再死盯光标。
    const sitMotionOn = this.sitPoseActive && this.sitGain > 0.01;
    if (this.gaze && this.arbiter && !sitMotionOn) {
      this.gaze.update(now, this.width, this.height, this.arbiter);
    }

    // 3.1) ADR 0049 D1：idle 池的「偶尔歪头」——叠加在视线之上的 roll 通道。
    //      权重是池给的 0..1（换条目时指数交叉淡入淡出），所以歪头不会瞬切；
    //      池不活跃时权重自然衰减到 0，进入坐姿/拖拽的过渡里也不会硬切。
    const idleTilt = idlePool.weights.headTilt ?? 0;
    if (idleTilt > 0.001 && this.arbiter) {
      const head = this.model?.bones.head ?? null;
      const neck = this.model?.bones.neck ?? null;
      if (head) {
        this.arbiter.add(
          head,
          IDLE_TILT_HEAD_YAW_RAD * idleTilt,
          0,
          IDLE_TILT_HEAD_ROLL_RAD * idleTilt,
        );
      }
      if (neck) {
        this.arbiter.add(neck, 0, 0, IDLE_TILT_HEAD_ROLL_RAD * IDLE_TILT_NECK_SHARE * idleTilt);
      }
    }

    // 4) 反应通道叠加：摸头**没有**任何程序化姿态（ADR 0039 D2），
    //    这里只剩坐姿降级时的弯腿；官方片段自己会动身体。
    const pat = this.patState(now);
    // 摸头反应结束（官方片段播完 / 表情窗口到期）时把表情还原：
    // `applyFacial` 是事件驱动的，不会每帧自己重画。
    if (pat.active !== this.lastPatActive) {
      this.lastPatActive = pat.active;
      this.applyFacial(now, true);
    }
    // ADR 0043 D3：坐姿混合权重（片段权重当插值因子；程序化降级退回时间包络）。
    // 必须在 mixer.update 之后算：权重是这一帧混合结算后的结果。
    this.updateSitGain(dt);
    // ADR 0051：下坐弹簧 + 两段式阶段（阶段 B 在片段本地 1.8s = 绝对 16.0s 触发）。
    this.updateSitStage(now, dt);
    const sitDrop = this.sitDropSpring.value();
    this.sitPoseGain = this.sitGain * sitDrop;
    this.sitUpperOverride = Math.min(1, this.sitStageBGain * this.sitPoseGain);
    /**
     * ADR 0051 D7：阶段 A 的抬头补偿。
     *
     * 只在阶段 A（stageBBlend=0）满额；阶段 B 的 0.3s 覆盖把它线性/缓动收到 0，
     * 所以 16.0s 不会"啪"地抬头。它叠在片段姿态之上（`add`），不是覆盖基底；
     * 阶段 B 时 `applySitMotion()` 的站立覆盖会接管头骨基底，二者相加过渡。
     */
    this.sitPhaseAHeadApplied =
      SIT_PHASE_A_HEAD_TUNE_RAD * this.sitPoseGain * (1 - this.sitStageBGain);
    if (Math.abs(this.sitPhaseAHeadApplied) > 1e-6 && this.arbiter) {
      const head = this.model?.bones.head ?? null;
      if (head) this.arbiter.add(head, 0, this.sitPhaseAHeadApplied);
    }
    this.sitSpineOverlay = this.sitUpperOverride * Math.min(1, Math.max(0, SIT_SPINE_OVERLAY_WEIGHT));
    // ADR 0046 D3.1：微侧身 —— 身体先侧 0.15rad（按 sitPoseGain 淡入淡出），
    // 头部的基准在标定时已扣掉这个偏航，所以不会把侧身转回去。
    this.sitBodyYaw = SIT_BODY_YAW_RAD * this.sitPoseGain;
    // ADR 0028 D8 / ADR 0043 D3 / ADR 0051：坐姿姿态只在**已落座且增益 > 0** 时参与，
    // 且每一项都乘 `sitGain × sitDrop` —— 进场（0→1）、弹簧下坐与退场（1→0）都不会硬切。
    const sit = this.sitPoseGain > 0.001 ? sitPose(sitDrop, this.sitProcedural) : null;
    if (sit && sit.thighBend !== 0 && this.arbiter) {
      for (const thigh of [this.model?.bones.thighL ?? null, this.model?.bones.thighR ?? null]) {
        if (thigh) this.arbiter.add(thigh, 0, -sit.thighBend * this.sitPoseGain);
      }
    }

    // 4.1) 坐姿活体微动（ADR 0044 / ADR 0051）：阶段 A 不启用，让官方片段自己演；
    //      阶段 B 起才把呼吸/自主张望/晃腿叠上去（`frame.gain` 有 500ms 软启动）。
    //      `active` 只在"已落座且已进入阶段 B"时为真：解除坐姿后由 `sit-motion` 自淡出。
    const stageBActive = this.sitting && this.sitArrived && this.sitStageBStartedAt !== null;
    const motion = this.sitMotion.update(now, dt, stageBActive);
    this.applySitMotion(motion, sitPool.weights);

    // 4.2) 拖拽姿态（ADR 0041 D1）：**不再有任何按部位手写的骨骼偏移**。
    //      悬空姿态由官方片段 `Formation_Pickup` 给出；这里只剩第 6 步的
    //      "整身绕抓取点旋转"（θ）与它的位置补偿。

    // 4.3) 落地冲击（ADR 0035 D4）：以 scale.y 为主，脊柱/膝盖只做小辅助
    let landingSquash = 0;
    this.landingSquash = 0;
    if (this.landing) {
      const elapsed = now - this.landing.startedAt;
      if (elapsed >= LANDING_DURATION_MS) {
        console.log(
          `[render] 落地缓冲结束（${String(this.landing.impact.toFixed(2))}）` +
            ` 峰值 scale.y 压扁=${this.landingPeakSquash.toFixed(4)}（ADR 0035 D4）`,
        );
        this.landing = null;
      } else {
        const pose = landingPose(elapsed, this.landing.impact);
        landingSquash = pose.squash;
        if (this.arbiter) {
          const spine = this.model?.bones.spine ?? null;
          const neck = this.model?.bones.neck ?? null;
          if (spine) this.arbiter.add(spine, 0, pose.spinePitch);
          if (neck) this.arbiter.add(neck, 0, pose.neckPitch);
          // 标定：thigh 负 pitch = 腿往前抬（膝盖前屈）；calf 正 pitch = 小腿往后
          for (const thigh of [this.model?.bones.thighL ?? null, this.model?.bones.thighR ?? null]) {
            if (thigh) this.arbiter.add(thigh, 0, -pose.kneeBend);
          }
          for (const calf of [this.model?.bones.calfL ?? null, this.model?.bones.calfR ?? null]) {
            if (calf) this.arbiter.add(calf, 0, pose.kneeBend * 0.8);
          }
          for (const arm of [this.model?.bones.upperArmL ?? null, this.model?.bones.upperArmR ?? null]) {
            if (arm) this.arbiter.add(arm, 0, pose.armPitch);
          }
        }
        this.landingSquash = landingSquash;
        if (landingSquash > this.landingPeakSquash) this.landingPeakSquash = landingSquash;
        if (landingSquash > this.lastLandingSquash) this.lastLandingSquash = landingSquash;
      }
    }

    // 4.4) 惊跳起身（ADR 0034 D5）：根变换在 step 6，骨骼与表情在这里
    let startleX = 0;
    let startleY = 0;
    let startleSquash = 0;
    if (this.startle) {
      const pose = startlePose(this.startle.reason, now - this.startle.startedAt);
      if (!pose.active) {
        this.startle = null;
        if (this.startleSurprised) {
          this.startleSurprised = false;
          this.applyFacial(now);
        }
      } else {
        startleX = pose.rootX;
        startleY = pose.rootY;
        startleSquash = pose.squash;
        if (pose.surprised !== this.startleSurprised) {
          this.startleSurprised = pose.surprised;
          this.applyFacial(now, true);
        }
        if (this.arbiter) {
          const spine = this.model?.bones.spine ?? null;
          const neck = this.model?.bones.neck ?? null;
          const head = this.model?.bones.head ?? null;
          if (spine) this.arbiter.add(spine, 0, pose.spinePitch);
          if (neck) this.arbiter.add(neck, 0, pose.neckPitch);
          if (head) this.arbiter.add(head, pose.headYaw, 0);
          const armL = this.model?.bones.upperArmL ?? null;
          const armR = this.model?.bones.upperArmR ?? null;
          // 标定：负 roll 把两侧手臂都抬起（不是镜像）
          if (armL) this.arbiter.add(armL, 0, 0, -pose.armRoll);
          if (armR) this.arbiter.add(armR, 0, 0, -pose.armRoll);
        }
      }
    }

    // 4.45) 程序化反应的骨骼通道：`nod` 只低头（头骨 + 一小份颈骨），
    //       不再用 `animationRoot.scale.y` 压扁整身（ADR 0039 D2：反应通道没有 squash）。
    if (this.reaction?.spec.headPitch && this.arbiter) {
      const progress = (now - this.reaction.startedAt) / this.reaction.spec.durationMs;
      if (progress < 1) {
        const envelope = Math.sin(Math.PI * Math.max(0, progress));
        const head = this.model?.bones.head ?? null;
        const neck = this.model?.bones.neck ?? null;
        const pitch = this.reaction.spec.headPitch * envelope;
        // ADR 0035 D5 标定：pitch > 0 = 低头
        if (head) this.arbiter.add(head, 0, pitch);
        if (neck) this.arbiter.add(neck, 0, pitch * 0.35);
      }
    }

    // 4.5) 标定偏移（ADR 0035 D5）：只用于确认骨骼轴向，生产姿态不依赖它
    if (this.arbiter && this.debugBoneOffsets.size > 0) {
      for (const [name, offset] of this.debugBoneOffsets) {
        const bone = this.findBone(name);
        if (bone) this.arbiter.add(bone, offset.yaw, offset.pitch, offset.roll);
      }
    }

    // 5) 写回最终四元数（每根受控骨骼只写一次）
    this.arbiter?.endFrame();

    // 6) Physics / 反应根变换
    let hop = 0;
    let tilt = 0;
    let look = 0;

    if (this.reaction) {
      const { spec, startedAt } = this.reaction;
      const progress = (now - startedAt) / spec.durationMs;
      if (progress >= 1) {
        this.reaction = null;
      } else {
        const envelope = Math.sin(Math.PI * progress);
        hop += (spec.hopPx ?? 0) * envelope;
        if (spec.tilt) {
          tilt += spec.oscillate
            ? spec.tilt * Math.sin(progress * Math.PI * 6) * envelope
            : spec.tilt * envelope;
        }
        look += (spec.look ?? 0) * envelope;
      }
    }

    // ADR 0035 D3：受迫单摆。拖拽中由支撑加速度驱动；松手后保留角速度自然衰减。
    let dragAngle = 0;
    if (this.dragging || this.dragPoseGain > 0.001) {
      const forcing = this.dragging
        ? {
            accelerationX: this.supportAcceleration.x,
            accelerationY: this.supportAcceleration.y,
          }
        : { accelerationX: 0, accelerationY: 0 };
      this.dragPendulum = stepDragPendulum(this.dragPendulum, this.dragBand, {
        dtSeconds: dt,
        forcing,
        nowMs: now,
      });
      dragAngle =
        (this.dragPendulum.angle + struggleOffset(this.dragBand, now, this.dragPoseGain)) *
        this.dragPoseGain;
    }
    this.dragAngle = dragAngle;

    // ADR 0035 D2：绕抓取点旋转，保持支点不动（补偿二维旋转带来的位移）
    const pivotShift = pivotCompensation(this.dragPivot, dragAngle);

    // ADR 0028 D8 / ADR 0043 D3 / ADR 0044 D5：
    // 坐姿的平移补偿是**窗口内的表现**，不参与窗口位置（窗口由 shell 定）；片段自带的身体平移
    // 用 `sitOffsetPx()` 抵消，保证"身体中心 = 窗口中线、最低点 = 窗口底边"。
    //
    // **补偿必须按坐姿混合权重缩放**：片段把身体搬到 (+257, -287)px，站姿时补偿必须是 0；
    // 旧实现直接用满值 → `snap_applied` 那一帧模型瞬移近 390px（真机"乱平移/出边框"的根因）。
    //
    // **呼吸与微动与补偿解耦**（ADR 0044 D5 / ADR 0051）：补偿只跟 `sitGain × sitDrop`，
    // 微动只走 `sit-motion`，两者相加而不是相乘 —— 呼吸的 ±0.9px 永远不会放大到补偿量上去。
    const sitRaw = this.sitOffsetPx();
    const sitShift = { x: sitRaw.x * this.sitPoseGain, y: sitRaw.y * this.sitPoseGain };
    const breathFloatPx = sitMotionOn ? this.sitMotion.frame()?.breathFloatPx ?? 0 : 0;
    this.animationRoot.position.x = sitShift.x + pivotShift.x + startleX;
    this.animationRoot.position.y =
      -this.height / 2 +
      hop -
      (sit?.dropPx ?? 0) * this.sitPoseGain +
      (sit?.transitionLiftPx ?? 0) * this.sitPoseGain +
      // ADR 0044 D2：呼吸的整体高低浮动，**≤1px**（常量 SIT_BREATH_FLOAT_PX）
      breathFloatPx +
      sitShift.y +
      pivotShift.y +
      startleY;
    this.animationRoot.rotation.z =
      tilt +
      dragAngle +
      (sit?.lean ?? 0) * this.sitPoseGain;
    // 转身 / `look` 反应 / 坐姿微侧身共用同一个 Y 轴通道：叠加而不是互相覆盖
    // ADR 0045 D1：根节点的偏航只剩"行走朝向"与"视线/反应"两个来源；
    // 原来的 `fidgetYaw`（原地转圈）已删除。ADR 0046 D3.1 新增坐姿微侧身。
    this.animationRoot.rotation.y = look + this.walkYaw + this.sitBodyYaw;
    // 根节点的竖向缩放只剩"落地缓冲"与"惊跳"；呼吸改由脊柱/颈的微小旋转表达
    // （缩放会把整个身体连头发一起放大，读起来像"心跳"——ADR 0043 D4 的旧做法已废止）。
    this.animationRoot.scale.set(1, 1 - landingSquash - startleSquash, 1);
  }
}

/** 渲染侧一次创建两个对象：§7.3 的公共接口，以及内部的掩膜采集器。 */
export interface RenderBundle {
  module: RenderModule;
  mask: MaskCapture;
}

export function createRenderModule(
  canvas: HTMLCanvasElement,
  options: RenderModuleOptions = {},
): RenderBundle {
  const instance = new StageRender(canvas, options);
  return { module: instance, mask: instance.maskCapture };
}
