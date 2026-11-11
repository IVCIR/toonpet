/**
 * 骨骼仲裁器（ADR 0014 D1/D2；ADR 0046 D1 起支持**基底覆写**）。
 *
 * 每帧的受控骨骼只允许被写一次，写的内容是：
 *
 *     final = rollQ · pitchQ · yawQ · baseLocal
 *
 * 其中 `baseLocal` 默认是 `AnimationMixer` 本帧写出的本地值（或上一帧的原样），
 * 偏移由视线通道、坐姿微动以**加法**方式提交（父空间、绕世界轴，避免依赖
 * 3ds Max / Blender 导出的局部轴朝向）。
 *
 * **基底覆写**（ADR 0046 D1）：坐姿停帧时官方片段把眼球转成"向下看"，而停帧后
 * Mixer 不再重写它。眼球需要回到"绑定姿态"这个基底，再叠张望；`overrideBase()`
 * 就是给某根骨骼换一个固定基底。只影响旋转，不碰位置（**位置通道已删除**：
 * ADR 0044 D4 用眼皮平移做眨眼，真机表现为"翻白眼"，见 ADR 0046 D2）。
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
  /**
   * 上一帧"动画基底从哪来"（诊断用）：
   * - `'mixer'`：本帧开始时四元数不等于我们上次写入的值 → 动画重写了，基底取当前值；
   * - `'cache'`：四元数仍等于我们上次写入的值 → 动画没重写，基底沿用上一帧的缓存。
   * 这两个分支任一走错都会让偏移逐帧累积（"头在打转"），所以必须可观测。
   */
  baseFrom: 'mixer' | 'cache' | null;
  /** 上一帧我们写出的四元数（[x,y,z,w]，诊断用） */
  applied: [number, number, number, number];
  /** 本帧是否用了基底覆写（ADR 0046 D1：眼球） */
  overridden: boolean;
  /** 本帧是否用了位置覆写（ADR 0057 D3：坐姿眼皮回到睁眼基线） */
  positionOverridden: boolean;
}

/** 叠加偏移的接收端（视线、反应通道只依赖这个窄接口）。 */
export interface BoneOffsetSink {
  add(bone: THREE.Bone, yaw: number, pitch: number, roll?: number): void;
}

export interface BoneArbiter extends BoneOffsetSink {
  /** 登记一根受控骨骼（幂等）。 */
  register(bone: THREE.Bone): void;
  /**
   * 渲染循环第 0 步（**必须在 `mixer.update()` 之前**）：记下每根受控骨骼当前的
   * 本地四元数。第 2 步的 `beginFrame()` 用"这中间有没有变化"判定动画是否重写了该骨骼。
   */
  capture(): void;
  /** 渲染循环第 2 步：抓取动画基底、清零叠加量。 */
  beginFrame(): void;
  /** 渲染循环第 5 步：写回最终四元数（每根骨骼只写一次）。 */
  endFrame(): void;
  /**
   * 读取某根骨骼**本帧的动画基底**（本地四元数；未登记返回 null）。
   *
   * ADR 0045 D2.1：坐姿头部基准要在"Mixer 已经不写这根骨"之后量一次片段自带的姿态。
   * 直接读 `bone.quaternion` 不行——停帧时它还是我们上一帧写出的**最终值**（含张望），
   * 而这里返回的是 `beginFrame()` 判定的动画基底，两种情况下都干净。
   *
   * **只读**：返回的是仲裁器内部对象，调用方不得修改（需要保留就 `clone()`）。
   */
  animationBase(bone: THREE.Bone): THREE.Quaternion | null;
  /**
   * 覆写某根骨骼的**旋转基底**（ADR 0046 D1：坐姿眼球回到绑定姿态）。
   *
   * 传 `null` = 取消覆写、回到动画基底。覆写只影响 `endFrame()` 的合成起点，
   * 不改变 `beginFrame()` 的"mixer 有没有重写"判定。
   */
  overrideBase(bone: THREE.Bone, quaternion: THREE.Quaternion | null): void;
  /**
   * 覆写某根骨骼的**本地位置**（ADR 0057 D3：坐姿停帧后把眼皮放回"睁眼"基线）。
   *
   * 与 `overrideBase` 同一套语义：传 `null` = 取消覆写，下一帧起由 mixer 自己写。
   * **不是**一条动画通道：没有累加、没有偏移量，只有一个固定值；
   * 存在的唯一理由是"停帧后 mixer 不再写这根骨，而它被冻在了一个不该保留的姿态上"。
   */
  overridePosition(bone: THREE.Bone, position: THREE.Vector3 | null): void;
  /** 某根骨骼此刻是否被位置覆写（诊断用） */
  positionOverridden(bone: THREE.Bone): boolean;
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
  /** `capture()` 时（mixer.update 之前）的四元数 */
  preMixer: THREE.Quaternion;
  /** 本帧是否调用过 `capture()` */
  captured: boolean;
  /** 上一次 beginFrame 的基底来源（诊断） */
  baseFrom: 'mixer' | 'cache' | null;
  yaw: number;
  pitch: number;
  roll: number;
  /** 基底覆写（ADR 0046 D1：坐姿眼球回到绑定姿态）；null = 用动画基底 */
  overrideBase: THREE.Quaternion | null;
  /** 位置覆写（ADR 0057 D3：坐姿眼皮回到睁眼基线）；null = 由 mixer 决定 */
  overridePos: THREE.Vector3 | null;
}

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

