/**
 * 布尔型环境开关的统一解析（ADR 0033）。
 *
 * 为什么单独一个文件：`proactive-config`（ADR 0031 D6）与 `heartbeat-config`（ADR 0033）
 * 都要回答同一个问题——"这个 `PET_*` 变量是不是被显式打开了"。两处各写一份 `truthy`
 * 就会出现两套语义（一个认 `on`、另一个不认），而这正是最难在真机上发现的偏差。
 *
 * **不 import Electron**：这两个 config 模块都要能在普通 Node 里单测。
 */

/** 被当作"真"的取值（大小写无关、去首尾空格）。空字符串与未设置一律为假。 */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function truthyFlag(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}
