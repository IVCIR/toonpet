// 用 Electron 自带的 Node 跑指定测试文件（ADR 0020 D9）。
//
// 为什么需要它：`better-sqlite3` 是 ABI 相关的原生模块，本仓库按 **Electron 33.4.11
// （NODE_MODULE_VERSION=130）** 安装。宿主 `node`（这里是 24.x / ABI 137）加载它会
// 直接 `ERR_DLOPEN_FAILED`。所以 `memory.test.ts` 必须跑在 Electron 的 Node 里：
// `ELECTRON_RUN_AS_NODE=1` 让 electron.exe 以纯 Node 模式执行脚本，ABI 与主进程一致。
//
// stdio 用 inherit：不要用管道捕获输出（受限环境里管道会 EPERM，见 scripts/start.mjs）。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('[electron-test] 用法：node scripts/run-electron-test.mjs <test.mjs> [more.mjs...]');
  process.exit(2);
}

let electronPath;
try {
  electronPath = require('electron');
} catch (error) {
  console.error(`[electron-test] 找不到 electron：${String(error)}`);
  process.exit(1);
}

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
delete env['ELECTRON_NO_ATTACH_CONSOLE'];

const child = spawn(electronPath, files, { stdio: 'inherit', env, cwd: process.cwd() });

child.on('error', (error) => {
  console.error(`[electron-test] 启动失败：${String(error)}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
