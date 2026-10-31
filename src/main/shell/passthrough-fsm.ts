/**
 * 穿透状态机（纯逻辑，不碰 Electron）。
 *
 * 契约 §3.3 R-6/R-7、§3.4 D-5/D-8、§12；ADR 0002、ADR 0004 D4/D5。
 * 唯一的 `setIgnoreMouseEvents` 调用在 pointer-poller 里，本文件只决定"应该是什么态"。
 *
 * 输入全部注入（光标、窗口矩形、探针结果、拖拽/沉降标志、时间），
 * 因此单测可以精确覆盖 8px 外扩、100ms 冷却、超时降级、拖拽抑制。
 */
import { LEAVE_HYSTERESIS_PX, PASSTHROUGH_SWITCH_COOLDOWN_MS } from '../../shared/constants';
import type { Rect } from '../../shared/geometry';

export type PassthroughTarget = 'interactive' | 'passthrough';

/** 本 tick 拿到的探针结果：null = 还没有结果；timeout = 在飞超时（按未命中处理）。 */
export type ProbeOutcome = { kind: 'hit'; hit: boolean } | { kind: 'timeout' } | null;

export type FsmReason =
  | 'dragging'
  | 'settling'
  | 'pressed'
  | 'outside'
  | 'hysteresis'
  | 'awaiting-probe'
  | 'hit'
  | 'transparent'
  | 'timeout';

export interface FsmInput {
  cursor: { x: number; y: number };
  /** 窗口内容区的屏幕坐标矩形（getContentBounds） */
  windowRect: Rect;
  probe: ProbeOutcome;
  probeInFlight: boolean;
  /** R-8：拖拽期间强制保持非穿透，且不探测 */
  dragging: boolean;
  /** ADR 0004 D3：回弹沉降窗口，同样保持非穿透 */
  settling: boolean;
  /**
   * D-2 的"按下保持位"：指针已按下、尚未越过 4px 阈值。
   *
   * 为什么需要它：按下后若光标在阈值内挪到透明像素，探针的 miss 会让窗口切穿透，
   * 随后的 pointerup 落到桌面 → 主进程永远收不到抬起，手势挂住。
   * 按下期间只锁住"不切穿透"，**不暂停探针**（R-5 的 ≥20Hz 仍然成立；
   * R-8 的采集暂停只针对真正的拖拽）。
   */
  pressed: boolean;
  now: number;
}

export interface FsmOutput {
  target: PassthroughTarget;
  changed: boolean;
  /** 本次本应切换，但被 100ms 冷却拦下（R-7） */
  cooled: boolean;
  reason: FsmReason;
  /** 非空表示本 tick 应当发出一次 cmd:probe（内容区 CSS 坐标） */
  probePoint: { x: number; y: number } | null;
}

function contains(rect: Rect, point: { x: number; y: number }, pad = 0): boolean {
  return (
    point.x >= rect.x - pad &&
    point.x < rect.x + rect.width + pad &&
    point.y >= rect.y - pad &&
    point.y < rect.y + rect.height + pad
  );
}

export class PassthroughFsm {
  private target: PassthroughTarget = 'passthrough';
  private lastSwitchAt = Number.NEGATIVE_INFINITY;

  get current(): PassthroughTarget {
    return this.target;
  }

  step(input: FsmInput): FsmOutput {
    // R-8 / D-6：拖拽与回弹沉降期间强制非穿透，不探测
    if (input.dragging) return this.decide('interactive', 'dragging', input);
    if (input.settling) return this.decide('interactive', 'settling', input);

    // D-2 的按下保持位：见 FsmInput.pressed 的说明。优先级低于 dragging / settling。
    if (input.pressed) {
      const decision = this.decide('interactive', 'pressed', input);
      const probePoint =
        input.probe === null && !input.probeInFlight
          ? {
              x: input.cursor.x - input.windowRect.x,
              y: input.cursor.y - input.windowRect.y,
            }
          : null;
      return { ...decision, probePoint };
    }

    const insideRect = contains(input.windowRect, input.cursor, 0);
    const insideHysteresis = contains(input.windowRect, input.cursor, LEAVE_HYSTERESIS_PX);

    // R-7：离开判定外扩 8px；真正出了外扩区才恢复穿透
    if (!insideRect && !insideHysteresis) return this.decide('passthrough', 'outside', input);
    if (!insideRect) return this.hold('hysteresis');

    // 在窗口矩形内：先要一次探针
    if (input.probe === null) {
      if (input.probeInFlight) return this.hold('awaiting-probe');
      return {
        target: this.target,
        changed: false,
        cooled: false,
        reason: 'awaiting-probe',
        probePoint: {
          x: input.cursor.x - input.windowRect.x,
          y: input.cursor.y - input.windowRect.y,
        },
      };
    }

    // ADR 0004 D4：探针超时按未命中处理，不得沿用上一次判定
    if (input.probe.kind === 'timeout') return this.decide('passthrough', 'timeout', input);

    return input.probe.hit
      ? this.decide('interactive', 'hit', input)
      : this.decide('passthrough', 'transparent', input);
  }

  private hold(reason: FsmReason): FsmOutput {
    return { target: this.target, changed: false, cooled: false, reason, probePoint: null };
  }

  private decide(
    desired: PassthroughTarget,
    reason: FsmReason,
    input: FsmInput,
  ): FsmOutput {
    if (desired === this.target) return this.hold(reason);

    // R-7：每次切换后 100ms 内不再切换
    if (input.now - this.lastSwitchAt < PASSTHROUGH_SWITCH_COOLDOWN_MS) {
      return { target: this.target, changed: false, cooled: true, reason, probePoint: null };
    }

    this.target = desired;
    this.lastSwitchAt = input.now;
    return { target: this.target, changed: true, cooled: false, reason, probePoint: null };
  }
}
