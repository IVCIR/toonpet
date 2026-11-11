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
    // ADR 0052：控制面板 preload（最小出口：invoke(cmd:panel) + onState(cmd:panel-state)）
    entry: 'src/preload/panel.ts',
    outfile: 'dist/preload/panel.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    // ADR 0052：控制面板页面（与角色页/输入条一样走 file://，不起本地 Web Server）
    entry: 'src/renderer/panel/panel.ts',
    outfile: 'dist/renderer/panel/panel.js',
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
    // ADR 0057 D2：整体缩放的窗口几何（等比 / 底边中心锚点 / 工作区夹取）
    entry: 'src/shared/window-scale.test.ts',
    outfile: 'dist/tests/window-scale.test.mjs',
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
    // ADR 0044：停帧 hold 的权重（否则坐姿补偿会整块消失）
    entry: 'src/renderer/render/role-weight.test.ts',
    outfile: 'dist/tests/role-weight.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0051：下坐弹簧（k=180 / c=26.8，临界阻尼、固定子步长）
    entry: 'src/renderer/render/sit-drop.test.ts',
    outfile: 'dist/tests/sit-drop.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0051：坐姿两段式（14.2→16.0→16.2；阶段 B 覆盖 0.3s）
    entry: 'src/renderer/render/sit-sequence.test.ts',
    outfile: 'dist/tests/sit-sequence.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0044：坐姿活体微动（呼吸 / 自主张望 / 眨眼 / 悬空晃腿）
    entry: 'src/renderer/render/sit-motion.test.ts',
    outfile: 'dist/tests/sit-motion.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0049 D1：微动作池（15–30s 抽签 / 指数交叉淡入淡出 / 强制与间隔覆盖）
    entry: 'src/renderer/render/micro-pool.test.ts',
    outfile: 'dist/tests/micro-pool.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0049 D2：视线三级阻尼（眼 12 / 头 8 / 躯干 4，150ms 保持 + 慢回正）
    entry: 'src/renderer/render/gaze.test.ts',
    outfile: 'dist/tests/gaze.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0045 D2.1：坐姿头部基准（抬头补偿 / 世界朝向分解）
    entry: 'src/renderer/render/sit-head.test.ts',
    outfile: 'dist/tests/sit-head.test.mjs',
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
    // ADR 0041：片段表（裁剪窗口/悬空片段唯一性/待机池）与"播完回到原动作"
    entry: 'src/renderer/render/animation-controller.test.ts',
    outfile: 'dist/tests/animation-controller.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0050：待机静态站姿轮换（20–45s 间隔 / 排除当前 / 只抽可用角色）
    entry: 'src/renderer/render/idle-variation.test.ts',
    outfile: 'dist/tests/idle-variation.test.mjs',
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
    // ADR 0056：动态模型列表（Key 注入安全边界 / 2s 节流 / 单飞 / 空清单）
    entry: 'src/main/llm-model-list.test.ts',
    outfile: 'dist/tests/llm-model-list.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },  {
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
    // ADR 0052：控制面板参数契约（夹取/部分更新/与默认值的差）
    entry: 'src/shared/tunable-params.test.ts',
    outfile: 'dist/tests/tunable-params.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0052 D3：渲染进程的参数表（热更新 / 非法输入忽略 / 变化 id）
    entry: 'src/renderer/render/tunables-store.test.ts',
    outfile: 'dist/tests/tunables-store.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0052 D5 / ADR 0053：config.json 的解析/夹取/保留未知键/原子写/llm.model
    entry: 'src/main/panel-config.test.ts',
    outfile: 'dist/tests/panel-config.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0055：LLM 提供商配置的纯校验（地址/模型/Key 脱敏）
    entry: 'src/tests/llm-providers.test.ts',
    outfile: 'dist/tests/llm-providers.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0054：OCR 客户端（URL 归一化 / 响应解析 / 失败降级 / 文本归一化）
    entry: 'src/main/vision/vision-service.test.ts',
    outfile: 'dist/tests/vision-service.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0054：截图（来源选择 / 前台窗口匹配 / 降级 / 缩放）
    entry: 'src/main/vision/capture.test.ts',
    outfile: 'dist/tests/vision-capture.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0054：段 3.6（一次性消费 / 过期 / 预算 / 规则路径不消费）
    entry: 'src/main/orchestrator/vision-context.test.ts',
    outfile: 'dist/tests/vision-context.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0053：角色卡读写（空卡拒绝 / 原子写 / 缺失降级）
    entry: 'src/main/character-card.test.ts',
    outfile: 'dist/tests/character-card.test.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node20',
  },
  {
    // ADR 0052 D6：Ollama 探测（注入 fetch，不联网；超时/缺模型/在线三态）
    entry: 'src/main/ollama-probe.test.ts',
    outfile: 'dist/tests/ollama-probe.test.mjs',
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
await mkdir(path.join(DIST, 'renderer', 'panel'), { recursive: true });
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
  ['src/renderer/panel/index.html', 'dist/renderer/panel/index.html'],
  ['src/renderer/panel/panel.css', 'dist/renderer/panel/panel.css'],
];

for (const [from, to] of staticFiles) {
  await copyFile(path.join(ROOT, from), path.join(ROOT, to));
}

console.log('[build] dist ready');
