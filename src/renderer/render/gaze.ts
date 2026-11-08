/**
 * 视线跟随与微动（ADR 0009 D6、ADR 0010 D1、ADR 0014 D2；ADR 0049 D2 改为三级阻尼）。
 *
 * 本模块**不写骨骼**：只计算三组角度，交给骨骼仲裁器以加法方式叠加在
 * `AnimationMixer` 写出的本地旋转之上。这样模型自带动画（Idle 也驱动
 * `Bip001 Head` / `eye_L` / `eye_R`）不会被视线抹平，视线也不会被动画吞掉。
 *
 * 三级阻尼（ADR 0049 D2）——"眼先动、头慢半拍、身子最后跟"：
 * - 眼球（`eye_L/R`）：刚度 12，最快；
 * - 头部（`head`）：刚度 8，中等；
 * - 躯干（`spine1`）：刚度 4，最慢，且**只在偏航超过阈值时**轻微跟随。
 *
 * 光标离开跟随范围（超过 `GAZE_CURSOR_HOLD_MS` 没有新的 `cmd:probe`）时，
 * 目标先保持 150ms 再以更慢的刚度缓出回正；静默超过 `GAZE_CURSOR_IDLE_TIMEOUT_MS`
 * 才进入 idle 随机微动（替代眨眼，ADR 0010 D1）。
 *
 * 旋转轴在骨骼父空间反解世界轴，避免依赖 3ds Max 导出的局部轴朝向；
 * 只写旋转、不写缩放（眼球 scaleY 压扁已被证伪，见 ADR 0010 背景）。
 *
 * 输入是内容区 CSS 坐标（`cmd:probe` 里带的就是它），因此不依赖鼠标事件
 * （穿透后渲染进程收不到 mousemove，§3.6 P-1）。
 */
import * as THREE from 'three';
import {
  GAZE_CURSOR_HOLD_MS,
  GAZE_CURSOR_IDLE_TIMEOUT_MS,
  GAZE_EYE_EXTRA,
  GAZE_EYE_LEAD_SHARE,
  GAZE_EYE_OFFSET_MAX_RAD,
  GAZE_EYE_STIFFNESS,
  GAZE_HEAD_STIFFNESS,
  GAZE_IDLE_PITCH_RAD,
  GAZE_IDLE_RETARGET_MS,
  GAZE_IDLE_YAW_RAD,
  GAZE_MAX_HEAD_PITCH_RAD,
  GAZE_MAX_HEAD_YAW_RAD,
  GAZE_RELEASE_STIFFNESS,
  GAZE_SPINE_SHARE,
  GAZE_SPINE_STIFFNESS,
  GAZE_SPINE_YAW_THRESHOLD_RAD,
} from '../../shared/constants';
import type { BoneOffsetSink } from './bone-arbiter';
import type { ModelBones } from './model-loader';

/** 当前处于哪个阶段（只进内部诊断，不跨进程、不进 `RenderState`） */
export type GazePhase = 'follow' | 'release' | 'idle';

export interface GazeState {
  /** 头部偏移（rad） */
  yaw: number;
  pitch: number;
  /** 头部本帧的目标（rad；回正阶段为 0） */
  targetYaw: number;
  targetPitch: number;
  idle: boolean;
  /** 本帧实际提交给仲裁器的头部偏移（诊断用） */
  submitted: boolean;
  /** 眼球相对头部的偏移（rad） */
  eyeYaw: number;
  eyePitch: number;
  /** 躯干（spine1）的偏航（rad） */
  spineYaw: number;
  /** 三级阻尼的当前阶段 */
  phase: GazePhase;
  /** 距上一次光标事实的毫秒数（诊断；∞ = 从未收到） */
  sinceCursorMs: number;
}

export interface GazeOptions {
  /** 注入随机源（单测用）；缺省 `Math.random` */
  random?: () => number;
  /**
   * ADR 0052 D3：三级阻尼刚度的**运行期来源**（控制面板滑块）。
   *
   * 缺省读 `shared/constants.ts` 的三个常量；给了这个回调就每帧读它的返回值，
   * 因此拖动滑块时下一帧就改变手感，**不需要**重建控制器或重启。
   * 回正阶段仍然固定用 `GAZE_RELEASE_STIFFNESS`（那是"缓出"的语义，不是跟随刚度）。
   */
  stiffness?: () => GazeStiffness;
}

