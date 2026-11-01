/**
 * presence（ADR 0030）：只读的"用户在场感"端口。
 *
 * 回答一个问题：**用户现在在不在电脑前、在有哪个应用前面。**
 * 这是 `idle-drive`（ADR 0031）唯一的"要不要打扰"依据，也是段 3.5 的数据源。
 *
 * 边界（重要）：
 * - **不截图**、不做 OCR、不读剪贴板、不枚举窗口列表——只要一句话能说清的事实；
 * - **不开定时器**：`getSnapshot()` 是懒采样，2s 内复用上一次读数（`PRESENCE_SAMPLE_INTERVAL_MS`）；
 * - 与 `shell/foreground-window.ts` 各自 `koffi.load('user32.dll')`：那边要的是 DWM 边框矩形
 *   （吸附用），这边要的是空闲毫秒 + 标题；互相不 import，避免把吸附的几何逻辑拖进语义层。
 * - 任何失败都折算成 `userIdleMs: null`，**永不抛异常**（§11：感知失败不阻断对话）。
 *
 * 本轮（ADR 0032 D1）：标题/类名在这里就**归一化**成标准类别（`app-normalizer.ts`）。
 * 原始标题只留在 `foregroundTitle` 里供诊断，进提示词的只有类别。
 */
import { PRESENCE_SAMPLE_INTERVAL_MS, PRESENCE_TITLE_MAX_CHARS } from '../shared/constants';
import type { PresencePort, PresenceSnapshot } from '../shared/world-types';
import { normalizeAppCategory } from './presence/app-normalizer';


/** `LASTINPUTINFO` 是两个 `DWORD`：`cbSize` 必须等于 8，否则 `GetLastInputInfo` 直接返回 0。 */
const LASTINPUTINFO_SIZE = 8;

/**
 * Win32 的那一小撮调用。做成接口是为了单测能注入一个假后端，
 * 而不用在这台机器上真的"让用户不动 90 秒"。
 */
export interface PresenceBindings {
  /** 系统级键鼠空闲毫秒；`null` = 读不到 */
  readIdleMs(): number | null;
  /** 前台窗口；没有前台窗口时返回 `null` */
  readForeground(): { title: string; className: string } | null;
}

interface LastInputInfo {
  cbSize: number;
  dwTime: number;
}

/** koffi 是**可选**依赖（`optionalDependencies`），只能运行期 `require`（esbuild 里标成 external）。 */
declare function require(id: string): unknown;

function loadPresenceBindings(): PresenceBindings {
  const koffi = require('koffi') as {
    load(path: string): { func(signature: string): (...args: unknown[]) => unknown };
    struct(name: string, fields: Record<string, string>): unknown;
  };

  const user32 = koffi.load('user32.dll');
  // 实测：`GetTickCount` 不在 user32 的导出表里（koffi 报 "Cannot find function"），
  // 它在 kernel32。`LASTINPUTINFO.dwTime` 的时基正是 GetTickCount，不能换 performance.now()。
  const kernel32 = koffi.load('kernel32.dll');

  koffi.struct('PET_PRESENCE_LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });

  // `_Inout_` 是必须的：写成 `_Out_`（或省略注解）时 koffi 不会把 cbSize 传进去，
  // GetLastInputInfo 会返回 0、dwTime 恒为 0——本轮实测踩到，见 ADR 0030 D1.2。
  const GetLastInputInfo = user32.func(
    'int __stdcall GetLastInputInfo(_Inout_ PET_PRESENCE_LASTINPUTINFO *info)',
  );
  const GetTickCount = kernel32.func('uint32 __stdcall GetTickCount()');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const GetWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(void *hWnd, _Out_ uint16 *name, int max)',
  );
  const GetClassNameW = user32.func(
    'int __stdcall GetClassNameW(void *hWnd, _Out_ uint16 *name, int max)',
  );

  // 复用同一块缓冲：GetWindowTextW / GetClassNameW 各写一次、读一次，不存在并发
  const buffer = new Uint16Array(256);
  const readUtf16 = (length: number): string => {
    const safe = Math.max(0, Math.min(length, buffer.length));
    let text = '';
    for (let index = 0; index < safe; index += 1) text += String.fromCharCode(buffer[index] ?? 0);
    return text;
  };

  return {
    readIdleMs(): number | null {
      const info: LastInputInfo = { cbSize: LASTINPUTINFO_SIZE, dwTime: 0 };
      const ok = Number(GetLastInputInfo(info));
      if (ok === 0) return null;
      const tick = Number(GetTickCount());
      if (!Number.isFinite(tick)) return null;
      // DWORD 无符号相减；GetTickCount 49.7 天回绕一次，回绕后差值会变成天文数字，
      // 大于 2^31 一律当作"刚刚有输入"（宁可少打扰，不可乱打扰）。
      const delta = (tick - Number(info.dwTime)) >>> 0;
      return delta > 0x7fffffff ? 0 : delta;
    },

    readForeground(): { title: string; className: string } | null {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return null;
      const titleLength = Number(GetWindowTextW(hwnd, buffer, buffer.length - 1));
      const title = readUtf16(titleLength);
      const classLength = Number(GetClassNameW(hwnd, buffer, buffer.length - 1));
      const className = readUtf16(classLength);
      return { title, className };
    },
  };
}

