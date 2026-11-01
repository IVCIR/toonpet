/**
 * 前台窗口边界（Win32，ADR 0028 D1/D2）。
 *
 * 只做三件事：拿句柄 → 取**物理像素**矩形 → 交给调用方换算 DIP。
 * 本文件不引用 Electron（DIP 换算由注入方用 `screen` API 完成），也不做任何决策
 * （全屏/太小/是不是自己，都在 `snap.ts` 与 `snap-geometry.ts` 里判）。
 *
 * koffi 是**可选**依赖（`optionalDependencies`）：它由 N-API 8 预编译，
 * Windows x64 的二进制在 `@koromix/koffi-win32-x64` 里，装包即用、不需要编译器。
 * 加载失败只把 `supported` 置 false，应用照常启动（回退到工作区贴边，ADR 0028 D7）。
 */

/** `DWMWA_EXTENDED_FRAME_BOUNDS`：肉眼看到的窗口边界（不含阴影与不可见调整边框） */
export const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
export interface PhysicalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WindowInfo {
  /** 句柄的十进制字符串（BigInt 直接序列化会变成 "123n"，日志里很别扭） */
  handle: string;
  title: string;
  className: string;
  minimized: boolean;
  visible: boolean;
  /** 物理像素（未换算 DIP） */
  physical: PhysicalRect;
  /** 矩形来源：DWM 优先，失败退回 GetWindowRect */
  source: 'dwm' | 'get-window-rect';
}

export interface ForegroundWindowReader {
  /** koffi 是否可用（false = 工作区贴边模式） */
  readonly supported: boolean;
  /** 不可用的原因（日志用） */
  readonly error: string | null;
  /** 当前前台窗口；没有窗口或调用失败返回 null */
  readForeground(): WindowInfo | null;
  /** 按句柄重读（跟随用）；句柄失效返回 null */
  readHandle(handle: string): WindowInfo | null;
  dispose(): void;
}

/** koffi 的调用面（只声明用到的部分，避免把可选依赖的类型引进编译图）。 */
interface KoffiBindings {
  getForegroundWindow(): unknown;
  isWindow(hwnd: unknown): number;
  isIconic(hwnd: unknown): number;
  isWindowVisible(hwnd: unknown): number;
  getClassName(hwnd: unknown): string;
  getWindowTitle(hwnd: unknown): string;
  getWindowRect(hwnd: unknown, out: PhysicalRect): number;
  dwmFrameBounds(hwnd: unknown, out: PhysicalRect): number;
}

interface RECT {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * koffi 是可选依赖，只能用运行期 `require`（esbuild 里标成 external）。
 * 局部 `declare` 让 TypeScript 认识它，同时保证打包后仍是原样的 `require('koffi')`。
 */
declare function require(id: string): unknown;

function loadBindings(): KoffiBindings {
  const koffi = require('koffi') as {
    load(path: string): {
      func(signature: string): (...args: unknown[]) => unknown;
    };
    struct(name: string, fields: Record<string, string>): unknown;
  };
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const rect = koffi.struct('PET_RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });

  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const IsWindow = user32.func('int __stdcall IsWindow(void *hWnd)');
  const IsIconic = user32.func('int __stdcall IsIconic(void *hWnd)');
  const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hWnd)');
  const GetClassNameW = user32.func(
    'int __stdcall GetClassNameW(void *hWnd, _Out_ uint16 *name, int max)',
  );
  const GetWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(void *hWnd, _Out_ uint16 *name, int max)',
  );
  const GetWindowRect = user32.func(
    'int __stdcall GetWindowRect(void *hWnd, _Out_ PET_RECT *rect)',
  );
  // 第 3 个参数在 Win32 里是 `void* pvAttribute` + `cbAttribute`；声明成 RECT 指针
  // 布局完全一致，省掉一次手工缓冲区管理（koffi 不接受把结构体对象传给 void*）。
  const DwmGetWindowAttribute = dwmapi.func(
    'long __stdcall DwmGetWindowAttribute(void *hwnd, uint32 attr, _Out_ PET_RECT *rect, uint32 cbAttribute)',
  );

  const buffer = new Uint16Array(256);
  const readUtf16 = (length: number): string => {
    const safe = Math.max(0, Math.min(length, buffer.length));
    let text = '';
    for (let index = 0; index < safe; index += 1) text += String.fromCharCode(buffer[index] ?? 0);
    return text;
  };

  return {
    getForegroundWindow: () => GetForegroundWindow(),
    isWindow: (hwnd) => Number(IsWindow(hwnd)),
    isIconic: (hwnd) => Number(IsIconic(hwnd)),
    isWindowVisible: (hwnd) => Number(IsWindowVisible(hwnd)),
    getClassName: (hwnd) => readUtf16(Number(GetClassNameW(hwnd, buffer, buffer.length - 1))),
    getWindowTitle: (hwnd) => readUtf16(Number(GetWindowTextW(hwnd, buffer, buffer.length - 1))),
    getWindowRect: (hwnd, out) => Number(GetWindowRect(hwnd, out)),
    dwmFrameBounds: (hwnd, out) =>
      Number(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out, 16)),
  };
}

function handleToString(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string') return value.replace(/n$/, '');
  return '0';
}

