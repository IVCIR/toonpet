/**
 * 坐姿解除时的"惊跳起身"（ADR 0034 D5）。纯数值，不引用 three。
 *
 * 复用 `reacting`/`reaction` 的视觉通道，但不进 HFSM：
 * 它只是 `sitting` 退出后的一个短暂根变换 + 骨骼偏移 + 表情投影，
 * `RenderState` 不因此增删字段，也不新增状态名。
 */
import {
  STARTLE_CLICKED_MS,
  STARTLE_COMMAND_MS,
  STARTLE_LOST_MS,
  STARTLE_SURPRISED_MS,
} from '../../shared/constants';

export type StartleReason = 'clicked' | 'command' | 'window-gone' | 'fullscreen';

export interface StartlePose {
  /** 根节点横向偏移（px，正右） */
  rootX: number;
  /** 根节点纵向偏移（px，正下） */
  rootY: number;
  /** 要减掉的 scale.y（0..1） */
  squash: number;
  spinePitch: number;
  neckPitch: number;
  headYaw: number;
  /** 双臂外展（右臂正、左臂负，调用方按侧取号） */
  armRoll: number;
  /** 临时把表情投影为 surprised */
  surprised: boolean;
  active: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function startleDurationMs(reason: StartleReason): number {
  switch (reason) {
    case 'clicked':
      return STARTLE_CLICKED_MS;
    case 'command':
      return STARTLE_COMMAND_MS;
    case 'window-gone':
    case 'fullscreen':
      return STARTLE_LOST_MS;
    default:
      return STARTLE_COMMAND_MS;
  }
}

/**
 * @param elapsedMs 从 `snap_released` 开始经过的毫秒数
 */
export function startlePose(reason: StartleReason, elapsedMs: number): StartlePose {
  const duration = startleDurationMs(reason);
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (elapsed >= duration) {
    return {
      rootX: 0,
      rootY: 0,
      squash: 0,
      spinePitch: 0,
      neckPitch: 0,
      headYaw: 0,
      armRoll: 0,
      surprised: false,
      active: false,
    };
  }

  const p = clamp(elapsed / duration, 0, 1);
  const envelope = Math.sin(Math.PI * p);
  const lost = reason === 'window-gone' || reason === 'fullscreen';
  const clicked = reason === 'clicked';

  if (clicked) {
    return {
      rootX: 0,
      rootY: -1.5 * envelope,
      squash: 0.02 * envelope,
      spinePitch: 0.08 * envelope,
      neckPitch: 0.04 * envelope,
      headYaw: 0,
      armRoll: 0.08 * envelope,
      surprised: false,
      active: true,
    };
  }

  if (lost) {
    return {
      // 先向后仰、再回正；用 sin(2πp) 让"左右看"有一次往返
      rootX: -5 * envelope,
      rootY: -7 * envelope,
      squash: 0.035 * envelope,
      spinePitch: -0.16 * envelope,
      neckPitch: -0.08 * envelope,
      headYaw: Math.sin(p * Math.PI * 2) * 0.22 * envelope,
      armRoll: 0.55 * envelope,
      // 惊跳时长可能短于 400ms：取两者的较短值，保证尾段已经"回过神"
      surprised: elapsed < Math.min(STARTLE_SURPRISED_MS, duration * 0.8),
      active: true,
    };
  }

  // command：平静站起，小跳一下
  return {
    rootX: 0,
    rootY: -3 * envelope,
    squash: 0.02 * envelope,
    spinePitch: -0.04 * envelope,
    neckPitch: -0.02 * envelope,
    headYaw: 0,
    armRoll: 0.12 * envelope,
    surprised: false,
    active: true,
  };
}
