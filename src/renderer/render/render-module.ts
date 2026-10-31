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
import { MOUTH_FRAME_CLOSED, REBOUND_SETTLE_MS } from '../../shared/constants';
import type { BroadcastEvent } from '../../shared/events';
import { isIntent } from '../../shared/intents';
import type { Bounds3 } from '../../shared/model-frame';
import { DEFAULT_FRAME_EXCLUDE } from '../../shared/model-frame';
import type { Emotion, Intent, RenderState } from '../../shared/types';
import { createModelAnimations } from './animation-controller';
import type { ActionStatus, AnimationSlot, ModelAnimations } from './animation-controller';
import { createBoneArbiter } from './bone-arbiter';
import type { BoneArbiter } from './bone-arbiter';
import type { ClipRole } from './clip-bank';
import { approach, walkYawFor, EMOTION_FACE, EMOTION_FADE_MS, fadeProgress, resolveMouthOwner } from './emotion-face';
import type { BlushLevel, EmotionFace, EyeAssetKey, MouthOwner, MouthShape } from './emotion-face';
import { loadExpressionAssets } from './expression-assets';
import type { ExpressionAssets, PixelImage } from './expression-assets';
import { createFaceDecal } from './face-decal';
import type { FaceDecal, FaceDecalDiagnostics } from './face-decal';
import { collectFacialGeometry } from './facial-geometry';
import {
  CH0335_MOUTH_LAYOUT,
  createBlushChannel,
  createFacialChannel,
  loadMouthAtlas,
} from './facial-texture';
import type {
  BlushChannel,
  FacialChannel,
  FacialChannelDiagnostics,
  MouthLayer,
} from './facial-texture';
import { DECAL_FACE_FILES } from '../../shared/expression-files';
import { createGazeController } from './gaze';
import type { GazeController, GazeState } from './gaze';
import { createHfsm } from './hfsm';
import type { Hfsm, HfsmSnapshot, WalkPlan } from './hfsm';
import { createMaskCapture } from './mask-capture';
import type { MaskCapture } from './mask-capture';
import { loadModel, measureAnimatedMinY, placeModel } from './model-loader';
import type { LoadedModel } from './model-loader';
import { PAT_DURATION_MS, PAT_MOUTH_FRAME, patPose } from './pat-react';
import type { PatPose } from './pat-react';
import { createCapsulePlaceholder, PLACEHOLDER_BOTTOM_MARGIN_PX } from './placeholder';
import type { PlaceholderModel } from './placeholder';

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

/** 拖拽期间的"整体轻微摇摆"与"被拎起"抬升（不写骨骼，只转/抬 animationRoot）。 */
const DRAG_SWAY_PERIOD_S = 1.6;
const DRAG_SWAY_RAD = 0.05;
const DRAG_SWAY_RAMP_MS = 220;
const DRAG_LIFT_PX = 18;
const DRAG_LIFT_SMOOTHING = 12;

/** 待机姿态轮换（ADR 0023 D5）：22–40s 在 Cafe_Idle / Formation_Idle 之间换。 */
const IDLE_VARIANT_ROLES: readonly ClipRole[] = ['idle', 'idle.alt1'];
const IDLE_VARIANT_MIN_MS = 22_000;
const IDLE_VARIANT_MAX_MS = 40_000;
const IDLE_VARIANT_FADE_SECONDS = 0.8;

/**
 * 官方片段接线表（ADR 0023 D2）：只有这里列出的 intent 会用模型自带片段，
 * 缺失时退回下面的程序化反应。`nod` / `shake_head` / `tilt_head` / `look_at_user` 没有片段。
 */
const INTENT_CLIP: Partial<Record<Intent, ClipRole>> = {
  greet: 'greet',
  happy_hop: 'happy',
};

interface ReactionSpec {
  durationMs: number;
  hopPx?: number;
  squash?: number;
  tilt?: number;
  /** 摆动型（摇头）而非保持型（歪头） */
  oscillate?: boolean;
  look?: number;
}

