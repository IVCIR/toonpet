// 构建脚本：用 esbuild CLI 打包主进程 / preload / 渲染页 / 测试。
//
// 为什么走 CLI 而不是 esbuild 的 JS API：JS API 会用管道 stdio 起一个常驻子进程，
// 在受限环境（无命名管道权限）下会直接 EPERM。CLI 是直接子进程、stdio 继承，
// 两边都能跑。构建期只读本地文件，不做任何网络访问。
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const ROOT = import.meta.dirname;
const DIST = path.join(ROOT, 'dist');
// C-2：只保证 Windows 11 x64，因此直接用 x64 平台包，不做跨平台分支。
const ESBUILD = path.join(ROOT, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');

/** @type {Array<{entry: string, outfile: string, platform: 'node'|'browser', format: 'cjs'|'iife'|'esm', target: string, external?: string[]}>} */
const bundles = [
  {
    entry: 'src/main/main.ts',
    outfile: 'dist/main/main.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // better-sqlite3 是原生模块（.node），不能塞进 bundle，只能运行期 require
    // koffi 同理（可选依赖：前台窗口吸附用，装不上时运行期回退，ADR 0028 D1）
    external: ['electron', 'better-sqlite3', 'koffi'],
  },
  {
    entry: 'src/preload/main.ts',
    outfile: 'dist/preload/main.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    entry: 'src/preload/input.ts',
    outfile: 'dist/preload/input.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    entry: 'src/renderer/render/main.ts',
    outfile: 'dist/renderer/render/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  },
  {
    entry: 'src/renderer/input/main.ts',
    outfile: 'dist/renderer/input/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  },
  {
    entry: 'src/shared/mask.test.ts',
    outfile: 'dist/tests/mask.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/shared/geometry.test.ts',
    outfile: 'dist/tests/geometry.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/shared/model-frame.test.ts',
    outfile: 'dist/tests/model-frame.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/shared/motion.test.ts',
    outfile: 'dist/tests/motion.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/shared/color.test.ts',
    outfile: 'dist/tests/color.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/glb-bounds.test.ts',
    outfile: 'dist/tests/glb-bounds.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/passthrough-fsm.test.ts',
    outfile: 'dist/tests/passthrough-fsm.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/snap-geometry.test.ts',
    outfile: 'dist/tests/snap-geometry.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/snap.test.ts',
    outfile: 'dist/tests/snap.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/sit-pose.test.ts',
    outfile: 'dist/tests/sit-pose.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/bone-arbiter.test.ts',
    outfile: 'dist/tests/bone-arbiter.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/drag-motion.test.ts',
    outfile: 'dist/tests/drag-motion.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/landing.test.ts',
    outfile: 'dist/tests/landing.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/startle.test.ts',
    outfile: 'dist/tests/startle.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/approach.test.ts',
    outfile: 'dist/tests/approach.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/drag-gesture.test.ts',
    outfile: 'dist/tests/drag-gesture.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/shell/drag-pause.test.ts',
    outfile: 'dist/tests/drag-pause.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/mask-sampler.test.ts',
    outfile: 'dist/tests/mask-sampler.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/shared/attachments.test.ts',
    outfile: 'dist/tests/attachments.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/hfsm.test.ts',
    outfile: 'dist/tests/hfsm.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/pat-react.test.ts',
    outfile: 'dist/tests/pat-react.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/render/facial-texture.test.ts',
    outfile: 'dist/tests/facial-texture.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/config.test.ts',
    outfile: 'dist/tests/config.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/orchestrator/reply-validator.test.ts',
    outfile: 'dist/tests/reply-validator.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/orchestrator/orchestrator.test.ts',
    outfile: 'dist/tests/orchestrator.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/voice/voice.test.ts',
    outfile: 'dist/tests/voice.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/voice/speech.test.ts',
    outfile: 'dist/tests/speech.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/input-bar-geometry.test.ts',
    outfile: 'dist/tests/input-bar-geometry.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/hotkey.test.ts',
    outfile: 'dist/tests/hotkey.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/shared/env-file.test.ts',
    outfile: 'dist/tests/env-file.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/main/shell/tray-menu.test.ts',
    outfile: 'dist/tests/tray-menu.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    entry: 'src/renderer/shell/subtitle-cue.test.ts',
    outfile: 'dist/tests/subtitle-cue.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0030：在场感（只测懒采样/降级，注入假后端，运行期不 require koffi）
    entry: 'src/main/presence.test.ts',
    outfile: 'dist/tests/presence.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['koffi'],
  },
  {
    // ADR 0032 D1：前台应用归一化（纯函数，标题/类名 → 标准类别）
    entry: 'src/main/presence/app-normalizer.test.ts',
    outfile: 'dist/tests/app-normalizer.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0032 D3：冷启动预热（本地桩 HTTP，只连回环）
    entry: 'src/main/orchestrator/llm-client.test.ts',
    outfile: 'dist/tests/llm-client.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0030 D4：段 3.5、相对时间、去冗余与段 3 预算
    entry: 'src/main/orchestrator/world.test.ts',
    outfile: 'dist/tests/world.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0031 D2：主动性的全部时间与状态边界（纯函数，假时钟）
    entry: 'src/main/orchestrator/idle-drive.test.ts',
    outfile: 'dist/tests/idle-drive.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0031 D6：主动性开关的优先级（自检默认硬关）
    entry: 'src/main/proactive-config.test.ts',
    outfile: 'dist/tests/proactive-config.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0033 D1：生命周期心跳（预热与主动性解耦、单飞、重试上限、model_ready 触发）
    entry: 'src/main/orchestrator/heartbeat.test.ts',
    outfile: 'dist/tests/heartbeat.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0033 D1.3：预热总闸的优先级（PET_PROACTIVE_DISABLE 不得影响它）
    entry: 'src/main/heartbeat-config.test.ts',
    outfile: 'dist/tests/heartbeat-config.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0033 D2.2：`model_ready` 的一次性闩锁（事件可能早于 runtime 装配）
    entry: 'src/main/model-ready.test.ts',
    outfile: 'dist/tests/model-ready.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0037：全局光照 + Toon（3 阶渐变贴图 / 只换 Body+Hair / 面部保持无光照）
    entry: 'src/renderer/render/toon-shading.test.ts',
    outfile: 'dist/tests/toon-shading.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },  {
    // ADR 0038：背面法描边（Inverted Hull / 共享几何与骨骼 / 屏幕像素宽度）
    entry: 'src/renderer/render/outline.test.ts',
    outfile: 'dist/tests/outline.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // 唯一需要跑在 Electron 的 Node 里的测试（原生模块 ABI，ADR 0020 D9）。
    // 由 `scripts/run-electron-test.mjs` 以 ELECTRON_RUN_AS_NODE=1 启动。
    entry: 'src/main/memory/memory.test.ts',
    outfile: 'dist/tests/memory.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['better-sqlite3'],
  },
];

await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, 'renderer', 'render'), { recursive: true });
await mkdir(path.join(DIST, 'renderer', 'input'), { recursive: true });
await mkdir(path.join(DIST, 'tests'), { recursive: true });

for (const bundle of bundles) {
  const args = [
    bundle.entry,
    '--bundle',
    `--platform=${bundle.platform}`,
    `--format=${bundle.format}`,
    `--target=${bundle.target}`,
    `--outfile=${bundle.outfile}`,
    '--sourcemap',
    '--charset=utf8',
    '--legal-comments=none',
    '--log-level=warning',
  ];
  for (const name of bundle.external ?? []) {
    args.push(`--external:${name}`);
  }

  const result = spawnSync(ESBUILD, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`esbuild 失败（${bundle.entry}），退出码 ${String(result.status)}`);
  }
}

const staticFiles = [
  ['src/renderer/render/index.html', 'dist/renderer/render/index.html'],
  ['src/renderer/render/styles.css', 'dist/renderer/render/styles.css'],
  ['src/renderer/input/index.html', 'dist/renderer/input/index.html'],
  ['src/renderer/input/input.css', 'dist/renderer/input/input.css'],
];

for (const [from, to] of staticFiles) {
  await copyFile(path.join(ROOT, from), path.join(ROOT, to));
}

console.log('[build] dist ready');
