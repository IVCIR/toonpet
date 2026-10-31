/**
 * 骨骼仲裁器（ADR 0014 D1/D2）。
 *
 * 每帧的受控骨骼只允许被写一次，写的内容是：
 *
 *     final = rollQ · pitchQ · yawQ · animatedLocal
 *
 * 其中 `animatedLocal` 是 `AnimationMixer` 本帧写出的本地旋转（或上一帧的原样），
 * 三个 offset 由视线通道、反应通道以**加法**方式提交（父空间、绕世界轴，
 * 避免依赖 3ds Max / Blender 导出的局部轴朝向）。
 *
 * 为什么需要"写回检测/还原"：three 的 AnimationMixer 没有骨骼级 mask，
 * 我们无法在写之前知道本帧哪些骨骼被动画驱动。若每帧都直接乘上去，
 * 未被动画驱动的骨骼会把上一帧的偏移当成新基底，几十秒后头会歪死。
 * 因此每根骨骼记住"上一帧我们写出的最终值"：
 * - 本帧开始时的值与它几乎相等 → 说明 mixer 没重写，基底沿用上一帧的基底；
 * - 不相等 → mixer 重写了，基底就取当前值（动画的真实产物）。
 *
 * 本模块是**唯一**可以写受控骨骼四元数的地方（ADR 0014 约束）。
 */
import * as THREE from 'three';

export interface BoneArbitrationState {
  bone: string;
  yaw: number;
  pitch: number;
  roll: number;
  /** 本帧是否有非零偏移（false = 只由动画驱动） */
  offset: boolean;
}

/** 叠加偏移的接收端（视线、反应通道只依赖这个窄接口）。 */
export interface BoneOffsetSink {
  add(bone: THREE.Bone, yaw: number, pitch: number, roll?: number): void;
}

export interface BoneArbiter {
  /** 登记一根受控骨骼（幂等）。 */
  register(bone: THREE.Bone): void;
  /** 提交本帧的叠加偏移（弧度，父空间绕世界轴）。同帧多次调用会累加。 */
  add(bone: THREE.Bone, yaw: number, pitch: number, roll?: number): void;
  /** 渲染循环第 2 步：抓取动画基底、清零叠加量。 */
  beginFrame(): void;
  /** 渲染循环第 5 步：写回最终四元数（每根骨骼只写一次）。 */
  endFrame(): void;
  /** 释放：把骨骼恢复到最近一次动画基底。 */
  reset(): void;
  snapshot(): BoneArbitrationState[];
  readonly size: number;
}

interface Entry {
  bone: THREE.Bone;
  /** 本帧动画产出的本地旋转 */
  base: THREE.Quaternion;
  /** 上一帧的 base（用于"未被动画重写"时还原） */
  prevBase: THREE.Quaternion;
  /** 上一帧我们写出的最终值 */
  applied: THREE.Quaternion;
  written: boolean;
  yaw: number;
  pitch: number;
  roll: number;
}

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

/** 四元数被视为"同一个朝向"的阈值（点积；写成 ±1 的等价位）。 */
const SAME_ROTATION_EPSILON = 1e-8;

function sameRotation(a: THREE.Quaternion, b: THREE.Quaternion): boolean {
  return Math.abs(a.dot(b)) >= 1 - SAME_ROTATION_EPSILON;
}

export function createBoneArbiter(): BoneArbiter {
  const entries: Entry[] = [];
  const byBone = new Map<THREE.Bone, Entry>();

  const parentWorld = new THREE.Quaternion();
  const inverseParent = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();
  const pitchQuat = new THREE.Quaternion();
  const rollQuat = new THREE.Quaternion();
  const finalQuat = new THREE.Quaternion();

  function entryFor(bone: THREE.Bone): Entry {
    let entry = byBone.get(bone);
    if (!entry) {
      entry = {
        bone,
        base: bone.quaternion.clone(),
        prevBase: bone.quaternion.clone(),
        applied: bone.quaternion.clone(),
        written: false,
        yaw: 0,
        pitch: 0,
        roll: 0,
      };
      byBone.set(bone, entry);
      entries.push(entry);
    }
    return entry;
  }

  return {
    get size(): number {
      return entries.length;
    },

    register(bone: THREE.Bone): void {
      entryFor(bone);
    },

    add(bone: THREE.Bone, yaw: number, pitch: number, roll = 0): void {
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(roll)) return;
      const entry = entryFor(bone);
      entry.yaw += yaw;
      entry.pitch += pitch;
      entry.roll += roll;
    },

    beginFrame(): void {
      for (const entry of entries) {
        const quaternion = entry.bone.quaternion;
        const animated = entry.written && sameRotation(quaternion, entry.applied);
        if (animated) entry.base.copy(entry.prevBase);
        else entry.base.copy(quaternion);
        entry.prevBase.copy(entry.base);
        entry.written = false;
        entry.yaw = 0;
        entry.pitch = 0;
        entry.roll = 0;
      }
    },

    endFrame(): void {
      for (const entry of entries) {
        if (entry.yaw === 0 && entry.pitch === 0 && entry.roll === 0) continue;

        const parent = entry.bone.parent;
        if (parent) parent.getWorldQuaternion(parentWorld);
        else parentWorld.identity();
        inverseParent.copy(parentWorld).invert();

        finalQuat.copy(entry.base);
        if (entry.roll !== 0) {
          axis.copy(WORLD_Z).applyQuaternion(inverseParent).normalize();
          rollQuat.setFromAxisAngle(axis, entry.roll);
          finalQuat.premultiply(rollQuat);
        }
        if (entry.pitch !== 0) {
          axis.copy(WORLD_X).applyQuaternion(inverseParent).normalize();
          pitchQuat.setFromAxisAngle(axis, entry.pitch);
          finalQuat.premultiply(pitchQuat);
        }
        if (entry.yaw !== 0) {
          axis.copy(WORLD_Y).applyQuaternion(inverseParent).normalize();
          yawQuat.setFromAxisAngle(axis, entry.yaw);
          finalQuat.premultiply(yawQuat);
        }

        entry.bone.quaternion.copy(finalQuat);
        entry.applied.copy(finalQuat);
        entry.written = true;
      }
    },

    reset(): void {
      for (const entry of entries) {
        entry.bone.quaternion.copy(entry.base);
        entry.applied.copy(entry.base);
        entry.written = false;
        entry.yaw = 0;
        entry.pitch = 0;
        entry.roll = 0;
      }
    },

    snapshot(): BoneArbitrationState[] {
      return entries.map((entry) => ({
        bone: entry.bone.name,
        yaw: entry.yaw,
        pitch: entry.pitch,
        roll: entry.roll,
        offset: entry.yaw !== 0 || entry.pitch !== 0 || entry.roll !== 0,
      }));
    },
  };
}
