/**
 * 渲染页入口：装配真实 GLB 模型（缺失时回退占位胶囊体）与掩膜采集，
 * 接上 `cmd:probe` 应答、`cmd:drag` 上行、R-8 的拖拽暂停，以及 `model_ready` 上行。
 *
 * 契约 §3.3 R-2/R-4/R-8、§3.5、§6.3、§7.3；ADR 0002、ADR 0004 D1/D2、ADR 0009。
 * 掩膜不是公共接口：`window.petMask` 只在本页内使用（自检与 IPC 应答），不跨进程暴露。
 * 渲染侧**不计算任何手势阈值**：这里只上报 `{phase,x,y,t}`，判定全在主进程。
 */
import { REBOUND_SETTLE_MS } from '../../shared/constants';
import { createDragPause } from '../shell/drag-pause';
import { createSubtitle } from '../shell/subtitle';
import { createSubtitleCue } from '../shell/subtitle-cue';
import { createSpeechPlayer } from '../voice/speech-player';
import type { ClipRole } from './clip-bank';
import { createRenderModule } from './render-module';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) throw new Error('缺少 #stage 画布');

const stage: HTMLCanvasElement = canvas;

const query = new URLSearchParams(window.location.search);
const frameExclude = query.get('frameExclude') ?? undefined;
const hideAttachments = query.get('hideAttachments') ?? undefined;
const modelId = query.get('modelId') ?? undefined;
// 自检模式：只接受脚本合成的 PointerEvent，忽略真实鼠标（否则用户动一下鼠标就会打乱场景）
const ignoreTrustedPointer = query.get('selftest') === '1';

const { module, mask } = createRenderModule(stage, {
  frameExclude,
  hideAttachments,
  modelId,
  // ADR 0024 D5：行走是命令，不是事件——位移物理在主进程，这里只发"往哪边走"
  onWalkRequest: (command) => {
    window.petShell.requestWalk(command);
  },
  // §6.3：render 只产生 model_ready 这一个事件；走既有的 evt:broadcast（双向转发）
  onModelReady: (payload) => {
    window.petShell.sendEvent('model_ready', payload);
  },
});
module.resize(window.innerWidth, window.innerHeight);

// 契约 §7.3 的接口；跨进程轮询当前没有通道（ADR 0004 D7），这里供同页脚本与自检使用。
window.petRender = module;
window.petMask = mask;
// 内部诊断（不属于 §7.3）：包围盒/负载耗时/骨骼/视线/呼吸/口型预留状态，供自检读取
window.petModel = {
  getDiagnostics: () => module.getDiagnostics(),
  // ADR 0039 排查：头部带几何（掩膜包围盒 / 22% 下边界 / 头骨位置）
  headBandDiagnostics: () => module.headBandDiagnostics(),
};

/**
 * 骨骼轴向标定（ADR 0035 D5，仅开发/自检用；不属于 §7.3，也不跨进程）：
 *
 *   diagnostics.listBones()
 *   diagnostics.setBone('Bip001_Spine', 0, 0.2, 0)   // yaw, pitch, roll
 *   diagnostics.clear()
 *   diagnostics.boneWorld('Bip001_L_Hand')          // 看手往哪边动
 *
 * 约定：pitch 绕世界 X、roll 绕世界 Z、yaw 绕世界 Y（BoneArbiter 会转到父空间）。
 */