/**
 * 非 pat_react 的程序化反应：只用位移/缩放/旋转表达，不引入新状态名或 intent。
 * pat_react 走 pat-react.ts 的三通道合成（头部后仰 + 嘴型）。
 */
const REACTIONS: Record<Exclude<Intent, 'none' | 'pat_react'>, ReactionSpec> = {
  greet: { durationMs: 700, hopPx: 18, look: 0.18 },
  nod: { durationMs: 380, squash: 0.06 },
  shake_head: { durationMs: 460, tilt: 0.13, oscillate: true },
  tilt_head: { durationMs: 1400, tilt: 0.2 },
  look_at_user: { durationMs: 600, look: 0.22 },
  happy_hop: { durationMs: 720, hopPx: 34 },
};

/** 加载成功但缺少这些骨骼时，按 §7.3 视为"骨骼缺失"整体回退（ADR 0009 D6）。 */
const REQUIRED_BONES = ['head', 'eyeL', 'eyeR'] as const;

/** 嘴型图集帧数（8×8；PAT_MOUTH_FRAME 的 frameCount 参数）。 */
const MOUTH_FRAME_COUNT = CH0335_MOUTH_LAYOUT.columns * CH0335_MOUTH_LAYOUT.rows;

/**
 * 表情嘴型用的**官方图集帧**（High 图集 8×8，行优先）。
 * 只取"看得出情绪"的几帧：轻微张口 / 小口 / 张口。
 */
const EMOTION_MOUTH_FRAME = 1;

/** 贴花调试色（`PET_DECAL_DEBUG=red` 等）：只用于核对平面位置，不进生产。 */
const DEBUG_DECAL_COLORS: Record<string, number> = {
  red: 0xff0000,
  green: 0x00ff00,
  blue: 0x0000ff,
  yellow: 0xffff00,
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
  active: boolean;
  weight: number;
  allowMouthChange: boolean;
  mouthFrame: number | null;
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
  gaze: { yaw: number; pitch: number; targetYaw: number; targetPitch: number; idle: boolean; submitted: boolean };
  animation: AnimationDiagnostics | null;
  /** 面部贴图通道（ADR 0026）；null = 未启用 */
  facial: FacialDiagnostics | null;
  /** 官方线稿贴花层（ADR 0026 D7）；null = 未启用 */
  decal: FaceDecalDiagnostics | null;
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
  pat: PatDiagnostics;
  speech: { frame: number; driven: boolean };
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
  /** 内部：语音播放器的口型驱动入口（ADR 0015 D4） */
  setMouthFrame(frame: number): void;
  /** 内部：交还闭嘴帧（`speech_ended` / 打断时调用） */
  resetMouthFrame(): void;
  /** 内部：`evt:broadcast` 的渲染侧入口（§6.3 白名单已由 preload 校验） */
  handleEvent(event: BroadcastEvent): void;
  /** 内部：自检/诊断用（不属于 §7.3） */
  getDiagnostics(): RenderDiagnostics;
  /** 内部：自检把 20–40s 的行走调度压到 1.5–2s */
  setWalkInterval(minIntervalMs: number, maxIntervalMs: number): void;
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
  /**
   * 视觉调试（ADR 0027 D3 的"破坏性实验"）：`red` / `green` / `blue` 时，
   * 贴花平面改用纯色渲染，并隐藏原 EyeMouth 网格——用来核对平面位置与尺寸。
   */
  decalDebug?: string;
}

class StageRender implements RenderModule {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
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

  /** 内部接口：掩膜采集（由 RenderBundle 持有，不属于 §7.3） */
  readonly maskCapture: MaskCapture;

  private readonly startedAt = performance.now();
  private frameHandle: number | null = null;
  private width = 0;
  private height = 0;
  private lastFrameAt = performance.now();

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
  private dragSwayGain = 0;
  private dragLiftPx = 0;
  private patMouthActive = false;
  /** 摸头是否由官方整身片段承担（true 时不再叠加程序化头部偏移，ADR 0023 D4） */
  private officialPat = false;
  /** 下一次待机姿态轮换的时刻（performance.now 基准） */
  private idleVariantAt = 0;
  private idleVariantRole: ClipRole = 'idle';
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

