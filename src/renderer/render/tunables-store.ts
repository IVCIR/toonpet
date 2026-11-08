/**
 * 渲染进程内的**热更新参数表**（ADR 0052 D3）。
 *
 * 为什么不是"直接改常量"：`shared/constants.ts` 的导出是 `const` 且被打包进 IIFE，
 * 运行期无法重新赋值；而且"改常量"会让"当前生效值"与"契约默认值"混成一个概念，
 * 面板上的"恢复默认"就没有可靠基线了。
 *
 * 这里的分工：
 * - `TUNABLE_DEFAULTS`（`shared/tunable-params.ts`，逐项引用 `constants.ts`）= 基线；
 * - 本 store 持有**当前生效值**，`apply()` 走与主进程同一套夹取；
 * - 消费方（`render-module` / `gaze`）每帧 `get(id)` 读，所以滑块一动下一帧就生效，
 *   **不需要**重建模型、重播动画或重启。
 *
 * 纯数值、无 DOM、无定时器：可以在 Node 单测里直接跑（`tunables-store.test.ts`）。
 */
import {
  clampTunableValue,
  isTunableId,
  TUNABLE_IDS,
  TUNABLE_DEFAULTS,
} from '../../shared/tunable-params';
import type { TunableId, TunableValues } from '../../shared/tunable-params';

export interface TunableStore {
  /** 当前生效值（拷贝，外部改不到内部状态） */
  values(): TunableValues;
  /** 单个参数的当前值（每帧调用，O(1)） */
  get(id: TunableId): number;
  /**
   * 应用一组**部分**更新。返回真正发生变化的 id（用于日志与"要不要重算"）。
   * 非法 id / 非有限数被忽略（不是抛错）。
   */
  apply(patch: unknown): TunableId[];
  /** 恢复全部默认值 */
  reset(): void;
  /** 全部回复默认（= `reset`，语义别名，供调用方读得更清楚） */
  restoreDefaults(): void;
}

export function createTunableStore(initial?: unknown): TunableStore {
  const current: TunableValues = { ...TUNABLE_DEFAULTS };
  if (initial && typeof initial === 'object') {
    const source = initial as Record<string, unknown>;
    for (const id of TUNABLE_IDS) {
      if (!(id in source)) continue;
      current[id] = clampTunableValue(id, source[id]);
    }
  }

  function apply(patch: unknown): TunableId[] {
    if (!patch || typeof patch !== 'object') return [];
    const source = patch as Record<string, unknown>;
    const changed: TunableId[] = [];
    for (const [key, raw] of Object.entries(source)) {
      if (!isTunableId(key)) continue;
      const next = clampTunableValue(key, raw);
      if (next === current[key]) continue;
      current[key] = next;
      changed.push(key);
    }
    return changed;
  }

  return {
    values(): TunableValues {
      return { ...current };
    },
    get(id: TunableId): number {
      return current[id];
    },
    apply,
    reset(): void {
      for (const id of TUNABLE_IDS) current[id] = TUNABLE_DEFAULTS[id];
    },
    restoreDefaults(): void {
      for (const id of TUNABLE_IDS) current[id] = TUNABLE_DEFAULTS[id];
    },
  };
}