/** 跟随阶段的三级刚度（1/s） */
export interface GazeStiffness {
  eye: number;
  head: number;
  spine: number;
}

function constantStiffness(): GazeStiffness {
  return { eye: GAZE_EYE_STIFFNESS, head: GAZE_HEAD_STIFFNESS, spine: GAZE_SPINE_STIFFNESS };
}

export interface GazeController {
  setCursor(cssX: number, cssY: number, at: number): void;
  /** 渲染循环第 3 步：计算并在父空间叠加到 head / spine1 / eyeL / eyeR。 */
  update(now: number, contentWidth: number, contentHeight: number, sink: BoneOffsetSink): void;
  state(): GazeState;
  dispose(): void;
}

/**
 * 帧率无关的一阶阻尼：`current += (target - current) · (1 - e^{-stiffness·dt})`。
 * 与 `approach()` / 坐姿微动用的是同一个公式，不引入新的缓动函数。
 */
function damp(current: number, target: number, stiffness: number, dt: number): number {
  const alpha = 1 - Math.exp(-stiffness * dt);
  return current + (target - current) * alpha;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sampleUnit(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function createGazeController(
  bones: ModelBones,
  options: GazeOptions = {},
): GazeController | null {
  const head = bones.head;
  const eyes = [bones.eyeL, bones.eyeR].filter((bone): bone is THREE.Bone => Boolean(bone));
  if (!head && eyes.length === 0) return null;
  const spine = bones.spine1;
  const random = options.random ?? Math.random;
  // ADR 0052 D3：每帧读一次（O(1)），滑块一动下一帧生效
  const readStiffness = options.stiffness ?? constantStiffness;

  let yaw = 0;
  let pitch = 0;
  let eyeYaw = 0;
  let eyePitch = 0;
  let spineYaw = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  let idle = true;
  let phase: GazePhase = 'idle';
  let lastSeenAt = Number.NEGATIVE_INFINITY;
  let nextIdleAt = 0;
  let lastUpdateAt = 0;
  let cursor: { x: number; y: number } | null = null;

  const headWorld = new THREE.Vector3();
  const headCss = { x: 0, y: 0 };

  function pickIdleTarget(now: number): void {
    targetYaw = (sampleUnit(random) * 2 - 1) * GAZE_IDLE_YAW_RAD;
    targetPitch = (sampleUnit(random) * 2 - 1) * GAZE_IDLE_PITCH_RAD;
    nextIdleAt = now + GAZE_IDLE_RETARGET_MS;
  }

  function computeHeadCss(contentWidth: number, contentHeight: number): void {
    // OrthographicCamera 下 1 世界单位 = 1 CSS px，窗口中心在相机原点（与 render-module 的投影一致）。
    if (head) {
      head.getWorldPosition(headWorld);
      headCss.x = contentWidth / 2 + headWorld.x;
      headCss.y = contentHeight / 2 - headWorld.y;
    } else {
      headCss.x = contentWidth / 2;
      headCss.y = contentHeight / 2;
    }
  }

  /** 光标坐标 → 头部目标角度（±MAX）。 */
  function aimAtCursor(contentWidth: number, contentHeight: number): void {
    if (!cursor) return;
    computeHeadCss(contentWidth, contentHeight);
    const dx = contentWidth > 0 ? (cursor.x - headCss.x) / (contentWidth / 2) : 0;
    const dy = contentHeight > 0 ? (cursor.y - headCss.y) / (contentHeight / 2) : 0;
    targetYaw = clamp(dx, -1, 1) * GAZE_MAX_HEAD_YAW_RAD;
    targetPitch = clamp(dy, -1, 1) * GAZE_MAX_HEAD_PITCH_RAD;
  }

  return {
    setCursor(cssX: number, cssY: number, at: number): void {
      cursor = { x: cssX, y: cssY };
      lastSeenAt = at;
      if (idle) {
        idle = false;
        // 从微动切回跟随时，下一个闲置点重新计时
        nextIdleAt = 0;
      }
    },

    update(now: number, contentWidth: number, contentHeight: number, sink: BoneOffsetSink): void {
      const dt = Math.min(0.1, Math.max(0, (now - lastUpdateAt) / 1000));
      lastUpdateAt = now;
      const since = now - lastSeenAt;

      /**
       * 阶段判定（ADR 0049 D2）：
       * - `follow`：光标静默 ≤ 150ms —— 目标按光标算，三层按各自刚度跟随；
       * - `release`：150ms < 静默 ≤ 1500ms —— **目标保持 150ms 后才在这里归零**，
       *   三层改用 `GAZE_RELEASE_STIFFNESS`（3.0）缓出，不是弹回；
       * - `idle`：静默 > 1500ms —— 每 5s 换一个随机注视方向（替代眨眼，ADR 0010 D1）。
       */
      if (since > GAZE_CURSOR_IDLE_TIMEOUT_MS) {
        phase = 'idle';
        if (!idle) {
          idle = true;
          pickIdleTarget(now);
        } else if (now >= nextIdleAt) {
          pickIdleTarget(now);
        }
      } else if (since > GAZE_CURSOR_HOLD_MS) {
        phase = 'release';
        idle = false;
        // 缓出回正：目标归零，但刚度换成更慢的那一档
        targetYaw = 0;
        targetPitch = 0;
      } else {
        phase = 'follow';
        idle = false;
        aimAtCursor(contentWidth, contentHeight);
      }

      const live = readStiffness();
      const stiffness = (layer: number): number =>
        phase === 'release' ? GAZE_RELEASE_STIFFNESS : layer;

      // 1) 头部
      yaw = damp(yaw, targetYaw, stiffness(live.head), dt);
      pitch = damp(pitch, targetPitch, stiffness(live.head), dt);

      /**
       * 2) 眼球：先承担"头还没到的那一截"（`GAZE_EYE_LEAD_SHARE`），再回到
       *    `EYE_EXTRA × 目标` 的常驻量。只把刚度调快不够——眼球自己的目标只有
       *    0.11rad，会被头部 0.32rad 的运动淹没，画面上看不出"眼先动"。
       */
      const eyeTargetYaw = clamp(
        (targetYaw - yaw) * GAZE_EYE_LEAD_SHARE + targetYaw * GAZE_EYE_EXTRA,
        -GAZE_EYE_OFFSET_MAX_RAD,
        GAZE_EYE_OFFSET_MAX_RAD,
      );
      const eyeTargetPitch = clamp(
        (targetPitch - pitch) * GAZE_EYE_LEAD_SHARE + targetPitch * GAZE_EYE_EXTRA,
        -GAZE_EYE_OFFSET_MAX_RAD,
        GAZE_EYE_OFFSET_MAX_RAD,
      );
      eyeYaw = damp(eyeYaw, eyeTargetYaw, stiffness(live.eye), dt);
      eyePitch = damp(eyePitch, eyeTargetPitch, stiffness(live.eye), dt);

      /**
       * 3) 躯干：最慢，而且**只在大幅偏航时**跟一点点。
       *    阈值以下一律不动（日常微动不该带着肩膀转），阈值以上按份额线性跟。
       */
      const spineTargetYaw =
        Math.sign(targetYaw) * Math.max(0, Math.abs(targetYaw) - GAZE_SPINE_YAW_THRESHOLD_RAD) * GAZE_SPINE_SHARE;
      spineYaw = damp(spineYaw, spineTargetYaw, stiffness(live.spine), dt);

      if (head) sink.add(head, yaw, pitch);
      // 眼球：叠在头部之上的额外量
      for (const eye of eyes) sink.add(eye, eyeYaw, eyePitch);
      if (spine) sink.add(spine, spineYaw, 0);
    },

    state(): GazeState {
      return {
        yaw,
        pitch,
        targetYaw,
        targetPitch,
        idle,
        submitted: Boolean(head || eyes.length > 0),
        eyeYaw,
        eyePitch,
        spineYaw,
        phase,
        sinceCursorMs: Number.isFinite(lastSeenAt) ? Math.max(0, lastUpdateAt - lastSeenAt) : Number.POSITIVE_INFINITY,
      };
    },

    dispose(): void {
      // 骨骼由仲裁器恢复，这里没有需要释放的资源
    },
  };
}
