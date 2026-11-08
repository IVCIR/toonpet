/**
 * 运行时热更新参数的**唯一事实源**（ADR 0052）。
 *
 * 背景：坐姿手感（A 段抬头补偿、下背覆盖权重）与视线三级阻尼原先只能改
 * `shared/constants.ts` 再重启应用。ADR 0052 引入"控制面板"后，这五个参数可以在
 * 运行期由滑块驱动、立即生效、并持久化到 `<appRoot>/config.json`。
 *
 * 三条硬规则：
 * 1. **默认值仍然来自 `constants.ts`**：本文件只做"可调范围 + 展示元数据 + 夹取"，
 *    绝不另写一份默认值（`TUNABLE_DEFAULTS` 逐项引用常量）。常量仍是阈值唯一出处。
 * 2. **夹取在全进程只有这一份实现**：主进程校验面板载荷、渲染进程应用、配置文件读取
 *    都走 `sanitizeTunableValues` / `clampTunableValue`，避免"面板显示 0.3、实际拿 3"。
 * 3. **不跨进程传函数/DOM**：这里只有数字与字符串，符合契约 §6.2 N-7 的纯数据要求。
 */
import {
  GAZE_EYE_STIFFNESS,
  GAZE_HEAD_STIFFNESS,
  GAZE_SPINE_STIFFNESS,
  SIT_PHASE_A_HEAD_TUNE_RAD,
  SIT_SPINE_OVERLAY_WEIGHT,
} from './constants';

/** 参数所属的界面分组（左侧 Tab）。本期只有"物理手感"可写，其余 Tab 只读。 */
export type TunableGroup = 'physics';

/**
 * 全部可热更新参数（顺序即面板里的显示顺序）。
 *
 * 新增一个参数 = 契约 minor 升级 + 该文件加一行 + 在消费方读 `get(id)`；
 * **不得**在消费方再写一份范围或默认值。
 */
export const TUNABLE_IDS = [
  'sit.phaseAHeadTuneRad',
  'sit.spineOverlayWeight',
  'gaze.eyeStiffness',
  'gaze.headStiffness',
  'gaze.spineStiffness',
] as const;

export type TunableId = (typeof TUNABLE_IDS)[number];

/** 完整的一组参数值（永远包含全部 `TunableId`） */
export type TunableValues = Record<TunableId, number>;

export interface TunableMeta {
  id: TunableId;
  group: TunableGroup;
  /** 面板里的分组标题（同一 section 的参数画在同一张卡片里） */
  section: string;
  /** 展示名（中文） */
  label: string;
  /** 常量名，面板里以小字显示，方便对照 `constants.ts` 与日志 */
  constant: string;
  /** 一句话解释"往哪边调会怎样" */
  hint: string;
  /** 单位后缀（`rad` / 空字符串） */
  unit: string;
  min: number;
  max: number;
  step: number;
  /** 显示与持久化的小数位（也是夹取后的取整位数） */
  decimals: number;
  /** 契约默认值，逐项引用 `constants.ts` */
  default: number;
}

export const TUNABLE_META: Record<TunableId, TunableMeta> = {
  'sit.phaseAHeadTuneRad': {
    id: 'sit.phaseAHeadTuneRad',
    group: 'physics',
    section: '坐姿',
    label: 'A 段头部俯仰',
    constant: 'SIT_PHASE_A_HEAD_TUNE_RAD',
    hint: '落座瞬间的头骨俯仰：负 = 抬头。',
    unit: 'rad',
    min: -0.3,
    max: 0.3,
    step: 0.005,
    decimals: 3,
    default: SIT_PHASE_A_HEAD_TUNE_RAD,
  },
  'sit.spineOverlayWeight': {
    id: 'sit.spineOverlayWeight',
    group: 'physics',
    section: '坐姿',
    label: '下背站立覆盖权重',
    constant: 'SIT_SPINE_OVERLAY_WEIGHT',
    hint: '1.0 = 下背照抄站立；0.85 = 保留 15% 前倾。',
    unit: '',
    min: 0,
    max: 1,
    step: 0.01,
    decimals: 2,
    default: SIT_SPINE_OVERLAY_WEIGHT,
  },
  'gaze.eyeStiffness': {
    id: 'gaze.eyeStiffness',
    group: 'physics',
    section: '视线三级阻尼',
    label: '眼球刚度',
    constant: 'GAZE_EYE_STIFFNESS',
    hint: '越大越跟手，三级里最快的一档。',
    unit: '/s',
    min: 1,
    max: 30,
    step: 0.5,
    decimals: 1,
    default: GAZE_EYE_STIFFNESS,
  },
  'gaze.headStiffness': {
    id: 'gaze.headStiffness',
    group: 'physics',
    section: '视线三级阻尼',
    label: '头部刚度',
    constant: 'GAZE_HEAD_STIFFNESS',
    hint: '慢半拍；与眼球的差就是"眼先动"。',
    unit: '/s',
    min: 1,
    max: 30,
    step: 0.5,
    decimals: 1,
    default: GAZE_HEAD_STIFFNESS,
  },
  'gaze.spineStiffness': {
    id: 'gaze.spineStiffness',
    group: 'physics',
    section: '视线三级阻尼',
    label: '躯干刚度',
    constant: 'GAZE_SPINE_STIFFNESS',
    hint: '最后跟；太大像整个人在转身。',
    unit: '/s',
    min: 0.5,
    max: 20,
    step: 0.5,
    decimals: 1,
    default: GAZE_SPINE_STIFFNESS,
  },
};

