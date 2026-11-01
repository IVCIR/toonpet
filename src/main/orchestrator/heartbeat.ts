/**
 * 生命周期心跳（ADR 0033）：主进程里**唯一**只做生命周期任务的节拍器。
 *
 * 它回答的问题与 `idle-drive` 不同，这是本轮的关键区分：
 * - `idle-drive`（ADR 0031）回答"现在能不能打扰老师"——只在主动性开启时存在，关掉就什么都不做；
 * - 心跳回答"进程活着还需要做什么"——目前只有一件事：**冷启动预热**（ADR 0032 D3）。
 *
 * 于是预热从 idle-drive 的 15s 节拍搬到此处（ADR 0033 D1）：`PET_PROACTIVE_DISABLE=1`
 * 关掉的是"是否打扰"，不是"把模型热好"。旧实现把两者串在一条链上，
 * 一关主动性就顺带废掉了预热——那是本轮要修的硬约束。
 *
 * 边界（ADR 0032 D3 的 W-1…W-4，一条都不放松）：
 * 1. **不触发全局锁**：不建 `UtteranceSession`、不置 `thinking`、不碰 `voice`；
 * 2. **不改熔断状态**：成功不置 `llmHealthChecked`、失败不置 `llmDisabled`；
 * 3. **不发事件、不播兜底**：成功/失败都只记日志；
 * 4. **不占预算**：不进对话历史、不计入 `proactiveCount`、不写 `memory.db`。
 *
 * 新增（ADR 0033 D3）：`model-ready` 触发**绕过 presence 门槛**。进程刚被老师启动、模型刚加载完，
 * "他就在这台机器前"已经是既成事实；15s 心跳仍然沿用旧规则——读不到在场感就不做消耗 CPU 的事。
 */
import {
  HEARTBEAT_TICK_MS,
  LLM_WARMUP_MAX_ATTEMPTS,
  LLM_WARMUP_RETRY_MS,
} from '../../shared/constants';
import type { PresencePort } from '../../shared/world-types';
import type { LlmClient } from './llm-client';

/** 这次预热是被什么触发的（只进日志与诊断，不影响请求本体）。 */
export type WarmupTrigger = 'model-ready' | 'tick';

/**
 * 一次"想预热但没发"的原因。全部是**同步就能判定**的条件，
 * 与 `IdleDriveReason` 分开：心跳不认识"打扰"，只认识"现在能不能加载模型"。
 */
export type WarmupSkipReason =
  | 'disabled'
  | 'no-warmup'
  | 'warmed-up'
  | 'in-flight'
  | 'attempts-exhausted'
  | 'llm-disabled'
  | 'busy'
  | 'no-presence'
  | 'retry-wait';

/** 最近一次真实请求的结果（`null` = 还没发过）。 */
export type WarmupResultTag = 'ok' | 'unavailable' | 'timeout' | 'error';

/**
 * 心跳需要编排层的两个只读事实。**只读**：心跳既不改编排状态，也不替它做决定
 * （§7.7 I-1：不暴露内部状态对象给外部改写）。
 */
export interface HeartbeatHost {
  /** 编排层是否忙碌：`thinking` / 有在途话语 / 正在播语音（与 idle-drive 的 busy 同源） */
  isBusy(): boolean;
  /** 本会话 LLM 是否已被用户交互判死（§11：预热不得改变它，只须尊重它） */
  isLlmDisabled(): boolean;
}