window.diagnostics = {
  listBones: () => module.listBones(),
  setBone: (name: string, yaw: number, pitch: number, roll: number) =>
    module.setDebugBoneOffset(name, yaw, pitch, roll),
  clear: () => module.clearDebugBoneOffsets(),
  boneWorld: (name: string) => module.getBoneWorld(name),
  // 阶段 14：手部发白诊断（只读 + 临时换材质；不改变生产默认路径）
  inspectMaterials: () => module.inspectMaterials(),
  tintSkin: (scope) => module.tintSkinVertices(scope),
  testHandMaterial: (color) => module.testHandMaterial(color),
  // ADR 0037：全局光照 + Toon 的 A/B 开关（关 = 修改前的无光照样子）
  setToon: (enabled) => module.setToonShading(enabled),
  // ADR 0038：描边 A/B 开关 + 光环受光对照
  setOutline: (enabled) => module.setOutline(enabled),
  setHaloToon: (enabled) => module.setHaloToon(enabled),
  resetMaterials: () => module.resetMaterialDiagnostics(),
  handScreenPoints: () => module.handScreenPoints(),
  // ADR 0046 D2：停帧不再眨眼，`forceBlink` 已删除（眼骨位移通道整套移除）
  // ADR 0044：极轻的坐姿微动快照（自检以 16ms 间隔采样张望/晃腿用）
  sitMotion: () => module.sitMotionDiagnostics(),
  // ADR 0047 取证：EyeMouth 贴图上叠绿色准星，用来分辨"瞳孔画低了"还是"卡片被挪走了"
  eyeProbe: (enabled: boolean) => module.setEyeProbe(enabled),
  // ADR 0047 取证：脸部特写相机（正交视锥收到脸上，不改模型/姿态）
  faceZoom: (size: number) => module.setFaceZoom(size),
  // ADR 0048 D2：坐姿头部微调（键盘 ↑/↓ 与自检共用）
  headTune: (rad: number) => module.setSitHeadTune(rad),
  // ADR 0049：微动作池（只读快照 / 强制条目 / 压缩间隔，全部只给自检与取证）
  microPool: () => module.microPoolDiagnostics(),
  forceMicroPool: (pool: 'idle' | 'sit', kind: string | null) => module.forceMicroPool(pool, kind),
  setMicroPoolInterval: (pool: 'idle' | 'sit', minMs: number, maxMs: number) =>
    module.setMicroPoolInterval(pool, minMs, maxMs),
  // ADR 0050：待机静态站姿轮换（只读快照 / 强制角色 / 压缩间隔，全部只给自检与取证）
  idleVariation: () => module.idleVariationDiagnostics(),
  forceIdleVariation: (role: string | null) => module.forceIdleVariation(role as ClipRole | null),
  setIdleVariationInterval: (minMs: number, maxMs: number) =>
    module.setIdleVariationInterval(minMs, maxMs),
  // ADR 0051：坐姿两段式（极轻快照 / 强制张望目标，只给自检与取证）
  sitSequence: () => module.sitSequenceDiagnostics(),
  forceSitGaze: (kind: 'camera' | 'wander') => module.forceSitGaze(kind),
  // ADR 0049 D2：视线三级阻尼的极轻快照（自检 16ms 采样"眼→头→躯干"的时间差）
  gaze: () => module.gazeDiagnostics(),
  // ADR 0052：当前生效的可调参数（证明控制面板的滑块真的到了渲染侧）
  tuning: () => module.tuningValues(),
};

// --- ADR 0048 D2：键盘 ↑/↓ 现场微调坐姿头部（**默认关闭**，只在 `?tune=1` 时挂载） ---
// 为什么默认不挂：桌宠窗口 `focusable: false`（§3.2），平时根本收不到键盘事件；留着监听
// 只会让"按方向键"这件事在别的调试场景里互相干扰。正式运行**不注册任何键盘监听**。
// 用法：`dsh web`/开发态给窗口地址加 `?tune=1`，或直接调 `window.diagnostics.headTune(rad)`
// （自检走的就是这条，所以"调出来的数"和"截图里的数"是同一个）。
function installHeadTuneKeys(): void {
  const HEAD_TUNE_STEP = 0.02;
  let headTuneValue = 0;
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    // Shift + ↑/↓ 走大步（0.1rad），方便快速找到大致范围
    const step = event.shiftKey ? 0.1 : HEAD_TUNE_STEP;
    headTuneValue += event.key === 'ArrowDown' ? step : -step;
    headTuneValue = module.setSitHeadTune(headTuneValue);
    console.log(`[render] ↑/↓ 微调：${headTuneValue.toFixed(2)}rad（ADR 0048 D2）`);
  });
  console.log('[render] 键盘微调已挂载（?tune=1；ADR 0048 D2）');
}

if (new URLSearchParams(window.location.search).has('tune')) installHeadTuneKeys();