  /** 官方线稿贴花层（ADR 0026 D7）：眨眼线 + 嘴线，挂在头骨上 */
  private decal: FaceDecal | null = null;
  /** 下一次眨眼的时刻 */
  private nextBlinkAt = 0;
  /** 当前眨眼动画的起点；null = 不在眨眼 */
  private blinkStartedAt: number | null = null;

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

      if (this.placeholder) {
        this.animationRoot.remove(this.placeholder.group);
        this.placeholder.dispose();
        this.placeholder = null;
      }
      this.animationRoot.add(loaded.root);
      this.applyPlacement();

      this.setupAnimations(loaded);
      this.calibrateGround();

      this.arbiter = createBoneArbiter();
      for (const bone of [loaded.bones.head, loaded.bones.eyeL, loaded.bones.eyeR]) {
        if (bone) this.arbiter.register(bone);
      }
      this.gaze = createGazeController(loaded.bones);

      void this.attachFacialChannel();
      void this.attachFaceDecal();

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
    this.idleVariantRole = 'idle';
    this.scheduleIdleVariant(performance.now());
    // 让首帧动作权重生效，随后才能做地面校正的蒙皮采样
    animations.update(0);
    model.root.updateMatrixWorld(true);
  }

  private playAnimation(slot: AnimationSlot, fadeSeconds: number, reason: string): void {
    if (!this.animations) return;
    const ok = this.animations.play(slot, fadeSeconds);
    const current = this.animations.current();
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

  /** ADR 0023 D5：排下一次待机姿态轮换。 */
  private scheduleIdleVariant(now: number): void {
    const span = IDLE_VARIANT_MAX_MS - IDLE_VARIANT_MIN_MS;
    this.idleVariantAt = now + IDLE_VARIANT_MIN_MS + Math.random() * span;
  }

  /** ADR 0023 D5：在待机姿态之间交叉淡入，避免长时间看出循环。 */
  private rotateIdleVariant(now: number): void {
    this.scheduleIdleVariant(now);
    const animations = this.animations;
    if (!animations || IDLE_VARIANT_ROLES.length < 2) return;
    const candidates = IDLE_VARIANT_ROLES.filter((role) => role !== this.idleVariantRole);
    if (candidates.length === 0) return;
    const role = candidates[Math.floor(Math.random() * candidates.length)];
    if (animations.playRole(role, IDLE_VARIANT_FADE_SECONDS, 'idle')) {
      this.idleVariantRole = role;
      console.log(`[render] 待机姿态轮换 → ${role}=${String(animations.roles[role].name)}`);
    }
  }

  /**
   * ADR 0024 D1：进入 `walking`。
   * 位移**不使用动画里的 root motion**——窗口位置由 `cmd:walk` 交给 shell 的纯函数物理，
   * 这里只负责换动作与记录计划。
   */
  private beginWalk(plan: WalkPlan, now: number): void {
    this.walkingPlan = plan;
    this.scheduleIdleVariant(now);
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

  /** 摸头姿态（ADR 0014 D6）：头部后仰/侧倾 + 身体前倾，按 `sin(πp)` 包络。 */
  private patState(now: number): { pose: PatPose; progress: number } | null {
    const snapshot = this.hfsm.snapshot();
    const reaction = snapshot.reaction;
    if (!reaction) return null;
    const isPat = reaction.kind === 'head_patted' || reaction.intent === 'pat_react';
    if (!isPat) return null;
    const progress = (now - reaction.startedAt) / reaction.durationMs;
    if (progress >= 1) return null;
    const speaking = snapshot.speakingUtteranceId !== null;
    return { pose: patPose(progress, speaking), progress };
  }

  /** 摸头的表情通道：非说话时切 shy 嘴型；说话时让位给口型（§5.2 / §5.3）。 */
  private syncPatMouth(pat: { pose: PatPose } | null): void {
    const shouldPaint = pat !== null && pat.pose.allowMouthChange;
    if (shouldPaint && !this.patMouthActive) {
      this.patMouthActive = true;
      return;
    }
    if (!shouldPaint) this.restorePatMouth();
  }

  /** 交还嘴型通道（回到静态闭嘴底图）。幂等。 */
  private restorePatMouth(): void {
    if (!this.patMouthActive) return;
    this.patMouthActive = false;
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
    const pat = this.patState(now);
    const patActive = pat !== null;
    const effective: Emotion = patActive ? 'shy' : this.emotion;

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
      patActive,
      emotionMouth: face.mouth,
      alpha,
    });

    let layer: MouthLayer;
    if (owner === 'lip-sync') {
      layer = { kind: 'atlas', frame: this.lipSyncFrame, frameCount: MOUTH_FRAME_COUNT };
    } else if (owner === 'pat') {
      layer = { kind: 'atlas', frame: PAT_MOUTH_FRAME, frameCount: MOUTH_FRAME_COUNT };
    } else if (owner === 'emotion') {
      // 表情嘴型改用**官方高清图集帧**，不再用 Canvas 画的 `glyph`
      // （ADR 0026 D6.6：嘴型/眼型/腮红的每个像素都必须来自图片）
      layer = { kind: 'atlas', frame: EMOTION_MOUTH_FRAME, frameCount: MOUTH_FRAME_COUNT };
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

  private facialDiagnostics(now: number, pat: { pose: PatPose } | null): FacialDiagnostics | null {
    const facial = this.facial;
    if (!facial) return null;
    const snapshot = this.hfsm.snapshot();
    const speaking = snapshot.speakingUtteranceId !== null;
    const effective: Emotion = pat ? 'shy' : this.emotion;
    const face: EmotionFace = EMOTION_FACE[effective] ?? EMOTION_FACE.neutral;
    const alpha = fadeProgress(now - this.emotionFadeStartedAt, EMOTION_FADE_MS);
    const owner = resolveMouthOwner({
      speaking,
      lipSyncDriven: this.lipSyncDriven,
      patActive: pat !== null,
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
   * 官方线稿贴花层（ADR 0026 D7）。
   *
   * 线稿来自 `FX_TEX_CH0335_Img_Face_01.png`（官方给 3D 小人做表情用的 3×3 线稿），
   * 挂在头骨下、参与深度测试，因此随动画走且会被刘海正确遮挡。
   * 贴图缺失时整层不生效，只记一条 WARN（§11）。
   */
  private async attachFaceDecal(): Promise<void> {
    const model = this.model;
    if (!model) return;

    const load = async (file: string): Promise<HTMLImageElement | null> => {
      try {
        const image = new Image();
        image.src = `pet-asset://asset/expr/${file}`;
        await image.decode();
        return image;
      } catch {
        return null;
      }
    };
    const [eyesClosed, mouthLine, mouthOpen] = await Promise.all([
      load(DECAL_FACE_FILES.eyesClosed),
      load(DECAL_FACE_FILES.mouthLine),
      load(DECAL_FACE_FILES.mouthOpen),
    ]);

    if (!eyesClosed && !mouthLine) {
      console.warn('[render] 面部线稿贴图缺失，贴花层不启用（§11）');
      return;
    }

    this.decal = createFaceDecal({
      headBone: model.bones.head,
      root: model.root,
      meshes: model.meshes,
      assets: { eyesClosed, mouthLine, mouthOpen, blush: null },
      debugColor: DEBUG_DECAL_COLORS[this.options.decalDebug ?? ''] ?? null,
    });

    // 调试：隐藏原 EyeMouth，只留贴花平面，便于核对位置/尺寸
    if (this.options.decalDebug === 'blink') {
      // 只为了截图：强制闭眼线稿常亮，不隐藏原眼（用于判断"叠在原眼上"的观感）
      this.decal.setBlink(1);
      console.log('[render] 贴花调试：强制眨眼');
    } else if (this.options.decalDebug) {
      const mouthMaterial = this.model?.mouthMaterial ?? null;
      if (mouthMaterial) mouthMaterial.visible = false;
      const world = new THREE.Vector3();
      this.decal.debugWorldPositions().forEach((entry, index) => {
        world.set(entry[0], entry[1], entry[2]);
        console.log(
          `[render] 贴花平面#${index} world=(${entry.map((v) => v.toFixed(2)).join(',')})`,
        );
      });
      console.log(`[render] 贴花调试模式 decalDebug=${this.options.decalDebug}（已隐藏 EyeMouth）`);
    }
    this.scheduleBlink(performance.now());

    const diag = this.decal.diagnostics();
    console.log(
      `[render] 面部贴花 ready=${String(diag.ready)} eyePlanes=${diag.eyePlanes} ` +
        `mouth=${String(diag.mouth)} blush=${String(diag.blush)} ` +
        `eyeCenter=${diag.eyeCenter?.map((value) => value.toFixed(6)).join(',') ?? '(none)'} ` +
        `eyePatch=${diag.eyePatch ? `${diag.eyePatch[0].toFixed(1)}x${diag.eyePatch[1].toFixed(1)}` : '-'} ` +
        `mouthPatch=${diag.mouthPatch ? `${diag.mouthPatch[0].toFixed(1)}x${diag.mouthPatch[1].toFixed(1)}` : '-'} ` +
        `reason=${diag.reason ?? '-'}`,
    );
  }

  /** 眨眼间隔 2.6–6s（随机，避免机械感）。 */
  private scheduleBlink(now: number): void {
    this.nextBlinkAt = now + 2600 + Math.random() * 3400;
  }

  /** 每帧推进眨眼：三角包络 0→1→0，总时长 140ms。 */
  private updateBlink(now: number): void {
    const decal = this.decal;
    if (!decal) return;

    if (this.blinkStartedAt === null) {
      if (now < this.nextBlinkAt) {
        decal.update();
        return;
      }
      this.blinkStartedAt = now;
    }

    const elapsed = now - this.blinkStartedAt;
    const duration = 140;
    if (elapsed >= duration) {
      decal.setBlink(0);
      this.blinkStartedAt = null;
      this.scheduleBlink(now);
    } else {
      const progress = elapsed / duration;
      decal.setBlink(progress < 0.5 ? progress * 2 : (1 - progress) * 2);
    }
    decal.update();
  }

  /** 拖拽期间的轻微摇摆（ADR 0014 D3）。 */
  private dragSway(now: number): number {
    if (this.dragStartedAt === null || this.dragSwayGain <= 0.001) return 0;
    const elapsedMs = Math.max(0, now - this.dragStartedAt);
    const ramp = Math.min(1, elapsedMs / DRAG_SWAY_RAMP_MS);
    const phase = (elapsedMs / 1000 / DRAG_SWAY_PERIOD_S) * Math.PI * 2;
    return Math.sin(phase) * DRAG_SWAY_RAD * ramp * this.dragSwayGain;
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
      this.placeholder.group.position.y = -this.height / 2 + PLACEHOLDER_BOTTOM_MARGIN_PX;
    }
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(this.width, this.height, false);
    this.animationRoot.position.y = -this.height / 2;
    this.applyPlacement();
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

    // ADR 0024 D3：回弹期间不接受新的动作意图（唯一例外是重新拖拽）
    if (this.hfsm.snapshot().physics === 'settling') {
      console.log(`[render] settling 期间忽略 intent=${intent}（ADR 0024 D3）`);
      return;
    }

    if (intent === 'pat_react') {
      // 与 head_patted 同一条反应路径（§4.4：低权重混合，不得打断口型）
      this.hfsm.intent(now, intent, PAT_DURATION_MS);
      console.log('[render] pat_react（intent 命令）→ reacting');
      return;
    }

    const spec = REACTIONS[intent];
    if (!spec) return;
    // ADR 0023 D2：有官方片段就整身播，没有就退回程序化位移/缩放
    const role = INTENT_CLIP[intent];
    const played = role ? this.playOfficial(role, 'idle', `intent ${intent}`) : false;
    const clipMs = played ? this.oneShotDurationMs() : 0;
    this.reaction = played ? null : { spec, startedAt: now };
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
        this.restorePatMouth();
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
        // ADR 0024 D3：回弹期间不接受新的摸头（重新拖拽除外）
        if (this.hfsm.snapshot().physics === 'settling') {
          console.log('[render] settling 期间忽略 head_patted（ADR 0024 D3）');
          break;
        }
        const speaking = this.hfsm.snapshot().speakingUtteranceId !== null;
        // §5.3 / ADR 0023 D4：说话期间整身片段会让位给口型通道，退回程序化摸头
        const played = !speaking && this.playOfficial('pat', 'idle', 'head_patted');
        this.officialPat = played;
        const clipMs = played ? this.oneShotDurationMs() : 0;
        this.hfsm.headPatted(now, clipMs > 0 ? clipMs : undefined);
        console.log(
          `[render] head_patted → reacting patCount=${payload.patCount}` +
            `（${played ? '官方片段' : '程序化'}）`,
        );
        break;
      }
      case 'drag_started': {
        // §4.1：`walking` 的退出条件之一是被拖拽打断
        this.stopWalk('drag_started');
        this.hfsm.dragStarted(now);
        this.dragStartedAt = now;
        this.dragging = true;
        this.playAnimation('held', DRAG_IN_CROSSFADE_SECONDS, 'drag_started');
        break;
      }
      case 'drag_released': {
        // D-6 / ADR 0024 D3：松手先进入 settling，回弹过程中淡回 Idle
        this.hfsm.dragReleased(now);
        this.dragging = false;
        this.playAnimation('idle', SETTLE_FADE_SECONDS, 'drag_released → settling（回弹中）');
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
          // 落地缓冲：极短的下蹲（ADR 0024 D3），不参与窗口位移
          this.reaction = {
            spec: { durationMs: 180, squash: 0.06 },
            startedAt: now,
          };
          console.log(`[render] 回弹结束（${reason}）→ 落地缓冲 180ms`);
        }
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

  setWalkInterval(minIntervalMs: number, maxIntervalMs: number): void {
    if (!Number.isFinite(minIntervalMs) || !Number.isFinite(maxIntervalMs)) return;
    if (minIntervalMs <= 0 || maxIntervalMs < minIntervalMs) return;
    this.hfsm.setWalkSchedule({ minIntervalMs, maxIntervalMs }, performance.now());
    console.log(`[render] 行走调度间隔改为 ${minIntervalMs}–${maxIntervalMs}ms（自检用）`);
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
      gaze: this.gaze?.state() ?? {
        yaw: 0,
        pitch: 0,
        targetYaw: 0,
        targetPitch: 0,
        idle: true,
        submitted: false,
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
      facial: this.facialDiagnostics(now, this.patState(now)),
      decal: this.decal?.diagnostics() ?? null,
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
      pat: (() => {
        const pat = this.patState(now);
        return {
          active: pat !== null,
          weight: pat?.pose.weight ?? 0,
          allowMouthChange: pat?.pose.allowMouthChange ?? true,
          mouthFrame: this.patMouthActive ? PAT_MOUTH_FRAME : 0,
        };
      })(),
      speech: { frame: this.lipSyncFrame, driven: this.lipSyncDriven },
      probePoints: this.computeProbePoints(),
    };
  }

  /**
   * 自检用的探针点（不是生产路径）：
   * - head：取景包围盒顶部往下 17%（落在 R-10 掩膜头部带内）；
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
    const headUnitY = frame.maxY - frameHeight * 0.17;
    const headY = this.height - (headUnitY - frame.minY) * pixelsPerUnit;
    const centerX = this.width / 2;

    let bodyY = this.height - (frame.minY + frameHeight * 0.45) * pixelsPerUnit;
    if (model.bones.pelvis) {
      model.root.updateMatrixWorld(true);
      const world = new THREE.Vector3();
      model.bones.pelvis.getWorldPosition(world);
      bodyY = this.height / 2 - world.y;
    }

    return {
      head: { x: centerX, y: headY },
      body: { x: centerX, y: bodyY },
    };
  }

  dispose(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.maskCapture.stop();
    this.model?.dispose();
    this.placeholder?.dispose();
    this.renderer.dispose();
  }

  private handleFrame = (): void => {
    const now = performance.now();
    this.updateFrame(now);
    this.renderer.render(this.scene, this.camera);

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
    this.lastFrameAt = now;

    // HFSM：一次性反应自愈 + Base 层行走调度（§4.1 / ADR 0024 D1）
    const hfsmTick = this.hfsm.tick(now);
    if (hfsmTick.startWalk) this.beginWalk(hfsmTick.startWalk, now);

    // ADR 0026 D1：行走朝向指数逼近（与 look 共用 Y 轴通道，见第 6 步）
    this.walkYaw = approach(this.walkYaw, this.walkYawTarget, dt, 9);

    const oneShot = this.animations?.oneShot() ?? null;
    this.officialPat = oneShot?.role === 'pat';
    const snapshot = this.hfsm.snapshot();

    // ADR 0023 D5：空闲时轮换待机姿态（拖拽、行走与一次性演出期间不换）
    if (
      !this.dragging &&
      !oneShot &&
      snapshot.base === 'idle' &&
      snapshot.physics === null &&
      now >= this.idleVariantAt
    ) {
      this.rotateIdleVariant(now);
    }

    // 1) AnimationMixer（ADR 0014 D1：全帧只允许在这里 update）
    this.animations?.update(dt);

    // 2) 骨骼仲裁：抓取本帧动画基底并清零叠加量
    this.arbiter?.beginFrame();

    // 3) 视线通道叠加（合成在动画姿态之上，而不是覆盖绑定姿态）
    if (this.gaze && this.arbiter) {
      this.gaze.update(now, this.width, this.height, this.arbiter);
    }

    // 4) 反应通道叠加（pat_react 的头部后仰/侧倾）
    const pat = this.patState(now);
    const head = this.model?.bones.head ?? null;
    // 官方片段自己会动头/动身体，程序化后仰、侧倾只在降级路径叠加（ADR 0023 D4）
    if (pat && head && this.arbiter && !this.officialPat) {
      this.arbiter.add(head, 0, pat.pose.headPitch, pat.pose.headRoll);
    }
    this.syncPatMouth(pat);

    // 5) 写回最终四元数（每根受控骨骼只写一次）
    this.arbiter?.endFrame();

    // 6) Physics / 反应根变换
    let hop = 0;
    let tilt = 0;
    let look = 0;
    let squash = 0;

    if (this.reaction) {
      const { spec, startedAt } = this.reaction;
      const progress = (now - startedAt) / spec.durationMs;
      if (progress >= 1) {
        this.reaction = null;
      } else {
        const envelope = Math.sin(Math.PI * progress);
        hop += (spec.hopPx ?? 0) * envelope;
        squash += (spec.squash ?? 0) * envelope;
        if (spec.tilt) {
          tilt += spec.oscillate
            ? spec.tilt * Math.sin(progress * Math.PI * 6) * envelope
            : spec.tilt * envelope;
        }
        look += (spec.look ?? 0) * envelope;
      }
    }

    const draggingTarget = this.dragging ? 1 : 0;
    const liftTarget = this.dragging ? DRAG_LIFT_PX : 0;
    const smooth = 1 - Math.exp(-DRAG_LIFT_SMOOTHING * dt);
    this.dragSwayGain += (draggingTarget - this.dragSwayGain) * smooth;
    this.dragLiftPx += (liftTarget - this.dragLiftPx) * smooth;

    const sway = this.dragSway(now);
    this.animationRoot.position.y = -this.height / 2 + hop - this.dragLiftPx;
    this.animationRoot.rotation.z =
      tilt + sway + (this.officialPat ? 0 : (pat?.pose.bodyLean ?? 0));
    // 转身与 `look` 反应共用同一个 Y 轴通道：叠加而不是互相覆盖
    this.animationRoot.rotation.y = look + this.walkYaw;
    this.animationRoot.scale.set(1, 1 - squash, 1);

    // 7) 面部：表情/口型合成（脏矩形重绘）+ 官方线稿贴花（眨眼）
    this.applyFacial(now);
    this.updateBlink(now);
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
