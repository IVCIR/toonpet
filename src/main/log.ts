// 统一的日志出口：所有模块都从这里写，便于回滚与排查。
//
// 为什么必须落盘：Electron 在 Windows 上是 GUI 子系统进程，从终端启动时
// `console.log` 不会出现在终端里。验收依赖日志（§12 降级计数、R-9 降级、D-9 单实例），
// 所以每次写入同时追加到 <应用目录>/logs/pet.log。只写本地文件，不发网络（§10.1 $3）。
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** 单文件上限；超过则在进程内第一次写入前清空，避免无限增长。 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

let logFilePath: string | null = null;
let resolved = false;

function candidateLogDirectories(): string[] {
  const directories: string[] = [];
  try {
    directories.push(path.join(app.getAppPath(), 'logs'));
  } catch {
    // app 尚未就绪时可能抛错，走后面的候选
  }
  directories.push(path.join(process.cwd(), 'logs'));
  directories.push(path.join(tmpdir(), 'aa3dpet-logs'));
  return directories;
}

function resolveLogFile(): string | null {
  if (resolved) return logFilePath;
  resolved = true;

  for (const directory of candidateLogDirectories()) {
    try {
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'pet.log');
      try {
        if (statSync(file).size > MAX_LOG_BYTES) writeFileSync(file, '');
      } catch {
        // 文件还不存在，无需处理
      }
      logFilePath = file;
      return logFilePath;
    } catch {
      // 换个候选目录；全部失败就只走 stdout
    }
  }

  logFilePath = null;
  return null;
}

function stringify(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) return ` ${data.stack ?? data.message}`;
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ' [unserializable]';
  }
}

function emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}${stringify(data)}`;

  if (level === 'INFO') console.log(line);
  else console.warn(line);

  const file = resolveLogFile();
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // 日志写入失败不得影响主流程
  }
}

export function logInfo(scope: string, message: string, data?: unknown): void {
  emit('INFO', scope, message, data);
}

export function logWarn(scope: string, message: string, data?: unknown): void {
  emit('WARN', scope, message, data);
}

export function logError(scope: string, message: string, error?: unknown): void {
  emit('ERROR', scope, message, error);
}
