/**
 * 启动面包屑：在**加载 Electron 之前**落一行磁盘记录。
 *
 * 目的：Electron 在 Windows 上是 GUI 子系统进程，终端看不到 console；一旦主进程
 * 在 app ready 前退出，或根本没被加载，日志链路就是黑的。这条记录只依赖 node:fs，
 * 用来回答"主进程到底有没有跑起来、跑在什么环境里"。
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAX_BOOT_LOG_BYTES = 256 * 1024;

function candidateDirectories(): string[] {
  return [
    path.join(process.cwd(), 'logs'),
    // 打包后 __dirname = <项目根>/dist/main
    path.join(__dirname, '..', '..', 'logs'),
    path.join(tmpdir(), 'aa3dpet-logs'),
  ];
}

export function writeBootBreadcrumb(): void {
  const record = {
    at: new Date().toISOString(),
    argv: process.argv,
    cwd: process.cwd(),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath ?? null,
    versions: {
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node,
    },
    env: {
      ELECTRON_RUN_AS_NODE: process.env['ELECTRON_RUN_AS_NODE'] ?? null,
      PET_SELFTEST: process.env['PET_SELFTEST'] ?? null,
    },
  };
  const line = `${JSON.stringify(record)}\n`;

  for (const directory of candidateDirectories()) {
    try {
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'boot.log');
      try {
        if (statSync(file).size > MAX_BOOT_LOG_BYTES) writeFileSync(file, '');
      } catch {
        // 首次启动没有该文件
      }
      appendFileSync(file, line);
      return;
    } catch {
      // 换下一个候选目录；全部失败时静默放弃，绝不能挡住启动
    }
  }
}
