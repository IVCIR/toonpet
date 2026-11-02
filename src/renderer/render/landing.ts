/**
 * 落地冲击的程序化姿态（ADR 0035 D4）。纯数值，不引用 three。
 *
 * 重要约束：**不用 IK**。下蹲以 `animationRoot.scale.y` 为主（脚底是缩放原点，
 * 不会穿出窗口底边），脊柱/膝盖只是很小的辅助。膝盖弯曲过大会让脚离地，
 * 实机标定后若穿帮，把 `LANDING_KNEE_MAX_RAD` 降为 0。
 */
import {
  LANDING_ABSORB_MS,
  LANDING_DURATION_MS,
  LANDING_IMPACT_MAX_PX_PER_SEC,
  LANDING_IMPACT_MIN_PX_PER_SEC,
  LANDING_KNEE_MAX_RAD,
  LANDING_MAX_SQUASH,
  LANDING_SPINE_MAX_RAD,
} from '../../shared/constants';

export interface LandingPose {
  /** 要减掉的 scale.y（0..LANDING_MAX_SQUASH） */
  squash: number;
  spinePitch: number;
  neckPitch: number;
  kneeBend: number;
  armPitch: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * @param elapsedMs 从 `motion_ended{settle}` 开始经过的毫秒数
 * @param impact 0..1 的归一化冲击（由 `vDownMax` 换算，见 render-module）
 */
export function landingPose(elapsedMs: number, impact: number): LandingPose {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const strength = clamp(Number.isFinite(impact) ? impact : 0, 0, 1);
  if (elapsed >= LANDING_DURATION_MS || strength <= 0) {
    return { squash: 0, spinePitch: 0, neckPitch: 0, kneeBend: 0, armPitch: 0 };
  }

  // 0–50ms 快速吸震（ease-out），50–300ms 回正；两段相乘形成"压下去再起来"
  const absorb = 1 - (1 - clamp(elapsed / LANDING_ABSORB_MS, 0, 1)) ** 2;
  const recover = smoothstep(LANDING_ABSORB_MS / LANDING_DURATION_MS, 1, elapsed / LANDING_DURATION_MS);
  const envelope = absorb * (1 - recover);

  return {
    squash: LANDING_MAX_SQUASH * strength * envelope,
    spinePitch: LANDING_SPINE_MAX_RAD * strength * envelope,
    neckPitch: -0.5 * LANDING_SPINE_MAX_RAD * strength * envelope,
    kneeBend: LANDING_KNEE_MAX_RAD * strength * envelope,
    armPitch: 0.06 * strength * envelope,
  };
}

/** 冲击速度 → 0..1（窗口支撑点的向下峰值速度，px/s） */
export function impactFromDownVelocity(downVelocityPxPerSec: number): number {
  const v = Number.isFinite(downVelocityPxPerSec) ? Math.abs(downVelocityPxPerSec) : 0;
  return clamp(
    (v - LANDING_IMPACT_MIN_PX_PER_SEC) /
      Math.max(1, LANDING_IMPACT_MAX_PX_PER_SEC - LANDING_IMPACT_MIN_PX_PER_SEC),
    0,
    1,
  );
}