/** 句柄为 0（没有前台窗口）或读取失败时的统一结果。 */
const NULL_HANDLE = '0';

/**
 * 自检用的**脚本化前台窗口**（与 `cursor-source.ts` 的脚本化光标同一手法）。
 *
 * 为什么需要：自检要断言"跳到记事本下边缘"，但它没法把 OS 的前台窗口抢过来——
 * 本应用的主窗口 `focusable` 恒为 false（§3.2 / ADR 0003），进程没有前台权，
 * `BrowserWindow.focus()` 在 Windows 上会被前台锁拦下（本轮实测：真实前台仍是别的应用）。
 *
 * 注入点只在 `PET_SELFTEST=1` 时生效，**物理像素**输入，仍然走真实的
 * `screen.screenToDipPoint()` 换算与真实的吸附控制器——只是"谁是前台窗口"由脚本决定。
 */
export const SCRIPTED_WINDOW_HANDLE = 'scripted';

let scripted: PhysicalRect | null | undefined;

/** 仅自检：把"前台窗口"指向这个物理像素矩形；`null` = 没有前台窗口。 */
export function pushScriptedForeground(physical: PhysicalRect | null): void {
  if (process.env['PET_SELFTEST'] !== '1') return;
  scripted = physical;
}

/** 仅自检：恢复真实 Win32 读取。 */
export function resetScriptedForeground(): void {
  scripted = undefined;
}

export interface ReaderOptions {
  /** 注入 require 结果（测试用）；缺省走真实 `require('koffi')` */
  loadBindings?: () => KoffiBindings;
}

export function createForegroundWindowReader(options: ReaderOptions = {}): ForegroundWindowReader {
  let bindings: KoffiBindings | null = null;
  let error: string | null = null;
  let attempted = false;
  /** 最近一次读到的原生句柄：`readHandle` 优先复用它，避免字符串 ↔ BigInt 往返 */
  let lastHandle: { text: string; native: unknown } | null = null;

  function ensure(): KoffiBindings | null {
    if (attempted) return bindings;
    attempted = true;
    try {
      bindings = (options.loadBindings ?? loadBindings)();
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause);
      bindings = null;
    }
    return bindings;
  }

  function read(native: unknown): WindowInfo | null {
    const api = ensure();
    if (!api || native === null || native === undefined) return null;
    const handle = handleToString(native);
    if (handle === NULL_HANDLE) return null;
    const className = api.getClassName(native);
    const title = api.getWindowTitle(native);
    const visible = api.isWindowVisible(native) !== 0;
    const minimized = api.isIconic(native) !== 0;

    const out: RECT = { left: 0, top: 0, right: 0, bottom: 0 };
    let source: WindowInfo['source'] = 'dwm';
    let ok = api.dwmFrameBounds(native, out) === 0;
    if (!ok || out.right - out.left <= 0 || out.bottom - out.top <= 0) {
      const fallback: RECT = { left: 0, top: 0, right: 0, bottom: 0 };
      if (api.getWindowRect(native, fallback) === 0) return null;
      out.left = fallback.left;
      out.top = fallback.top;
      out.right = fallback.right;
      out.bottom = fallback.bottom;
      source = 'get-window-rect';
    }

    lastHandle = { text: handle, native };
    return {
      handle,
      title,
      className,
      minimized,
      visible,
      physical: { left: out.left, top: out.top, right: out.right, bottom: out.bottom },
      source,
    };
  }

  /** 脚本化前台窗口（只在 `PET_SELFTEST=1` 时由自检注入） */
  function scriptedInfo(): WindowInfo | null {
    if (!scripted) return null;
    return {
      handle: SCRIPTED_WINDOW_HANDLE,
      title: '脚本化前台窗口（自检）',
      className: 'ScriptedWindow',
      minimized: false,
      visible: true,
      physical: { ...scripted },
      source: 'dwm',
    };
  }

  return {
    get supported(): boolean {
      // 自检注入时也必须有真实后端：断言的是"控制器 + 几何 + 渲染"，不是伪造的能力位
      return ensure() !== null;
    },

    get error(): string | null {
      if (!attempted) ensure();
      return error;
    },

    readForeground(): WindowInfo | null {
      if (scripted !== undefined) return scriptedInfo();
      const api = ensure();
      if (!api) return null;
      try {
        return read(api.getForegroundWindow());
      } catch (cause) {
        error = String(cause instanceof Error ? cause.message : cause);
        return null;
      }
    },

    readHandle(handle: string): WindowInfo | null {
      if (scripted !== undefined) {
        return handle === SCRIPTED_WINDOW_HANDLE ? scriptedInfo() : null;
      }
      const api = ensure();
      if (!api) return null;
      try {
        let native: unknown = lastHandle && lastHandle.text === handle ? lastHandle.native : null;
        if (native === null) {
          // 句柄字符串 → BigInt：koffi 接受 BigInt 作为 `void *` 实参（实测）
          native = BigInt(handle);
        }
        if (api.isWindow(native) === 0) {
          lastHandle = null;
          return null;
        }
        return read(native);
      } catch (cause) {
        error = String(cause instanceof Error ? cause.message : cause);
        return null;
      }
    },

    dispose(): void {
      bindings = null;
      lastHandle = null;
    },
  };
}