/**
 * 窗口标题进 prompt 前的清洗：控制字符会让段 3.5 出现换行（破坏"段 3.5 单行"的断言），
 * 某些应用标题里带全角空格与零宽字符，统一压成单空格。
 */
export function sanitizeWindowText(raw: unknown, limit: number = PRESENCE_TITLE_MAX_CHARS): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned;
}

export interface PresenceOptions {
  now?: () => number;
  /** 注入假后端（单测）；缺省走真实 koffi */
  loadBindings?: () => PresenceBindings;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

const UNKNOWN: Omit<PresenceSnapshot, 'at'> = {
  userIdleMs: null,
  foregroundTitle: '',
  foregroundClass: '',
  // 没有前台窗口 → `''`（段 3.5 整项省略），与 `normalizeAppCategory({})` 的返回一致
  foregroundCategory: '',
};

export function createPresence(options: PresenceOptions = {}): PresencePort {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);

  let bindings: PresenceBindings | null = null;
  let bindingsAttempted = false;
  let lastError: string | null = null;
  let snapshot: PresenceSnapshot | null = null;
  let sampledAt = 0;

  function ensure(): PresenceBindings | null {
    if (bindingsAttempted) return bindings;
    bindingsAttempted = true;
    try {
      bindings = (options.loadBindings ?? loadPresenceBindings)();
      log('info', 'presence 已就绪（Win32：GetLastInputInfo + 前台窗口）');
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error);
      bindings = null;
      // 可选依赖缺失不阻断启动：idle-drive 会因为"未知"而永久不触发（§11）
      log('warn', 'presence 不可用：idle-drive 将不会主动开口', { error: lastError });
    }
    return bindings;
  }

  function sample(at: number): PresenceSnapshot {
    const api = ensure();
    if (!api) return { ...UNKNOWN, at };
    try {
      const idle = api.readIdleMs();
      const foreground = api.readForeground();
      const foregroundTitle = sanitizeWindowText(foreground?.title ?? '');
      const foregroundClass = sanitizeWindowText(foreground?.className ?? '');
      return {
        userIdleMs: typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 ? idle : null,
        foregroundTitle,
        foregroundClass,
        // ADR 0032 D1：在采样点就归一化，下游（段 3.5）拿不到原始标题
        foregroundCategory: normalizeAppCategory({ title: foregroundTitle, className: foregroundClass }),
        at,
      };
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error);
      log('warn', 'presence 采样失败（本次按"未知"处理）', { error: lastError });
      return { ...UNKNOWN, at };
    }
  }

  return {
    getSnapshot(): PresenceSnapshot {
      const at = now();
      // 懒采样：2s 内复用。没有定时器，因此不构成 §12 的"第二个轮询器"。
      if (snapshot === null || at - sampledAt >= PRESENCE_SAMPLE_INTERVAL_MS || at < sampledAt) {
        snapshot = sample(at);
        sampledAt = at;
      }
      return snapshot;
    },
  };
}
