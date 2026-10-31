/**
 * 光标来源：默认接 `screen.getCursorScreenPoint()`；
 * `PET_SELFTEST=1` 时改为脚本化坐标，供自检驱动真实 16ms 轮询器。
 * §7.2 的对外接口不受影响（这只是 shell 内部依赖）。
 */
import { screen } from 'electron';

export interface CursorSource {
  point(): { x: number; y: number };
}

let scriptedPoint: { x: number; y: number } | null = null;

/** 仅自检使用：注入一个屏幕坐标点。 */
export function pushScriptedCursor(x: number, y: number): void {
  scriptedPoint = { x, y };
}

export function resetScriptedCursor(): void {
  scriptedPoint = null;
}

export function createCursorSource(): CursorSource {
  if (process.env['PET_SELFTEST'] === '1') {
    // 默认放在所有显示器之外，避免自检开始时误命中
    return { point: () => scriptedPoint ?? { x: -100000, y: -100000 } };
  }
  return { point: () => screen.getCursorScreenPoint() };
}