/**
 * "同一个朝向"的阈值（点积）。取 1e-6 而不是 1e-8：
 * 这里只关心"mixer 有没有真的改动这根骨"，浮点末位噪声不该被当成写入
 * （1e-6 ≈ 0.0014 rad，肉眼不可分辨）。
 */
const SAME_ROTATION_EPSILON = 1e-6;

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
        preMixer: bone.quaternion.clone(),
        captured: false,
        baseFrom: null,
        yaw: 0,
        pitch: 0,
        roll: 0,
        overrideBase: null,
        overridePos: null,
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

    capture(): void {
      for (const entry of entries) {
        entry.preMixer.copy(entry.bone.quaternion);
        entry.captured = true;
      }
    },

    beginFrame(): void {
      for (const entry of entries) {
        const quaternion = entry.bone.quaternion;
        /**
         * 动画基底从哪来？
         *
         * **首选**（`capture()` 已调用）：`mixer.update()` 前后这根骨的四元数变了没有。
         * 这是直接观测，不依赖任何"我们写了什么"的记忆。
         *
         * 为什么必须这样：three 的 `PropertyMixer.apply()` 在"累计值和上一个 accu 相同"时
         * **跳过 `binding.setValue()`**（`PropertyMixer.js` 的 "value has changed -> update
         * scene graph" 分支）。`playHold` 把片段停在最后一帧后，每帧 mixer 算出的姿态完全
         * 相同 → mixer 再也不写这根骨 → 旧判据（"骨的值 = 我上次写的值"⇒ 动画没写）
         * 在浮点末位噪声下会误判成"动画写了"，于是把我们上一帧的偏移当成新基底，
         * **每帧再叠一次**：真机上表现为"头疯狂打转"（实测 2.5 rad/s）。
         *
         * **兜底**（没调用 `capture()` 的旧调用方/单测）：沿用"骨的值是否还是我上次写的"。
         */
        let mixerWrote: boolean;
        if (entry.captured) {
          mixerWrote = !sameRotation(entry.preMixer, quaternion);
        } else {
          mixerWrote = !(entry.written && sameRotation(quaternion, entry.applied));
        }

        entry.captured = false;
        entry.baseFrom = mixerWrote ? 'mixer' : 'cache';
        if (mixerWrote) entry.base.copy(quaternion);
        else entry.base.copy(entry.prevBase);
        entry.prevBase.copy(entry.base);
        entry.written = false;
        entry.yaw = 0;
        entry.pitch = 0;
        entry.roll = 0;
      }
    },

    endFrame(): void {
      for (const entry of entries) {
        const hasRotation = entry.yaw !== 0 || entry.pitch !== 0 || entry.roll !== 0;
        // 覆写基底即使零偏移也要写：否则"眼球回到绑定姿态"要等到第一个非零张望才生效
        const hasOverride = entry.overrideBase !== null;
        const hasPosition = entry.overridePos !== null;
        if (!hasRotation && !hasOverride && !hasPosition) continue;

        if (hasPosition) {
          // ADR 0057 D3：位置覆写是**绝对值**（不是偏移），每帧写一次，直到被清成 null
          entry.bone.position.copy(entry.overridePos as THREE.Vector3);
        }
        if (!hasRotation && !hasOverride) continue;

        const parent = entry.bone.parent;
        if (parent) parent.getWorldQuaternion(parentWorld);
        else parentWorld.identity();
        inverseParent.copy(parentWorld).invert();

        // 基底：ADR 0046 D1 的覆写优先（坐姿眼球回到绑定姿态）
        finalQuat.copy(entry.overrideBase ?? entry.base);
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

    animationBase(bone: THREE.Bone): THREE.Quaternion | null {
      const entry = byBone.get(bone);
      return entry ? entry.base : null;
    },

    overrideBase(bone: THREE.Bone, quaternion: THREE.Quaternion | null): void {
      const entry = entryFor(bone);
      entry.overrideBase = quaternion ? quaternion.clone() : null;
    },

    overridePosition(bone: THREE.Bone, position: THREE.Vector3 | null): void {
      const entry = entryFor(bone);
      entry.overridePos = position ? position.clone() : null;
    },

    positionOverridden(bone: THREE.Bone): boolean {
      return byBone.get(bone)?.overridePos != null;
    },

    reset(): void {
      for (const entry of entries) {
        entry.bone.quaternion.copy(entry.base);
        entry.applied.copy(entry.base);
        entry.written = false;
        entry.yaw = 0;
        entry.pitch = 0;
        entry.roll = 0;
        entry.overrideBase = null;
        entry.overridePos = null;
      }
    },

    snapshot(): BoneArbitrationState[] {
      return entries.map((entry) => ({
        bone: entry.bone.name,
        yaw: entry.yaw,
        pitch: entry.pitch,
        roll: entry.roll,
        offset: entry.yaw !== 0 || entry.pitch !== 0 || entry.roll !== 0,
        baseFrom: entry.baseFrom,
        applied: [
          Number(entry.applied.x.toFixed(6)),
          Number(entry.applied.y.toFixed(6)),
          Number(entry.applied.z.toFixed(6)),
          Number(entry.applied.w.toFixed(6)),
        ],
        overridden: entry.overrideBase !== null,
        positionOverridden: entry.overridePos !== null,
      }));
    },
  };
}