export interface HeartbeatOptions {
  llm: LlmClient;
  host: HeartbeatHost;
  /** 在场感只读端口（ADR 0030）；缺省时 `tick` 触发一律不预热 */
  presence?: PresencePort | null;
  /** 总闸（`PET_SELFTEST=1` / `PET_WARMUP_DISABLE=1` → false）。false 时连定时器都不建 */
  enabled?: boolean;
  /** 总闸原因，原样进诊断（"为什么不预热"的答案） */
  reason?: string;
  intervalMs?: number;
  /** 注入定时器（单测用假定时器）；缺省 `setInterval` */
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export interface HeartbeatSnapshot {
  /** 总闸是否打开（自检里恒为 false） */
  enabled: boolean;
  /** 定时器是否真的在跑 */
  running: boolean;
  reason: string;
  intervalMs: number;
  /** 本会话是否已经成功预热过（= 模型已常驻内存） */
  warmedUp: boolean;
  /** 真实发出的请求次数（跳过的不计） */
  attempts: number;
  lastAttemptAt: number | null;
  lastTrigger: WarmupTrigger | null;
  lastResult: WarmupResultTag | null;
  /** 最近一次"没发"的原因；`null` = 还没评估过，或上一次真的发出去了 */
  lastSkip: WarmupSkipReason | null;
}

export interface Heartbeat {
  /** 启动 15s 节拍；总闸关闭时是空操作（不建定时器） */
  start(): void;
  stop(): void;
  /**
   * 立刻尝试一次预热（`model-ready` 用）。返回是否真的发出了请求。
   * 幂等且永不抛：条件不满足就静默跳过，由下一次心跳自然重试。
   */
  warmUpNow(trigger: WarmupTrigger): boolean;
  snapshot(): HeartbeatSnapshot;
}

export function createHeartbeat(options: HeartbeatOptions): Heartbeat {
  const now = options.now ?? Date.now;
  const log =
    options.log ??
    ((level, message, data) => {
      const line = `[heartbeat] ${message}`;
      if (level === 'warn') console.warn(line, data ?? '');
      else console.log(line, data ?? '');
    });
  const enabled = options.enabled !== false;
  const reason = options.reason ?? 'default';
  const intervalMs = options.intervalMs ?? HEARTBEAT_TICK_MS;
  const schedule =
    options.schedule ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const cancel =
    options.cancel ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

  let timer: unknown = null;
  let running = false;
  let warmedUp = false;
  let attempts = 0;
  let lastAttemptAt: number | null = null;
  let lastTrigger: WarmupTrigger | null = null;
  let lastResult: WarmupResultTag | null = null;
  let lastSkip: WarmupSkipReason | null = null;
  /** 单飞：一次预热在飞的时候，后面的触发不再叠一发（模型正在加载，多打一次只是排队） */
  let inFlight = false;

  function skip(value: WarmupSkipReason): false {
    lastSkip = value;
    return false;
  }

  /** 读在场感；读不到（koffi 缺失 / 调用异常）一律返回 `null`。 */
  function presenceIdleMs(): number | null {
    try {
      const snapshot = options.presence?.getSnapshot() ?? null;
      const idle = snapshot?.userIdleMs ?? null;
      return idle !== null && Number.isFinite(idle) ? idle : null;
    } catch (error) {
      log('warn', '在场感读数异常，本次按"读不到"处理', String(error));
      return null;
    }
  }

  function attempt(trigger: WarmupTrigger): boolean {
    const at = now();
    if (!enabled) return skip('disabled');
    const warmup = options.llm.warmup;
    if (typeof warmup !== 'function') return skip('no-warmup'); // 测试桩不实现预热 → 自然跳过
    if (warmedUp) return skip('warmed-up');
    if (inFlight) return skip('in-flight');
    if (attempts >= LLM_WARMUP_MAX_ATTEMPTS) return skip('attempts-exhausted');
    // 已判死的服务不值得再打（§11）。注意方向：**读取**熔断状态，绝不写它。
    if (options.host.isLlmDisabled()) return skip('llm-disabled');
    // 正在说话 / 思考时不抢 CPU。model-ready 也守这一条：宁可晚 15s 热，也不打断在途对话。
    if (options.host.isBusy()) return skip('busy');

    const idle = presenceIdleMs();
    // tick 沿用"读不到在场感就不做消耗 CPU 的事"（ADR 0032 D3 第 4 条）；
    // model-ready 是启动动作本身给出的在场证据，不受它约束（ADR 0033 D3）。
    if (trigger === 'tick' && idle === null) return skip('no-presence');

    if (lastAttemptAt !== null && at - lastAttemptAt < LLM_WARMUP_RETRY_MS) {
      return skip('retry-wait');
    }

    attempts += 1;
    lastAttemptAt = at;
    lastTrigger = trigger;
    lastSkip = null;
    inFlight = true;
    const attemptNo = attempts;
    const startedAt = Date.now();
    log('info', 'LLM 预热已发出（1 token，不占对话预算）', {
      attempt: attemptNo,
      trigger,
      model: options.llm.model,
      userIdleMs: idle,
    });

    void warmup
      .call(options.llm)
      .then((result) => {
        if (result.ok) {
          warmedUp = true;
          lastResult = 'ok';
          log('info', 'LLM 预热完成：模型已常驻内存', {
            attempt: attemptNo,
            trigger,
            loadMs: result.loadMs,
            wallMs: Date.now() - startedAt,
          });
          return;
        }
        lastResult = result.reason;
        log('warn', 'LLM 预热失败（不影响对话，按间隔重试）', {
          attempt: attemptNo,
          trigger,
          reason: result.reason,
          detail: result.detail ?? null,
        });
      })
      .catch((error: unknown) => {
        // 纯优化，任何异常都不许冒泡到节拍器（否则会被当成心跳故障）
        lastResult = 'error';
        log('warn', 'LLM 预热异常（已忽略，不冒泡到节拍器）', String(error));
      })
      .finally(() => {
        inFlight = false;
      });
    return true;
  }

  return {
    start(): void {
      if (running || timer !== null) return;
      if (!enabled) {
        // 自检 / 显式关闭：连定时器都不建，保证"零后台推理"是可断言的硬事实
        log('info', '生命周期心跳未启动：预热已关闭', { reason });
        return;
      }
      timer = schedule(() => {
        try {
          attempt('tick');
        } catch (error) {
          // 心跳崩了绝不能拖垮主链路：吞掉、记一条、下个节拍继续
          log('warn', '生命周期心跳异常（已忽略，下个节拍继续）', String(error));
        }
      }, intervalMs);
      running = true;
      log('info', '生命周期心跳已启动（ADR 0033：只做生命周期任务，与主动性无关）', {
        intervalMs,
        reason,
        warmupAvailable: typeof options.llm.warmup === 'function',
        retryMs: LLM_WARMUP_RETRY_MS,
        maxAttempts: LLM_WARMUP_MAX_ATTEMPTS,
      });
    },

    stop(): void {
      if (timer === null) {
        running = false;
        return;
      }
      try {
        cancel(timer);
      } catch (error) {
        log('warn', '生命周期心跳停止失败（进程退出时无所谓）', String(error));
      }
      timer = null;
      running = false;
    },

    warmUpNow(trigger: WarmupTrigger): boolean {
      try {
        return attempt(trigger);
      } catch (error) {
        // 调用点在事件回调里（`model_ready`），绝不能把异常抛进事件派发
        log('warn', '预热触发异常（已忽略）', String(error));
        return false;
      }
    },

    snapshot(): HeartbeatSnapshot {
      return {
        enabled,
        running,
        reason,
        intervalMs,
        warmedUp,
        attempts,
        lastAttemptAt,
        lastTrigger,
        lastResult,
        lastSkip,
      };
    },
  };
}
