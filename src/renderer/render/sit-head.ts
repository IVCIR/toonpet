/**
 * 坐姿的**头部基准**（ADR 0045 D2.1）。
 *
 * 背景：官方坐姿片段停在 14.5–14.7s 时，头骨带一个"低头沉思"的初始旋转。
 * 程序化张望是**叠加**在这个低头底座上的，于是"四处看"变成了"一直看自己的膝盖"。
 *
 * 关键教训（本轮真机 + 自检实测）：
 * **不能直接用头骨世界四元数的欧拉角当"低头量"**。3ds Max 导出的骨骼带任意 rest 朝向，
 * 头骨世界四元数的 x 分量里混着绑定姿态的偏转（本资产实测约 -0.20rad），
 * 拿它当"她低着头"会把基准掰到天上去。真正有意义的量是**相对绑定姿态的旋转差**：
 *
 *     delta = worldSit · worldBind⁻¹
 *
 * 抵消量就是 `delta⁻¹`，按 YXZ 拆成 (yaw, pitch, roll) 交给骨骼仲裁器
 * （仲裁器的合成顺序 `yawQ · pitchQ · rollQ · base` 正好等于 YXZ）。
 *
 * 另外，`worldSit` 必须来自 `BoneArbiter.animationBase()`（动画基底），不是
 * `bone.quaternion`：停帧后 Mixer 不再重写头骨，后者是我们上一帧写出的最终值（含张望）。
 *
 * 本文件只放纯函数，可脱离 WebGL 单测。
 */
import * as THREE from 'three';

/**
 * 基准姿态的夹取上限（rad）。
 * 超过 0.6rad（≈34°）说明量到的不是"低头"而是骨架朝向异常（模型换了 / 片段选错），
 * 这时宁可不修，也不要把她的头掰到天上去。
 */
export const SIT_HEAD_LEVEL_MAX_RAD = 0.6;

/** 抵消量（rad，世界轴；与 `BoneArbiter.add()` 的 yaw/pitch/roll 同口径） */
export interface SitHeadCorrection {
  yaw: number;
  pitch: number;
  roll: number;
}

/**
 * 动画基底（本地四元数）+ 父骨骼世界朝向 → 头骨的**世界**朝向。
 *
 * 为什么不用 `head.getWorldQuaternion()`：见文件头（停帧后读到的是上一帧最终值）。
 * 父骨骼（颈）只带呼吸的 ±0.0025rad，用它的当前世界朝向足够精确。
 */
export function headWorldFromBase(
  baseLocal: THREE.Quaternion,
  parentWorld: THREE.Quaternion | null,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  if (parentWorld) return out.copy(parentWorld).multiply(baseLocal);
  return out.copy(baseLocal);
}

/** 坐姿停帧相对绑定姿态的旋转差：`delta = worldSit · worldBind⁻¹`（纯函数） */
export function headTiltFromBind(
  sitWorld: THREE.Quaternion,
  bindWorld: THREE.Quaternion,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  return out.copy(sitWorld).multiply(inverseBind.copy(bindWorld).invert());
}

const inverseBind = new THREE.Quaternion();
const yawAxis = new THREE.Vector3(0, 1, 0);
const yawQuat = new THREE.Quaternion();

/**
 * 从世界朝向里扣掉**我们自己加的微侧身**（ADR 0046 D3.1）。
 *
 * 身体侧 0.15rad 之后，头骨的世界朝向也带着这 0.15rad；如果直接拿它算"低头基准"，
 * 补偿会把侧身一起转回去（脖子拧着看镜头）。所以基准要在**未侧身**的坐标系里量。
 */
export function removeBodyYaw(
  world: THREE.Quaternion,
  bodyYaw: number,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const yaw = Number.isFinite(bodyYaw) ? bodyYaw : 0;
  if (yaw === 0) return out.copy(world);
  yawQuat.setFromAxisAngle(yawAxis, -yaw);
  return out.copy(world).premultiply(yawQuat);
}

/**
 * 旋转差 → 每帧要叠加的抵消量（`delta⁻¹` 的 YXZ 分解）。
 *
 * 注意**不能**把 delta 的三个欧拉角直接取反：欧拉分解不是线性的，
 * `inverse(Ry·Rx·Rz) = Rz⁻¹·Rx⁻¹·Ry⁻¹` 并不等于 `Ry(-y)·Rx(-x)·Rz(-z)`。
 * 必须先对四元数求逆、再分解。
 *
 * @deprecated ADR 0047 D2 起**运行时不使用**：拿"相对绑定姿态的旋转差"当补偿量，
 * 会把 T-pose 的基准误差（≈0.13rad）一起补进去，实测把脸抬过头。现在只补 pitch、
 * 基准取"站立待机时头骨的世界 pitch"，逻辑在 `RenderModule.captureSitHeadLevel()`。
 * 函数与单测保留，作为"为什么不能对欧拉角取反"的参考实现。
 *
 * @returns `null` = 不修（非法值 / 低头量超过 `SIT_HEAD_LEVEL_MAX_RAD`）
 */
export function sitHeadLevelCorrection(delta: THREE.Quaternion): SitHeadCorrection | null {
  const { x, y, z, w } = delta;
  if (![x, y, z, w].every((value) => Number.isFinite(value))) return null;
  // 单位旋转（没有低头）→ 不需要补偿
  if (2 * Math.acos(Math.min(1, Math.abs(w))) < 1e-6) return null;

  const tilt = new THREE.Euler().setFromQuaternion(delta, 'YXZ');
  if (!Number.isFinite(tilt.x) || Math.abs(tilt.x) > SIT_HEAD_LEVEL_MAX_RAD) return null;

  const inverse = new THREE.Quaternion(-x, -y, -z, w).normalize();
  const eulerInverse = new THREE.Euler().setFromQuaternion(inverse, 'YXZ');
  return {
    yaw: eulerInverse.y === 0 ? 0 : eulerInverse.y,
    pitch: eulerInverse.x === 0 ? 0 : eulerInverse.x,
    roll: eulerInverse.z === 0 ? 0 : eulerInverse.z,
  };
}

const euler = new THREE.Euler();

/** 世界朝向 → pitch（rad，YXZ 的 x；相对绑定姿态时 **正 = 低头**） */
export function headWorldPitch(world: THREE.Quaternion): number {
  euler.setFromQuaternion(world, 'YXZ');
  return Number.isFinite(euler.x) ? euler.x : 0;
}

/** 世界朝向 → yaw（rad，YXZ 的 y；相对绑定姿态时 正 = 往她的左边转） */
export function headWorldYaw(world: THREE.Quaternion): number {
  euler.setFromQuaternion(world, 'YXZ');
  return Number.isFinite(euler.y) ? euler.y : 0;
}