// --- 字幕气泡（§8.3：TTS/LLM 不可用时的纯文本降级；§3.2 R-1 允许的唯一 DOM） ---
// 时序不在这一层决定：`intent_resolved` 只登记，`speech_started` 才显示（ADR 0021）。
const subtitle = createSubtitle();
const subtitleCue = createSubtitleCue({
  show: (text, holdMs) => subtitle.show(text, holdMs),
  holdFor: (holdMs) => subtitle.holdFor(holdMs),
  hide: () => subtitle.hide(),
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel: (handle) => {
    if (typeof handle === 'number') window.clearTimeout(handle);
  },
});

// --- 语音播放侧（ADR 0015 D3/D4）：解码 WAV、按包络推进口型、上报播放事实 ---
const speech = createSpeechPlayer({
  onStarted: (utteranceId) => {
    window.petShell.reportSpeech({ utteranceId, phase: 'started' });
  },
  onEnded: (utteranceId, reason, durationMs, detail) => {
    window.petShell.reportSpeech({
      utteranceId,
      phase: 'ended',
      reason,
      durationMs,
      ...(detail ? { detail } : {}),
    });
  },
  onFrame: (frame) => {
    module.setMouthFrame(frame);
  },
});
window.petVoice = { getDiagnostics: () => speech.getDiagnostics() };
// 字幕时序的内部诊断（不进 RenderState；自检与排查用）
window.petSubtitle = { getDiagnostics: () => subtitleCue.snapshot() };

window.petShell.onVoice((command) => {
  if (command.kind === 'speak') {
    void speech.play(command);
    return;
  }
  speech.stop(command.utteranceId);
});

// cmd:render-intent（§3.5）：动作命令只有这一条路径（orchestrator → render）
window.petShell.onRenderIntent((command) => {
  if (!command || typeof command !== 'object') return;
  module.handleIntent(command.intent);
});

// cmd:tuning（ADR 0052 D3）：控制面板滑块的热更新入口——只改内存值，下一帧生效。
window.petShell.onTuning((values) => {
  const changed = module.applyTuning(values);
  if (changed.length > 0) {
    console.log(`[render] 控制面板热更新：${changed.join(', ')}（ADR 0052）`);
  }
});

// cmd:state-poll（ADR 0052 D4）：面板可见时 4Hz 回报一次极轻快照（不碰 getDiagnostics）。
window.petShell.onStatePoll(() => {
  window.petShell.reportState(module.panelSnapshot());
});

window.addEventListener('beforeunload', () => {
  subtitleCue.dispose();
  speech.dispose();
  subtitle.dispose();
});

window.addEventListener('resize', () => {
  module.resize(window.innerWidth, window.innerHeight);
});

// cmd:probe → 掩膜判定 → cmd:interactive（渲染侧只回答事实，不改穿透：D-8）
// 同时把探针坐标交给视线跟随：穿透后收不到 mousemove（§3.6 P-1），探针是唯一可靠的光标信号。
let lastProbeLogAt = 0;
window.petShell.onProbe((request) => {
  module.setCursor(request.x, request.y);
  const sample = mask.probe(request.x, request.y);
  // ADR 0040：头部区不再用掩膜 bbox 22%，而是"以头骨为圆心、0.125 × 内容高为半径"。
  // 掩膜那一层只提供 hit 与降级用的 head；骨骼缺失/掩膜 cold 时才退回旧口径。
  const head = module.headSampleAt(sample.x, sample.y, sample.head, sample.hit);
  // ADR 0039/0040 排查打点（只读，≤4Hz）：这一点到底算不算"头部"，用的是哪条口径。
  const now = performance.now();
  if (now - lastProbeLogAt >= 250) {
    lastProbeLogAt = now;
    const band = module.headBandDiagnostics();
    const headY = band.headBoneCss ? band.headBoneCss.y : null;
    const dist = headY === null ? null : Math.round(Math.hypot(sample.x - band.headBoneCss!.x, sample.y - headY));
    console.log(
      `[render] probe css=(${Math.round(request.x)},${Math.round(request.y)}) ` +
        `hit=${String(sample.hit)} head=${String(head.head)} src=${head.source} ` +
        `boneY=${headY === null ? '-' : Math.round(headY)} radius=${band.headRadiusPx ?? '-'} dist=${dist ?? '-'} ` +
        `bandBottomY=${band.bandBottomCssY ?? '-'} bbox=${band.bbox ? `${band.bbox.minX},${band.bbox.minY}..${band.bbox.maxX},${band.bbox.maxY}` : '-'}`,
    );
  }
  window.petShell.reportProbe({
    hit: sample.hit,
    x: sample.x,
    y: sample.y,
    head: head.head,
  });
});

