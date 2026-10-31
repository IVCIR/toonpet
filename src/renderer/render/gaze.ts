/**
 * 视线跟随与微动（ADR 0009 D6、ADR 0010 D1、ADR 0014 D2）。
 *
 * 本模块**不写骨骼**：只计算 yaw / pitch，交给骨骼仲裁器以加法方式叠加在
 * `AnimationMixer` 写出的本地旋转之上。这样模型自带动画（Idle 也驱动
 * `Bip001 Head` / `eye_L` / `eye_R`）不会被视线抹平，视线也不会被动画吞掉。
 *
 * 旋转轴在骨骼父空间反解世界轴，避免依赖 3ds Max 导出的局部轴朝向；
 * 只写旋转、不写缩放（眼球 scaleY 压扁已被证伪，见 ADR 0010 背景）。
 *
 * 输入是内容区 CSS 坐标（`cmd:probe` 里带的就是它），因此不依赖鼠标事件
 * （穿透后渲染进程收不到 mousemove，§3.6 P-1）。
 */
import * as THREE from 'three';
import type { BoneOffsetSink } from './bone-arbiter';
import type { ModelBones } from './model-loader';

/** 有光标但超过这么久没有新探针 → 视为"无光标"，转入视线微动。 */
const IDLE_TIMEOUT_MS = 1500;
/** 无光标时每 5 秒换一个随机注视方向（替代眨眼，ADR 0010 D1）。 */
const IDLE_INTERVAL_MS = 5000;

const MAX_HEAD_YAW = 0.32; // ≈18°
const MAX_HEAD_PITCH = 0.2; // ≈11°
const EYE_EXTRA = 0.35; // 眼球相对头部的额外幅度
const SMOOTHING_PER_SECOND = 12;

export interface GazeState {
  yaw: number;
  pitch: number;
  targetYaw: number;
  targetPitch: number;
  idle: boolean;
  /** 本帧实际提交给仲裁器的头部偏移（诊断用） */
  submitted: boolean;
}

export interface GazeController {
  setCursor(cssX: number, cssY: number, at: number): void;
  /** 渲染循环第 3 步：计算并在父空间叠加到 head / eyeL / eyeR。 */
  update(now: number, contentWidth: number, contentHeight: number, sink: BoneOffsetSink): void;
  state(): GazeState;
  dispose(): void;
}

export function createGazeController(bones: ModelBones): GazeController | null {
  const head = bones.head;
  const eyes = [bones.eyeL, bones.eyeR].filter((bone): bone is THREE.Bone => bone !== null);
  if (!head && eyes.length === 0) return null;

  let yaw = 0;
  let pitch = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  let idle = true;
  let lastSeenAt = Number.NEGATIVE_INFINITY;
  let nextIdleAt = 0;
  let lastUpdateAt = 0;
  let cursor: { x: number; y: number } | null = null;

  const headWorld = new THREE.Vector3();
  const headCss = { x: 0, y: 0 };

  function pickIdleTarget(now: number): void {
    targetYaw = (Math.random() * 2 - 1) * 0.2;
    targetPitch = (Math.random() * 2 - 1) * 0.1;
    nextIdleAt = now + IDLE_INTERVAL_MS;
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

      if (now - lastSeenAt > IDLE_TIMEOUT_MS) {
        if (!idle) {
          idle = true;
          pickIdleTarget(now);
        } else if (now >= nextIdleAt) {
          pickIdleTarget(now);
        }
      } else if (cursor && !idle) {
        computeHeadCss(contentWidth, contentHeight);
        const dx = contentWidth > 0 ? (cursor.x - headCss.x) / (contentWidth / 2) : 0;
        const dy = contentHeight > 0 ? (cursor.y - headCss.y) / (contentHeight / 2) : 0;
        targetYaw = THREE.MathUtils.clamp(dx, -1, 1) * MAX_HEAD_YAW;
        targetPitch = THREE.MathUtils.clamp(dy, -1, 1) * MAX_HEAD_PITCH;
      }

      const alpha = 1 - Math.exp(-SMOOTHING_PER_SECOND * dt);
      yaw += (targetYaw - yaw) * alpha;
      pitch += (targetPitch - pitch) * alpha;

      if (head) sink.add(head, yaw, pitch);
      // 眼球：在头部的旋转之上再给一点，让"看"的方向更明确
      for (const eye of eyes) sink.add(eye, yaw * EYE_EXTRA, pitch * EYE_EXTRA);
    },

    state(): GazeState {
      return { yaw, pitch, targetYaw, targetPitch, idle, submitted: Boolean(head || eyes.length > 0) };
    },

    dispose(): void {
      // 骨骼由仲裁器恢复，这里没有需要释放的资源
    },
  };
}
