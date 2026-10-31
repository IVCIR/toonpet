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
import { createRenderModule } from './render-module';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (!canvas) throw new Error('缺少 #stage 画布');

const stage: HTMLCanvasElement = canvas;

const query = new URLSearchParams(window.location.search);
const frameExclude = query.get('frameExclude') ?? undefined;
const hideAttachments = query.get('hideAttachments') ?? undefined;
const modelId = query.get('modelId') ?? undefined;
// 视觉调试（ADR 0027 D3）：贴花平面用纯色 + 隐藏 EyeMouth，用于核对位置/尺寸
const decalDebug = query.get('decalDebug') ?? undefined;
// 自检模式：只接受脚本合成的 PointerEvent，忽略真实鼠标（否则用户动一下鼠标就会打乱场景）
const ignoreTrustedPointer = query.get('selftest') === '1';

const { module, mask } = createRenderModule(stage, {
  frameExclude,
  hideAttachments,
  modelId,
  ...(decalDebug ? { decalDebug } : {}),
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
};

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
window.petShell.onProbe((request) => {
  module.setCursor(request.x, request.y);
  const sample = mask.probe(request.x, request.y);
  window.petShell.reportProbe({
    hit: sample.hit,
    x: sample.x,
    y: sample.y,
    head: sample.head,
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