// --- R-8：拖拽期间暂停掩膜采集，松手后经 500ms 沉降窗口恢复（setPaused 的唯一输入） ---
const dragPause = createDragPause();

mask.setTickListener((now) => {
  if (dragPause.settle(now) !== 'resumed') return;
  mask.setPaused(false);
  console.log(
    `[render] 掩膜采集恢复（R-8：拖拽结束 + ${REBOUND_SETTLE_MS}ms 沉降窗口） pausedMs=${Math.round(
      dragPause.pausedMs ?? 0,
    )}`,
  );
});

window.petShell.onEvent((event) => {
  // HFSM（Base/Overlay/Physics）与动作切换都在 module 内部处理（ADR 0014 D3）
  module.handleEvent(event);

  if (event.name === 'intent_resolved') {
    // ADR 0021 D1：只登记待显示文本，**不显示**（TTS 还要 4–6s）
    subtitleCue.onIntentResolved((event.payload as { text?: unknown }).text);
    return;
  }

  if (event.name === 'speech_started') {
    // ADR 0021 D2：语音真的开始播了，同一帧显示完整字幕
    subtitleCue.onSpeechStarted(event.payload as { text?: unknown });
    return;
  }

  if (event.name === 'speech_ended') {
    // ADR 0021 D3/D4/D5：failed 兜底显示；completed/interrupted 只补尾巴
    subtitleCue.onSpeechEnded(event.payload as { reason?: unknown });
    return;
  }

  if (event.name === 'drag_started') {
    if (dragPause.onDragStarted(performance.now()) === 'paused') {
      mask.setPaused(true);
      console.log('[render] 掩膜采集暂停（R-8：拖拽中，穿透保持关闭）');
    }
    return;
  }
  if (event.name === 'drag_released') {
    dragPause.onDragReleased(performance.now());
  }
});

// --- cmd:drag：只上报原始指针事实（ADR 0004 D2），位移/速度/阈值全在主进程 ---
function reportPointer(phase: 'down' | 'up', event: PointerEvent): void {
  window.petShell.reportPointer({
    phase,
    x: event.clientX,
    y: event.clientY,
    t: performance.now(),
  });
}

window.addEventListener('pointerdown', (event) => {
  if (ignoreTrustedPointer && event.isTrusted) return;
  if (!event.isPrimary || event.button !== 0) return;
  // ADR 0035 D1：抓取点事实留在渲染进程，不跨 IPC；drag_started 到达时消费。
  module.noteGrabPoint(event.clientX, event.clientY, performance.now());
  // 拖到屏幕外时窗口会被 D-7 钳制停住，指针可能离开窗口；
  // 尽量用指针捕获把抬起事件留在本页（合成事件没有活动指针时会抛错，忽略即可）。
  try {
    stage.setPointerCapture(event.pointerId);
  } catch {
    // 忽略：无活动指针（自检的合成事件）或指针已释放
  }
  reportPointer('down', event);
});

window.addEventListener('pointerup', (event) => {
  if (ignoreTrustedPointer && event.isTrusted) return;
  if (!event.isPrimary || event.button !== 0) return;
  reportPointer('up', event);
});

window.addEventListener('pointercancel', (event) => {
  if (ignoreTrustedPointer && event.isTrusted) return;
  if (!event.isPrimary) return;
  // 系统取消（窗口被移动/焦点变化）也按抬起收尾，避免主进程的手势挂住
  reportPointer('up', event);
});

console.log(
  `[render] 渲染页就绪：GLB 管线 + 掩膜采集 + cmd:probe 应答 + cmd:drag 上行 + HFSM ` +
    `(frameExclude=${String(frameExclude)} hideAttachments=${String(hideAttachments)})`,
);
