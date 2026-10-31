/**
 * 输入条全局热键（ADR 0016 D4）。
 *
 * 契约不规定热键，但"文本入口只有一个"是 ADR 0003 的直接后果：热键注册失败必须
 * **降级而不是崩溃**——先试默认 `Control+Shift+B`，被占用则退到 `Control+Alt+B`，
 * 两个都失败只记 ERROR 并继续启动（Esc/失焦/托盘仍可用，程序行为不退化到异常）。
 *
 * 本模块不引用 Electron：`register` 由调用方注入，便于单测覆盖三级降级路径。
 */
export const INPUT_HOTKEY_DEFAULT = 'Control+Shift+B';
export const INPUT_HOTKEY_FALLBACK = 'Control+Alt+B';

export type HotkeyLogLevel = 'info' | 'warn' | 'error';

export interface HotkeyDeps {
  /** 返回是否注册成功；允许抛错（accelerator 非法时 Electron 会抛） */
  register(accelerator: string): boolean;
  log(level: HotkeyLogLevel, message: string, data?: unknown): void;
}

export interface HotkeyRegistration {
  /** 实际生效的加速键；两个都失败时为 null */
  accelerator: string | null;
  /** 是否走了降级（默认热键被占用） */
  fallbackUsed: boolean;
  /** 默认热键是否注册失败（含抛错） */
  defaultFailed: boolean;
}

export function registerInputHotkey(
  deps: HotkeyDeps,
  preferred: string = INPUT_HOTKEY_DEFAULT,
  fallback: string = INPUT_HOTKEY_FALLBACK,
): HotkeyRegistration {
  const attempt = (accelerator: string): boolean => {
    try {
      return deps.register(accelerator) === true;
    } catch (error) {
      // accelerator 语法错误/系统拒绝都折算为"注册失败"，绝不让启动流程抛出去
      deps.log('warn', '热键注册抛错，按注册失败处理', {
        accelerator,
        error: String(error),
      });
      return false;
    }
  };

  if (attempt(preferred)) {
    deps.log('info', '全局热键已注册', { accelerator: preferred, fallbackUsed: false });
    return { accelerator: preferred, fallbackUsed: false, defaultFailed: false };
  }

  deps.log('warn', '默认热键被占用或不可用，降级到备用热键', {
    preferred,
    fallback,
  });

  if (attempt(fallback)) {
    deps.log('info', '备用热键已注册（降级生效）', { accelerator: fallback, fallbackUsed: true });
    return { accelerator: fallback, fallbackUsed: true, defaultFailed: true };
  }

  // 不抛错、不退出：文本入口不可用是可接受的降级（§11 的失败矩阵没有"热键失败"一行，
  // 因此只记日志，不新增事件、不改状态）。
  deps.log('error', '两个热键都无法注册：输入条只能由内部入口打开（程序继续运行）', {
    preferred,
    fallback,
  });
  return { accelerator: null, fallbackUsed: false, defaultFailed: true };
}