/** 面板渲染顺序（按分组聚在一起，组内保持这里的顺序） */
export const TUNABLE_ORDER: readonly TunableId[] = TUNABLE_IDS;

export const TUNABLE_DEFAULTS: TunableValues = Object.freeze(
  Object.fromEntries(
    TUNABLE_ORDER.map((id) => [id, TUNABLE_META[id].default]),
  ) as TunableValues,
) as TunableValues;

export function isTunableId(value: unknown): value is TunableId {
  return typeof value === 'string' && (TUNABLE_IDS as readonly string[]).includes(value);
}

/** 小数位取整（`toFixed` 后再转回数字，消掉 0.30000000000000004 这类噪声） */
export function roundTunable(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(Math.min(6, Math.max(0, decimals))));
  // `-0.0001.toFixed(3)` 是 `-0.000` → `Number` 得到 `-0`；面板上会显示 "-0.000 rad"。
  // 归一成 0（`Object.is(-0, 0) === false`，也会让单测的 deepEqual 意外失败）。
  return rounded === 0 ? 0 : rounded;
}

/**
 * 把输入折算成有限数字；**不认识的一律 `null`**。
 *
 * 为什么不用裸 `Number()`：`Number(null) === 0`、`Number(true) === 1`、`Number([]) === 0`，
 * 面板传一个 `null` 就会变成"把刚度调到 0"——那不是"没改"，而是"改坏了"。
 */
function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 夹取 + 对齐步长。**非法输入一律退回默认值**（不是 0 也不是 `min`）：
 * 面板传 `null` / `"abc"` / `NaN` 时，最不意外的结果是"这一项没被改过"。
 */
export function clampTunableValue(id: TunableId, raw: unknown): number {
  const meta = TUNABLE_META[id];
  const value = toFiniteNumber(raw);
  if (value === null) return meta.default;
  const clamped = Math.min(meta.max, Math.max(meta.min, value));
  const steps = Math.round((clamped - meta.min) / meta.step);
  return roundTunable(Math.min(meta.max, Math.max(meta.min, meta.min + steps * meta.step)), meta.decimals);
}

/** 把任意输入归一成**完整**的一组值（缺项 / 未知项 → 默认值） */
export function sanitizeTunableValues(input: unknown): TunableValues {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out = {} as TunableValues;
  for (const id of TUNABLE_ORDER) {
    out[id] = id in source ? clampTunableValue(id, source[id]) : TUNABLE_DEFAULTS[id];
  }
  return out;
}

/** 只保留输入里**真实出现**的已知项（用于"部分更新"：面板只发改动的滑块） */
export function sanitizeTunablePatch(input: unknown): Partial<TunableValues> {
  if (!input || typeof input !== 'object') return {};
  const source = input as Record<string, unknown>;
  const out: Partial<TunableValues> = {};
  for (const id of TUNABLE_ORDER) {
    if (!(id in source)) continue;
    out[id] = clampTunableValue(id, source[id]);
  }
  return out;
}

/** 与默认值不同的项（写进 `config.json` 的只有这些，避免把默认值冻结进用户文件） */
export function diffTunableValues(values: TunableValues): Partial<TunableValues> {
  const out: Partial<TunableValues> = {};
  for (const id of TUNABLE_ORDER) {
    if (roundTunable(values[id], TUNABLE_META[id].decimals) !== TUNABLE_DEFAULTS[id]) {
      out[id] = values[id];
    }
  }
  return out;
}

/** 人读格式：`0.000 rad` / `1.00` / `12.0 /s`（面板与日志共用同一口径） */
export function formatTunableValue(id: TunableId, value: number): string {
  const meta = TUNABLE_META[id];
  const number = roundTunable(value, meta.decimals).toFixed(meta.decimals);
  return meta.unit === '' ? number : `${number} ${meta.unit}`;
}
