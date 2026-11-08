/**
 * 启动自检：`PET_SELFTEST=1` 时在窗口就绪后跑一组场景并落日志/截图，按结果退出。
 * `PET_SELFTEST_FALLBACK=1`（`npm run selftest:fallback`）时改跑"模型缺失"验收。
 *
 * 本文件只用于本机验证，不改变产品行为（§7.7 I-4）。
 * 探针点不再写死：真实模型的窗口尺寸/角色位置由包围盒决定，自检从
 * `window.petModel.getDiagnostics()` 取候选点，并用真实掩膜（`petMask.probe`）校验命中与头部带。
 */
import { app, BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron';
import type { NativeImage } from 'electron';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Rect } from '../shared/geometry';
import { SIT_HEAD_TUNE_RAD } from '../shared/constants';
import type { VisionResult } from '../shared/vision';
import { logInfo, logWarn } from './log';
import { getRuntime } from './runtime';
import { SELFTEST_LLM_MODEL, SELFTEST_TTS_PORT, startSelftestStubs } from './selftest-stubs';
import { pushScriptedCursor, resetScriptedCursor } from './shell/cursor-source';
import { pushScriptedForeground, resetScriptedForeground } from './shell/foreground-window';
import { rectsOverlap } from './shell/input-bar-geometry';
import { INPUT_HOTKEY_DEFAULT, INPUT_HOTKEY_FALLBACK } from './shell/hotkey';
import { shell } from './shell/index';
import type { InputBarDiagnostics, ShellBounds } from './shell/index';

const SETTLE_MS = 1200;
const MODEL_LOAD_TIMEOUT_MS = 15000;
const CAPTURE_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AcceptanceCheck {
  name: string;
  pass: boolean;
  detail?: unknown;
}

interface ProbePoint {
  x: number;
  y: number;
}

/** ADR 0049 D1：`window.diagnostics.microPool()` 的单池快照形状 */
interface MicroPoolDiagnostics {
  active: string;
  weights: Record<string, number>;
  nextSwitchInMs: number;
  switches: number;
  /** ADR 0049 D1 生命周期：非默认条目回默认的次数 / 自动回正倒计时 */
  releases: number;
  activeForMs: number;
  holdRemainingMs: number;
  forced: string | null;
}

/** ADR 0050：`window.diagnostics.idleVariation()` 的快照形状 */
interface IdleVariationDiagnostics {
  role: string;
  clip: string | null;
  nextInMs: number | null;
  switches: number;
  forced: string | null;
  minIntervalMs: number;
  maxIntervalMs: number;
  fadeSeconds: number;
  candidates: { role: string; clip: string }[];
}

/** ADR 0051：`window.diagnostics.sitSequence()` 的快照形状 */
interface SitSequenceDiagnostics {
  stage: 'a' | 'b';
  holdTimeSeconds: number | null;
  holdDurationSeconds: number | null;
  stageBBlend: number;
  stageBInMs: number | null;
  sitDrop: number;
  sitPoseGain: number;
  upperOverride: number;
  phaseAHeadAppliedRad: number;
  spineOverlayWeight: number;
  spineOverlayApplied: number;
  headQuat: [number, number, number, number] | null;
  headWorld: { x: number; y: number } | null;
}

interface ModelDiagnostics {
  ready: boolean;
  loading: boolean;
  error: string | null;
  modelId: string | null;
  loadMs: number | null;
  frame: { minX: number; maxX: number; minY: number; maxY: number } | null;
  content: { width: number; height: number };
  bones: { head: string | null; eyeL: string | null; eyeR: string | null; pelvis: string | null };
  hasMorphTargets: boolean;
  meshNames: string[];
  materialNames?: string[];
  hiddenMeshes: string[];
  mouth: { materialName: string | null; atlasLoaded: boolean; calibrated: boolean };
  gaze: {
    yaw: number;
    pitch: number;
    targetYaw: number;
    targetPitch: number;
    idle: boolean;
    /** ADR 0049 D2：眼球的额外偏移 / 躯干偏航 / 当前阶段（三级阻尼诊断） */
    eyeYaw?: number;
    eyePitch?: number;
    spineYaw?: number;
    phase?: string;
    /** ADR 0049 D2 真机取证：Spine1 骨骼**实际**被写入的偏航（不是控制器提交量） */
    spineBone?: {
      spineYawRad: number;
      spineYawDeg: number;
      axisY: number;
      submittedYawRad: number;
    } | null;
  };
  animation:
    | {
        clipCount: number;
        clips: string[];
        idle: ClipDiagnostics;
        held: ClipDiagnostics;
        walk: ClipDiagnostics;
        current: { name: string | null; slot: string | null; time: number; weight: number; running: boolean };
        actions: { name: string; weight: number; time: number; running: boolean }[];
        groundCorrectionPx: number | null;
      }
    | null;
  hfsm: {
    base: string;
    overlay: string | null;
    physics: string | null;
    speakingUtteranceId: string | null;
    reaction: { kind: string; intent: string | null; startedAt: number; durationMs: number } | null;
  };
  /** ADR 0024：行走 / 回弹状态 */
  motion: {
    base: string;
    physics: string | null;
    walking: { direction: string; distancePx: number } | null;
    nextWalkInMs: number | null;
    /** 行走朝向（rad；ADR 0026 D1） */
    walkYaw?: number;
    walkYawTarget?: number;
  };
  /** ADR 0028：吸附与坐姿 */
  sit?: {
    sitting: boolean;
    /** ADR 0034：false = 接近阶段，true = 已落座 */
    arrived?: boolean;
    approach?: { mode: 'walk' | 'leap'; durationMs: number; progress: number } | null;
    edge: 'top' | 'bottom' | null;
    procedural: boolean;
    clip: string | null;
    done: boolean | null;
    /** ADR 0043 D2 的循环坐姿已在 ADR 0044 废止，恒为 false；保留只为不破坏诊断形状 */
    looping?: boolean;
    /** ADR 0043 D3：坐姿混合权重 0..1 */
    blend?: number;
    clipWeight?: number;
    dropPx: number;
    /** ADR 0044/0046：活体微动（呼吸 / 自主张望 / 眼球 / 晃腿） */
    motion?: {
      gain: number;
      breathPx: number;
      spinePitch: number;
      claviclePitch?: number;
      upperArmPitch?: number;
      gaze: {
        yaw: number;
        pitch: number;
        targetYaw: number;
        targetPitch: number;
        /** ADR 0051：`camera` = 看屏幕中心，`wander` = 随机张望 */
        targetKind?: 'camera' | 'wander';
        nextInMs: number;
      };
      eye?: { yaw: number; pitch: number };
      legs: { gain: number; thighL: number; thighR: number; calfL: number; calfR: number };
    } | null;
    /** ADR 0042/0051：下坐进度（sitDrop）与"悬空高度" */
    transition?: number;
    transitionLiftPx?: number;
    /** ADR 0051：两段式阶段 / 覆盖权重 / 下坐弹簧 */
    stage?: 'a' | 'b';
    stageBBlend?: number;
    sitDrop?: number;
    sitPoseGain?: number;
    upperOverride?: number;
    /** ADR 0051 D7：阶段 A 抬头补偿 / 下背覆盖权重 */
    phaseAHeadTuneRad?: number;
    phaseAHeadAppliedRad?: number;
    spineOverlayWeight?: number;
    spineOverlayApplied?: number;
    holdAtSeconds?: number;
    holdTimeSeconds?: number | null;
    offsetPx?: { x: number; y: number };
    rawOffsetPx?: { x: number; y: number };
    /** ADR 0046 D3.1：微侧身偏航（rad） */
    bodyYaw?: number;
    /** 头骨本地四元数（诊断"头在打转"的累积漂移） */
    headQuat?: [number, number, number, number] | null;
    headWorld?: { x: number; y: number } | null;
    headBase?: { baseFrom: string | null; yaw: number; pitch: number; roll: number } | null;
    /** ADR 0048 D1：站立上半身姿态（胸/颈/头的局部四元数）是否已记录 */
    idleUpperCaptured?: boolean;
    /** ADR 0048 D2：当前人工微调量（rad，正 = 低头） */
    headTune?: number;
    headOrientation?: { pitch: number; yaw: number } | null;
    /** ADR 0046 D1：眼球当前相对头骨的朝向 */
    eyeOrientation?: { pitch: number; yaw: number } | null;
  };
  /** ADR 0035：拖拽抓取点/受迫摆/落地分级 */
  drag?: {
    phase: 'idle' | 'dragged' | 'settling';
    band: 'head' | 'body' | 'foot' | null;
    pivot: { x: number; y: number };
    angle: number;
    omega: number;
    gain: number;
    supportAcceleration: { x: number; y: number };
    landingImpact: number | null;
    landingSquash?: number;
    /** 最近一次落地冲击（缓冲只有 220ms，诊断读不到时靠它） */
    lastLandingImpact?: number;
    lastLandingSquash?: number;
    landingCount?: number;
    startle: string | null;
  };
  facial?: {
    emotion: string;
    effective: string;
    eyes: string | null;
    mouthShape: string;
    mouthOwner: string;
    blush: number;
    alpha: number;
    fading: boolean;
    repaints: number;
    lastRepaintMs: number | null;
    channel: {
      calibrated: boolean;
      eyeCalibrated: boolean;
      eyePixels: number;
      mouthPixels: number;
      /** ADR 0045 D4.1：最近一次画嘴的图集帧 / alpha 裁边 / 目标矩形 */
      mouth?: {
        kind: string;
        frame: number | null;
        box: { x: number; y: number; width: number; height: number } | null;
        target: { x: number; y: number; width: number; height: number } | null;
      } | null;
      textureDigest?: string | null;
      /** 与首次绘制基线的平均绝对差（0..1） */
      faceDistance?: number | null;
    } | null;
    blushChannel: {
      calibrated: boolean;
      mouthPixels: number;
      textureDigest?: string | null;
      faceDistance?: number | null;
    } | null;
    assets?: {
      loadedEyes: string[];
      blushLoaded: boolean;
      missing: string[];
      eyeImageLabel: string | null;
    };
  };
  /** ADR 0039：摸头反应（官方片段 + 表情投影，无程序化姿态） */
  pat: {
    active: boolean;
    body: boolean;
    clip: string | null;
    blockedBy: 'dragged' | 'settling' | 'sitting' | 'walking' | 'speaking' | 'missing' | null;
  };
  speech: { frame: number; driven: boolean };
  /** ADR 0049 D1：微动作池（idle / sitting）的只读快照 */
  microPool?: {
    idle: MicroPoolDiagnostics | null;
    sit: MicroPoolDiagnostics | null;
  };
  /** ADR 0050：待机静态站姿轮换（当前角色 / 下一次倒计时 / 候选池） */
  idleVariation?: IdleVariationDiagnostics;
  /** ADR 0037：全局光照 + Toon（内部诊断） */
  toon: {
    enabled: boolean;
    ambient: number;
    directional: number;
    direction: [number, number, number];
    gradientSteps: number[];
    gradientWidth: number;
    materials: Array<{ mesh: string; material: string; from: string; to: string }>;
    litMeshes: string[];
  } | null;
  /** ADR 0038：背面法描边（内部诊断） */
  outline: {
    enabled: boolean;
    width: number;
    hairWidth: number;
    depthBias: number;
    color: string;
    sources: string[];
    meshes: Array<{ source: string; outline: string; sharedGeometry: boolean; skinned: boolean }>;
    tracked: boolean;
    matrixDelta: number;
  } | null;
  render: { calls: number; triangles: number; frameMs: number } | null;
  probePoints: { head: ProbePoint | null; body: ProbePoint | null };
}

interface ClipDiagnostics {
  name: string | null;
  reason: string;
  preferred: string;
}

function petLogPath(): string {
  return path.join(app.getAppPath(), 'logs', 'pet.log');
}

async function readPetLog(): Promise<string> {
  try {
    return await readFile(petLogPath(), 'utf8');
  } catch {
    return '';
  }
}

/** 本次自检开始前的日志行数：`pet.log` 跨运行追加，断言只看本次运行。 */
let logBaselineLines = 0;

/** 本进程启动时刻：selftest 模块在 bootstrap 的 import 链里加载，早于 app.ready。 */
const PROCESS_STARTED_AT = Date.now();

/**
 * 按时间戳求"本次运行"的日志起点。
 *
 * 为什么不用"当前行数"：`model_ready` 可能在 `runtime.start()` 完成之前就落盘，
 * 而 `runSelfTestIfRequested()` 在那之后才执行；按行数切分会把本轮已经发生的事件
 * 算成上一轮，导致 `收到 model_ready` 偶发断言失败（2026-10-30 复现）。
 */
function baselineLineCount(text: string, startedAt: number): number {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\[([^\]]+)\]/.exec(lines[index]);
    if (!match) continue;
    const at = Date.parse(match[1]);
    if (Number.isFinite(at) && at >= startedAt) return index;
  }
  return lines.length;
}

async function runLogText(): Promise<string> {
  const text = await readPetLog();
  if (!text) return '';
  return text.split('\n').slice(logBaselineLines).join('\n');
}

async function countInLog(marker: string): Promise<number> {
  const text = await runLogText();
  if (!text || !marker) return 0;
  return text.split(marker).length - 1;
}

function lastJsonAfter(text: string, marker: string): Record<string, unknown> | null {
  const lines = text.split('\n').filter((line) => line.includes(marker));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const at = line.indexOf('{');
  if (at < 0) return null;
  try {
    return JSON.parse(line.slice(at)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function lastPausedMs(text: string): number | null {
  const lines = text.split('\n').filter((line) => line.includes('掩膜采集恢复'));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const match = /pausedMs=(\d+(?:\.\d+)?)/.exec(line);
  return match ? Number(match[1]) : null;
}

function visibleExtent(bounds: ShellBounds, area: Rect): { width: number; height: number } {
  const left = Math.max(bounds.x, area.x);
  const right = Math.min(bounds.x + bounds.width, area.x + area.width);
  const top = Math.max(bounds.y, area.y);
  const bottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** 与 shell/motion 同口径：取与窗口重叠面积最大的工作区（D-7 禁止 getDisplayNearestPoint）。 */
function workAreaFor(bounds: ShellBounds): Rect {
  const areas = screen.getAllDisplays().map((display) => display.workArea);
  let best: Rect = areas[0] ?? { x: 0, y: 0, width: 1920, height: 1080 };
  let bestOverlap = -1;
  for (const area of areas) {
    const overlap = visibleExtent(bounds, area);
    const value = overlap.width * overlap.height;
    if (value > bestOverlap) {
      bestOverlap = value;
      best = area;
    }
  }
  return best;
}

/**
 * 表情贴图的判定阈值（ADR 0026 D4.4）。
 *
 * 单位是"贴图缩略图与基线的平均绝对差"（0..1，见 `faceDistance`）。实测：
 * 四种情绪 1.5%–6%，还原 neutral 后 ≤0.2%；红晕层（颊部面积小）0.5% 量级。
 */
const EMOTION_DISTANCE_MIN = 0.01;
/** 缺差分时只变嘴型的差异量级（实测 0.1%–0.3%），远小于有眼型时的 ≥1% */
const MOUTH_ONLY_DISTANCE_MIN = 0.0005;
const BLUSH_DISTANCE_MIN = 0.002;
const BLUSH_RESTORE_MAX = 0.0015;
/** 恢复 neutral 后的贴图允许残差（脏矩形边界的 1 texel 抗锯齿差异） */
const NEUTRAL_RESTORE_MAX = 0.002;

/** 自检截图：Idle / 拖拽 / 摸头 / 语音四类帧（ADR 0014、ADR 0015 验收要求）。 */
async function captureToImage(window: BrowserWindow, fileName: string): Promise<CapturedImage> {
  await sleep(CAPTURE_DELAY_MS);
  const startedAt = Date.now();
  const image = await window.webContents.capturePage();
  const outputDir = path.join(app.getAppPath(), 'dist', 'selftest');
  await mkdir(outputDir, { recursive: true });
  const pngPath = path.join(outputDir, fileName);
  await writeFile(pngPath, await image.toPNG());
  logInfo('selftest', 'capture-timing', {
    fileName,
    captureMs: Date.now() - startedAt,
    size: image.getSize(),
  });
  return { image, pngPath };
}

async function captureScreenshot(
  window: BrowserWindow,
  fileName: string,
  mode: string,
): Promise<string> {
  const captured = await captureToImage(window, fileName);
  logInfo('selftest', 'capture', { mode, pngPath: captured.pngPath, size: captured.image.getSize() });
  return captured.pngPath;
}

/**
 * DIP 矩形 → 物理像素矩形（`pushScriptedForeground` 的输入口径）。
 * 用 Electron 的 `screen.dipToScreenPoint()` 求逆，保证与主进程 `screenToDipPoint`
 * 的换算完全对称（自检断言才能卡在 ±1px）。
 */
function dipRectToPhysical(rect: Rect): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const topLeft = screen.dipToScreenPoint({ x: rect.x, y: rect.y });
  const bottomRight = screen.dipToScreenPoint({
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  });
  return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
}

/**
 * 抓一张**桌面合成图**（ADR 0028 验收：她坐在记事本窗口边缘的样子）。
 *
 * `capturePage()` 只给桌宠自己的窗口（透明底），看不到她与目标窗口的相对位置；
 * 这里用 `desktopCapturer` 抓主显示器整屏（物理像素），是唯一能证明"坐在别人窗口边缘"的证据。
 * 失败只记 WARN 并返回 null（某些远程会话/受控桌面里屏幕捕获会被禁用）。
 */
async function captureDesktop(fileName: string): Promise<{ pngPath: string; size: { width: number; height: number } } | null> {
  try {
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(primary.size.width * primary.scaleFactor),
        height: Math.round(primary.size.height * primary.scaleFactor),
      },
    });
    const source =
      sources.find((item) => item.display_id === String(primary.id)) ?? sources[0] ?? null;
    if (!source || source.thumbnail.isEmpty()) {
      logWarn('selftest', '桌面截图不可用（没有屏幕源或缩略图为空）', {
        sources: sources.length,
        fileName,
      });
      return null;
    }
    const outputDir = path.join(app.getAppPath(), 'dist', 'selftest');
    await mkdir(outputDir, { recursive: true });
    const pngPath = path.join(outputDir, fileName);
    await writeFile(pngPath, source.thumbnail.toPNG());
    const size = source.thumbnail.getSize();
    logInfo('selftest', 'capture-desktop', { fileName, pngPath, size });
    return { pngPath, size };
  } catch (error) {
    logWarn('selftest', '桌面截图失败（继续跑其余断言）', { fileName, error: String(error) });
    return null;
  }
}

interface CapturedImage {
  image: NativeImage;
  pngPath: string;
}

interface SubtitleFacts {
  text: string | null;
  visible: boolean;
}

interface VoiceDiagnostics {
  speaking: boolean;
  utteranceId: string | null;
  level: number;
  frame: number;
  contextState: string | null;
  envelopeMs: number | null;
  windowCount: number;
}

async function readSubtitle(window: BrowserWindow): Promise<SubtitleFacts> {
  try {
    const raw = (await window.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById('subtitle');
        return JSON.stringify({ text: el ? el.textContent : null, visible: el ? el.classList.contains('visible') : false });
      })()`,
      true,
    )) as string;
    return JSON.parse(raw) as SubtitleFacts;
  } catch {
    return { text: null, visible: false };
  }
}

/** ADR 0054：等字幕出现某段文字（TTS 桩要先把 WAV 合成完，字幕不早于 speech_started） */
async function waitForSubtitleText(
  window: BrowserWindow,
  needle: string,
  timeoutMs = 12000,
): Promise<SubtitleFacts> {
  const deadline = Date.now() + timeoutMs;
  let last: SubtitleFacts = { text: null, visible: false };
  while (Date.now() < deadline) {
    last = await readSubtitle(window);
    if (last.visible && (last.text ?? '').includes(needle)) return last;
    await sleep(100);
  }
  return last;
}

async function readVoiceDiagnostics(window: BrowserWindow): Promise<VoiceDiagnostics | null> {
  try {
    const raw = (await window.webContents.executeJavaScript(
      `JSON.stringify(window.petVoice ? window.petVoice.getDiagnostics() : null)`,
      true,
    )) as string;
    return JSON.parse(raw) as VoiceDiagnostics | null;
  } catch {
    return null;
  }
}

interface SubtitleCueFacts {
  pending: string | null;
  visible: boolean;
  armed: boolean;
}

/** 渲染侧字幕时序诊断（ADR 0021；不进 RenderState） */
async function readSubtitleCue(window: BrowserWindow): Promise<SubtitleCueFacts | null> {
  try {
    const raw = (await window.webContents.executeJavaScript(
      `JSON.stringify(window.petSubtitle ? window.petSubtitle.getDiagnostics() : null)`,
      true,
    )) as string;
    return JSON.parse(raw) as SubtitleCueFacts | null;
  } catch {
    return null;
  }
}

/** 轮询渲染侧字幕时序诊断（ADR 0021） */
async function waitForSubtitleCue(
  window: BrowserWindow,
  predicate: (cue: SubtitleCueFacts) => boolean,
  timeoutMs = 3000,
): Promise<SubtitleCueFacts | null> {
  const deadline = Date.now() + timeoutMs;
  let last = await readSubtitleCue(window);
  while (Date.now() < deadline) {
    if (last && predicate(last)) return last;
    await sleep(50);
    last = await readSubtitleCue(window);
  }
  return last;
}

async function submitUtterance(window: BrowserWindow, text: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `window.petShell.submitUtterance(${JSON.stringify(text)})`,
    true,
  );
}

/**
 * 自检专用：直接把 `intent_resolved` 注入渲染页（生产路径是主进程广播）。
 * 只用于验证"emotion → 面部贴图"这条渲染侧链路，不改变任何事件契约。
 */
async function pushEmotion(window: BrowserWindow, emotion: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `window.petRender.handleEvent({ name: 'intent_resolved', payload: { emotion: ${JSON.stringify(
      emotion,
    )} } })`,
    true,
  );
}

async function waitForLog(marker: string, minCount: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while (Date.now() < deadline) {
    count = await countInLog(marker);
    if (count >= minCount) return count;
    await sleep(80);
  }
  return count;
}

async function waitForLogJson(
  marker: string,
  predicate: (json: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    last = lastJsonAfter(await runLogText(), marker);
    if (last && predicate(last)) return last;
    await sleep(80);
  }
  return last;
}

async function waitForVoice(
  window: BrowserWindow,
  predicate: (diagnostics: VoiceDiagnostics | null) => boolean,
  timeoutMs = 4000,
): Promise<VoiceDiagnostics | null> {
  const deadline = Date.now() + timeoutMs;
  let last: VoiceDiagnostics | null = null;
  while (Date.now() < deadline) {
    last = await readVoiceDiagnostics(window);
    if (predicate(last)) return last;
    await sleep(60);
  }
  return last;
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(rect.width), width - x)),
    height: Math.max(1, Math.min(Math.round(rect.height), height - y)),
  };
}

/** 两张截图的局部像素差（BGRA；忽略 alpha，单通道差 > 16 计为变化）。 */
function diffRegion(
  before: NativeImage,
  after: NativeImage,
  region: Rect,
): { changed: number; total: number; rect: Rect } {
  const size = before.getSize();
  const rect = clampRect(region, size.width, size.height);
  const a = before.crop(rect).toBitmap();
  const b = after.crop(rect).toBitmap();
  const total = Math.min(a.length, b.length) / 4;
  let changed = 0;
  for (let index = 0; index + 3 < Math.min(a.length, b.length); index += 4) {
    if (
      Math.abs((a[index] ?? 0) - (b[index] ?? 0)) > 16 ||
      Math.abs((a[index + 1] ?? 0) - (b[index + 1] ?? 0)) > 16 ||
      Math.abs((a[index + 2] ?? 0) - (b[index + 2] ?? 0)) > 16
    ) {
      changed += 1;
    }
  }
  return { changed, total, rect };
}

/** 面部/嘴部区域：以自检探针的头部点为基准（口型在头点下方 60–180 CSS px 的带内）。 */
function mouthRegion(diagnostics: ModelDiagnostics | null, content: { width: number; height: number }): Rect {
  const head = diagnostics?.probePoints?.head ?? null;
  const x = head ? head.x : content.width / 2;
  const y = head ? head.y : content.height * 0.3;
  return { x: x - 60, y: y + 60, width: 120, height: 120 };
}

/**
 * 整张脸的像素区域（ADR 0026 验收：眼睛 + 颊部 + 嘴）。
 * 头点是"取景框顶部 17%"，脸（眼/颊/嘴）在它下方 8–140 CSS px 的带内。
 */
function faceRegion(diagnostics: ModelDiagnostics | null, content: { width: number; height: number }): Rect {
  const head = diagnostics?.probePoints?.head ?? null;
  const x = head ? head.x : content.width / 2;
  const y = head ? head.y : content.height * 0.25;
  return { x: x - 78, y: y + 8, width: 156, height: 136 };
}

async function readDiagnostics(window: BrowserWindow): Promise<ModelDiagnostics | null> {
  try {
    const raw = (await window.webContents.executeJavaScript(
      `(() => {
        const api = window.petModel;
        return JSON.stringify(api ? api.getDiagnostics() : null);
      })()`,
      true,
    )) as string;
    return JSON.parse(raw) as ModelDiagnostics | null;
  } catch {
    return null;
  }
}

async function waitFor(
  window: BrowserWindow,
  timeoutMs: number,
  predicate: (diagnostics: ModelDiagnostics | null) => boolean,
): Promise<ModelDiagnostics | null> {
  const deadline = Date.now() + timeoutMs;
  let last: ModelDiagnostics | null = null;
  while (Date.now() < deadline) {
    last = await readDiagnostics(window);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

interface ResolvedPoints {
  head: ProbePoint | null;
  body: ProbePoint | null;
  preferred: Record<string, unknown> | null;
  bbox: unknown;
}

/** 用真实掩膜校验候选点；不可用时在掩膜 bbox 内扫描出可命中点。 */
async function resolvePoints(window: BrowserWindow): Promise<ResolvedPoints> {
  const raw = (await window.webContents.executeJavaScript(
    `(() => {
      const m = window.petMask;
      const d = window.petModel ? window.petModel.getDiagnostics() : null;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const probe = (x, y) => {
        const s = m.probe(x, y);
        // ADR 0040：head 的权威口径在渲染侧（头骨半径）；掩膜那一层只给 hit 与降级值
        const h = window.petRender.headSampleAt(s.x, s.y, s.head, s.hit);
        return { x, y, hit: s.hit, headMask: s.head, head: h.head, src: h.source };
      };
      const out = { head: null, body: null, preferred: {}, bbox: m.snapshot().bbox };
      const preferred = d && d.probePoints ? d.probePoints : null;
      if (preferred) {
        for (const key of ['head', 'body']) {
          const pt = preferred[key];
          if (!pt) continue;
          const v = probe(pt.x, pt.y);
          out.preferred[key] = v;
          if (key === 'head' && v.hit && v.head) out.head = { x: pt.x, y: pt.y };
          if (key === 'body' && v.hit) out.body = { x: pt.x, y: pt.y };
        }
      }
      const bbox = out.bbox;
      if (bbox && (!out.head || !out.body)) {
        const toCss = (mx, my) => ({ x: ((mx + 0.5) / 128) * w, y: ((my + 0.5) / 72) * h });
        const spanY = bbox.maxY - bbox.minY;
        const step = 0.4;
        if (!out.head) {
          outerHead: for (let my = bbox.minY; my <= bbox.minY + spanY * 0.6; my += step) {
            for (let mx = bbox.minX; mx <= bbox.maxX; mx += step) {
              const pt = toCss(mx, my);
              const v = probe(pt.x, pt.y);
              if (v.hit && v.head) { out.head = pt; break outerHead; }
            }
          }
        }
        if (!out.body) {
          for (let my = bbox.minY + spanY * 0.45; my <= bbox.minY + spanY * 0.9; my += step) {
            for (let mx = bbox.minX; mx <= bbox.maxX; mx += step) {
              const pt = toCss(mx, my);
              const v = probe(pt.x, pt.y);
              if (v.hit && !v.head) { out.body = pt; break; }
            }
          }
        }
      }
      return JSON.stringify(out);
    })()`,
    true,
  )) as string;
  return JSON.parse(raw) as ResolvedPoints;
}

/**
 * 取"能命中头带/身体"的探针点。
 *
 * 掩膜是离屏渲染 + 逐帧回读的：模型刚加载完的那一帧 `bbox` 可能还是 `null`
 * （cold，R-9 的矩形退路），此时 `head` 也必然是 `null`。这会让"找到头部带命中点"
 * 变成偶发失败（2026-11-03 复现一次）。这里只做**等掩膜就绪**的有界重试，
 * 不改变任何断言口径：等不到就照实返回 null，断言仍会失败。
 */
async function resolveMaskPoints(window: BrowserWindow): Promise<ResolvedPoints> {
  let points = await resolvePoints(window);
  for (let attempt = 0; attempt < 8 && points.head === null && points.bbox === null; attempt += 1) {
    await sleep(120);
    points = await resolvePoints(window);
  }
  return points;
}

/**
 * 在**当前姿态**的掩膜里找一个真实命中点（自检用）。
 *
 * 为什么需要：坐姿与站姿的身体轮廓完全不同，加载时算出的 body 探针点在 `sitting`
 * 时会落到空气里（本轮实测：探针判 transparent → 按下被 D-2 门槛拒绝）。
 * 扫描从窗口中线向两侧扩、从下往上找：先命中的点落在她的下半身，
 * 既避开头部带（不误触摸头），也离窗口边缘足够远（掩膜边缘容易抖动）。
 */
async function findCurrentHitPoint(window: BrowserWindow): Promise<ProbePoint | null> {
  try {
    const raw = (await window.webContents.executeJavaScript(
      `(() => {
        const m = window.petMask;
        const w = window.innerWidth;
        const h = window.innerHeight;
        const centerX = Math.round(w / 2);
        const offsets = [];
        for (let d = 0; d < w / 2 - 24; d += 16) {
          offsets.push(d);
          if (d !== 0) offsets.push(-d);
        }
        // 命中点必须落在"实心区域"里（周围 8px 的四个邻点至少 3 个也命中）：
        // ADR 0043 起坐姿是活的（呼吸/片段循环会让身体逐帧移动 1–3px），
        // 落在轮廓边缘（例如两腿之间、裙摆边、发梢）的点会在几百毫秒后变成透明，
        // 按下就被判 not-interactive。
        const isSolid = (x, y) => {
          const neighbors = [
            m.probe(x - 8, y).hit,
            m.probe(x + 8, y).hit,
            m.probe(x, y - 8).hit,
            m.probe(x, y + 8).hit,
          ];
          return neighbors.filter(Boolean).length >= 3;
        };
        // ① 优先从**骨盆**所在高度往上下扫：躯干是最大的一块实心区域，最稳
        let bodyY = null;
        try {
          const d = window.petModel && window.petModel.getDiagnostics();
          bodyY = d && d.probePoints && d.probePoints.body ? d.probePoints.body.y : null;
        } catch {}
        if (typeof bodyY === 'number' && Number.isFinite(bodyY)) {
          for (let dy = 0; dy < h / 2; dy += 12) {
            for (const y of dy === 0 ? [bodyY] : [bodyY - dy, bodyY + dy]) {
              if (y < 48 || y > h - 48) continue;
              for (const offset of offsets) {
                const x = centerX + offset;
                if (x < 24 || x > w - 24) continue;
                if (m.probe(x, y).hit && isSolid(x, y)) return JSON.stringify({ x, y });
              }
            }
          }
        }
        // ② 退回"从下往上扫"（旧行为），仍要求实心
        for (let y = h - 48; y > 48; y -= 16) {
          for (const offset of offsets) {
            const x = centerX + offset;
            if (x < 24 || x > w - 24) continue;
            if (m.probe(x, y).hit && isSolid(x, y)) return JSON.stringify({ x, y });
          }
        }
        // ③ 兜底：任意命中点（保证旧路径可用）
        for (let y = h - 48; y > 48; y -= 16) {
          for (const offset of offsets) {
            const x = centerX + offset;
            if (x < 24 || x > w - 24) continue;
            if (m.probe(x, y).hit) return JSON.stringify({ x, y });
          }
        }
        return 'null';
      })()`,
      true,
    )) as string;
    return JSON.parse(raw) as ProbePoint | null;
  } catch {
    return null;
  }
}

async function runFallbackSuite(window: BrowserWindow, checks: AcceptanceCheck[]): Promise<void> {  const check = (name: string, pass: boolean, detail?: unknown): void => {
    checks.push({ name, pass, detail });
  };

  const diagnostics = await waitFor(window, 5000, (d) => d !== null && d.loading === false);
  check('缺失模型：modelReady=false', diagnostics?.ready === false, diagnostics?.error ?? null);
  const fullLog = await readPetLog();
  check(
    '缺失模型：有明确失败原因（日志可诊断）',
    fullLog.includes('模型文件不存在') && fullLog.includes('模型加载失败'),
  );

  const bounds = window.getContentBounds();
  check(
    '缺失模型：窗口退回默认 480×720',
    bounds.width === 480 && bounds.height === 720,
    bounds,
  );

  // 胶囊体没有探针就不会采掩膜：先把光标停到胶囊体上，等一次采集后再取点位
  const boundsForProbe = window.getContentBounds();
  pushScriptedCursor(boundsForProbe.x + boundsForProbe.width / 2, boundsForProbe.y + boundsForProbe.height * 0.75);
  await sleep(600);
  const points = await resolvePoints(window);
  check('缺失模型：占位胶囊体可命中（不白屏）', points.body !== null, points);

  await sleep(CAPTURE_DELAY_MS);
  const image = await window.webContents.capturePage();
  const outputDir = path.join(app.getAppPath(), 'dist', 'selftest');
  await mkdir(outputDir, { recursive: true });
  const pngPath = path.join(outputDir, 'window-fallback.png');
  await writeFile(pngPath, await image.toPNG());
  logInfo('selftest', 'capture', { mode: 'fallback', pngPath, size: image.getSize() });

  const failed = checks.filter((item) => !item.pass);
  logInfo('selftest', '模型缺失回退验收', { total: checks.length, failed: failed.length, checks });
  await shell.stop();
  app.exit(failed.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 输入条套件（第 6 步验收：热键入口 / 定位 / 提交 / Esc / 失焦）
// ---------------------------------------------------------------------------

async function waitForInputBar(
  predicate: (facts: InputBarDiagnostics) => boolean,
  timeoutMs = 3000,
): Promise<InputBarDiagnostics> {
  const deadline = Date.now() + timeoutMs;
  let last = shell.inputBarDiagnostics();
  while (Date.now() < deadline) {
    last = shell.inputBarDiagnostics();
    if (predicate(last)) return last;
    await sleep(60);
  }
  return last;
}

async function waitForSubtitle(
  window: BrowserWindow,
  needle: string,
  timeoutMs = 6000,
): Promise<SubtitleFacts> {
  const deadline = Date.now() + timeoutMs;
  let last = await readSubtitle(window);
  while (Date.now() < deadline) {
    last = await readSubtitle(window);
    if (last.visible && (last.text ?? '').includes(needle)) return last;
    await sleep(100);
  }
  return last;
}

/** 字幕元素在**屏幕坐标**下的矩形（CSS px 与 DIP 1:1，缩放因子恒为 1：ADR 0004 D1.2）。 */
async function readSubtitleBox(window: BrowserWindow): Promise<Rect | null> {
  try {
    const raw = (await window.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById('subtitle');
        if (!el) return 'null';
        const r = el.getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
      })()`,
      true,
    )) as string;
    const box = JSON.parse(raw) as { left: number; top: number; width: number; height: number } | null;
    if (!box) return null;
    const content = window.getContentBounds();
    return {
      x: content.x + box.left,
      y: content.y + box.top,
      width: box.width,
      height: box.height,
    };
  } catch {
    return null;
  }
}

interface InputPageState {
  value: string;
  activeId: string | null;
}

async function readInputPageState(window: BrowserWindow): Promise<InputPageState | null> {
  try {
    const raw = (await window.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById('text');
        return JSON.stringify({
          value: el ? el.value : '',
          activeId: document.activeElement ? document.activeElement.id : null,
        });
      })()`,
      true,
    )) as string;
    return JSON.parse(raw) as InputPageState;
  } catch {
    return null;
  }
}

/** 在输入页里填入文本并按 Enter（走页面自己的 keydown 处理，不绕过它）。 */
async function submitFromInputPage(window: BrowserWindow, text: string): Promise<boolean> {
  try {
    await window.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById('text');
        if (!el) return false;
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return true;
      })()`,
      true,
    );
    return true;
  } catch {
    return false;
  }
}

async function runInputSuite(window: BrowserWindow, checks: AcceptanceCheck[]): Promise<void> {
  const check = (name: string, pass: boolean, detail?: unknown): void => {
    checks.push({ name, pass, detail });
  };

  const mainWindow = window;
  const bar = shell.getInputBarWindow();

  // 0) 托盘：启动时创建、顶部两行只读诊断、菜单项固定、图标为 16×16 占位
  //    （ADR 0018 D3 / ADR 0028 D4 / ADR 0032 D4）
  let tray = shell.traySnapshot();
  // 诊断项由既有的 16ms 轮询器刷新（读数一变，下一拍就同步）：这里给最多 1s 的稳定窗口，
  // 避免把"启动瞬间的旧读数"当成失败。
  for (let attempt = 0; attempt < 20 && tray.stats.lastReason !== 'disabled'; attempt += 1) {
    await sleep(50);
    tray = shell.traySnapshot();
  }
  check('托盘：启动时已创建（ADR 0018 D3）', tray.exists === true, tray);
  check(
    '托盘：顶部两行只读诊断（今天主动交互 / 上次未主动原因，ADR 0032 D4）',
    tray.statLabels.length === 2 &&
      /^今天主动交互: \d+ 次$/u.test(tray.statLabels[0] ?? '') &&
      /^上次未主动原因: /u.test(tray.statLabels[1] ?? ''),
    tray.statLabels,
  );
  check(
    '托盘：自检里主动性硬关 → 诊断项显示 disabled（ADR 0031 D6 / ADR 0032 D4）',
    tray.stats.lastReason === 'disabled' && tray.stats.firedCount === 0,
    tray.stats,
  );
  check(
    '托盘：菜单项为 两行诊断 + 呼出输入条 / 控制面板 / 吸附 / 离开 / 重新加载桌宠 / 退出（ADR 0028 D4、ADR 0052 D1）',
    JSON.stringify(tray.menuLabels) ===
      JSON.stringify([
        '今天主动交互: 0 次',
        '上次未主动原因: disabled（主动性已关闭）',
        '呼出输入条',
        '控制面板…',
        '吸附到前台窗口（Ctrl+Shift+S）',
        '离开窗口边缘',
        '重新加载桌宠',
        '退出',
      ]),
    tray.menuLabels,
  );
  check(
    '托盘：16×16 占位图标已解码',
    tray.iconSize?.width === 16 && tray.iconSize?.height === 16,
    tray.iconSize,
  );

  // 1) 启动态：窗口存在但不可见；主窗口 focusable 恒 false
  const initial = shell.inputBarDiagnostics();
  check(
    '输入条：启动时已创建且隐藏（show:false 复用，ADR 0003 §2）',
    initial.exists === true && initial.visible === false,
    initial,
  );
  check(
    '输入条：尺寸 260×44（契约 §3.2 输入条行）',
    initial.bounds?.width === 260 && initial.bounds?.height === 44,
    initial.bounds ?? null,
  );
  check('主窗口：focusable 恒为 false（ADR 0003）', mainWindow.isFocusable() === false, {
    focusable: mainWindow.isFocusable(),
  });
  check('主窗口：启动时未被输入条抢焦点', mainWindow.isFocused() === false, {
    focused: mainWindow.isFocused(),
  });

  // 2) 热键：默认或降级必须有一个生效
  const hotkey = shell.hotkeySnapshot();
  const accelerator = hotkey?.accelerator ?? null;
  const expected = [INPUT_HOTKEY_DEFAULT, INPUT_HOTKEY_FALLBACK];
  check(
    '热键：已注册默认 Ctrl+Shift+B 或降级 Ctrl+Alt+B',
    accelerator !== null && expected.includes(accelerator),
    hotkey,
  );
  check(
    '热键：globalShortcut.isRegistered 与注册结果一致',
    accelerator !== null && globalShortcut.isRegistered(accelerator),
    { accelerator, registered: accelerator ? globalShortcut.isRegistered(accelerator) : false },
  );
  check(
    '热键：降级路径与日志一致（ADR 0016 D4）',
    hotkey?.fallbackUsed === true
      ? (await countInLog('降级到备用热键')) >= 1
      : (await countInLog('降级到备用热键')) === 0,
    { fallbackUsed: hotkey?.fallbackUsed ?? null },
  );

  // 3) 打开：可见、持有焦点、输入框是活动元素、主窗口不参与
  const opened = shell.openInputBar();
  const visible = await waitForInputBar((facts) => facts.visible, 3000);
  check('输入条：可打开（等价热键入口）', opened === true && visible.visible === true, visible);
  check('输入条：打开后持有键盘焦点', visible.focused === true, visible);
  check(
    '主窗口：输入条打开时仍不可聚焦、未抢焦点',
    mainWindow.isFocusable() === false && mainWindow.isFocused() === false,
    { focusable: mainWindow.isFocusable(), focused: mainWindow.isFocused() },
  );
  const pageState = bar ? await readInputPageState(bar) : null;
  check('输入条：输入框是活动元素（可直接打字）', pageState?.activeId === 'text', pageState);

  // 4) 定位：上方 8px / 贴顶改下方 8px；水平居中；不出工作区
  const content = mainWindow.getContentBounds();
  const workArea = screen.getDisplayMatching(content).workArea;
  const inputBounds = visible.bounds;
  const above = inputBounds
    ? Math.abs(inputBounds.y + inputBounds.height + 8 - content.y) <= 1
    : false;
  const below = inputBounds ? Math.abs(inputBounds.y - (content.y + 8)) <= 1 : false;
  check(
    '定位：主窗口顶边上方 8px（上方不足时改下方 8px，ADR 0004 D8.2）',
    Boolean(inputBounds) && (above || below),
    { inputBounds, content, placement: above ? 'above' : below ? 'below' : 'unknown' },
  );
  check(
    '定位：相对主窗口水平居中（±1px）',
    Boolean(inputBounds) &&
      Math.abs(inputBounds!.x + inputBounds!.width / 2 - (content.x + content.width / 2)) <= 1,
    { inputBounds, content },
  );
  check(
    '定位：完整落在显示器工作区内',
    Boolean(inputBounds) &&
      inputBounds!.x >= workArea.x &&
      inputBounds!.y >= workArea.y &&
      inputBounds!.x + inputBounds!.width <= workArea.x + workArea.width &&
      inputBounds!.y + inputBounds!.height <= workArea.y + workArea.height,
    { inputBounds, workArea },
  );

  // 5) 与字幕气泡不重叠（字幕固定在主窗口下沿，输入条在顶边之外/顶边内 8–52px）
  const subtitleBox = await readSubtitleBox(mainWindow);
  check(
    '布局：输入条与字幕气泡矩形不相交',
    inputBounds !== null && subtitleBox !== null && !rectsOverlap(inputBounds!, subtitleBox!),
    { inputBounds, subtitleBox },
  );

  // 6) 截图：输入条打开
  if (bar) {
    const shot = await captureToImage(bar, 'input-bar.png');
    logInfo('selftest', 'capture', {
      mode: 'input-bar',
      pngPath: shot.pngPath,
      size: shot.image.getSize(),
    });
    check('截图：dist/selftest/input-bar.png 已落盘', shot.image.getSize().width > 0, shot.pngPath);
  } else {
    check('截图：输入条窗口句柄可用', false);
  }

  // 7) 提交：Enter → 收起 → user_utterance → 字幕
  const submitted = bar ? await submitFromInputPage(bar, '你好') : false;
  const hidden = await waitForInputBar((facts) => facts.visible === false, 3000);
  check('提交：Enter → 输入条收起', submitted === true && hidden.visible === false, hidden);

  const utterance = await waitForLogJson(
    'user_utterance 发出（§6.3）',
    (json) => json.source === 'input-bar' && json.chars === 2 && json.input === 'hotkey',
    4000,
  );
  check(
    '提交：cmd:respond → user_utterance{input:"hotkey"}（§6.3）',
    typeof utterance?.utteranceId === 'string' && utterance?.input === 'hotkey',
    utterance,
  );

  const subtitle = await waitForSubtitle(mainWindow, 'おはようございます', 6000);
  check(
    '提交：字幕气泡显示桌宠的回答（规则路径）',
    subtitle.visible === true && (subtitle.text ?? '').includes('おはようございます'),
    subtitle,
  );
  check(
    '提交后：主窗口仍不可聚焦、未抢焦点',
    mainWindow.isFocusable() === false && mainWindow.isFocused() === false,
    { focusable: mainWindow.isFocusable(), focused: mainWindow.isFocused() },
  );

  // 字幕带文本时的真实矩形也必须与输入条不相交（空文本时元素只有 padding，尺寸偏小）
  const subtitleBoxAfter = await readSubtitleBox(mainWindow);
  check(
    '布局：回复显示时字幕仍不与输入条矩形相交',
    subtitleBoxAfter !== null && inputBounds !== null && !rectsOverlap(inputBounds!, subtitleBoxAfter!),
    { inputBounds, subtitleBoxAfter },
  );

  const mainShot = await captureToImage(mainWindow, 'input-submitted.png');
  logInfo('selftest', 'capture', {
    mode: 'input-submitted',
    pngPath: mainShot.pngPath,
    size: mainShot.image.getSize(),
  });

  // 8) Esc：关闭且不发事件
  const escBaseline = await countInLog('user_utterance 发出（§6.3）');
  shell.openInputBar();
  await waitForInputBar((facts) => facts.visible, 2000);
  if (bar) {
    bar.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    bar.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }
  const escHidden = await waitForInputBar((facts) => facts.visible === false, 3000);
  const escCount = await countInLog('user_utterance 发出（§6.3）');
  check('Esc：关闭输入条', escHidden.visible === false, escHidden);
  check('Esc：不发任何事件（user_utterance 计数不变）', escCount === escBaseline, {
    escBaseline,
    escCount,
  });

  // 9) 失焦（点击桌面）：关闭
  shell.openInputBar();
  await waitForInputBar((facts) => facts.visible, 2000);
  if (bar) {
    try {
      bar.blur();
    } catch {
      // 某些桌面会话里窗口尚未取得前台焦点，blur 会抛；下面用页面级 window.blur 兜底
    }
  }
  let blurred = await waitForInputBar((facts) => facts.visible === false, 800);
  if (blurred.visible && bar) {
    try {
      await bar.webContents.executeJavaScript('window.blur()', true);
    } catch {
      // 忽略：窗口已不可用
    }
    blurred = await waitForInputBar((facts) => facts.visible === false, 2000);
  }
  check('失焦：点击输入条外 → 输入条收起（ADR 0003 §3）', blurred.visible === false, blurred);

  const failed = checks.filter((item) => !item.pass);
  logInfo('selftest', '输入条验收', {
    total: checks.length,
    failed: failed.length,
    checks,
  });
  await shell.stop();
  app.exit(failed.length === 0 ? 0 : 1);
}

async function runSpeechSuite(window: BrowserWindow, checks: AcceptanceCheck[]): Promise<void> {
  const check = (name: string, pass: boolean, detail?: unknown): void => {
    checks.push({ name, pass, detail });
  };

  let stubs: Awaited<ReturnType<typeof startSelftestStubs>>;
  try {
    stubs = await startSelftestStubs();
    logInfo('selftest', '语音自检桩已启动', {
      llmModel: SELFTEST_LLM_MODEL,
      ttsPort: SELFTEST_TTS_PORT,
    });
  } catch (error) {
    logInfo('selftest', '语音自检桩启动失败', { error: String(error) });
    await shell.stop();
    app.exit(1);
    return;
  }

  try {
    const diagnostics = await waitFor(
      window,
      MODEL_LOAD_TIMEOUT_MS,
      (d) => d !== null && (d.ready || (!d.loading && d.error !== null)),
    );
    check(
      '语音：模型已就绪（口型需要真实 EyeMouth 材质）',
      diagnostics?.ready === true,
      diagnostics?.error ?? null,
    );

    const snapshot = getRuntime()?.snapshot() ?? null;
    check(
      '装配：TTS 指向本地桩且已配置（参考音频 + 提示文本齐备）',
      snapshot?.tts.enabled === true && snapshot?.tts.baseUrl === `http://127.0.0.1:${SELFTEST_TTS_PORT}`,
      snapshot?.tts ?? null,
    );
    check(
      '装配：LLM 指向本地桩',
      snapshot?.llm.model === SELFTEST_LLM_MODEL,
      snapshot?.llm ?? null,
    );
    check(
      '装配：台词池与兜底集合已加载（§9.1 ③）',
      (snapshot?.data.ruleCount ?? 0) >= 5 && (snapshot?.data.fallbackCount ?? 0) >= 3,
      snapshot?.data ?? null,
    );

    // Idle 帧（闭嘴）作为像素差基线
    const idle = await captureToImage(window, 'window-idle.png');
    logInfo('selftest', 'capture', { mode: 'idle', pngPath: idle.pngPath });

    // ADR 0045 D4.1：不开口时必须停在图集的**闭嘴帧**（7 号小弧线），
    // 不能停在微张帧、也不能因为 `frameCount=1` 被夹成 0 号极细横线。
    const idleFacial = await readDiagnostics(window);
    check(
      '口型：neutral 且不发声 → 闭嘴帧（speech.frame=0、driven=false，ADR 0046 D3.2）',
      idleFacial?.speech.frame === 0 && idleFacial?.speech.driven === false,
      { speech: idleFacial?.speech ?? null, mouth: idleFacial?.facial?.channel?.mouth ?? null },
    );

    // ADR 0045 D4 取证：把嘴型钉在 7 / 6 / 14 / 2 / 9 各截一帧，用"与闭嘴帧的像素差"
    // 证明（a）闭嘴帧本身是一张小嘴、（b）四档帧确实画出不同的形状。
    const mouthFrameShots: Array<{ frame: number; png: string; changed: number; box: string }> = [];
    for (const frame of [7, 6, 14, 2, 9]) {
      await window.webContents.executeJavaScript(`window.petRender.setMouthFrame(${frame})`, true);
      await sleep(90);
      const shot = await captureToImage(window, `mouth-frame-${frame}.png`);
      const region = mouthRegion(idleFacial, window.getContentBounds());
      const scale = idle.image.getSize().width / Math.max(1, window.getContentBounds().width);
      const diff = diffRegion(
        idle.image,
        shot.image,
        {
          x: region.x * scale,
          y: region.y * scale,
          width: region.width * scale,
          height: region.height * scale,
        },
      );
      mouthFrameShots.push({
        frame,
        png: shot.pngPath,
        changed: diff.changed,
        box: `${diff.rect.x},${diff.rect.y} ${diff.rect.width}x${diff.rect.height}`,
      });
    }
    await window.webContents.executeJavaScript('window.petRender.resetMouthFrame()', true);
    await sleep(120);
    const mouthFramesDistinct = new Set(mouthFrameShots.map((shot) => shot.changed)).size;
    check(
      '口型：四档嘴型各自画出不同形状（7/6/14/2/9 五帧互不相同，ADR 0045 D4.2）',
      mouthFrameShots.length === 5 &&
        mouthFramesDistinct >= 3 &&
        mouthFrameShots.filter((shot) => shot.changed > 0).length >= 4,
      { shots: mouthFrameShots },
    );

    // 口型多帧化取证：在页面内以 25ms 采样 voice 播放器的当前嘴型帧（单次 ~微秒，
    // 不像 `getDiagnostics()` 那样要 300ms），覆盖"开口前 → 说话中 → 结束"。
    await window.webContents.executeJavaScript(
      `(() => {
        const trace = [];
        window.__mouthTrace = trace;
        const started = performance.now();
        const timer = setInterval(() => {
          const d = window.petVoice.getDiagnostics();
          trace.push({
            t: Math.round(performance.now() - started),
            frame: d.frame,
            level: Number(d.level.toFixed(3)),
            speaking: d.speaking === true,
          });
          if (performance.now() - started > 12000) clearInterval(timer);
        }, 25);
        return true;
      })()`,
      true,
    );

    // ------------------------------------------------------------------
    // 1) 规则路径 → TTS 桩 → 播放 → 口型 → 自然结束
    // ------------------------------------------------------------------
    const startedBaseline = await countInLog('speech_started');
    await submitUtterance(window, '你好');
    const startedCount = await waitForLog('speech_started', startedBaseline + 1, 8000);
    check('语音：speech_started 由 voice 发出', startedCount >= startedBaseline + 1, {
      startedBaseline,
      startedCount,
    });
    check(
      '语音：走规则路径（route=rule，规则先于 LLM）',
      (await waitForLogJson('intent_resolved 已发', (json) => json.route === 'rule', 3000))?.route === 'rule',
    );

    const voiceDiag = await waitForVoice(window, (d) => d?.speaking === true && (d?.frame ?? 0) > 0, 4000);
    check('口型：播放中包络帧 > 0（voice 播放器）', (voiceDiag?.frame ?? 0) > 0, voiceDiag);
    check(
      '播放：AudioContext 处于 running（ADR 0015 D5 的 autoplay 开关生效）',
      voiceDiag?.contextState === 'running',
      voiceDiag,
    );

    const during = await readDiagnostics(window);
    check(
      '口型：render 侧 setMouthFrame 已生效，且 overlay=speaking',
      (during?.speech?.frame ?? 0) > 0 && during?.hfsm.overlay === 'speaking',
      { speech: during?.speech ?? null, hfsm: during?.hfsm ?? null },
    );

    const subtitleDuring = await readSubtitle(window);
    check(
      '字幕：intent_resolved 的文本已显示',
      subtitleDuring.visible === true && (subtitleDuring.text ?? '').includes('おはようございます'),
      subtitleDuring,
    );

    const speakingShot = await captureToImage(window, 'window-speech.png');
    logInfo('selftest', 'capture', { mode: 'speaking', pngPath: speakingShot.pngPath });
    const content = window.getContentBounds();
    const baseRegion = mouthRegion(during, content);
    // capturePage 返回的是物理像素（本机 DPR=2），而 diagnostics 的点位是 CSS px
    const scale = idle.image.getSize().width / Math.max(1, content.width);
    const region = {
      x: baseRegion.x * scale,
      y: baseRegion.y * scale,
      width: baseRegion.width * scale,
      height: baseRegion.height * scale,
    };
    const diff = diffRegion(idle.image, speakingShot.image, region);
    check(
      '截图：说话时面部区域像素变化（嘴部贴图发生切换）',
      diff.changed >= 30,
      { region: diff.rect, changed: diff.changed, total: diff.total, scale },
    );

    await waitForLog('speech_ended completed', 1, 8000);
    check('语音：自然结束发 speech_ended{completed}', (await countInLog('speech_ended completed')) >= 1);

    // ADR 0045 D4.2：说话期间嘴型必须在 3–4 档官方帧之间切换（不再只有一张嘴）。
    const mouthTrace = JSON.parse(
      (await window.webContents.executeJavaScript(
        'JSON.stringify(window.__mouthTrace ?? [])',
        true,
      )) as string,
    ) as Array<{ t: number; frame: number; level: number; speaking: boolean }>;
    const spokenFrames = new Set(mouthTrace.filter((s) => s.speaking).map((s) => s.frame));
    const allFrames = new Set(mouthTrace.map((s) => s.frame));
    check(
      '口型：说话时多帧切换（≥2 种嘴型，且闭嘴帧也在轨迹里，ADR 0045 D4.2）',
      spokenFrames.size >= 2 && allFrames.has(0) && mouthTrace.length >= 10,
      {
        spokenFrames: [...spokenFrames],
        allFrames: [...allFrames],
        samples: mouthTrace.length,
        curve: mouthTrace
          .filter((s) => s.speaking)
          .slice(0, 24)
          .map((s) => `${s.frame}@${s.level.toFixed(2)}`),
      },
    );
    await window.webContents.executeJavaScript('window.__mouthTrace = null; true', true);

    // ------------------------------------------------------------------
    // 2) LLM 路径（合法 JSON）
    // ------------------------------------------------------------------
    await submitUtterance(window, '今天有什么安排吗');
    const llmEntry = await waitForLogJson('intent_resolved 已发', (json) => json.route === 'llm', 8000);
    check('§9.1 ②：LLM 桩返回合法 JSON → route=llm', llmEntry?.route === 'llm', llmEntry);
    const promptAssembly = await waitForLogJson(
      'LLM 请求已装配',
      (json) => json.hasCard === true && Number(json.systemChars ?? 0) > 300,
      5000,
    );
    check(
      '§9.3：提示词已带角色卡（system 段 >300 字）',
      promptAssembly?.hasCard === true && Number(promptAssembly?.systemChars ?? 0) > 300,
      promptAssembly,
    );

    // ------------------------------------------------------------------
    // 2.5) memory（ADR 0020）：写入 → 检索 → 段 3 注入
    // ------------------------------------------------------------------
    const memoryBefore = getRuntime()?.snapshot().memory ?? null;
    check(
      '装配：记忆库已就绪（file + WAL + FTS5，ADR 0020 D1/D3）',
      memoryBefore?.enabled === true && memoryBefore?.mode === 'file' && memoryBefore?.fts === true,
      memoryBefore,
    );

    const completedBeforeMemory = await countInLog('speech_ended completed');
    const resolvedBeforeMemory = await countInLog('intent_resolved 已发');
    await submitUtterance(window, 'コーヒーが好きです');
    const memoryResolved = await waitForLog('intent_resolved 已发', resolvedBeforeMemory + 1, 8000);
    check('记忆：第一句走 LLM 路径并落库的前置成立', memoryResolved >= resolvedBeforeMemory + 1, {
      resolvedBeforeMemory,
      memoryResolved,
    });
    await waitForLog('speech_ended completed', completedBeforeMemory + 1, 12000);
    await sleep(200); // setImmediate 之后才写库（ADR 0020 D5）

    const memoryAfterWrite = getRuntime()?.snapshot().memory ?? null;
    check(
      '记忆：一轮对话后写入 user + pet 两条（ADR 0020 D5）',
      (memoryAfterWrite?.rows ?? 0) >= (memoryBefore?.rows ?? 0) + 2,
      { before: memoryBefore?.rows ?? null, after: memoryAfterWrite?.rows ?? null },
    );

    const assemblyBaseline = await countInLog('LLM 请求已装配');
    await submitUtterance(window, 'コーヒー');
    const memoryAssembly = await waitForLogJson(
      'LLM 请求已装配',
      (json) => Number(json.memoryFacts ?? 0) > 0,
      8000,
    );
    check(
      '记忆：检索命中并注入提示词段 3（memoryFacts > 0，ADR 0020 D8）',
      (await countInLog('LLM 请求已装配')) > assemblyBaseline &&
        Number(memoryAssembly?.memoryFacts ?? 0) > 0,
      memoryAssembly,
    );
    const retrieveTrace = getRuntime()?.snapshot().memory.lastRetrieve ?? null;
    check(
      `记忆：检索在主线程同步完成且 ≤ 50ms（实测 ${retrieveTrace?.ms ?? '?'}ms）`,
      retrieveTrace !== null && retrieveTrace.count > 0 && retrieveTrace.ms <= 50,
      retrieveTrace,
    );
    await waitForLog('speech_ended completed', completedBeforeMemory + 2, 15000);

    // ------------------------------------------------------------------
    // 2.6) 字幕时序（ADR 0021）：TTS 慢合成时字幕不得早于 speech_started
    // ------------------------------------------------------------------
    const cueStartedBaseline = await countInLog('speech_started');
    await submitUtterance(window, 'SLOWTTS を確認');
    const cueBeforeSpeech = await waitForSubtitleCue(
      window,
      (cue) => typeof cue.pending === 'string' && cue.pending.includes('SLOWTTS'),
      3000,
    );
    const subtitleBeforeSpeech = await readSubtitle(window);
    check(
      'ADR 0021 D1：intent_resolved 之后字幕**尚未**显示（只登记 pending）',
      (cueBeforeSpeech?.pending ?? '').includes('SLOWTTS') && subtitleBeforeSpeech.visible === false,
      { subtitle: subtitleBeforeSpeech, cue: cueBeforeSpeech },
    );

    await waitForLog('speech_started', cueStartedBaseline + 1, 12000);
    const subtitleAfterSpeech = await waitForSubtitle(window, 'SLOWTTS', 4000);
    check(
      'ADR 0021 D2：speech_started 之后字幕出现，且文本与语音一致',
      subtitleAfterSpeech.visible === true && (subtitleAfterSpeech.text ?? '').includes('SLOWTTS'),
      subtitleAfterSpeech,
    );
    await waitForLog('speech_ended completed', completedBeforeMemory + 3, 15000);

    // ------------------------------------------------------------------
    // 3) 非法输出 → invalid_output → 兜底
    // ------------------------------------------------------------------
    await submitUtterance(window, 'INVALID 测试');
    const invalid = await waitForLogJson(
      'LLM 路径失败，走兜底',
      (json) => json.reason === 'invalid_output',
      8000,
    );
    check('§9.2：非法输出 → llm_failed{invalid_output}', invalid?.reason === 'invalid_output', invalid);
    const fallbackEntry = await waitForLogJson('intent_resolved 已发', (json) => json.route === 'fallback', 8000);
    check('§9.1 ③：非法输出后降级到兜底', fallbackEntry?.route === 'fallback', fallbackEntry);

    // ------------------------------------------------------------------
    // 4) 打断：新话语打断在播语音
    // ------------------------------------------------------------------
    const interruptStartedBaseline = await countInLog('speech_started');
    const interruptedBaseline = await countInLog('speech_ended interrupted');
    const completedBaseline = await countInLog('speech_ended completed');

    await submitUtterance(window, '第一句');
    await waitForLog('speech_started', interruptStartedBaseline + 1, 8000);
    await sleep(250);
    await submitUtterance(window, '第二句');
    const interrupted = await waitForLog('speech_ended interrupted', interruptedBaseline + 1, 6000);
    check('§12：新话语打断旧语音 → speech_ended{interrupted}', interrupted >= interruptedBaseline + 1, {
      interruptedBaseline,
      interrupted,
    });
    const restarted = await waitForLog('speech_started', interruptStartedBaseline + 2, 8000);
    check('§12：打断后新语音重新开始播放', restarted >= interruptStartedBaseline + 2);
    await waitForLog('speech_ended completed', completedBaseline + 1, 8000);

    // ------------------------------------------------------------------
    // 5) TTS 失败 → 字幕保留（§11）
    // ------------------------------------------------------------------
    const failedBaseline = await countInLog('speech_ended failed');
    await submitUtterance(window, 'NOAUDIO 测试');
    const failed = await waitForLog('speech_ended failed', failedBaseline + 1, 8000);
    check('§11：TTS 500 → speech_ended{failed}', failed >= failedBaseline + 1, { failedBaseline, failed });
    const subtitleAfterFailure = await readSubtitle(window);
    check(
      '§11：TTS 失败时字幕气泡仍显示文本（无语音降级）',
      subtitleAfterFailure.visible === true && (subtitleAfterFailure.text ?? '').includes('NOAUDIO'),
      subtitleAfterFailure,
    );

    check('桩统计：LLM 至少被调用 4 次', stubs.stats.llmChats >= 4, stubs.stats);
    check('桩统计：TTS 至少被调用 4 次且至少失败 1 次', stubs.stats.ttsCalls >= 4 && stubs.stats.ttsFailures >= 1, stubs.stats);
    check(
      '收尾：没有在途语音（voice 回到 idle）',
      getRuntime()?.snapshot().voice.phase === 'idle',
      getRuntime()?.snapshot().voice ?? null,
    );
  } catch (error) {
    check('语音套件未抛异常', false, String(error));
  } finally {
    await stubs.close();
  }

  const failed = checks.filter((item) => !item.pass);
  logInfo('selftest', '对话与发声闭环验收', {
    total: checks.length,
    failed: failed.length,
    checks,
  });
  await shell.stop();
  app.exit(failed.length === 0 ? 0 : 1);
}

/**
 * ADR 0054：视觉/OCR 全链路验收。
 *
 * 顺序刻意是"先失败、后成功"：
 * 1. OCR 桩还没起 → 查询必须返回 `unavailable`，且编排层的视觉上下文仍是空的；
 * 2. 起桩 + 在屏幕上放一个写着 `VISIONTEST` 的测试窗口 → 走真实
 *    `cmd:vision-query`（渲染页 preload → 主进程 → desktopCapturer → OCR 桩 → 段 3.6）；
 * 3. 提交一句"画面里写了什么" → LLM 桩只有在 system 段里看到 OCR 文字时才回带标记的答案；
 * 4. 截图 + 落 JSON，证明"截到的画面 / 识别出的文字 / 最终回复"三者一致。
 */
async function runVisionSuite(window: BrowserWindow, checks: AcceptanceCheck[]): Promise<void> {
  const check = (name: string, pass: boolean, detail?: unknown): void => {
    checks.push({ name, pass, detail });
  };
  const outputDir = path.join(app.getAppPath(), 'dist', 'selftest');
  const evidenceDir = path.join(app.getAppPath(), 'logs', 'evidence');
  const screenshots: string[] = [];
  let noteWindow: BrowserWindow | null = null;
  let stubs: Awaited<ReturnType<typeof startSelftestStubs>> | null = null;

  try {
    // ------------------------------------------------------------------
    // 1) 失败降级：OCR 端点不存在时，查询返回失败但不抛、不产生上下文
    // ------------------------------------------------------------------
    const beforeAnyStub = await shell.queryVision('screen');
    check(
      '降级：OCR 端点未启动 → 查询返回失败（不抛异常）',
      beforeAnyStub !== null && beforeAnyStub.ok === false,
      beforeAnyStub,
    );
    check(
      '降级：失败原因是 unavailable / timeout',
      beforeAnyStub !== null &&
        (beforeAnyStub.reason === 'unavailable' || beforeAnyStub.reason === 'timeout'),
      beforeAnyStub?.reason ?? null,
    );
    check(
      '降级：截图仍然成功（失败发生在 OCR，而不是截图）',
      beforeAnyStub?.image !== null && (beforeAnyStub?.image?.bytes ?? 0) > 0,
      beforeAnyStub?.image ?? null,
    );
    check(
      '降级：失败不产生视觉上下文',
      getRuntime()?.snapshot().orchestrator.visionAvailable === false,
      getRuntime()?.snapshot().orchestrator ?? null,
    );

    // ------------------------------------------------------------------
    // 2) 屏幕上放一个可被 OCR 读到的测试窗口
    // ------------------------------------------------------------------
    noteWindow = await createVisionTestWindow();
    stubs = await startSelftestStubs();
    logInfo('selftest', '视觉自检桩已启动', {
      ocrPort: 8003,
      llmModel: SELFTEST_LLM_MODEL,
      ttsPort: SELFTEST_TTS_PORT,
    });

    const diagnostics = await waitFor(
      window,
      MODEL_LOAD_TIMEOUT_MS,
      (d) => d !== null && (d.ready || (!d.loading && d.error !== null)),
    );
    check('模型：已就绪（视觉自检不需要 LLM 真模型，但仍要有渲染页）', diagnostics !== null, diagnostics?.error ?? null);

    // ------------------------------------------------------------------
    // 3) 走真实 IPC：渲染页 preload → 主进程 → 截图 → OCR 桩（Windows OCR）
    // ------------------------------------------------------------------
    const ipcResult = (await window.webContents.executeJavaScript(
      `window.petShell.queryVision({ source: 'screen' })`,
      true,
    )) as VisionResult;
    check('IPC：cmd:vision-query 返回 ok=true', ipcResult.ok === true, ipcResult);
    check(
      'OCR：识别文本包含屏幕上的标记 "VISIONTEST"',
      ipcResult.text.includes('VISIONTEST'),
      { chars: ipcResult.chars, textHead: ipcResult.text.slice(0, 400) },
    );
    check(
      '截图：PNG 非空且尺寸合理（>= 1000px 宽）',
      ipcResult.image !== null && ipcResult.image.bytes > 5000 && ipcResult.image.width >= 1000,
      ipcResult.image,
    );
    check(
      '上下文：成功查询后编排层 visionAvailable=true',
      getRuntime()?.snapshot().orchestrator.visionAvailable === true,
      getRuntime()?.snapshot().orchestrator ?? null,
    );
    check(
      '桩统计：OCR 收到图片并真的识别（imageBytes > 0）',
      stubs.stats.ocrCalls >= 1 && stubs.stats.ocrImageBytes > 0,
      { calls: stubs.stats.ocrCalls, bytes: stubs.stats.ocrImageBytes, failures: stubs.stats.ocrFailures },
    );

    // 把 OCR 桩实际收到的那张图留作证据（就是 desktopCapturer 截出来的原图）
    await mkdir(outputDir, { recursive: true });
    const capturedSource = path.join(app.getAppPath(), 'logs', 'selftest', 'vision-request.png');
    const capturedCopy = path.join(outputDir, 'vision-capture.png');
    await copyFile(capturedSource, capturedCopy);
    screenshots.push(capturedCopy);

    // ------------------------------------------------------------------
    // 4) 提交话语：LLM 桩只有看到 system 段里的 OCR 文字才回带标记的答案
    // ------------------------------------------------------------------
    const baseline = await countInLog('intent_resolved 已发');
    await submitUtterance(window, 'この画面に書いてある文字を教えて。');
    const resolved = await waitForLog('intent_resolved 已发', baseline + 1, 15000);
    check('对话：提交后产生 intent_resolved', resolved >= baseline + 1, {
      baseline,
      resolved,
    });

    const subtitle = await waitForSubtitleText(window, 'VISIONTEST', 15000);
    check(
      '段 3.6：回复引用了画面文字（LLM 桩只在 system 段里看到标记时才这样回）',
      subtitle.visible && (subtitle.text ?? '').includes('VISIONTEST'),
      subtitle,
    );
    check('桩统计：LLM 请求的 system 段里确实带上了 OCR 文字', stubs.stats.llmVisionPrompt === true);
    check(
      '一次性：这一轮消费后视觉上下文已清空',
      getRuntime()?.snapshot().orchestrator.visionAvailable === false,
      getRuntime()?.snapshot().orchestrator ?? null,
    );

    // ------------------------------------------------------------------
    // 5) 截图：她带着字幕的样子 + 整屏（左边测试窗口、右边她）
    // ------------------------------------------------------------------
    await sleep(350);
    screenshots.push(await captureScreenshot(window, 'vision-reply.png', 'vision'));
    const desktop = await captureDesktop('vision-desktop.png');
    if (desktop) screenshots.push(desktop.pngPath);

    const hotkey = shell.visionHotkeySnapshot();
    check(
      '热键：视觉热键已注册（Ctrl+Shift+V，或降级 Ctrl+Alt+V）',
      hotkey !== null && typeof hotkey.accelerator === 'string',
      hotkey,
    );
    check(
      '诊断：runtime.vision 记录了查询次数与最近结果',
      (getRuntime()?.snapshot().vision.queries ?? 0) >= 2,
      getRuntime()?.snapshot().vision ?? null,
    );

    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.join(evidenceDir, 'vision-chain.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          checks,
          runtime: getRuntime()?.snapshot() ?? null,
          ocr: {
            ok: ipcResult.ok,
            reason: ipcResult.reason,
            chars: ipcResult.chars,
            durationMs: ipcResult.durationMs,
            image: ipcResult.image,
            text: ipcResult.text,
          },
          stubStats: stubs.stats,
          screenshots,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch (error) {
    check('视觉套件未抛异常', false, String(error));
  } finally {
    if (noteWindow && !noteWindow.isDestroyed()) noteWindow.destroy();
    await stubs?.close().catch(() => undefined);
  }

  const failed = checks.filter((item) => !item.pass);
  logInfo('selftest', '视觉/OCR 全链路验收', {
    total: checks.length,
    failed: failed.length,
    checks,
  });
  await shell.stop();
  app.exit(failed.length === 0 ? 0 : 1);
}

/**
 * ADR 0054：自检专用的"可被 OCR 读到的窗口"。
 *
 * 用纯白底 + 超大字号（84px），保证 Windows OCR 在 1600×1000 的整屏截图里也能稳定读出；
 * 放在左上角避开桌宠，`showInactive()` 不抢焦点（截图走整屏，不依赖前台）。
 */
async function createVisionTestWindow(): Promise<BrowserWindow> {
  const noteWindow = new BrowserWindow({
    width: 1040,
    height: 300,
    x: 40,
    y: 60,
    frame: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#ffffff',    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#fff;color:#000;overflow:hidden}
    .box{padding:30px 40px;font-family:'Segoe UI','Microsoft YaHei',sans-serif}
    .big{font:700 96px/1.05 Consolas,'Segoe UI',monospace;letter-spacing:0}
    .sub{margin-top:14px;font-size:38px;font-weight:400;line-height:1.2}
  </style></head><body><div class="box">
    <div class="big">VISIONTEST</div>
    <div class="sub">桌宠视觉链路：截屏 → OCR → 提示词</div>
  </div></body></html>`;
  await noteWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // 必须比普通 always-on-top 窗口更高：实测 QQ 的悬浮聊天窗会盖住测试窗口，
  // OCR 只读到半个 "VISION"。screen-saver 与桌宠同层，且本窗口创建更晚，稳定在上。
  noteWindow.setAlwaysOnTop(true, 'screen-saver');
  noteWindow.moveTop();
  noteWindow.showInactive();
  // 等一帧合成：desktopCapturer 抓的是合成后的桌面，不是画布内容
  await sleep(800);
  return noteWindow;
}

async function dispatchPointerFor(
  window: BrowserWindow,
  phase: 'down' | 'up',
  x: number,
  y: number,
): Promise<void> {
  const type = phase === 'down' ? 'pointerdown' : 'pointerup';
  await window.webContents.executeJavaScript(
    `(() => {
      const event = new PointerEvent('${type}', {
        bubbles: true, cancelable: true, composed: true,
        clientX: ${String(x)}, clientY: ${String(y)},
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: ${phase === 'down' ? '1' : '0'},
      });
      window.dispatchEvent(event);
    })()`,
    true,
  );
}

/**
 * 抓取部位标定（ADR 0035 D1/D2）：分别从头部/身体/脚部按下去拖，落三张截图，
 * 记录抓取带、支点与摆角，人眼确认"垂/拎/挣扎"三种姿态。
 *
 * 运行：`$env:PET_GRAB_CALIBRATE='1'; $env:PET_SELFTEST='1'; node scripts/start.mjs --selftest`
 */
async function runGrabCalibration(window: BrowserWindow): Promise<void> {
  const ready = await waitFor(
    window,
    MODEL_LOAD_TIMEOUT_MS,
    (diagnostics) => diagnostics !== null && diagnostics.ready === true,
  );
  if (!ready?.ready) {
    console.error('[grab-calibrate] 模型未就绪');
    return;
  }
  await window.webContents.executeJavaScript('window.petRender.setWalkInterval(600000, 600001)', true);
  shell.releaseSnap();
  await sleep(500);

  const content = window.getContentBounds();
  const points = ready.probePoints;
  const footCandidate = (await window.webContents.executeJavaScript(
    `(() => {
      const m = window.petMask;
      const w = window.innerWidth, h = window.innerHeight;
      for (let yy = 0.98; yy >= 0.84; yy -= 0.01) {
        for (let xx = 0.30; xx <= 0.70; xx += 0.02) {
          const x = w * xx, y = h * yy;
          if (m.probe(x, y).hit) return { x, y };
        }
      }
      return null;
    })()`,
    true,
  )) as { x: number; y: number } | null;
  const candidates: Array<{ band: 'head' | 'body' | 'foot'; x: number; y: number }> = [
    { band: 'head', x: points?.head?.x ?? content.width / 2, y: points?.head?.y ?? content.height * 0.28 },
    { band: 'body', x: points?.body?.x ?? content.width / 2, y: points?.body?.y ?? content.height * 0.72 },
    {
      band: 'foot',
      x: footCandidate?.x ?? content.width / 2,
      y: footCandidate?.y ?? content.height * 0.94,
    },
  ];

  for (const item of candidates) {
    const current = window.getContentBounds();
    pushScriptedCursor(current.x + item.x, current.y + item.y);
    await sleep(360);
    const hit = (await window.webContents.executeJavaScript(
      `window.petMask.probe(${item.x}, ${item.y}).hit`,
      true,
    )) as boolean;
    if (!hit) {
      logWarn('selftest', 'grab-calibrate: 候选点未命中，跳过', item);
      continue;
    }
    await dispatchPointerFor(window, 'down', item.x, item.y);
    await sleep(40);
    pushScriptedCursor(current.x + item.x + 60, current.y + item.y - 24);
    await sleep(380);
    const pngPath = await captureScreenshot(window, `grab-${item.band}.png`, `grab-${item.band}`);
    const diag = await readDiagnostics(window);
    logInfo('selftest', 'grab-calibrate: case', {
      expected: item.band,
      point: { x: item.x, y: item.y },
      band: diag?.drag?.band ?? null,
      pivot: diag?.drag?.pivot ?? null,
      angle: diag?.drag?.angle ?? null,
      omega: diag?.drag?.omega ?? null,
      pngPath,
    });
    await dispatchPointerFor(window, 'up', item.x, item.y);
    await waitFor(window, 4000, (diagnostics) => diagnostics?.hfsm.physics === null);
    await sleep(700);
  }
  resetScriptedCursor();
  logInfo('selftest', 'grab-calibrate: done', { output: 'dist/selftest/grab-*.png' });
}

/**
 * 落地冲击分级标定（ADR 0035 D4）：从 10px / 300px 两处回弹，落两张"落地帧"截图，
 * 记录 impact 与 landingSquash，肉眼对比压扁幅度与脊柱前倾。
 *
 * 运行：`$env:PET_LANDING_CALIBRATE='1'; $env:PET_SELFTEST='1'; node scripts/start.mjs --selftest`
 */
async function runLandingCalibration(window: BrowserWindow): Promise<void> {
  const ready = await waitFor(
    window,
    MODEL_LOAD_TIMEOUT_MS,
    (diagnostics) => diagnostics !== null && diagnostics.ready === true,
  );
  if (!ready?.ready) {
    console.error('[landing-calibrate] 模型未就绪');
    return;
  }
  shell.releaseSnap();
  await sleep(400);

  for (const heightPx of [10, 300]) {
    const dropped = shell.debugDropFromHeight(heightPx);
    logInfo('selftest', 'landing-calibrate: drop', { heightPx, dropped });
    // 不能用 waitFor（250ms 轮询会错过 300ms 的下蹲）：16ms 紧凑轮询
    let landed: ModelDiagnostics | null = null;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      landed = await readDiagnostics(window);
      const impact = landed?.drag?.landingImpact;
      if (typeof impact === 'number') break;
      await sleep(16);
    }
    // 吸震峰值在落地后 ~50ms；capturePage 本身约 60ms，直接抓
    await sleep(20);
    const immediate = await window.webContents.capturePage();
    const outputDir = path.join(app.getAppPath(), 'dist', 'selftest');
    await mkdir(outputDir, { recursive: true });
    const pngPath = path.join(outputDir, `landing-${heightPx}px.png`);
    await writeFile(pngPath, await immediate.toPNG());
    const atPeak = await readDiagnostics(window);
    logInfo('selftest', 'landing-calibrate: frame', {
      heightPx,
      impact: landed?.drag?.landingImpact ?? null,
      squash: atPeak?.drag?.landingSquash ?? null,
      pngPath,
    });
    await waitFor(window, 4000, (diagnostics) => diagnostics?.hfsm.physics === null);
    await sleep(600);
  }
  logInfo('selftest', 'landing-calibrate: done', { output: 'dist/selftest/landing-*.png' });
}

/**
 * 骨骼轴向标定（ADR 0035 D5）：只通过渲染页的 `window.diagnostics` 施加偏移，
 * 每个 case 落一张截图 + 记录"探针骨骼的世界坐标变化方向"。
 *
 * 运行：`$env:PET_CALIBRATE='1'; $env:PET_SELFTEST='1'; node scripts/start.mjs --selftest`
 */
async function runBoneCalibration(window: BrowserWindow): Promise<void> {
  const ready = await waitFor(
    window,
    MODEL_LOAD_TIMEOUT_MS,
    (diagnostics) => diagnostics !== null && diagnostics.ready === true,
  );
  if (!ready?.ready) {
    console.error('[calibrate] 模型未就绪，无法标定骨骼');
    return;
  }

  const bones = (await window.webContents.executeJavaScript(
    'window.diagnostics.listBones()',
  )) as string[];
  logInfo('selftest', 'calibrate: bones', { count: bones.length, bones });
  const pick = (target: string): string | null =>
    bones.find((name) => name.toLowerCase() === target) ??
    bones.find((name) => name.toLowerCase().includes(target)) ??
    null;

  const spine = pick('bip001_spine');
  const neck = pick('bip001_neck');
  const armL = pick('bip001_l_upperarm');
  const armR = pick('bip001_r_upperarm');
  const handL = pick('bip001_l_hand');
  const handR = pick('bip001_r_hand');
  const head = pick('bip001_head');

  const world = async (bone: string | null): Promise<unknown> => {
    if (!bone) return null;
    return window.webContents.executeJavaScript(
      `window.diagnostics.boneWorld(${JSON.stringify(bone)})`,
    );
  };

  const thighL = pick('bip001_l_thigh');
  const calfL = pick('bip001_l_calf');
  const footL = pick('bip001_l_foot');

  const cases: Array<{
    name: string;
    bone: string | null;
    probe: string | null;
    yaw: number;
    pitch: number;
    roll: number;
  }> = [
    { name: 'spine-pitch-plus', bone: spine, probe: head, yaw: 0, pitch: 0.25, roll: 0 },
    { name: 'spine-pitch-minus', bone: spine, probe: head, yaw: 0, pitch: -0.25, roll: 0 },
    { name: 'neck-pitch-plus', bone: neck, probe: head, yaw: 0, pitch: 0.25, roll: 0 },
    { name: 'neck-pitch-minus', bone: neck, probe: head, yaw: 0, pitch: -0.25, roll: 0 },
    { name: 'upperarm-l-roll-plus', bone: armL, probe: handL, yaw: 0, pitch: 0, roll: 0.5 },
    { name: 'upperarm-l-roll-minus', bone: armL, probe: handL, yaw: 0, pitch: 0, roll: -0.5 },
    { name: 'upperarm-r-roll-plus', bone: armR, probe: handR, yaw: 0, pitch: 0, roll: 0.5 },
    { name: 'upperarm-r-roll-minus', bone: armR, probe: handR, yaw: 0, pitch: 0, roll: -0.5 },
    { name: 'upperarm-l-pitch-plus', bone: armL, probe: handL, yaw: 0, pitch: 0.5, roll: 0 },
    { name: 'thigh-l-pitch-plus', bone: thighL, probe: footL, yaw: 0, pitch: 0.3, roll: 0 },
    { name: 'thigh-l-pitch-minus', bone: thighL, probe: footL, yaw: 0, pitch: -0.3, roll: 0 },
    { name: 'calf-l-pitch-plus', bone: calfL, probe: footL, yaw: 0, pitch: 0.3, roll: 0 },
    { name: 'calf-l-pitch-minus', bone: calfL, probe: footL, yaw: 0, pitch: -0.3, roll: 0 },
  ];

  for (const item of cases) {
    if (!item.bone) {
      logWarn('selftest', 'calibrate: 骨骼缺失，跳过', { case: item.name, bone: item.bone });
      continue;
    }
    await window.webContents.executeJavaScript('window.diagnostics.clear()');
    await sleep(120);
    const before = await world(item.probe);
    const applied = await window.webContents.executeJavaScript(
      `window.diagnostics.setBone(${JSON.stringify(item.bone)}, ${item.yaw}, ${item.pitch}, ${item.roll})`,
    );
    await sleep(320);
    const after = await world(item.probe);
    const pngPath = await captureScreenshot(window, `calib-${item.name}.png`, 'calibration');
    logInfo('selftest', 'calibrate: case', {
      case: item.name,
      bone: item.bone,
      applied,
      offset: { yaw: item.yaw, pitch: item.pitch, roll: item.roll },
      probe: item.probe,
      before,
      after,
      pngPath,
    });
  }
  await window.webContents.executeJavaScript('window.diagnostics.clear()');
  logInfo('selftest', 'calibrate: done', { output: 'dist/selftest/calib-*.png' });
}

interface RegionColorStats {
  mean: [number, number, number];
  /** 红色像素占比（r>140 且 g/b < 90）：验证"手被染红" */
  redRatio: number;
  /** 近白像素占比（三通道都 > 235）：验证"手看起来像白板" */
  whiteRatio: number;
  pixels: number;
  /** 亮度均值（Rec.601） */
  luma: number;
  /** 亮度标准差：平涂 ≈ 0–5，有明暗 ≈ 10+（ADR 0037 的量化判据） */
  lumaStdDev: number;
  /** 亮度 5% / 95% 分位（看"最暗面 vs 最亮面"的跨度） */
  lumaP05: number;
  lumaP95: number;
  /** 亮度 < 60% 满量程的像素占比（阴影面） */
  darkRatio: number;
}

/** 从一个 NativeImage 的 CSS 矩形区域取像素统计（capturePage 是物理像素，先按 DPR 缩放）。 */
function regionColorStats(
  image: NativeImage,
  rectCss: Rect,
  contentWidth: number,
): RegionColorStats | null {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0 || contentWidth <= 0) return null;
  const scale = size.width / contentWidth;
  const x = Math.max(0, Math.min(size.width - 1, Math.round(rectCss.x * scale)));
  const y = Math.max(0, Math.min(size.height - 1, Math.round(rectCss.y * scale)));
  const width = Math.max(1, Math.min(size.width - x, Math.round(rectCss.width * scale)));
  const height = Math.max(1, Math.min(size.height - y, Math.round(rectCss.height * scale)));
  try {
    const bitmap = image.crop({ x, y, width, height }).toBitmap();
    let r = 0;
    let g = 0;
    let b = 0;
    let red = 0;
    let white = 0;
    let count = 0;
    let sumLuma = 0;
    let sumLumaSq = 0;
    const histogram = new Array<number>(256).fill(0);
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      const alpha = bitmap[i + 3]!;
      if (alpha < 128) continue;
      const blue = bitmap[i]!;
      const green = bitmap[i + 1]!;
      const redValue = bitmap[i + 2]!;
      r += redValue;
      g += green;
      b += blue;
      if (redValue > 140 && green < 90 && blue < 90) red += 1;
      if (redValue > 235 && green > 235 && blue > 235) white += 1;
      const luma = 0.299 * redValue + 0.587 * green + 0.114 * blue;
      sumLuma += luma;
      sumLumaSq += luma * luma;
      histogram[Math.max(0, Math.min(255, Math.round(luma)))]! += 1;
      count += 1;
    }
    if (count === 0) return null;
    const luma = sumLuma / count;
    const variance = Math.max(0, sumLumaSq / count - luma * luma);
    const percentile = (fraction: number): number => {
      const target = count * fraction;
      let seen = 0;
      for (let value = 0; value < 256; value += 1) {
        seen += histogram[value]!;
        if (seen >= target) return value;
      }
      return 255;
    };
    let dark = 0;
    for (let value = 0; value < 153; value += 1) dark += histogram[value]!;
    return {
      mean: [Math.round(r / count), Math.round(g / count), Math.round(b / count)],
      redRatio: red / count,
      whiteRatio: white / count,
      pixels: count,
      luma: Math.round(luma * 10) / 10,
      lumaStdDev: Math.round(Math.sqrt(variance) * 10) / 10,
      lumaP05: percentile(0.05),
      lumaP95: percentile(0.95),
      darkRatio: Math.round((dark / count) * 1000) / 1000,
    };
  } catch {
    return null;
  }
}

/** 诊断截图：只在内存里拿 NativeImage，落盘由调用方决定（A/B 要从多帧里挑一对）。 */
async function captureEvidence(window: BrowserWindow): Promise<NativeImage> {
  return window.webContents.capturePage();
}

/**
 * 把某个 CSS 矩形裁成独立 PNG。
 *
 * 为什么要裁：整窗 422×720 缩到对话里看时，衣服上的二分阴影只剩 2–3 个像素，
 * 根本分不出"有没有明暗"；裁 90–180px 的局部才能真正看清楚。
 */
async function saveCrop(
  image: NativeImage,
  rect: Rect,
  contentWidth: number,
  folder: string,
  fileName: string,
): Promise<string | null> {
  const size = image.getSize();
  if (size.width <= 0 || contentWidth <= 0) return null;
  const scale = size.width / contentWidth;
  const x = Math.max(0, Math.min(size.width - 1, Math.round(rect.x * scale)));
  const y = Math.max(0, Math.min(size.height - 1, Math.round(rect.y * scale)));
  const width = Math.max(1, Math.min(size.width - x, Math.round(rect.width * scale)));
  const height = Math.max(1, Math.min(size.height - y, Math.round(rect.height * scale)));
  try {
    const cropped = image.crop({ x, y, width, height });
    const outputDir = path.join(app.getAppPath(), 'dist', folder);
    await mkdir(outputDir, { recursive: true });
    const pngPath = path.join(outputDir, fileName);
    await writeFile(pngPath, cropped.toPNG());
    return path.relative(app.getAppPath(), pngPath);
  } catch (error) {
    logWarn('selftest', 'Toon 诊断：裁剪失败', { fileName, error: String(error) });
    return null;
  }
}

interface ToonRegionSample {
  key: string;
  rect: Rect;
  stats: RegionColorStats | null;
  crop: string | null;
}

interface ToonCapture {
  image: NativeImage;
  regions: Array<{ key: string; rect: Rect; stats: RegionColorStats | null }>;
}

/**
 * 阶段 15 专用诊断：`PET_TOON_DIAG=1` 时只跑这一套（ADR 0037）。
 *
 * 同一姿态、同一相机，唯一变量是"全局光照 + Toon 材质"开/关：
 *   1. `setToon(false)` → 抓"修改前"（原无光照 MeshBasicMaterial = 平涂）；
 *   2. `setToon(true)`  → 抓"修改后"（3 阶 Toon + 主方向光 + 极低环境光）；
 *   3. 对每个区域算亮度均值 / 标准差 / 5%–95% 分位 / 暗部占比，并裁局部 PNG。
 *
 * 难点是**动画在跑**（眨眼、呼吸、手指微动）：直接隔 300ms 拍两张，可能一张闭眼一张睁眼，
 * 那就不叫 A/B 了。这里改成"反复拍 before/after 对，挑脸部统计最接近的一对"——
 * 眨眼会同时改变脸部亮度均值与标准差，所以脸部差值最小的一对就是眼睛状态一致的一对。
 */
async function runToonDiagnostics(window: BrowserWindow): Promise<void> {
  const diagnostics = await waitFor(
    window,
    MODEL_LOAD_TIMEOUT_MS,
    (d) => d !== null && (d.ready || (!d.loading && d.error !== null)),
  );
  if (!diagnostics?.ready) {
    logWarn('selftest', 'Toon 诊断：模型未就绪', { error: diagnostics?.error ?? null });
    app.exit(1);
    return;
  }
  await sleep(1200);

  const outputDir = path.join(app.getAppPath(), 'dist', 'diagnostics');
  await mkdir(outputDir, { recursive: true });
  const selftestDir = path.join(app.getAppPath(), 'dist', 'selftest');
  await mkdir(selftestDir, { recursive: true });
  const content = window.getContentBounds();
  const width = content.width;
  const height = content.height;

  const materials = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.diagnostics.inspectMaterials())',
      true,
    )) as string,
  ) as Array<Record<string, unknown>>;
  const toonAtBoot = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.petModel.getDiagnostics().toon)',
      true,
    )) as string,
  ) as Record<string, unknown>;

  const bones = (await window.webContents.executeJavaScript(
    'window.diagnostics.listBones()',
    true,
  )) as string[];
  const pick = (target: string): string | null =>
    bones.find((name) => name.toLowerCase() === target) ??
    bones.find((name) => name.toLowerCase().includes(target)) ??
    null;
  const boneCss = async (name: string | null): Promise<{ x: number; y: number } | null> => {
    if (!name) return null;
    const world = (await window.webContents.executeJavaScript(
      `window.diagnostics.boneWorld(${JSON.stringify(name)})`,
      true,
    )) as { x: number; y: number; z: number } | null;
    if (!world) return null;
    return { x: width / 2 + world.x, y: height / 2 - world.y };
  };

  const handL = await boneCss(pick('bip001_l_hand'));
  const handR = await boneCss(pick('bip001_r_hand'));
  const head = await boneCss(pick('bip001_head'));
  const probe = diagnostics.probePoints;

  const boxAround = (point: { x: number; y: number } | null, size: number): Rect | null => {
    if (!point) return null;
    const x = Math.max(0, Math.min(width - 1, Math.round(point.x - size / 2)));
    const y = Math.max(0, Math.min(height - 1, Math.round(point.y - size / 2)));
    return {
      x,
      y,
      width: Math.max(1, Math.min(width - x, size)),
      height: Math.max(1, Math.min(height - y, size)),
    };
  };

  /** 躯干中心（探针的 pelvis 位置）往上 12% 窗高 = 外套胸口，二分阴影最明显的地方 */
  const coatCenter = probe.body
    ? { x: probe.body.x, y: probe.body.y - height * 0.12 }
    : null;

  const regions: Array<{ key: string; rect: Rect }> = [
    { key: 'all', rect: { x: 0, y: 0, width, height } },
  ];
  for (const [key, rect] of [
    ['coat', boxAround(coatCenter, 180)],
    ['torso', boxAround(probe.body, 160)],
    ['face', boxAround(head ?? probe.head, 72)],
    ['handL', boxAround(handL, 90)],
    ['handR', boxAround(handR, 90)],
  ] as Array<[string, Rect | null]>) {
    if (rect) regions.push({ key, rect });
  }

  const capture = async (): Promise<ToonCapture> => {
    const image = await captureEvidence(window);
    return {
      image,
      regions: regions.map((region) => ({
        key: region.key,
        rect: region.rect,
        stats: regionColorStats(image, region.rect, width),
      })),
    };
  };

  const faceOf = (captureValue: ToonCapture): RegionColorStats | null =>
    captureValue.regions.find((region) => region.key === 'face')?.stats ?? null;

  // 多拍几对，挑"眼睛状态一致"的一对（脸部亮度均值 + 标准差最接近）
  let best: { before: ToonCapture; after: ToonCapture; faceDelta: number; attempt: number } | null =
    null;
  const attempts: Array<{ attempt: number; faceDelta: number }> = [];
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await window.webContents.executeJavaScript('window.diagnostics.setToon(false)', true);
    await sleep(140);
    const before = await capture();
    await window.webContents.executeJavaScript('window.diagnostics.setToon(true)', true);
    await sleep(140);
    const after = await capture();

    const beforeFace = faceOf(before);
    const afterFace = faceOf(after);
    const faceDelta =
      beforeFace && afterFace
        ? Math.abs(beforeFace.luma - afterFace.luma) + Math.abs(beforeFace.lumaStdDev - afterFace.lumaStdDev)
        : Number.POSITIVE_INFINITY;
    attempts.push({ attempt, faceDelta: Math.round(faceDelta * 10) / 10 });
    if (!best || faceDelta < best.faceDelta) best = { before, after, faceDelta, attempt };
    // 脸部统计几乎一致 → 眼睛/嘴的状态相同，可以停
    if (faceDelta < 1.5) break;
  }

  // 静态场景兜底：理论上循环至少跑一次
  const chosen = best!;
  const beforePng = path.join(selftestDir, 'toon-00-before.png');
  const afterPng = path.join(selftestDir, 'toon-01-after.png');
  await writeFile(beforePng, await chosen.before.image.toPNG());
  await writeFile(afterPng, await chosen.after.image.toPNG());

  const samplesFor = async (
    captureValue: ToonCapture,
    phase: 'before' | 'after',
  ): Promise<ToonRegionSample[]> => {
    const samples: ToonRegionSample[] = [];
    for (const region of captureValue.regions) {
      samples.push({
        key: region.key,
        rect: region.rect,
        stats: region.stats,
        crop: await saveCrop(
          captureValue.image,
          region.rect,
          width,
          'selftest',
          `toon-${phase}-${region.key}.png`,
        ),
      });
    }
    return samples;
  };

  const beforeSamples = await samplesFor(chosen.before, 'before');
  const afterSamples = await samplesFor(chosen.after, 'after');

  const toonAfter = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.petModel.getDiagnostics().toon)',
      true,
    )) as string,
  ) as Record<string, unknown>;

  const delta = (key: string): Record<string, unknown> | null => {
    const left = beforeSamples.find((sample) => sample.key === key)?.stats ?? null;
    const right = afterSamples.find((sample) => sample.key === key)?.stats ?? null;
    if (!left || !right) return null;
    return {
      lumaBefore: left.luma,
      lumaAfter: right.luma,
      lumaDelta: Math.round((right.luma - left.luma) * 10) / 10,
      stdDevBefore: left.lumaStdDev,
      stdDevAfter: right.lumaStdDev,
      rangeBefore: left.lumaP95 - left.lumaP05,
      rangeAfter: right.lumaP95 - right.lumaP05,
      darkRatioBefore: left.darkRatio,
      darkRatioAfter: right.darkRatio,
      whiteRatioBefore: left.whiteRatio,
      whiteRatioAfter: right.whiteRatio,
      pixels: left.pixels,
    };
  };

  logInfo('selftest', 'Toon 诊断：before', {
    png: path.relative(app.getAppPath(), beforePng),
    regions: beforeSamples.map((sample) => ({
      key: sample.key,
      luma: sample.stats?.luma ?? null,
      stdDev: sample.stats?.lumaStdDev ?? null,
      mean: sample.stats?.mean ?? null,
    })),
  });
  logInfo('selftest', 'Toon 诊断：after', {
    png: path.relative(app.getAppPath(), afterPng),
    regions: afterSamples.map((sample) => ({
      key: sample.key,
      luma: sample.stats?.luma ?? null,
      stdDev: sample.stats?.lumaStdDev ?? null,
      mean: sample.stats?.mean ?? null,
    })),
  });

  const summary = {
    at: new Date().toISOString(),
    content,
    model: {
      modelId: diagnostics.modelId,
      meshNames: diagnostics.meshNames,
      materialNames: diagnostics.materialNames,
      contentMode: '无光照（修改前：平涂 + 无灯）↔ 3 阶 Toon + 主方向光（修改后）',
    },
    pairSelection: {
      maxAttempts: MAX_ATTEMPTS,
      attempts,
      pickedAttempt: chosen.attempt,
      faceDelta: Math.round(chosen.faceDelta * 10) / 10,
    },
    toon: toonAfter,
    toonAtBoot,
    materials,
    bones: { handL, handR, head },
    before: { png: path.relative(app.getAppPath(), beforePng), regions: beforeSamples },
    after: { png: path.relative(app.getAppPath(), afterPng), regions: afterSamples },
    deltas: Object.fromEntries(regions.map((region) => [region.key, delta(region.key)])),
  };
  await writeFile(
    path.join(outputDir, 'toon-comparison.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  logInfo('selftest', 'Toon 诊断：汇总', {
    json: 'dist/diagnostics/toon-comparison.json',
    pair: summary.pairSelection,
    deltas: summary.deltas,
  });
}

/** 诊断：等模型就绪并返回内容区尺寸（描边/光环两套诊断共用）。 */
async function waitForDiagnosticWindow(
  window: BrowserWindow,
  label: string,
): Promise<{ width: number; height: number; diagnostics: ModelDiagnostics } | null> {
  const diagnostics = await waitFor(
    window,
    MODEL_LOAD_TIMEOUT_MS,
    (d) => d !== null && (d.ready || (!d.loading && d.error !== null)),
  );
  if (!diagnostics?.ready) {
    logWarn('selftest', `${label}：模型未就绪`, { error: diagnostics?.error ?? null });
    return null;
  }
  await sleep(1200);
  const content = window.getContentBounds();
  return { width: content.width, height: content.height, diagnostics };
}

/** 诊断：骨骼世界坐标 → 内容区 CSS 坐标（原点左上）。 */
async function boneCssPoint(
  window: BrowserWindow,
  bone: string | null,
  width: number,
  height: number,
): Promise<{ x: number; y: number } | null> {
  if (!bone) return null;
  const world = (await window.webContents.executeJavaScript(
    `window.diagnostics.boneWorld(${JSON.stringify(bone)})`,
    true,
  )) as { x: number; y: number; z: number } | null;
  if (!world) return null;
  return { x: width / 2 + world.x, y: height / 2 - world.y };
}

/** 诊断：按名字挑骨骼（`listBones()` 只返回 humanoid 映射表里的 21 根）。 */
async function pickBoneNames(window: BrowserWindow): Promise<(target: string) => string | null> {
  const bones = (await window.webContents.executeJavaScript(
    'window.diagnostics.listBones()',
    true,
  )) as string[];
  return (target: string) =>
    bones.find((name) => name.toLowerCase() === target) ??
    bones.find((name) => name.toLowerCase().includes(target)) ??
    null;
}

/**
 * 姿态指纹：把整窗缩到 16×16 的灰度缩略图。
 *
 * 用途（ADR 0038）：描边/光环的 A/B 需要"同一姿态"的两帧，而模型一直在呼吸、眨眼。
 * 只比"脸部亮度"会漏掉整体平移，这里直接比缩略图：16×16 每格平均了 ~50×90 个像素，
 * 描边那几条 1px 的线在格内几乎被平均掉，而整体位移 2px 会让每一格都变——
 * 于是"缩略图差最小的一对"就是姿态最接近的一对。
 */
function poseSignature(image: NativeImage): number[] {
  try {
    const small = image.resize({ width: 16, height: 16, quality: 'good' });
    const bitmap = small.toBitmap();
    const values: number[] = [];
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      // Windows 上 toBitmap() 是 BGRA
      values.push(0.299 * bitmap[i + 2]! + 0.587 * bitmap[i + 1]! + 0.114 * bitmap[i]!);
    }
    return values;
  } catch {
    return [];
  }
}

function signatureDelta(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

function boxAroundPoint(
  point: { x: number; y: number } | null,
  size: number,
  width: number,
  height: number,
): Rect | null {
  if (!point) return null;
  const x = Math.max(0, Math.min(width - 1, Math.round(point.x - size / 2)));
  const y = Math.max(0, Math.min(height - 1, Math.round(point.y - size / 2)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, size)),
    height: Math.max(1, Math.min(height - y, size)),
  };
}

/**
 * 阶段 16 专用诊断：`PET_OUTLINE_DIAG=1` 时只跑这一套（ADR 0038）。
 *
 * 同一个姿态、同一相机，唯一变量是"描边壳 visible"：
 *   - `outline-00-off.png` / `outline-01-on.png`（整窗）
 *   - `outline-{off,on}-{head,coat,hand}.png`（局部，能数清线宽）
 *   - 每个区域统计"暗像素占比"：描边会在轮廓处增加一圈暗像素，这是最直接的量化信号。
 *
 * 与 Toon 诊断一样连拍多对、取**脸部统计最接近**的一对，避免眨眼/呼吸造成姿态差。
 */
async function runOutlineDiagnostics(window: BrowserWindow): Promise<void> {
  const ready = await waitForDiagnosticWindow(window, '描边诊断');
  if (!ready) {
    app.exit(1);
    return;
  }
  const { width, height } = ready;
  const outputDir = path.join(app.getAppPath(), 'dist', 'diagnostics');
  const selftestDir = path.join(app.getAppPath(), 'dist', 'selftest');
  await mkdir(outputDir, { recursive: true });
  await mkdir(selftestDir, { recursive: true });

  const outline = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.petModel.getDiagnostics().outline)',
      true,
    )) as string,
  ) as Record<string, unknown>;
  const materials = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.diagnostics.inspectMaterials())',
      true,
    )) as string,
  ) as Array<Record<string, unknown>>;

  const pick = await pickBoneNames(window);
  const head = await boneCssPoint(window, pick('bip001_head'), width, height);
  const handL = await boneCssPoint(window, pick('bip001_l_hand'), width, height);
  const probe = ready.diagnostics.probePoints;
  const coatCenter = probe.body ? { x: probe.body.x, y: probe.body.y - height * 0.12 } : null;

  const regions: Array<{ key: string; rect: Rect }> = [
    { key: 'all', rect: { x: 0, y: 0, width, height } },
  ];
  for (const [key, rect] of [
    ['head', boxAroundPoint(head ?? probe.head, 200, width, height)],
    ['hair', boxAroundPoint(head ? { x: head.x, y: head.y + 40 } : null, 170, width, height)],
    ['coat', boxAroundPoint(coatCenter, 180, width, height)],
    ['face', boxAroundPoint(head ?? probe.head, 72, width, height)],
    ['hand', boxAroundPoint(handL, 90, width, height)],
  ] as Array<[string, Rect | null]>) {
    if (rect) regions.push({ key, rect });
  }

  const capture = async (): Promise<ToonCapture> => {
    const image = await captureEvidence(window);
    return {
      image,
      regions: regions.map((region) => ({
        key: region.key,
        rect: region.rect,
        stats: regionColorStats(image, region.rect, width),
      })),
    };
  };

  let best: { off: ToonCapture; on: ToonCapture; poseDelta: number; attempt: number } | null = null;
  const attempts: Array<{ attempt: number; poseDelta: number }> = [];
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await window.webContents.executeJavaScript('window.diagnostics.setOutline(false)', true);
    await sleep(60);
    const off = await capture();
    await window.webContents.executeJavaScript('window.diagnostics.setOutline(true)', true);
    await sleep(60);
    const on = await capture();

    // 姿态对齐用 16×16 缩略图差（描边那几条 1px 线在缩略图里几乎被平均掉，位移不会）
    const poseDelta = signatureDelta(poseSignature(off.image), poseSignature(on.image));
    attempts.push({ attempt, poseDelta: Math.round(poseDelta * 100) / 100 });
    if (!best || poseDelta < best.poseDelta) best = { off, on, poseDelta, attempt };
    if (poseDelta < 0.6) break;
  }

  const chosen = best!;
  const offPng = path.join(selftestDir, 'outline-00-off.png');
  const onPng = path.join(selftestDir, 'outline-01-on.png');
  await writeFile(offPng, await chosen.off.image.toPNG());
  await writeFile(onPng, await chosen.on.image.toPNG());

  const samplesFor = async (captureValue: ToonCapture, phase: 'off' | 'on'): Promise<ToonRegionSample[]> => {
    const samples: ToonRegionSample[] = [];
    for (const region of captureValue.regions) {
      samples.push({
        key: region.key,
        rect: region.rect,
        stats: region.stats,
        crop: await saveCrop(
          captureValue.image,
          region.rect,
          width,
          'selftest',
          `outline-${phase}-${region.key}.png`,
        ),
      });
    }
    return samples;
  };

  const offSamples = await samplesFor(chosen.off, 'off');
  const onSamples = await samplesFor(chosen.on, 'on');
  const delta = (key: string): Record<string, unknown> | null => {
    const left = offSamples.find((sample) => sample.key === key)?.stats ?? null;
    const right = onSamples.find((sample) => sample.key === key)?.stats ?? null;
    if (!left || !right) return null;
    return {
      lumaOff: left.luma,
      lumaOn: right.luma,
      lumaDelta: Math.round((right.luma - left.luma) * 10) / 10,
      darkRatioOff: left.darkRatio,
      darkRatioOn: right.darkRatio,
      /** 描边增加的暗像素占比（轮廓线就是暗像素） */
      darkDelta: Math.round((right.darkRatio - left.darkRatio) * 10000) / 10000,
      stdDevOff: left.lumaStdDev,
      stdDevOn: right.lumaStdDev,
      pixels: left.pixels,
    };
  };

  const outlineAfter = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.petModel.getDiagnostics().outline)',
      true,
    )) as string,
  ) as Record<string, unknown>;
  // 性能口径：draw call / 三角形数 / 帧时间 EMA，各采一次（开、关描边）
  const readRender = async (): Promise<Record<string, unknown>> =>
    JSON.parse(
      (await window.webContents.executeJavaScript(
        'JSON.stringify(window.petModel.getDiagnostics().render)',
        true,
      )) as string,
    ) as Record<string, unknown>;
  await window.webContents.executeJavaScript('window.diagnostics.setOutline(false)', true);
  await sleep(300);
  const perfOff = await readRender();
  await window.webContents.executeJavaScript('window.diagnostics.setOutline(true)', true);
  await sleep(300);
  const perfOn = await readRender();
  // 运动中的贴附证据：拖拽把整身换成"被拎着"的垂姿（骨骼大范围变形），
  // 连拍两帧看描边有没有跟住；再补一张 happy_hop 的落点。
  const motionShots: string[] = [];
  await window.webContents.executeJavaScript(
    "window.petRender.handleEvent({ name: 'drag_started', payload: { x: 200, y: 300 } })",
    true,
  );
  await sleep(420);
  motionShots.push(
    (await saveCrop(
      await captureEvidence(window),
      { x: 0, y: 0, width, height },
      width,
      'selftest',
      'outline-02-drag-a.png',
    )) ?? '',
  );
  await sleep(160);
  motionShots.push(
    (await saveCrop(
      await captureEvidence(window),
      { x: 0, y: 0, width, height },
      width,
      'selftest',
      'outline-03-drag-b.png',
    )) ?? '',
  );
  await window.webContents.executeJavaScript(
    "window.petRender.handleEvent({ name: 'drag_released', payload: { x: 200, y: 300, vx: 0, vy: 0 } })",
    true,
  );
  await sleep(120);
  await window.webContents.executeJavaScript("window.petRender.handleIntent('happy_hop')", true);
  await sleep(260);
  motionShots.push(
    (await saveCrop(
      await captureEvidence(window),
      { x: 0, y: 0, width, height },
      width,
      'selftest',
      'outline-04-hop.png',
    )) ?? '',
  );

  const summary = {
    at: new Date().toISOString(),
    content: { width, height },
    outline,
    outlineAfter,
    materials,
    pairSelection: {
      maxAttempts: MAX_ATTEMPTS,
      attempts,
      pickedAttempt: chosen.attempt,
      poseDelta: Math.round(chosen.poseDelta * 100) / 100,
    },    perf: { off: perfOff, on: perfOn },
    motionShots,
    off: { png: path.relative(app.getAppPath(), offPng), regions: offSamples },
    on: { png: path.relative(app.getAppPath(), onPng), regions: onSamples },
    deltas: Object.fromEntries(regions.map((region) => [region.key, delta(region.key)])),
  };
  await writeFile(
    path.join(outputDir, 'outline-comparison.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  logInfo('selftest', '描边诊断：汇总', {
    json: 'dist/diagnostics/outline-comparison.json',
    meshes: outlineAfter.meshes ?? null,
    pair: summary.pairSelection,
    deltas: summary.deltas,
  });
}

/**
 * 阶段 16 专用诊断：`PET_HALO_DIAG=1` 时只跑这一套（ADR 0038 任务二）。
 *
 * 把光环临时换成 `MeshToonMaterial`，同姿态拍两张：
 *   `halo-00-basic.png`（全亮 MeshBasicMaterial）/ `halo-01-toon.png`（吃光）。
 * 结论只看一件事：吃光后光环会不会变成"脏脏的铁丝网"。
 */
async function runHaloDiagnostics(window: BrowserWindow): Promise<void> {
  const ready = await waitForDiagnosticWindow(window, '光环诊断');
  if (!ready) {
    app.exit(1);
    return;
  }
  const { width, height } = ready;
  const outputDir = path.join(app.getAppPath(), 'dist', 'diagnostics');
  const selftestDir = path.join(app.getAppPath(), 'dist', 'selftest');
  await mkdir(outputDir, { recursive: true });
  await mkdir(selftestDir, { recursive: true });

  const pick = await pickBoneNames(window);
  const head = await boneCssPoint(window, pick('bip001_head'), width, height);
  const probe = ready.diagnostics.probePoints;
  // 光环浮在头顶上方：以头部为基准往上取一块
  const haloRect =
    boxAroundPoint(head ? { x: head.x, y: head.y - 120 } : null, 260, width, height) ?? {
      x: 0,
      y: 0,
      width,
      height,
    };

  const capture = async (): Promise<{ image: NativeImage; stats: RegionColorStats | null }> => {
    const image = await captureEvidence(window);
    return { image, stats: regionColorStats(image, haloRect, width) };
  };

  let best: {
    basic: { image: NativeImage; stats: RegionColorStats | null };
    toon: { image: NativeImage; stats: RegionColorStats | null };
    delta: number;
    attempt: number;
  } | null = null;
  const attempts: Array<{ attempt: number; poseDelta: number }> = [];
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await window.webContents.executeJavaScript('window.diagnostics.setHaloToon(false)', true);
    await sleep(60);
    const basic = await capture();
    await window.webContents.executeJavaScript('window.diagnostics.setHaloToon(true)', true);
    await sleep(60);
    const toon = await capture();

    const delta = signatureDelta(poseSignature(basic.image), poseSignature(toon.image));
    attempts.push({ attempt, poseDelta: Math.round(delta * 100) / 100 });
    if (!best || delta < best.delta) best = { basic, toon, delta, attempt };
    if (delta < 0.6) break;
  }

  const chosen = best!;
  const basicPng = path.join(selftestDir, 'halo-00-basic.png');
  const toonPng = path.join(selftestDir, 'halo-01-toon.png');
  await writeFile(basicPng, await chosen.basic.image.toPNG());
  await writeFile(toonPng, await chosen.toon.image.toPNG());
  const basicCrop = await saveCrop(chosen.basic.image, haloRect, width, 'selftest', 'halo-00-basic-crop.png');
  const toonCrop = await saveCrop(chosen.toon.image, haloRect, width, 'selftest', 'halo-01-toon-crop.png');

  const halo = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.diagnostics.setHaloToon(true))',
      true,
    )) as string,
  ) as Record<string, unknown>;

  const summary = {
    at: new Date().toISOString(),
    content: { width, height },
    haloMaterialSwap: halo,
    haloRect,
    pairSelection: { maxAttempts: MAX_ATTEMPTS, attempts, pickedAttempt: chosen.attempt },
    basic: {
      png: path.relative(app.getAppPath(), basicPng),
      crop: basicCrop,
      stats: chosen.basic.stats,
    },
    toon: {
      png: path.relative(app.getAppPath(), toonPng),
      crop: toonCrop,
      stats: chosen.toon.stats,
    },
  };
  await writeFile(
    path.join(outputDir, 'halo-comparison.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  logInfo('selftest', '光环诊断：汇总', {
    json: 'dist/diagnostics/halo-comparison.json',
    swap: halo,
    basic: chosen.basic.stats,
    toon: chosen.toon.stats,
  });
}

export async function runSelfTestIfRequested(): Promise<void> {
  if (process.env.PET_SELFTEST !== '1') return;

  const fallbackMode = process.env.PET_SELFTEST_FALLBACK === '1';
  const speechMode = process.env.PET_SELFTEST_SPEECH === '1';
  const inputMode = process.env.PET_SELFTEST_INPUT === '1';
  logBaselineLines = baselineLineCount(await readPetLog(), PROCESS_STARTED_AT);

  await sleep(SETTLE_MS);

  // 输入条也是 BrowserWindow，且 getAllWindows() 的顺序不保证按创建顺序；
  // 因此显式排除输入条，永远拿主窗口做断言（第 6 步引入第二个窗口后必须这样取）。
  const inputBarWindow = shell.getInputBarWindow();
  const window =
    BrowserWindow.getAllWindows().find((candidate) => candidate !== inputBarWindow) ?? null;
  if (!window) {
    console.error('[selftest] 没有创建出主窗口');
    app.exit(1);
    return;
  }

  logInfo('selftest', 'window facts', {
    windowBounds: window.getBounds(),
    contentBounds: window.getContentBounds(),
    isVisible: window.isVisible(),
    isAlwaysOnTop: window.isAlwaysOnTop(),
    isFocusable: window.isFocusable(),
    isResizable: window.isResizable(),
    zoomFactor: window.webContents.getZoomFactor(),
    workArea: screen.getPrimaryDisplay().workArea,
  });

  const checks: AcceptanceCheck[] = [];
  const check = (name: string, pass: boolean, detail?: unknown): void => {
    checks.push({ name, pass, detail });
  };

  // 骨骼轴向标定（ADR 0035 D5）：`PET_CALIBRATE=1` 时只跑这一套，落截图后退出。
  if (process.env.PET_CALIBRATE === '1') {
    await runBoneCalibration(window);
    app.exit(0);
    return;
  }

  // 全局光照 / Toon 对照诊断（ADR 0037）：`PET_TOON_DIAG=1` 时只跑这一套，落 before/after 截图 + JSON 后退出。
  if (process.env.PET_TOON_DIAG === '1') {
    await runToonDiagnostics(window);
    app.exit(0);
    return;
  }

  // 描边对照诊断（ADR 0038）：`PET_OUTLINE_DIAG=1` 时只跑这一套。
  if (process.env.PET_OUTLINE_DIAG === '1') {
    await runOutlineDiagnostics(window);
    app.exit(0);
    return;
  }

  // 光环受光对照诊断（ADR 0038 任务二）：`PET_HALO_DIAG=1` 时只跑这一套。
  if (process.env.PET_HALO_DIAG === '1') {
    await runHaloDiagnostics(window);
    app.exit(0);
    return;
  }

  // 落地冲击分级标定（ADR 0035 D4）：`PET_LANDING_CALIBRATE=1` 时只跑这一套。
  if (process.env.PET_LANDING_CALIBRATE === '1') {
    await runLandingCalibration(window);
    app.exit(0);
    return;
  }

  // 抓取部位标定（ADR 0035 D1/D2）：`PET_GRAB_CALIBRATE=1` 时只跑这一套。
  if (process.env.PET_GRAB_CALIBRATE === '1') {
    await runGrabCalibration(window);
    app.exit(0);
    return;
  }

  if (fallbackMode) {
    await runFallbackSuite(window, checks);
    return;
  }

  if (speechMode) {
    await runSpeechSuite(window, checks);
    return;
  }

  if (inputMode) {
    await runInputSuite(window, checks);
    return;
  }

  if (process.env.PET_SELFTEST_VISION === '1') {
    await runVisionSuite(window, checks);
    return;
  }

  // ------------------------------------------------------------------
  // 1) 模型加载与能力探测
  // ------------------------------------------------------------------
  const diagnostics = await waitFor(
    window,
    MODEL_LOAD_TIMEOUT_MS,
    (d) => d !== null && (d.ready || (!d.loading && d.error !== null)),
  );
  const durationMs = diagnostics?.loadMs ?? null;
  check('模型：modelReady=true', diagnostics?.ready === true, diagnostics?.error ?? null);
  check(
    '模型：加载耗时已记录（0 < loadMs < 15s）',
    typeof durationMs === 'number' && durationMs > 0 && durationMs < MODEL_LOAD_TIMEOUT_MS,
    { loadMs: durationMs },
  );
  check('模型：modelId 来自实际文件', Boolean(diagnostics?.modelId), diagnostics?.modelId);

  /**
   * 自检稳定性（本轮排查）：主场景的**前半段**不需要行走调度，而默认 20–40s 的随机行走
   * 会偶发撞进摸头/拖拽用例——她正好走开时，"冷却结束后可再次触发"直接失败；
   * 走位还会让脚本光标的 `current` 变旧，拖拽检查读到十几像素的偏差。
   * 这里先推到 600s，后面的「行走」用例会显式压回 1.5–2s（`setWalkInterval`）。
   */
  await window.webContents.executeJavaScript(
    'window.petRender.setWalkInterval(600000, 600001)',
    true,
  );

  const contentSize = window.getContentBounds();
  check(
    '窗口尺寸：高度沿用 720、宽度按包围盒校正（240–960）',
    contentSize.height === 720 && contentSize.width >= 240 && contentSize.width <= 960,
    contentSize,
  );
  check(
    '能力探测：无 morph target（ADR 0010 的资产事实）',
    diagnostics?.hasMorphTargets === false,
    { hasMorphTargets: diagnostics?.hasMorphTargets },
  );
  check(
    '能力探测：头部/双眼骨骼齐全',
    Boolean(diagnostics?.bones.head && diagnostics?.bones.eyeL && diagnostics?.bones.eyeR),
    diagnostics?.bones,
  );
  check(
    '能力探测：EyeMouth 材质与嘴型图集就绪（阶段 5 钩子）',
    Boolean(diagnostics?.mouth.materialName) &&
      diagnostics?.mouth.atlasLoaded === true &&
      diagnostics?.mouth.calibrated === true,
    diagnostics?.mouth,
  );
  // ADR 0037：全局光照 + Toon 的回归断言（几何/材质级，不依赖截图里的姿势/背景）
  const toon = diagnostics?.toon ?? null;
  const toonMaterialNames = (toon?.materials ?? []).map((swap) => swap.material).sort();
  check(
    '着色：身体/头发已换成 MeshToonMaterial，其余材质不动（ADR 0037）',
    toon !== null &&
      toon.enabled === true &&
      toonMaterialNames.length === 2 &&
      toonMaterialNames.includes('CH0335_Body') &&
      toonMaterialNames.includes('CH0335_Hair') &&
      toon.materials.every((swap) => swap.to === 'MeshToonMaterial'),
    { materials: toonMaterialNames, swaps: toon?.materials ?? null },
  );
  check(
    '着色：3 阶硬边渐变贴图（暗/中/亮，NearestFilter）',
    toon !== null &&
      toon.gradientSteps.length === 3 &&
      toon.gradientSteps[0]! < toon.gradientSteps[1]! &&
      toon.gradientSteps[1]! < toon.gradientSteps[2]! &&
      toon.gradientSteps[2] === 1,
    toon ? { steps: toon.gradientSteps, width: toon.gradientWidth } : null,
  );
  check(
    '着色：面部（Face/EyeMouth/眉毛）保持无光照（§7.3 面部死守）',
    toon !== null &&
      toon.materials.every((swap) => !/face|eyemouth|eyebrow/i.test(swap.material)),
    toon?.materials ?? null,
  );
  check(
    '着色：主方向光 + 极低环境光（受光 ≈ 贴图原色，不整体压灰）',
    toon !== null &&
      toon.directional > toon.ambient &&
      toon.ambient + toon.directional > Math.PI * 0.98 &&
      toon.ambient + toon.directional < Math.PI * 1.02,
    toon ? { ambient: toon.ambient, directional: toon.directional } : null,
  );

  // ADR 0038：背面法描边的回归断言（结构级：几何/骨骼共享、范围、参数）
  const outline = diagnostics?.outline ?? null;
  const outlineSources = outline?.sources ?? [];
  const outlineMeshes = outline?.meshes ?? [];
  check(
    '描边：身体/头发/脸三块已加描边（ADR 0038）',
    outline !== null &&
      outline.enabled === true &&
      outlineMeshes.length === 3 &&
      outlineSources.length === 3,
    outline ? { width: outline.width, sources: outlineSources } : null,
  );
  check(
    '描边：眼睛嘴/眉毛/光环/配件不描边（只输出给 Body/Hair/Face）',
    outline !== null &&
      outlineMeshes.every((mesh) => /(?:^|_)(body|hair|face)$/i.test(mesh.source.replace(/_\d+$/, ''))) &&
      !outlineSources.some((source) => /eyemouth|eyebrow|halo|weapon|prop|brush/i.test(source)),
    outlineSources,
  );
  check(
    '描边：共享几何与骨骼（描边壳随动画同步，不复制顶点）',
    outline !== null &&
      outlineMeshes.every((mesh) => mesh.sharedGeometry === true && mesh.skinned === true),
    outlineMeshes,
  );
  check(
    '描边：宽度是屏幕像素、颜色为深褐（不用纯黑）',
    outline !== null &&
      outline.width > 0 &&
      outline.width <= 4 &&
      outline.hairWidth > 0 &&
      outline.hairWidth < outline.width &&
      outline.color.toLowerCase() === '#2a1b1a' &&
      outline.depthBias >= 0,
    outline
      ? { width: outline.width, hairWidth: outline.hairWidth, color: outline.color, depthBias: outline.depthBias }
      : null,
  );
  check(
    '描边：世界矩阵与源网格逐元素一致（不穿模、不滞后，ADR 0038）',
    outline !== null && outline.tracked === true && outline.matrixDelta === 0,
    outline ? { tracked: outline.tracked, matrixDelta: outline.matrixDelta } : null,
  );

  // ------------------------------------------------------------------
  // 1.5) ADR 0014：自带动画枚举 / 片段选择 / 配件隐藏 / 地面校正
  // ------------------------------------------------------------------
  check(
    '动画：模型自带 44 段已枚举',
    diagnostics?.animation?.clipCount === 44,
    { clipCount: diagnostics?.animation?.clipCount ?? null },
  );
  check(
    '动画：Idle 精确命中 CH0335_Cafe_Idle（正面待机；Normal_Idle 为侧身战斗待机）',
    diagnostics?.animation?.idle?.name === 'CH0335_Cafe_Idle' &&
      diagnostics?.animation?.idle?.reason === 'exact' &&
      (diagnostics?.animation?.clips ?? []).includes('CH0335_Normal_Idle'),
    diagnostics?.animation?.idle ?? null,
  );
  check(
    '动画：悬空片段精确命中 CH0335_Formation_Pickup（被拎着的垂姿；Carrier_Idle 是站姿）',
    diagnostics?.animation?.held?.name === 'CH0335_Formation_Pickup' &&
      diagnostics?.animation?.held?.reason === 'exact',
    diagnostics?.animation?.held ?? null,
  );
  check(
    '动画：行走片段已识别（CH0335_Cafe_Walk，正面行走，本轮只识别不启用）',
    diagnostics?.animation?.walk?.name === 'CH0335_Cafe_Walk',
    diagnostics?.animation?.walk ?? null,
  );
  // ADR 0041 D3/D4：本轮接进来的新角色必须逐个落到片段上（缺失会走降级，不会报错）
  {
    const roleLog = (await readPetLog()).split('\n').filter((line) => line.includes('语义角色：')).pop() ?? '';
    const expectedRoles = [
      ['idle.alt2', 'CH0335_Carrier_Idle'],
      ['idle.alt3', 'CH0335_Victory_End_Random'],
      ['idle.alt4', 'CH0335_Carrier2_Idle'],
      ['idle.alt5', 'CH0335_Victory_End'],
      ['idle.alt6', 'CH0335_Formation_Idle_Random'],
      ['nod', 'CH0335_Cafe_Reaction'],
      ['greet', 'CH0335_Cafe_Reaction'],
      ['happy', 'CH0335_Victory_Start'],
    ] as const;
    const missing = expectedRoles.filter(([role, clip]) => !roleLog.includes(`${role}=${clip}`));
    check(
      '动画：语义角色全部命中官方片段（正面待机池 ×7 / nod / greet / happy；ADR 0050）',
      roleLog.length > 0 && missing.length === 0,
      { missing, roleLog: roleLog.slice(-600) },
    );
    check(
      '动画：一次性空闲小动作 fidget.shy 已删除（Cafe_Reaction 不再由空闲触发）',
      !roleLog.includes('fidget.shy'),
      { roleLog: roleLog.slice(-600) },
    );
    check(
      '动画：抓头的旧角色 held.limp 已删除（拖拽统一走 held，ADR 0041 D1）',
      !roleLog.includes('held.limp'),
      { roleLog: roleLog.slice(-600) },
    );
  }
  const hidden = diagnostics?.hiddenMeshes ?? [];
  check(
    '配件：Weapon/Prop/brush 三件已隐藏（visible=false）',
    hidden.length >= 3 &&
      hidden.some((name) => /weapon/i.test(name)) &&
      hidden.some((name) => /prop/i.test(name)) &&
      hidden.some((name) => /brush/i.test(name)),
    hidden,
  );
  check(
    '地面校正：Idle 姿态最低点已对齐内容区底边',
    typeof diagnostics?.animation?.groundCorrectionPx === 'number',
    { groundCorrectionPx: diagnostics?.animation?.groundCorrectionPx ?? null },
  );

  // 主进程包围盒日志 vs three 侧包围盒：两条独立实现互相校验
  // 包围盒/窗口尺寸两行发生在 selftest 开始之前，不能按本次运行日志切片，取最后一条（本次运行）
  const fullLog = await readPetLog();
  const bboxLog = lastJsonAfter(fullLog, '[shell] 模型包围盒');
  const frameLog = bboxLog?.['frame'] as { minX: number; maxX: number; minY: number; maxY: number } | undefined;
  const frame = diagnostics?.frame ?? null;
  const frameMatches =
    Boolean(frameLog && frame) &&
    Math.abs((frameLog?.minX ?? 0) - (frame?.minX ?? 0)) < 1e-4 &&
    Math.abs((frameLog?.maxX ?? 0) - (frame?.maxX ?? 0)) < 1e-4 &&
    Math.abs((frameLog?.minY ?? 0) - (frame?.minY ?? 0)) < 1e-4 &&
    Math.abs((frameLog?.maxY ?? 0) - (frame?.maxY ?? 0)) < 1e-4;
  check('日志：包围盒（主进程解析 = three 加载）一致', frameMatches, { frameLog, frame });
  check('日志：窗口尺寸校正行已输出', fullLog.includes('窗口尺寸已按包围盒校正'));
  check('事件：model_ready 已发出并被主进程收到', (await countInLog('收到 model_ready')) >= 1);

  // ------------------------------------------------------------------
  // 2) 视线跟随 / Idle 动画 / 视线微动
  // ------------------------------------------------------------------
  /**
   * ADR 0040 验收：头部区口径。
   *
   * 首选 = 以头骨为圆心、`0.125 × 内容区高度` 为半径（本资产 422×720 → 90px）；
   * 降级 = 掩膜 bbox 顶部 22%（光环会把这条带顶到发顶之上，所以只作兜底）。
   * 下面的竖扫同时打出"掩膜口径"与"头骨口径"，两者的差异就是本轮修的东西。
   */
  const headBand = (await window.webContents.executeJavaScript(
    `(() => {
      const band = window.petModel.headBandDiagnostics();
      const x = Math.round(window.innerWidth / 2);
      const probes = [];
      for (let ratio = 0.10; ratio <= 0.50001; ratio += 0.04) {
        const y = Math.round(window.innerHeight * ratio);
        // 为什么沿这一行再扫一遍 x，而不是只取中线：光环（HaloRoot）在角色的右上方，
        // 中线在 y≈130–200 这一段常常是空气。旧写法只探中线，"光环上有没有命中点"
        // 就取决于当帧头发/光环摆到哪儿 —— 实测会随机假失败（2026-11-03 复现两次）。
        let s = window.petMask.probe(x, y);
        if (!s.hit) {
          for (let px = Math.round(window.innerWidth * 0.1); px <= window.innerWidth * 0.9; px += 8) {
            const candidate = window.petMask.probe(px, y);
            if (candidate.hit) {
              s = candidate;
              break;
            }
          }
        }
        const h = window.petRender.headSampleAt(s.x, s.y, s.head, s.hit);
        probes.push({ ratio: Number(ratio.toFixed(2)), y, hit: s.hit, headMask: s.head, headNow: h.head, src: h.source });
      }
      return JSON.stringify({ band, probes, viewport: [window.innerWidth, window.innerHeight] });
    })()`,
    true,
  )) as string;
  const headBandInfo = JSON.parse(headBand) as {
    band: {
      source: string;
      headBoneCss: { x: number; y: number } | null;
      headRadiusPx: number | null;
      bandBottomCssY: number | null;
      contentHeight: number;
    };
    probes: Array<{ ratio: number; y: number; hit: boolean; headMask: boolean | null; headNow: boolean | null; src: string }>;
  };
  logInfo('selftest', '头部区几何', headBandInfo);

  check(
    '头部区：首选口径是头骨半径（src=bone，R=0.125×高度，ADR 0040）',
    headBandInfo.band.source === 'bone' &&
      headBandInfo.band.headBoneCss !== null &&
      Math.abs((headBandInfo.band.headRadiusPx ?? 0) - 0.125 * headBandInfo.band.contentHeight) < 0.5,
    headBandInfo.band,
  );
  // 光环区（y≈120–205）里有掩膜像素（hit=true）但不在头骨半径内 → 不得算头部
  const haloProbe = headBandInfo.probes.find((item) => item.y >= 130 && item.y <= 200 && item.hit);
  check(
    '头部区：光环上的点 hit=true 但 head=false（ADR 0040 验收 2）',
    haloProbe !== undefined && haloProbe.headMask === true && haloProbe.headNow === false,
    haloProbe ?? headBandInfo.probes,
  );
  // 脸/头骨附近必须是 head=true（旧口径这里是 false，就是"点她没反应"的根因）
  const faceProbe = headBandInfo.band.headBoneCss
    ? headBandInfo.probes.find((item) => Math.abs(item.y - headBandInfo.band.headBoneCss!.y) <= 24)
    : undefined;
  check(
    '头部区：头骨附近 head=true（旧口径为 false，ADR 0040 验收 1 的判据层）',
    faceProbe !== undefined && faceProbe.headNow === true,
    faceProbe ?? headBandInfo.band,
  );

  const points = await resolveMaskPoints(window);
  check('掩膜：找到头部区命中点', points.head !== null, {
    bbox: points.bbox,
    preferred: points.preferred,
  });
  check('掩膜：找到体型命中点', points.body !== null, {
    bbox: points.bbox,
    preferred: points.preferred,
  });

  const headY = points.head?.y ?? contentSize.height * 0.3;
  pushScriptedCursor(contentSize.x + contentSize.width * 0.12, contentSize.y + headY);
  await sleep(400);
  const gazeLeft = (await readDiagnostics(window))?.gaze ?? null;
  pushScriptedCursor(contentSize.x + contentSize.width * 0.88, contentSize.y + headY);
  await sleep(400);
  const gazeRight = (await readDiagnostics(window))?.gaze ?? null;
  check(
    '视线跟随：左右光标产生相反的水平注视（探针数据）',
    Boolean(gazeLeft && gazeRight) &&
      (gazeLeft?.idle === false) &&
      (gazeRight?.idle === false) &&
      (gazeLeft?.yaw ?? 0) * (gazeRight?.yaw ?? 0) < 0 &&
      Math.abs(gazeLeft?.yaw ?? 0) > 0.03 &&
      Math.abs(gazeRight?.yaw ?? 0) > 0.03,
    { left: gazeLeft, right: gazeRight },
  );

  // ------------------------------------------------------------------
  // 2.1) ADR 0049 D2：视线三级阻尼的时间差（眼球 → 头部 → 躯干）
  //
  // 判据是"到 90% 终值"的时刻：眼 12 / 头 8 / 躯干 4 的刚度差应该给出
  // 几十毫秒到几百毫秒的阶梯。先把光标放到头部正前方回正，再瞬间跳到右侧，
  // 用 rAF 采 900ms（`window.diagnostics.gaze()` 是微秒级，不走面部贴图摘要）。
  // ------------------------------------------------------------------
  pushScriptedCursor(contentSize.x + contentSize.width * 0.5, contentSize.y + headY);
  await sleep(900);
  pushScriptedCursor(contentSize.x + contentSize.width * 0.88, contentSize.y + headY);
  await sleep(40);
  const gazeSeries = JSON.parse(
    (await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const rows = [];
        const startedAt = performance.now();
        const tick = () => {
          const g = window.diagnostics.gaze();
          if (g) {
            rows.push({
              t: performance.now() - startedAt,
              eye: g.eyeYaw,
              head: g.yaw,
              spine: g.spineYaw,
              spineBone: g.spineBone?.spineYawRad ?? 0,
              spineBoneDeg: g.spineBone?.spineYawDeg ?? 0,
              spineAxisY: g.spineBone?.axisY ?? 0,
              spineSubmitted: g.spineBone?.submittedYawRad ?? 0,
              phase: g.phase,
            });
          }
          if (performance.now() - startedAt < 900) requestAnimationFrame(tick);
          else resolve(JSON.stringify(rows));
        };
        requestAnimationFrame(tick);
      })`,
      true,
    )) as string,
  ) as Array<{
    t: number;
    eye: number;
    head: number;
    spine: number;
    spineBone: number;
    spineBoneDeg: number;
    spineAxisY: number;
    spineSubmitted: number;
    phase: string;
  }>;
  const gazeFinal = gazeSeries[gazeSeries.length - 1] ?? null;
  const gazeT90 = (key: 'eye' | 'head' | 'spine'): number => {
    if (!gazeFinal) return Number.NaN;
    const target = Math.abs(gazeFinal[key]);
    const hit = gazeSeries.find((row) => Math.abs(row[key]) >= target * 0.9);
    return hit ? hit.t : Number.NaN;
  };
  const eyeT90 = gazeT90('eye');
  const headT90 = gazeT90('head');
  const spineT90 = gazeT90('spine');
  check(
    '视线三级阻尼：眼球先到（t90 早于头部 ≥60ms，ADR 0049 D2）',
    Number.isFinite(eyeT90) && Number.isFinite(headT90) && eyeT90 <= headT90 - 60,
    { eyeT90, headT90, spineT90, samples: gazeSeries.length, final: gazeFinal },
  );
  check(
    '视线三级阻尼：头部先于躯干（t90 早 ≥100ms），且躯干跟随达到肉眼可见（≥0.04rad / 2.3°）',
    Number.isFinite(headT90) &&
      Number.isFinite(spineT90) &&
      headT90 <= spineT90 - 100 &&
      Math.abs(gazeFinal?.spine ?? 0) > 0.04 &&
      Math.abs(gazeFinal?.spine ?? 0) < 0.12,
    { eyeT90, headT90, spineT90, final: gazeFinal },
  );
  // 真机问题一：Spine1 骨骼**实际**转了多少（不是控制器提交量）。
  // `spineBone` 由 render 侧从 `final · animationBase⁻¹` 反解并投影到世界 Y。
  const spineBoneFinal = gazeFinal
    ? { rad: gazeFinal.spineBone, deg: gazeFinal.spineBoneDeg, axisY: gazeFinal.spineAxisY }
    : null;
  check(
    '视线跟随：Spine1 骨骼实际 rotation.y 跟随（|rad| ≥ 0.05 / 2.9°，且与提交量一致）',
    Boolean(gazeFinal) &&
      Math.abs(spineBoneFinal?.rad ?? 0) >= 0.05 &&
      Math.abs((spineBoneFinal?.rad ?? 0) - (gazeFinal?.spineSubmitted ?? 0)) < 0.012 &&
      Math.abs(spineBoneFinal?.axisY ?? 0) > 0.9,
    {
      spineBone: spineBoneFinal,
      submitted: gazeFinal?.spineSubmitted ?? null,
      controllerSpine: gazeFinal?.spine ?? null,
      headYaw: gazeFinal?.head ?? null,
    },
  );
  await sleep(160);
  const spineGazeShot = await captureScreenshot(window, 'window-gaze-spine.png', 'gaze-spine-right');
  logInfo('selftest', 'gaze-spine 截图', { png: spineGazeShot });

  const idleName = diagnostics?.animation?.idle?.name ?? 'CH0335_Cafe_Idle';
  const animA = (await readDiagnostics(window))?.animation?.current ?? null;
  await sleep(450);
  const animB = (await readDiagnostics(window))?.animation?.current ?? null;
  check(
    '动画：Base 层 idle 由模型动画驱动（Idle 在播且时间前进）',
    animA?.name === idleName &&
      animB?.name === idleName &&
      (animA?.running ?? false) &&
      (animB?.running ?? false) &&
      (animA?.weight ?? 0) > 0.9 &&
      (animB?.weight ?? 0) > 0.9 &&
      animA?.time !== animB?.time,
    { animA, animB, idleName },
  );

  resetScriptedCursor();
  await sleep(1700);
  const idleA = (await readDiagnostics(window))?.gaze ?? null;
  await sleep(5300);
  const idleB = (await readDiagnostics(window))?.gaze ?? null;
  check('视线微动：无光标时进入 idle（替代眨眼）', idleA?.idle === true, idleA);
  check(
    '视线微动：每 5s 更新随机注视目标',
    Boolean(idleA && idleB) &&
      (idleA?.targetYaw !== idleB?.targetYaw || idleA?.targetPitch !== idleB?.targetPitch),
    { idleA, idleB },
  );

  // ------------------------------------------------------------------
  // 2.2) ADR 0049 D1：idle 微动作池（15–30s 抽签；自检压缩到 650ms）
  //
  // 两条断言：① 2.6s 内抽签 ≥2 次且换过 ≥2 个条目（不是固定循环）；
  // ② 每次抽签是**交叉淡入淡出**（100ms 采样的权重跳变 < 0.5，不是瞬切）。
  // 之后强制两次条目，验证"歪头"真的落到头骨 roll，并且换回待机能平滑回正。
  // ------------------------------------------------------------------
  await window.webContents.executeJavaScript(
    `window.diagnostics.setMicroPoolInterval('idle', 650, 650)`,
    true,
  );
  const idlePoolSeries = JSON.parse(
    (await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const rows = [];
        const startedAt = performance.now();
        const tick = () => {
          const pool = window.diagnostics.microPool().idle;
          if (pool) rows.push({ t: performance.now() - startedAt, ...pool });
          if (performance.now() - startedAt < 2600) setTimeout(tick, 100);
          else resolve(JSON.stringify(rows));
        };
        tick();
      })`,
      true,
    )) as string,
  ) as Array<{ t: number; active: string; weights: Record<string, number>; switches: number }>;
  const idlePoolLast = idlePoolSeries[idlePoolSeries.length - 1] ?? null;
  const idlePoolKinds = new Set(idlePoolSeries.map((row) => row.active));
  let idlePoolMaxStep = 0;
  for (let i = 1; i < idlePoolSeries.length; i += 1) {
    for (const kind of ['browse', 'headTilt']) {
      idlePoolMaxStep = Math.max(
        idlePoolMaxStep,
        Math.abs(
          (idlePoolSeries[i]!.weights[kind] ?? 0) - (idlePoolSeries[i - 1]!.weights[kind] ?? 0),
        ),
      );
    }
  }
  check(
    'idle 微动作池：随机抽签在 2.6s 内换过 ≥2 个条目（不是固定循环，ADR 0049 D1）',
    (idlePoolLast?.switches ?? 0) >= 2 && idlePoolKinds.size >= 2,
    { switches: idlePoolLast?.switches ?? null, kinds: [...idlePoolKinds] },
  );
  check(
    'idle 微动作池：条目之间平滑交叉（100ms 采样权重跳变 < 0.5，不是瞬切）',
    idlePoolMaxStep > 0 && idlePoolMaxStep < 0.5,
    { maxStep: Number(idlePoolMaxStep.toFixed(3)), samples: idlePoolSeries.length },
  );

  await window.webContents.executeJavaScript(
    `window.diagnostics.forceMicroPool('idle', 'headTilt')`,
    true,
  );
  await sleep(900);
  const tiltDiag = await readDiagnostics(window);
  const tiltRoll = tiltDiag?.sit?.headBase?.roll ?? 0;
  const tiltShot = await captureScreenshot(window, 'idle-micro-tilt.png', 'idle-micro-tilt');
  check(
    'idle 微动作池：歪头落到头骨 roll 通道（≥0.08rad，只动头/颈，ADR 0049 D1）',
    Math.abs(tiltRoll) >= 0.08,
    { roll: tiltRoll, headBase: tiltDiag?.sit?.headBase ?? null, png: tiltShot },
  );
  // 真机问题二：解除歪头 → 权重必须平滑衰减到 0、头部回到直立；不能一直歪着。
  // 先把抽签间隔恢复成生产值（避免 650ms 抽签在这 1.2s 里又抽到 headTilt），再解除强制。
  await window.webContents.executeJavaScript(
    `window.diagnostics.setMicroPoolInterval('idle', 15000, 30000); window.diagnostics.forceMicroPool('idle', null)`,
    true,
  );
  await sleep(1200);
  const untiltDiag = await readDiagnostics(window);
  const untiltRoll = untiltDiag?.sit?.headBase?.roll ?? 0;
  const untiltPool = untiltDiag?.microPool?.idle ?? null;
  const untiltShot = await captureScreenshot(window, 'idle-micro-untilt.png', 'idle-micro-untilt');
  check(
    'idle 微动作池：歪头退出后平滑回正（|roll| < 0.02），并记一次 release（ADR 0049 D1）',
    Math.abs(untiltRoll) < 0.02 && (untiltPool?.releases ?? 0) >= 1,
    {
      roll: untiltRoll,
      releases: untiltPool?.releases ?? null,
      pool: untiltPool,
      tiltPng: tiltShot,
      untiltPng: untiltShot,
    },
  );

  // ------------------------------------------------------------------
  // 2.3) ADR 0050：待机**静态站姿轮换**（20–45s / 0.8s 交叉淡入）
  //
  // 验收四件事：
  // ① 生产常量真的是 20–45s / 0.8s，候选池 7 个正面静态循环片段、不含 Cafe_Reaction；
  // ② 压缩时序后 3.2s 内换过 ≥2 个站姿（不是固定循环）；
  // ③ 换姿势是**交叉淡入**（250ms 时两个片段权重都在 0–1 之间，不是瞬切）；
  // ④ 7 个站姿逐一截图（`idle-pose-00..06.png`），人工复核姿态无穿模/扭曲。
  // ------------------------------------------------------------------
  const prodVariation = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.diagnostics.idleVariation())',
      true,
    )) as string,
  ) as IdleVariationDiagnostics;
  check(
    '待机站姿轮换：生产间隔 20–45s、交叉淡入 0.8s（常量来自 shared/constants.ts，ADR 0050）',
    prodVariation.minIntervalMs === 20_000 &&
      prodVariation.maxIntervalMs === 45_000 &&
      Math.abs(prodVariation.fadeSeconds - 0.8) < 1e-9,
    prodVariation,
  );
  check(
    '待机站姿轮换：候选池 7 个正面静态循环片段，且不含 Cafe_Reaction / Normal_Idle',
    prodVariation.candidates.length === 7 &&
      prodVariation.candidates.every(
        (candidate) =>
          !candidate.clip.includes('Cafe_Reaction') && candidate.clip !== 'CH0335_Normal_Idle',
      ),
    prodVariation.candidates,
  );

  await window.webContents.executeJavaScript(
    `window.diagnostics.forceIdleVariation(null); window.diagnostics.setIdleVariationInterval(700, 700)`,
    true,
  );
  const idleVarSeries = JSON.parse(
    (await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const rows = [];
        const startedAt = performance.now();
        const tick = () => {
          const snap = window.diagnostics.idleVariation();
          rows.push({ t: performance.now() - startedAt, role: snap.role, clip: snap.clip, switches: snap.switches });
          if (performance.now() - startedAt < 3200) setTimeout(tick, 100);
          else resolve(JSON.stringify(rows));
        };
        tick();
      })`,
      true,
    )) as string,
  ) as Array<{ t: number; role: string; clip: string | null; switches: number }>;
  const idleVarLast = idleVarSeries[idleVarSeries.length - 1] ?? null;
  const idleVarRoles = new Set(idleVarSeries.map((row) => row.role));
  check(
    '待机站姿轮换：压缩到 700ms 后 3.2s 内换过 ≥2 个站姿（不是固定循环，ADR 0050）',
    (idleVarLast?.switches ?? 0) >= 2 && idleVarRoles.size >= 2,
    { switches: idleVarLast?.switches ?? null, roles: [...idleVarRoles] },
  );
  check(
    '待机站姿轮换：轮换期间没有播放 Cafe_Reaction（突兀演出已删除）',
    idleVarSeries.every((row) => row.clip === null || !row.clip.includes('Cafe_Reaction')),
    idleVarSeries.filter((row) => row.clip?.includes('Cafe_Reaction') ?? false),
  );

  // 交叉淡入取证：先把站姿强制回 idle 并等它稳定，再切 alt1，150ms 后读两个片段的权重。
  // `getDiagnostics()` 本身约 300ms，所以 150ms + 300ms ≈ 450ms，仍在 0.8s 淡入的中段。
  await window.webContents.executeJavaScript(
    `window.diagnostics.setIdleVariationInterval(600000, 600001); window.diagnostics.forceIdleVariation('idle')`,
    true,
  );
  await sleep(1200);
  await window.webContents.executeJavaScript(`window.diagnostics.forceIdleVariation('idle.alt1')`, true);
  await sleep(150);
  const midVarFade = await readDiagnostics(window);
  const midVarActions = midVarFade?.animation?.actions ?? [];
  const cafeWeight = midVarActions.find((action) => action.name === 'CH0335_Cafe_Idle')?.weight ?? 0;
  const formationWeight =
    midVarActions.find((action) => action.name === 'CH0335_Formation_Idle')?.weight ?? 0;
  check(
    '待机站姿轮换：换姿势是 0.8s 交叉淡入（中段两个片段权重都在 0–1 之间，不是瞬切）',
    cafeWeight > 0.02 &&
      cafeWeight < 0.98 &&
      formationWeight > 0.02 &&
      formationWeight < 0.98,
    { cafeWeight, formationWeight },
  );

  // 逐一取证 7 个站姿（截图供人眼复核：手臂是否穿模、姿态是否扭曲）
  await window.webContents.executeJavaScript(
    `window.diagnostics.setMicroPoolInterval('idle', 600000, 600001); window.diagnostics.forceMicroPool('idle', null)`,
    true,
  );
  const idlePoseRoles = [
    'idle',
    'idle.alt1',
    'idle.alt2',
    'idle.alt3',
    'idle.alt4',
    'idle.alt5',
    'idle.alt6',
  ] as const;
  const idlePoseShots: string[] = [];
  for (let index = 0; index < idlePoseRoles.length; index += 1) {
    await window.webContents.executeJavaScript(
      `window.diagnostics.forceIdleVariation('${idlePoseRoles[index]}')`,
      true,
    );
    await sleep(950);
    idlePoseShots.push(
      await captureScreenshot(window, `idle-pose-${String(index).padStart(2, '0')}.png`, `idle-pose-${index}`),
    );
  }
  check(
    '待机站姿轮换：7 个正面站姿逐一产出截图（idle-pose-00..06.png）',
    idlePoseShots.length === 7 && idlePoseShots.every((shot) => shot.length > 0),
    { shots: idlePoseShots },
  );

  // 交叉淡入的**视觉**取证：从"双手垂下"（alt5/Victory_End）切到"抱臂"（alt1/Formation_Idle），
  // 这是轮廓差最大的一对。0 / 250 / 550 / 1100ms 各拍一张，人工确认 0.8s 内手臂没有穿过身体。
  const crossfadeShots: string[] = [];
  await window.webContents.executeJavaScript(`window.diagnostics.forceIdleVariation('idle.alt5')`, true);
  await sleep(950);
  crossfadeShots.push(await captureScreenshot(window, 'idle-crossfade-00.png', 'idle-crossfade-0'));
  await window.webContents.executeJavaScript(`window.diagnostics.forceIdleVariation('idle.alt1')`, true);
  await sleep(250);
  crossfadeShots.push(await captureScreenshot(window, 'idle-crossfade-01.png', 'idle-crossfade-1'));
  await sleep(300);
  crossfadeShots.push(await captureScreenshot(window, 'idle-crossfade-02.png', 'idle-crossfade-2'));
  await sleep(550);
  crossfadeShots.push(await captureScreenshot(window, 'idle-crossfade-03.png', 'idle-crossfade-3'));
  check(
    '待机站姿轮换：0.8s 交叉淡入的中间帧已产出（idle-crossfade-00..03.png）',
    crossfadeShots.length === 4 && crossfadeShots.every((shot) => shot.length > 0),
    { shots: crossfadeShots },
  );

  await window.webContents.executeJavaScript(
    `window.diagnostics.setIdleVariationInterval(20000, 45000); window.diagnostics.forceIdleVariation(null); window.diagnostics.setMicroPoolInterval('idle', 15000, 30000)`,
    true,
  );

  // ------------------------------------------------------------------
  // 2.9) ADR 0047：**站姿脸部特写 + 眼骨 A/B**
  //
  // 这一组截图回答一个只能靠像素回答的问题：瞳孔朝下到底是**画在贴图上的**
  // 还是**眼骨转出来的**。
  // - face-idle.png        站姿原样（真机上她 90% 的时间是这个姿态）
  // - face-idle-eye-down   眼骨额外 +0.35rad（标定：正 = 低头）
  // - face-idle-eye-up     眼骨额外 -0.35rad（抬头）
  //
  // 判据：上下两张图里**瞳孔在眼眶内的位置**若明显移动 → 眼球是骨骼驱动的，
  // 姿态能修；若纹丝不动 → 视线是贴图画的，只能改贴图/UV。
  // ------------------------------------------------------------------
  const idleFaceBox = (await window.webContents.executeJavaScript(
    'window.diagnostics.faceZoom(260)',
    true,
  )) as { x: number; y: number; size: number } | null;
  await sleep(260);
  const idleFaceShot = await captureScreenshot(window, 'face-idle.png', 'face-idle');
  await window.webContents.executeJavaScript(
    `window.diagnostics.setBone('Bip001_eye_L', 0, 0.35, 0); window.diagnostics.setBone('Bip001_eye_R', 0, 0.35, 0); true`,
    true,
  );
  await sleep(260);
  const idleEyeDownShot = await captureScreenshot(window, 'face-idle-eye-down.png', 'face-idle-eye-down');
  await window.webContents.executeJavaScript(
    `window.diagnostics.clear(); window.diagnostics.setBone('Bip001_eye_L', 0, -0.35, 0); window.diagnostics.setBone('Bip001_eye_R', 0, -0.35, 0); true`,
    true,
  );
  await sleep(260);
  const idleEyeUpShot = await captureScreenshot(window, 'face-idle-eye-up.png', 'face-idle-eye-up');
  await window.webContents.executeJavaScript('window.diagnostics.clear()', true);
  await window.webContents.executeJavaScript('window.diagnostics.faceZoom(0)', true);
  check(
    '脸部特写：站姿 + 眼骨 A/B 已产出（face-idle*.png，ADR 0047）',
    idleFaceShot.length > 0 &&
      idleEyeDownShot.length > 0 &&
      idleEyeUpShot.length > 0 &&
      (idleFaceBox?.size ?? 0) === 260,
    { idleFaceBox, idleFaceShot, idleEyeDownShot, idleEyeUpShot },
  );

  // ------------------------------------------------------------------
  // 3) 掩膜 / 穿透 / 拖拽 / 摸头（沿用上一轮的链路，点位改为动态）
  // ------------------------------------------------------------------
  const body = points.body ?? { x: contentSize.width / 2, y: contentSize.height * 0.7 };
  const head = points.head ?? { x: contentSize.width / 2, y: contentSize.height * 0.3 };
  const transparent = { x: 6, y: 6 };

  let current = window.getContentBounds();

  // 3.1 掩膜三态与降级计数：cold = 暂停 + 标记丢失；stale = 暂停后等过 100ms
  const degraded = (await window.webContents.executeJavaScript(
    `(async () => {
      const m = window.petMask;
      const before = m.snapshot();
      m.setPaused(true);
      m.markContextLost();
      const cold = m.probe(${String(transparent.x)}, ${String(transparent.y)});
      const afterCold = m.snapshot();
      m.setPaused(false);
      await new Promise((r) => setTimeout(r, 90));
      const recovered = m.probe(${String(transparent.x)}, ${String(transparent.y)});
      const afterRecover = m.snapshot();
      m.setPaused(true);
      await new Promise((r) => setTimeout(r, 170));
      const stale = m.probe(${String(transparent.x)}, ${String(transparent.y)});
      const afterStale = m.snapshot();
      m.setPaused(false);
      return JSON.stringify({ before, cold, afterCold, recovered, afterRecover, stale, afterStale });
    })()`,
    true,
  )) as string;
  const degradedResult = JSON.parse(degraded) as Record<string, { counters?: { cold: number; stale: number } }>;
  check(
    '掩膜：cold / stale 仍走 R-9 矩形退路并各自计数',
    (degradedResult['afterCold']?.counters?.cold ?? 0) >= 1 &&
      (degradedResult['afterStale']?.counters?.stale ?? 0) >= 1,
  );

  // 3.2 穿透状态机：窗口外 → 命中区 → 透明区
  pushScriptedCursor(current.x - 60, current.y + 100);
  await sleep(220);
  pushScriptedCursor(current.x + body.x, current.y + body.y);
  await sleep(280);
  pushScriptedCursor(current.x + transparent.x, current.y + transparent.y);
  await sleep(280);
  check(
    '穿透状态机：命中区关闭穿透、透明区恢复穿透',
    (await countInLog('"target":"interactive"')) >= 1 &&
      (await countInLog('"target":"passthrough"')) >= 1,
  );

  // 3.3 摸头 + 800ms 冷却
  current = window.getContentBounds();
  pushScriptedCursor(current.x + head.x, current.y + head.y);
  await sleep(320);
  const patBaseline = await countInLog('head_patted 发出');
  const dispatchPointer = async (phase: 'down' | 'up', x: number, y: number): Promise<void> => {
    const type = phase === 'down' ? 'pointerdown' : 'pointerup';
    await window.webContents.executeJavaScript(
      `(() => {
        const event = new PointerEvent('${type}', {
          bubbles: true, cancelable: true, composed: true,
          clientX: ${String(x)}, clientY: ${String(y)},
          pointerId: 1, pointerType: 'mouse', isPrimary: true,
          button: 0, buttons: ${phase === 'down' ? '1' : '0'},
        });
        window.dispatchEvent(event);
      })()`,
      true,
    );
  };

  await dispatchPointer('down', head.x, head.y);
  await sleep(60);
  await dispatchPointer('up', head.x + 2, head.y + 1);
  await sleep(150);
  const patAfterFirst = await countInLog('head_patted 发出');
  check('摸头：头部区短按（≤250ms、≤4px）发出 head_patted', patAfterFirst === patBaseline + 1, {
    patBaseline,
    patAfterFirst,
  });

  await dispatchPointer('down', head.x, head.y);
  await sleep(40);
  await dispatchPointer('up', head.x, head.y);
  await sleep(150);
  check(
    '摸头：800ms 冷却内重复点击不重复发事件',
    (await countInLog('head_patted 发出')) === patAfterFirst,
  );
  check('摸头：冷却拦下留有日志（D-4）', (await countInLog('head_patted 被冷却拦下')) >= 1);

  // ADR 0039 D1：摸头现在播官方整身片段（2.1s，缩身→保持→抬头回正），
  // 片段播放期间头部已经离开固定探针点，所以等它播完、姿态回到 Idle 再点第二次。
  await sleep(2400);
  await dispatchPointer('down', head.x, head.y);
  await sleep(50);
  await dispatchPointer('up', head.x, head.y);
  await sleep(150);
  check(
    '摸头：冷却结束后可再次触发',
    (await countInLog('head_patted 发出')) === patAfterFirst + 1,
  );

  // 摸头反应（ADR 0039）：HFSM overlay=reacting、官方片段接管身体、表情投影 shy、截图
  const patDiag = await readDiagnostics(window);
  check(
    '摸头：HFSM overlay=reacting（head_patted → reacting，§4.1）',
    patDiag?.hfsm.overlay === 'reacting' && patDiag?.hfsm.reaction?.kind === 'head_patted',
    patDiag?.hfsm ?? null,
  );
  check(
    '摸头：官方片段接管身体（pat.body=true，clip 来自 Victory_Start_Random，ADR 0039 D1）',
    patDiag?.pat.active === true &&
      patDiag?.pat.body === true &&
      (patDiag?.pat.clip ?? '').includes('Victory_Start_Random'),
    patDiag?.pat ?? null,
  );
  check(
    '摸头：表情投影 emotion=shy（§4.5；不再有程序化骨骼/缩放，ADR 0039 D2/D3）',
    patDiag?.facial?.effective === 'shy',
    patDiag?.facial ?? null,
  );
  check(
    '摸头：状态投影 emotion=shy（§4.5，反应结束回到原 emotion）',
    (await window.webContents.executeJavaScript('window.petRender.getState().emotion', true)) === 'shy',
  );
  await captureScreenshot(window, 'window-pat.png', 'pat-react');

  /**
   * ADR 0040 验收 1：静止点击**脸部**必须触发官方摸头片段。
   *
   * 旧口径（掩膜 bbox 顶部 22%）下这一点是 `head=false`——就是"点她没反应"的根因。
   *
   * 稳定性（本轮排查）：**先等上一次摸头片段播完，再取头骨坐标**。旧写法先取
   * `headBandDiagnostics()` 再等 950ms——如果那时她还缩着（片段把她压低 ~57px），
   * 点到的是"缩着时的下巴"，等她回正后这个点在头骨半径外，断言随机失败。
   */
  await waitFor(window, 3000, (d) => d?.pat?.active === false);
  await sleep(250);
  const faceInfo = JSON.parse(
    (await window.webContents.executeJavaScript(
      `JSON.stringify(window.petModel.headBandDiagnostics())`,
      true,
    )) as string,
  ) as {
    headBoneCss: { x: number; y: number } | null;
    headRadiusPx: number | null;
    bandBottomCssY: number | null;
    source: string;
  };
  const facePatBefore = await countInLog('head_patted 发出');
  let faceClick: { x: number; y: number } | null = null;
  if (faceInfo.headBoneCss) {
    // 点在骨骼下方 8% 窗口高处：落在"眼睛/鼻子"上，不是在颈根
    const faceX = Math.round(faceInfo.headBoneCss.x);
    const faceY = Math.round(faceInfo.headBoneCss.y + contentSize.height * 0.08);
    faceClick = { x: faceX, y: faceY };
    current = window.getContentBounds();
    pushScriptedCursor(current.x + faceX, current.y + faceY);
    await sleep(320);
    await dispatchPointer('down', faceX, faceY);
    await sleep(60);
    await dispatchPointer('up', faceX, faceY);
    await sleep(220);
  }
  const facePatAfter = await countInLog('head_patted 发出');
  check(
    '验收 1：静止点击脸部 → 触发 head_patted（ADR 0040）',
    faceClick !== null && facePatAfter === facePatBefore + 1,
    { click: faceClick, bandBottomY: faceInfo.bandBottomCssY, source: faceInfo.source, before: facePatBefore, after: facePatAfter },
  );
  const faceReaction = await readDiagnostics(window);
  check(
    '验收 1：脸部摸头播的是官方片段（pat.body=true，clip 含 Victory_Start_Random）',
    faceReaction?.pat.active === true &&
      faceReaction?.pat.body === true &&
      (faceReaction?.pat.clip ?? '').includes('Victory_Start_Random'),
    faceReaction?.pat ?? null,
  );

  /**
   * ADR 0040 验收 2：点**光环或发顶上方**（y≈120–205）不得触发摸头。
   * 那里在掩膜里是不透明的（hit=true），但离头骨超过半径 → head=false。
   */
  await sleep(950);
  const haloPatBefore = await countInLog('head_patted 发出');
  const haloX = Math.round(contentSize.width / 2);
  const haloY = Math.round(contentSize.height * 0.22);
  current = window.getContentBounds();
  pushScriptedCursor(current.x + haloX, current.y + haloY);
  await sleep(320);
  await dispatchPointer('down', haloX, haloY);
  await sleep(60);
  await dispatchPointer('up', haloX, haloY);
  await sleep(220);
  const haloPatAfter = await countInLog('head_patted 发出');
  check(
    '验收 2：静止点击光环/发顶上方（y≈0.22H）→ 不触发 head_patted（ADR 0040）',
    haloPatAfter === haloPatBefore,
    { click: { x: haloX, y: haloY }, headBoneY: faceInfo.headBoneCss?.y, radius: faceInfo.headRadiusPx, before: haloPatBefore, after: haloPatAfter },
  );

  // §5.3 必测组合：说话时被摸头 —— 身体通道不动、只做表情、overlay 仍投影 speaking
  // 先等上一次摸头反应播完：`pat_react` 是幂等的（已在播就不重启），
  // 上一拍还没退干净时这条测的就不是"新起一次反应"（ADR 0047 自检修正）。
  await waitFor(window, 3000, (d) => d?.pat?.active === false);
  const speakingPat = JSON.parse(
    (await window.webContents.executeJavaScript(
      `(() => {
        window.petRender.handleEvent({ name: 'speech_started', payload: { utteranceId: 'selftest-speech-1', text: 'selftest' } });
        window.petRender.handleIntent('pat_react');
        const d = window.petModel.getDiagnostics();
        const s = window.petRender.getState();
        return JSON.stringify({ hfsm: d.hfsm, pat: d.pat, state: s });
      })()`,
      true,
    )) as string,
  ) as {
    hfsm: { overlay: string | null };
    pat: {
      active: boolean;
      body: boolean;
      clip: string | null;
      blockedBy: string | null;
    };
    state: { overlay: string | null; emotion: string };
  };
  check(
    '说话时被摸头：overlay 字段投影保持 speaking（§5.1 + §7.1 单字段）',
    speakingPat.hfsm.overlay === 'speaking' && speakingPat.state.overlay === 'speaking',
    speakingPat.hfsm,
  );
  // `pat.*` 诊断在**渲染帧**里刷新，而且"反应进行中"是个瞬态窗口：同一个 JS 同步块里
  // 读到的可能还是上一帧，等 200ms 又可能已经自愈退出。用轮询取"至少观察到一次"。
  const speakingPatFrame =
    (await waitFor(
      window,
      1600,
      (d) => d?.pat?.active === true && d.pat.blockedBy === 'speaking',
    )) ?? null;
  check(
    '说话时被摸头：身体通道不动、只做表情（§5.3 / ADR 0039 D4）',
    speakingPatFrame?.pat?.active === true &&
      speakingPatFrame?.pat?.body === false &&
      speakingPatFrame?.pat?.blockedBy === 'speaking',
    { sync: speakingPat.pat, polled: speakingPatFrame?.pat ?? null },
  );
  check(
    '说话时被摸头：emotion 仍临时投影 shy',
    speakingPat.state.emotion === 'shy',
    speakingPat.state,
  );

  await window.webContents.executeJavaScript(
    `window.petRender.handleEvent({ name: 'speech_ended', payload: { utteranceId: 'selftest-speech-1', reason: 'completed', durationMs: 120 } })`,
    true,
  );
  await sleep(80);
  // 摸头反应可能仍在（overlay 投影为 reacting），但不得再是 speaking
  const afterSpeech = (await window.webContents.executeJavaScript(
    'window.petRender.getState().overlay',
    true,
  )) as string | null;
  check('speech_ended 后 overlay 退出 speaking', afterSpeech !== 'speaking', { overlay: afterSpeech });

  // 3.4 4px 阈值边界（3px 微动不进入拖拽）
  current = window.getContentBounds();
  pushScriptedCursor(current.x + body.x, current.y + body.y);
  await sleep(320);
  const dragBaseline = await countInLog('拖拽开始');
  const patBaselineBody = await countInLog('head_patted 发出');
  await dispatchPointer('down', body.x, body.y);
  await sleep(40);
  pushScriptedCursor(current.x + body.x + 3, current.y + body.y);
  await sleep(50);
  await dispatchPointer('up', body.x + 3, body.y);
  await sleep(150);
  check('4px 阈值：3px 微动不进入拖拽', (await countInLog('拖拽开始')) === dragBaseline);
  check(
    '4px 阈值：体型区短按不误发 head_patted',
    (await countInLog('head_patted 发出')) === patBaselineBody,
  );

  // 3.5 拖拽进入 / 拖拽中 / 松手 / 沉降
  current = window.getContentBounds();
  pushScriptedCursor(current.x + body.x, current.y + body.y);
  await sleep(320);
  const boundsBeforeDrag = shell.getBounds();
  const dragBaseline2 = await countInLog('拖拽开始');
  const pausedBaseline = await countInLog('掩膜采集暂停');
  const passthroughBaseline = await countInLog('"target":"passthrough"');

  await dispatchPointer('down', body.x, body.y);
  await sleep(40);
  pushScriptedCursor(current.x + body.x + 20, current.y + body.y);
  await sleep(110);
  const boundsStarted = shell.getBounds();
  check('拖拽进入：位移 >4px 发出 drag_started', (await countInLog('拖拽开始')) === dragBaseline2 + 1);
  check(
    '拖拽进入：窗口跟随光标移动（≥16px）',
    boundsStarted.x - boundsBeforeDrag.x >= 16,
    { before: boundsBeforeDrag.x, after: boundsStarted.x },
  );
  check(
    '拖拽中：渲染侧掩膜采集暂停（R-8，日志可见 paused）',
    (await countInLog('掩膜采集暂停')) > pausedBaseline,
  );

  pushScriptedCursor(current.x + body.x + 70, current.y + body.y - 10);
  await sleep(40);
  pushScriptedCursor(current.x + body.x + 120, current.y + body.y - 20);
  await sleep(40);
  const boundsDuring = shell.getBounds();
  check(
    '拖拽中：窗口继续跟随（累计 ≥100px）',
    boundsDuring.x - boundsBeforeDrag.x >= 100,
    { before: boundsBeforeDrag.x, during: boundsDuring.x },
  );
  check(
    '拖拽中：穿透保持关闭（R-8，未新增 passthrough 切换）',
    (await countInLog('"target":"passthrough"')) === passthroughBaseline,
  );

  // 拖拽姿态（ADR 0014 D3/D6）：Physics 接管、切到"被拎起"悬空动作、整体轻微摇摆
  await sleep(120);
  const dragDiag = await readDiagnostics(window);
  check(
    '拖拽：Physics=dragged 且切到 Formation_Pickup 悬空动作',
    dragDiag?.hfsm.physics === 'dragged' &&
      dragDiag?.animation?.current?.name === 'CH0335_Formation_Pickup',
    { hfsm: dragDiag?.hfsm ?? null, current: dragDiag?.animation?.current ?? null },
  );
  check(
    '拖拽：Base 的 Idle 已淡出（权重 < 0.1），不再叠加 Y 轴位移',
    (dragDiag?.animation?.actions ?? []).every(
      (action) => action.name !== idleName || action.weight < 0.1,
    ),
    dragDiag?.animation?.actions ?? null,
  );
  check(
    '拖拽：抓取带与支点已建立（ADR 0035 D1/D2）',
    dragDiag?.drag?.band !== null &&
      dragDiag?.drag?.gain !== undefined &&
      dragDiag.drag.gain > 0.2 &&
      dragDiag.drag.pivot.x > 0 &&
      dragDiag.drag.pivot.y > 0,
    dragDiag?.drag ?? null,
  );
  await captureScreenshot(window, 'window-drag.png', 'dragged');

  // D-6 末速度只看抬手前 ~100ms 的光标采样；截图会停住光标，松手前补几次位移。
  // ADR 0040 D3：落地冲击现在只看**松手瞬间的竖直速度**（门槛 700px/s），所以这里先抬高、
  // 再向下**连续两次大位移**后松手：保证最后 100ms 的采样里有一段 ≥90px 的下移，
  // 不会因为 tick 采样相位不同而落到门槛以下（实测过一次 647px/s，刚好差 53）。
  pushScriptedCursor(current.x + body.x + 140, current.y + body.y - 235);
  await sleep(40);
  pushScriptedCursor(current.x + body.x + 145, current.y + body.y - 120);
  await sleep(25);
  pushScriptedCursor(current.x + body.x + 150, current.y + body.y - 30);
  await sleep(25);
  const boundsBeforeRelease = shell.getBounds();
  const landingCountBefore = dragDiag?.drag?.landingCount ?? 0;

  // 抬手的坐标必须是**当前窗口**里的坐标：窗口已经被拖到别处，
  // 还用按下时的局部坐标会让窗口在松手瞬间跳一段（实测 23px），
  // 那一下"瞬移"会被当成末速度，落地分级就不是真实物理了。
  const releaseLocalX = current.x + body.x + 150 - boundsBeforeRelease.x;
  const releaseLocalY = current.y + body.y - 30 - boundsBeforeRelease.y;

  await dispatchPointer('up', releaseLocalX, releaseLocalY);
  await sleep(160);
  const releaseLog = lastJsonAfter(await runLogText(), '拖拽松手（D-6）');
  const speed = releaseLog ? Math.hypot(Number(releaseLog['vx']), Number(releaseLog['vy'])) : 0;
  check('松手：drag_released 携带末速度（px/s）', speed > 0, { speed });
  const resumeBaseline = await countInLog('掩膜采集恢复');
  const boundsReleased = shell.getBounds();
  check(
    '松手：窗口尺寸不变、回弹只接管竖直方向',
    boundsReleased.width === contentSize.width && boundsReleased.height === contentSize.height,
    { beforeRelease: boundsBeforeRelease, released: boundsReleased },
  );

  // ADR 0024 D3：松手先进入 settling（回弹），不再直接回 Idle
  await sleep(140);
  const settlingDiag = await readDiagnostics(window);
  check(
    '松手：Physics=settling（回弹开始，D-6 / ADR 0024 D3）',
    settlingDiag?.hfsm.physics === 'settling' && settlingDiag?.motion.physics === 'settling',
    { hfsm: settlingDiag?.hfsm ?? null, motion: settlingDiag?.motion ?? null },
  );
  check(
    '松手：没有 reacting（拖拽 → settling → idle，永不经过 reacting，ADR 0039 D5）',
    settlingDiag?.hfsm.reaction === null && settlingDiag?.hfsm.overlay === null,
    { hfsm: settlingDiag?.hfsm ?? null },
  );

  // ADR 0039 D5：回弹期间**渲染侧**也拒绝 head_patted。
  // 这里直接给渲染侧发一条事件（模拟主进程的迟到事件），不移动窗口、不依赖合成手势，
  // 因此是确定性的：只要 physics=settling，reaction 必须保持 null、动作不得被切。
  const rejectBaseline = await countInLog('忽略 head_patted');
  await window.webContents.executeJavaScript(
    `window.petRender.handleEvent({ name: 'head_patted', payload: { patCount: 99 } })`,
    true,
  );
  await sleep(80);
  const settleReject = await readDiagnostics(window);
  check(
    '回弹期间：head_patted 被 render 拒绝（无 reaction、无 pat，ADR 0039 D5 严格互斥）',
    settleReject?.hfsm.physics === 'settling' &&
      settleReject?.hfsm.reaction === null &&
      settleReject?.pat?.active === false,
    { hfsm: settleReject?.hfsm ?? null, pat: settleReject?.pat ?? null },
  );
  check(
    '回弹期间：拒绝留有日志（严格互斥可诊断）',
    (await countInLog('忽略 head_patted')) > rejectBaseline,
  );

  // 回弹期间不接受新的动作意图（用户要求；唯一例外是重新拖拽）
  await window.webContents.executeJavaScript(`window.petRender.handleIntent('nod')`, true);
  await sleep(60);
  const settlingAfterIntent = await readDiagnostics(window);
  check(
    '回弹期间：intent 被忽略（reaction 仍为 null）',
    settlingAfterIntent?.hfsm.physics === 'settling' &&
      settlingAfterIntent?.hfsm.reaction === null,
    { hfsm: settlingAfterIntent?.hfsm ?? null },
  );

  // 等回弹收敛（弹簧 < SETTLE_MAX_MS 兜底 2.5s）
  const settledDiag = await waitFor(
    window,
    4000,
    (diagnostics) => diagnostics?.hfsm.physics === null && diagnostics?.motion.base === 'idle',
  );
  check(
    '回弹结束：Physics 退出、base=idle、Idle 动作淡入',
    settledDiag?.hfsm.physics === null &&
      settledDiag?.hfsm.base === 'idle' &&
      settledDiag?.animation?.current?.name === idleName,
    {
      hfsm: settledDiag?.hfsm ?? null,
      motion: settledDiag?.motion ?? null,
      current: settledDiag?.animation?.current ?? null,
    },
  );

  const groundBounds = shell.getBounds();
  const groundArea = workAreaFor(groundBounds);
  const expectedGroundY = groundArea.y + groundArea.height - contentSize.height;
  check(
    '回弹结束：窗口落到工作区地面线（±2px，ADR 0024 D2）',
    Math.abs(groundBounds.y - expectedGroundY) <= 2,
    { y: groundBounds.y, expectedGroundY },
  );
  // 落地缓冲只活 220ms（ADR 0040 D3），而 `getDiagnostics()` 单次约 300ms —— 读得稍晚
  // 就只剩 null（2026-11-04 复现）。改成读 render 侧留存的 `lastLandingImpact/lastLandingSquash`，
  // 它是"最近一次冲击"的持久值，不再受采样时机影响。
  const landingDiag = settledDiag;
  const lastLandingImpact = landingDiag?.drag?.lastLandingImpact ?? 0;
  // 冲击峰值是在 220ms 窗口里逐帧取的，读得**太早**会拿到 0（本轮实测偶发）。
  // 这里轮询到峰值出现为止；`lastLandingSquash` 是持久值，晚读不会丢。
  const landedDiag = await waitFor(
    window,
    1500,
    (d) => (d?.drag?.lastLandingSquash ?? 0) > 0,
  );
  const lastLandingSquash = landedDiag?.drag?.lastLandingSquash ?? landingDiag?.drag?.lastLandingSquash ?? 1;
  const landingCountAfter = landedDiag?.drag?.landingCount ?? landingDiag?.drag?.landingCount ?? 0;
  check(
    '落地：向下快速松手 → 轻微下蹲（impact>0；squash ≤3%，ADR 0040 D3）',
    landingCountAfter > landingCountBefore &&
      lastLandingImpact > 0 &&
      lastLandingSquash > 0 &&
      lastLandingSquash <= 0.0301,
    {
      landingCountBefore,
      landingCountAfter,
      lastLandingImpact,
      lastLandingSquash,
      live: { impact: landingDiag?.drag?.landingImpact ?? null, squash: landingDiag?.drag?.landingSquash ?? null },
    },
  );

  // ADR 0040 验收 3 的视觉证据：落地中（最多 3% 压扁）→ 400ms 后静止，两帧对比应只差一点点。
  await captureScreenshot(window, 'window-landing.png', 'settle(landing)');
  await sleep(400);
  await captureScreenshot(window, 'window-landed.png', 'settle(rest)');

  // ADR 0040 D3 的反向验收：**轻放不缩**。debugDropFromHeight 走真实 drag_released 链，
  // 但 vy=0（松手时没有向下速度）→ impact 必须是 0、不能再有"弹一下"。
  const lightDrop = shell.debugDropFromHeight(40);
  const lightSettled = await waitFor(
    window,
    4000,
    (diagnostics) => diagnostics?.hfsm.physics === null && diagnostics?.motion.base === 'idle',
  );
  check(
    '落地：轻放（releaseVy=0）→ 完全不缩（impact=0、squash=0，ADR 0040 D3）',
    lightDrop === true &&
      lightSettled?.drag?.landingImpact === 0 &&
      lightSettled?.drag?.landingSquash === 0,
    { dropped: lightDrop, drag: lightSettled?.drag ?? null },
  );

  await sleep(300);
  const pausedMs = lastPausedMs(await runLogText());
  check(
    '松手：500ms 沉降窗口后掩膜恢复采集（R-8）',
    (await countInLog('掩膜采集恢复')) > resumeBaseline && pausedMs !== null && pausedMs >= 500,
    { pausedMs },
  );

  // 3.55 抓头拖拽（ADR 0041 D1 的核心验收）：播的必须是**同一段**官方悬空片段。
  // 旧实现按抓取带分片：抓头 → `Carrier_Idle`（普通站姿）+ 手写骨骼偏移，
  // 于是"拖上半部分不触发官方动画"。这里在头骨附近按下、拖过 4px，断言
  // ① band=head（分类仍生效，只影响单摆物理）② 片段仍是 Formation_Pickup。
  current = window.getContentBounds();
  pushScriptedCursor(current.x + head.x, current.y + head.y);
  await sleep(320);
  const headDragBoundsBefore = shell.getBounds();
  await dispatchPointer('down', head.x, head.y);
  await sleep(40);
  pushScriptedCursor(current.x + head.x + 28, current.y + head.y + 6);
  await sleep(160);
  const headDragDiag = await readDiagnostics(window);
  check(
    '拖拽（抓头）：Physics=dragged 且播同一段官方悬空片段 Formation_Pickup（ADR 0041 D1）',
    headDragDiag?.hfsm.physics === 'dragged' &&
      headDragDiag?.drag?.band === 'head' &&
      headDragDiag?.animation?.current?.name === 'CH0335_Formation_Pickup',
    {
      hfsm: headDragDiag?.hfsm ?? null,
      band: headDragDiag?.drag?.band ?? null,
      current: headDragDiag?.animation?.current ?? null,
    },
  );
  check(
    '拖拽（抓头）：窗口同样跟随（部位只影响单摆，不影响位移链）',
    shell.getBounds().x - headDragBoundsBefore.x >= 16,
    { before: headDragBoundsBefore.x, after: shell.getBounds().x },
  );
  {
    const boundsNow = shell.getBounds();
    await dispatchPointer(
      'up',
      current.x + head.x + 28 - boundsNow.x,
      current.y + head.y + 6 - boundsNow.y,
    );
  }
  await waitFor(
    window,
    4000,
    (diagnostics) => diagnostics?.hfsm.physics === null && diagnostics?.motion.base === 'idle',
  );

  // 3.6 拖到屏幕外被 D-7 钳制
  current = window.getContentBounds();
  pushScriptedCursor(current.x + body.x, current.y + body.y);
  await sleep(320);
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const maxRight = Math.max(...workAreas.map((area) => area.x + area.width));
  const maxBottom = Math.max(...workAreas.map((area) => area.y + area.height));
  await dispatchPointer('down', body.x, body.y);
  await sleep(50);
  pushScriptedCursor(maxRight + 2000, maxBottom + 2000);
  await sleep(180);
  await dispatchPointer('up', body.x, body.y);
  await sleep(220);
  const boundsClamped = shell.getBounds();
  const extents = workAreas.map((area) => visibleExtent(boundsClamped, area));
  check(
    '拖到屏幕外：D-7 钳制后至少 80×120 留在任一显示器工作区内',
    extents.some((extent) => extent.width >= 80 && extent.height >= 120),
    { boundsClamped, extents },
  );
  check(
    '拖到屏幕外：钳制只改位置，不改尺寸',
    boundsClamped.width === contentSize.width && boundsClamped.height === contentSize.height,
  );

  // 复原窗口位置，截图仍落在初始位置
  window.setPosition(
    Math.round(screen.getPrimaryDisplay().workArea.x + (screen.getPrimaryDisplay().workArea.width - contentSize.width) / 2),
    Math.round(
      screen.getPrimaryDisplay().workArea.y +
        Math.max(0, screen.getPrimaryDisplay().workArea.height - contentSize.height),
    ),
  );
  await sleep(150);
  resetScriptedCursor();
  await sleep(200);

  // ------------------------------------------------------------------
  // 3.6b 真实回弹：抬高 220px 后松手，窗口应带惯性落到地面线（ADR 0024 D2/D3）
  // ------------------------------------------------------------------
  const groundAreaForBounce = workAreaFor(shell.getBounds());
  const bounceGroundY = groundAreaForBounce.y + groundAreaForBounce.height - contentSize.height;
  const beforeLift = window.getContentBounds();
  pushScriptedCursor(beforeLift.x + body.x, beforeLift.y + body.y);
  await sleep(320);
  await dispatchPointer('down', body.x, body.y);
  await sleep(60);
  pushScriptedCursor(beforeLift.x + body.x, beforeLift.y + body.y - 220);
  await sleep(220);
  const liftedBounds = shell.getBounds();
  await dispatchPointer('up', body.x, body.y);
  await sleep(120);
  const fallingBounds = shell.getBounds();
  check(
    '回弹：抬高后松手，窗口开始下落（y 增大）',
    liftedBounds.y < bounceGroundY - 80 && fallingBounds.y > liftedBounds.y,
    { liftedY: liftedBounds.y, fallingY: fallingBounds.y, groundY: bounceGroundY },
  );

  const bounced = await waitFor(
    window,
    4000,
    (diagnostics) => diagnostics?.motion.physics === null,
  );
  const bouncedBounds = shell.getBounds();
  check(
    '回弹：落到工作区地面线并静止（±2px）',
    bounced?.motion.physics === null && Math.abs(bouncedBounds.y - bounceGroundY) <= 2,
    { y: bouncedBounds.y, groundY: bounceGroundY, motion: bounced?.motion ?? null },
  );
  resetScriptedCursor();
  await sleep(200);

  // ------------------------------------------------------------------
  // 3.7 行走调度与窗口位移（ADR 0024 D1）
  //     自检把调度间隔压到 1.5–2s（shell 经 query 传给渲染页），否则要等 20–40s
  // ------------------------------------------------------------------
  // 契约缺省是 20–40s；自检把调度间隔压到 1.5–2s，否则一次自检等不到触发
  await window.webContents.executeJavaScript(`window.petRender.setWalkInterval(1500, 2000)`, true);
  await sleep(80);
  const walkStart = shell.getBounds();
  const walkingDiag = await waitFor(
    window,
    6000,
    (diagnostics) => diagnostics?.motion.base === 'walking',
  );
  check(
    '行走：idle 到点后进入 walking（契约 20–40s；自检压到 1.5–2s）',
    walkingDiag?.motion.base === 'walking' && walkingDiag?.motion.walking !== null,
    { motion: walkingDiag?.motion ?? null },
  );
  const walkClip = walkingDiag?.animation?.current?.name ?? null;
  check('行走：播放正面行走片段（CH0335_Cafe_Walk）', (walkClip ?? '').includes('Walk'), {
    walkClip,
  });
  // ADR 0026 D1：走动时按方向转向移动方向（±90°），不再是"正面侧滑"
  const walkDirection = walkingDiag?.motion.walking?.direction ?? null;
  const expectedYaw = walkDirection === 'left' ? -Math.PI / 2 : Math.PI / 2;
  check(
    '行走：按移动方向转身（target = ±90°）',
    Math.abs((walkingDiag?.motion.walkYawTarget ?? 0) - expectedYaw) < 1e-3,
    { direction: walkDirection, yawTarget: walkingDiag?.motion.walkYawTarget, expectedYaw },
  );
  const turnedDiag = await waitFor(
    window,
    2000,
    (diagnostics) => Math.abs((diagnostics?.motion.walkYaw ?? 0) - expectedYaw) < 0.05,
  );
  check(
    '行走：偏航平滑逼近目标（≤0.05 rad，指数插值而非瞬切）',
    Math.abs((turnedDiag?.motion.walkYaw ?? 0) - expectedYaw) < 0.05,
    { yaw: turnedDiag?.motion.walkYaw, expectedYaw },
  );
  const walkingShot = await captureScreenshot(window, 'window-walking.png', 'walking');

  let walkMoved = shell.getBounds();
  const walkDeadline = Date.now() + 4000;
  while (Date.now() < walkDeadline) {
    walkMoved = shell.getBounds();
    if (Math.abs(walkMoved.x - walkStart.x) >= 20) break;
    await sleep(60);
  }
  check(
    '行走：窗口在桌面上真实位移（≥20px；位移由代码接管，不用 root motion）',
    Math.abs(walkMoved.x - walkStart.x) >= 20,
    { from: walkStart.x, to: walkMoved.x, shot: walkingShot },
  );

  const walkEndedDiag = await waitFor(
    window,
    8000,
    (diagnostics) => diagnostics?.motion.base === 'idle',
  );
  check(
    '行走：到达后回到 idle 并重新排期',
    walkEndedDiag?.motion.base === 'idle' && walkEndedDiag?.motion.nextWalkInMs !== null,
    { motion: walkEndedDiag?.motion ?? null },
  );
  const facedFrontDiag = await waitFor(
    window,
    2000,
    (diagnostics) => Math.abs(diagnostics?.motion.walkYaw ?? 1) < 0.02,
  );
  check(
    '行走：停下后转回正面（walkYaw → 0）',
    Math.abs(facedFrontDiag?.motion.walkYaw ?? 1) < 0.02,
    { yaw: facedFrontDiag?.motion.walkYaw, target: facedFrontDiag?.motion.walkYawTarget },
  );

  // ------------------------------------------------------------------
  // 3.9 吸附到前台窗口与坐姿（ADR 0028）
  //     自检自己造一个"记事本"窗口（同进程 BrowserWindow、可聚焦），让它成为前台窗口，
  //     再走与 Ctrl+Shift+S 完全相同的入口（shell.snapToForeground）。
  //     验收要求的三件事：跳到下边缘、播放坐姿、截图可见。
  // ------------------------------------------------------------------
  await window.webContents.executeJavaScript(`window.petRender.setWalkInterval(600000, 600001)`, true);
  await waitFor(window, 6000, (diagnostics) => diagnostics?.motion.base === 'idle');

  const display = screen.getPrimaryDisplay();
  const notepadWidth = 560;
  const notepadHeight = 220;
  const notepadBottom = display.workArea.y + Math.round(display.workArea.height * 0.9);
  const notepadX = display.workArea.x + 240;
  const notepadY = notepadBottom - notepadHeight;
  const notepad = new BrowserWindow({
    x: notepadX,
    y: notepadY,
    width: notepadWidth,
    height: notepadHeight,
    show: false,
    frame: true,
    skipTaskbar: true,
    title: 'selftest-notepad',
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  await notepad.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="margin:0;background:#fbfbfb;font:16px \'Segoe UI\',sans-serif;color:#333">' +
          '<div style="padding:14px 18px;border-bottom:1px solid #ddd">未命名 - 记事本（自检替身）</div>' +
          '<div style="padding:14px 18px;color:#555">这一扇窗口只是为了让桌宠有"别人的窗口边缘"可坐。</div>' +
          '</body>',
      ),
  );
  notepad.setBounds({ x: notepadX, y: notepadY, width: notepadWidth, height: notepadHeight });
  notepad.show();
  await sleep(700);

  // 先验一次"真实前台窗口"：证明 Win32 读取 + DIP 换算这条真链路可用。
  // 注意本应用主窗口 focusable=false（§3.2），拿不到前台权，`notepad.focus()` 抢不来
  // 系统前台（本轮实测：真实前台仍是别的应用）——所以几何/解除断言改用脚本化前台（下一段）。
  const realSnap = shell.snapToForeground();
  const realDip = realSnap && realSnap.ok ? realSnap.target?.dip ?? null : null;
  check(
    '吸附：真实前台窗口可被 Win32 读到并换算成 DIP（命中或明确拒绝）',
    realSnap !== null &&
      (realSnap.ok
        ? realSnap.source === 'foreground' &&
          realDip !== null &&
          realDip.width >= 80 &&
          realDip.height >= 40
        : // 明确拒绝也说明 Win32 读取这条链路跑通了；只排除"根本没读"
          // （`disabled` / `busy` / `invalid-pet`）。桌面/隐藏窗口在不同会话里都可能出现，
          // 它们都是合法结果，不应把这条断言变成环境骰子（本轮复现过一次 hidden-window）。
          [
            'fullscreen',
            'invalid-rect',
            'geometry',
            'shell-window',
            'own-window',
            'hidden-window',
            'no-foreground',
          ].includes(realSnap.reason)),
    realSnap ?? null,
  );
  shell.releaseSnap();
  await waitFor(window, 3000, (diagnostics) => diagnostics?.hfsm.physics === null);

  // ADR 0034：把桌宠先挪回地面左侧，确保下一步"脚本化前台吸附"真的需要接近，
  // 否则她可能还站在刚才的窗沿上，距离 ≤8px 会直接落座（观察不到接近阶段）。
  window.setPosition(
    display.workArea.x + 100,
    display.workArea.y + display.workArea.height - contentSize.height,
    false,
  );
  await sleep(160);

  // 从这里开始把"前台窗口"指向自检自己造的那扇记事本窗口（PET_SELFTEST=1 才生效）。
  // 传入的是**物理像素**，仍然走真实的 `screenToDipPoint` 换算与真实的吸附控制器。
  pushScriptedForeground(dipRectToPhysical(notepad.getBounds()));
  await sleep(200);

  const snapOutcome = shell.snapToForeground();
  const snapDiag = shell.snapSnapshot();
  check('吸附：热键入口返回成功（ADR 0028 D4）', snapOutcome?.ok === true, snapOutcome ?? null);
  check(
    '吸附：Win32 前台窗口读取可用（auto 模式 / koffi，ADR 0028 D1）',
    snapDiag?.mode === 'foreground',
    snapDiag ?? null,
  );
  check(
    '吸附：先进入接近阶段，不瞬移（ADR 0034 D1/D3）',
    snapDiag?.approaching === true && snapDiag?.approachProgress !== null,
    snapDiag ?? null,
  );

  // ADR 0034：必须等"到达并落座"之后再量几何；physics=sitting 在接近阶段就为真，
  // 不能再拿它当"已经坐下"的判据。
  const arrived = await waitFor(
    window,
    4000,
    (diagnostics) => diagnostics?.sit?.arrived === true,
  );
  check(
    '吸附：接近结束后进入落座阶段（sit.arrived=true，ADR 0034 D2）',
    arrived?.sit?.arrived === true && arrived?.hfsm.physics === 'sitting',
    arrived?.sit ?? null,
  );
  // ADR 0042 D1：落座不是瞬间切换——到达后 240ms 内有一个"半蹲"过渡
  // （身体从座面上方 14px 落下、大腿前弯 0.22rad、躯干微前倾），之后全部归零。
  check(
    '坐姿：落座时有半蹲过渡（transition ∈ (0,1)、transitionLiftPx > 0，ADR 0042 D1）',
    typeof arrived?.sit?.transition === 'number' &&
      arrived.sit.transition > 0 &&
      arrived.sit.transition < 1 &&
      (arrived.sit.transitionLiftPx ?? 0) > 0,
    arrived?.sit ?? null,
  );

  const notepadBounds = notepad.getBounds();
  const seatedBounds = shell.getBounds();
  check(
    '吸附：窗口贴到记事本下边缘（±8px，ADR 0028 D2）',
    Math.abs(seatedBounds.y + seatedBounds.height - (notepadBounds.y + notepadBounds.height)) <= 8,
    { pet: seatedBounds, target: notepadBounds },
  );
  check(
    '吸附：水平居中于记事本（±8px）',
    Math.abs(
      seatedBounds.x + seatedBounds.width / 2 - (notepadBounds.x + notepadBounds.width / 2),
    ) <= 8,
    {
      petCenter: seatedBounds.x + seatedBounds.width / 2,
      targetCenter: notepadBounds.x + notepadBounds.width / 2,
    },
  );

  const seated = arrived;
  check(
    '吸附：render 进入 Physics=sitting（§4.1 新增状态，ADR 0028 D5）',
    seated?.hfsm.physics === 'sitting',
    seated?.hfsm ?? null,
  );
  check(
    '吸附：播放官方坐姿片段（pastmemory 14.2–16.2s，ADR 0051 两段式），不是程序化降级',
    (seated?.animation?.current?.name ?? '').includes('pastmemory') &&
      (seated?.animation?.current?.name ?? '').includes('@14.2-16.2s') &&
      seated?.sit?.procedural === false,
    { current: seated?.animation?.current ?? null, sit: seated?.sit ?? null },
  );
  check(
    '吸附：行走调度已关闭（walking=null、nextWalkInMs=null）',
    seated?.motion.walking === null && seated?.motion.nextWalkInMs === null,
    seated?.motion ?? null,
  );

  // ------------------------------------------------------------------
  // ADR 0051：坐姿两段式 + 下坐弹簧。
  //
  // 阶段 A：14.2→16.0s 正常播放（不覆盖上半身）；阶段 B：16.0→16.2s 停帧，
  // 从 16.0s 起 0.3s 淡入站立覆盖 + 程序化微动。这里用 `sitSequence()` 以 16ms
  // 采样整段（约 2.6s），同时验证：
  // ① A 阶段确实没有覆盖（upperOverride=0）；
  // ② B 在片段本地 1.8s 启动，0.3s 内覆盖到 1；
  // ③ A→B 头部四元数逐帧最大步进 < 0.15rad（不跳）；
  // ④ sitDrop 0→1 无过冲（≤1.01）。
  // ------------------------------------------------------------------
  const stageAShot = await captureScreenshot(window, 'sit-stage-a.png', 'sit-stage-a');
  /**
   * ADR 0051 D7 的 A/B 取证：阶段 A 的抬头补偿只能在**片段还在正放**时看出来。
   *
   * 采样 Promise 先启动，再在同一个时间轴里拍特写 —— 这样不会把 `firstStageB`
   * 往后推（既有断言要求 `t` 落在 900–2500ms，采样起点必须还在阶段 A）。
   * 采样开始约 0.4s 后 = 片段本地约 15.1s：官方 14.95s 的快速张望已经收尾，
   * 画面稳定，两张图的唯一变量就是 `SIT_PHASE_A_HEAD_TUNE_RAD`。
   */
  const sitSequencePromise = window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const rows = [];
      const startedAt = performance.now();
      const tick = () => {
        const snap = window.diagnostics.sitSequence();
        rows.push({ t: Math.round(performance.now() - startedAt), ...snap });
        if (performance.now() - startedAt < 2600) setTimeout(tick, 16);
        else resolve(JSON.stringify(rows));
      };
      tick();
    })`,
    true,
  ) as Promise<string>;
  await sleep(400);
  await window.webContents.executeJavaScript(`window.diagnostics.faceZoom(260)`, true);
  await sleep(180);
  const stageACloseupMoment = JSON.parse(
    (await window.webContents.executeJavaScript(
      `JSON.stringify(window.diagnostics.sitSequence())`,
      true,
    )) as string,
  ) as SitSequenceDiagnostics;
  const stageACloseup = await captureScreenshot(window, 'sit-ab-stage-a.png', 'sit-ab-stage-a');
  await window.webContents.executeJavaScript(`window.diagnostics.faceZoom(0)`, true);
  const sitSequenceSeries = JSON.parse(await sitSequencePromise) as Array<
    SitSequenceDiagnostics & { t: number }
  >;
  const stageASamples = sitSequenceSeries.filter((row) => row.stage === 'a');
  const firstStageB = sitSequenceSeries.find((row) => row.stage === 'b') ?? null;
  const lastSequence = sitSequenceSeries[sitSequenceSeries.length - 1] ?? null;
  let maxHeadStepRad = 0;
  for (let i = 1; i < sitSequenceSeries.length; i += 1) {
    const a = sitSequenceSeries[i - 1]!.headQuat;
    const b = sitSequenceSeries[i]!.headQuat;
    if (!a || !b) continue;
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    maxHeadStepRad = Math.max(maxHeadStepRad, 2 * Math.acos(Math.min(1, dot)));
  }
  const maxSitDrop = Math.max(0, ...sitSequenceSeries.map((row) => row.sitDrop));
  check(
    '坐姿两段式：阶段 A 先播（A 期间 upperOverride=0、stageBBlend=0；B 在片段本地 1.8s = 绝对 16.0s）',
    stageASamples.length > 5 &&
      stageASamples.every((row) => row.upperOverride <= 0.001 && row.stageBBlend <= 0.001) &&
      firstStageB !== null &&
      typeof firstStageB.holdTimeSeconds === 'number' &&
      firstStageB.holdTimeSeconds >= 1.75 &&
      firstStageB.holdTimeSeconds <= 2.001,
    {
      stageASamples: stageASamples.length,
      firstStageB: firstStageB
        ? { t: firstStageB.t, holdTimeSeconds: firstStageB.holdTimeSeconds, stageBBlend: firstStageB.stageBBlend }
        : null,
    },
  );
  {
    // ADR 0051 D7：阶段 A 抬头补偿接线。默认 0 时实际施加必须恒为 0；
    // 改成 -0.12 时至少要有一帧同号且达到配置值的 30%。
    const tune = seated?.sit?.phaseAHeadTuneRad ?? 0;
    const applied = stageASamples.map((row) => row.phaseAHeadAppliedRad ?? 0);
    const wired =
      tune === 0
        ? applied.every((value) => Math.abs(value) < 1e-6)
        : applied.some(
            (value) => Math.sign(value) === Math.sign(tune) && Math.abs(value) >= Math.abs(tune) * 0.3,
          );
    check(
      '坐姿标定：阶段 A 抬头补偿已接线（0 = 不施加；负值 = 抬头，实际施加与配置同号）',
      wired,
      { tune, applied: applied.map((value) => Number(value.toFixed(3))).slice(0, 8) },
    );
  }
  check(
    '坐姿两段式：阶段 B 在 0.3s 内把上半身覆盖从 0 收到 1（16.2s 停帧后不再跳）',
    firstStageB !== null &&
      firstStageB.t >= 900 &&
      firstStageB.t <= 2500 &&
      (lastSequence?.stageBBlend ?? 0) >= 0.999 &&
      (lastSequence?.upperOverride ?? 0) >= 0.95,
    {
      stageBAtMs: firstStageB?.t ?? null,
      finalStageBBlend: lastSequence?.stageBBlend ?? null,
      finalUpperOverride: lastSequence?.upperOverride ?? null,
    },
  );
  {
    // ADR 0051 D7：下背覆盖权重接线。1.0 时与 upperOverride 相等；
    // 0.85 时必须明显低于 upperOverride（保留一部分片段前倾）。
    const weight = seated?.sit?.spineOverlayWeight ?? 1;
    const applied = lastSequence?.spineOverlayApplied ?? 0;
    const upper = lastSequence?.upperOverride ?? 0;
    const wired =
      weight >= 0.999
        ? Math.abs(applied - upper) < 0.01
        : applied <= upper * weight + 0.01 && applied < upper - 0.05;
    check(
      '坐姿标定：下背 Spine 覆盖权重已接线（1.0 = 与上半身同权；<1 时明显低于 upperOverride）',
      wired,
      { weight, applied: Number(applied.toFixed(3)), upperOverride: Number(upper.toFixed(3)) },
    );
  }
  check(
    '坐姿两段式：A→B 头部无瞬间跳变（16ms 采样最大四元数步进 < 0.15rad）',
    maxHeadStepRad < 0.15,
    { maxHeadStepRad: Number(maxHeadStepRad.toFixed(4)), samples: sitSequenceSeries.length },
  );
  check(
    '坐姿：下坐弹簧 0→1 无过冲（max ≤1.01，最终 ≥0.95，ADR 0051）',
    maxSitDrop <= 1.01 && (lastSequence?.sitDrop ?? 0) >= 0.95,
    { maxSitDrop, finalSitDrop: lastSequence?.sitDrop ?? null },
  );
  // A/B 截图要可比较：阶段 B 强制看镜头，排除"随机张望"造成的头向差异。
  await window.webContents.executeJavaScript(`window.diagnostics.forceSitGaze('camera')`, true);
  await sleep(450);
  const stageBShot = await captureScreenshot(window, 'sit-stage-b.png', 'sit-stage-b');
  check(
    '坐姿两段式：阶段 A / B 截图已产出（sit-stage-a.png / sit-stage-b.png）',
    stageAShot.length > 0 && stageBShot.length > 0,
    { stageAShot, stageBShot },
  );
  // ADR 0051 D7 的 A/B 第二阶段：停帧后**下背覆盖权重**决定她坐得笔直还是稍微弓背。
  // 420px 特写带肩/胸/腰；相机仍跟随头骨，两张图取景一致。强制看镜头已排除随机张望。
  await window.webContents.executeJavaScript(`window.diagnostics.faceZoom(420)`, true);
  await sleep(220);
  const stageBCloseup = await captureScreenshot(window, 'sit-ab-stage-b.png', 'sit-ab-stage-b');
  await window.webContents.executeJavaScript(`window.diagnostics.faceZoom(0)`, true);
  check(
    '坐姿标定：A/B 特写已产出（sit-ab-stage-a.png 阶段 A 脸 / sit-ab-stage-b.png 阶段 B 上半身，ADR 0051 D7）',
    stageACloseup.length > 0 &&
      stageBCloseup.length > 0 &&
      stageACloseupMoment.stage === 'a' &&
      stageACloseupMoment.upperOverride <= 0.001 &&
      (lastSequence?.stageBBlend ?? 0) >= 0.999,
    {
      stageACloseup,
      stageBCloseup,
      stageA: {
        stage: stageACloseupMoment.stage,
        holdTimeSeconds: stageACloseupMoment.holdTimeSeconds,
        phaseAHeadTuneRad: seated?.sit?.phaseAHeadTuneRad ?? null,
        phaseAHeadAppliedRad: stageACloseupMoment.phaseAHeadAppliedRad,
        upperOverride: stageACloseupMoment.upperOverride,
      },
      stageB: {
        stageBBlend: lastSequence?.stageBBlend ?? null,
        upperOverride: lastSequence?.upperOverride ?? null,
        spineOverlayWeight: stageACloseupMoment.spineOverlayWeight,
        spineOverlayApplied: lastSequence?.spineOverlayApplied ?? null,
      },
    },
  );
  // 截图取证完就恢复随机张望，否则后面 11s 的"换向/头在转"断言只会看到一个 camera 目标。
  await window.webContents.executeJavaScript(`window.diagnostics.forceSitGaze('wander')`, true);
  await sleep(400);
  // ADR 0043 D3：落座过程中补偿必须跟着片段权重走（不能一帧内硬切 ~390px）。
  // 断言的是**不变量**而不是某一帧的绝对值：`offset == raw × blend`（±1px 取整误差）。
  // 这样与截图/IPC 的时序无关，又能证明"补偿被权重缩放"。
  {
    const sitNow = arrived?.sit ?? null;
    const rawX = sitNow?.rawOffsetPx?.x ?? 0;
    const rawY = sitNow?.rawOffsetPx?.y ?? 0;
    const offX = sitNow?.offsetPx?.x ?? 0;
    const offY = sitNow?.offsetPx?.y ?? 0;
    // ADR 0051：补偿 = raw × sitGain × sitDrop（诊断字段 `sitPoseGain`）
    const gain = sitNow?.sitPoseGain ?? 0;
    check(
      '坐姿：补偿按片段权重 × 弹簧增益缩放（offset ≈ raw × sitPoseGain，落座瞬间不会硬切，ADR 0043/0051）',
      Math.abs(rawX) > 50 &&
        gain > 0 &&
        gain < 1 &&
        Math.abs(offX - rawX * gain) < 1.5 &&
        Math.abs(offY - rawY * gain) < 1.5,
      { raw: sitNow?.rawOffsetPx ?? null, offset: sitNow?.offsetPx ?? null, sitPoseGain: sitNow?.sitPoseGain ?? null },
    );
  }

  // 等坐姿停帧 + 微动包络起来（片段权重到 1），再验证"活着"
  await waitFor(window, 3000, (diagnostics) => (diagnostics?.sit?.blend ?? 0) >= 0.98);

  // ADR 0044/0045/0046：一次采样覆盖 呼吸 / 自主张望 / 眼球 / 晃腿 / 头部基准。
  // ADR 0049 D6：张望放慢到 5–9s 换向，采样窗口必须**长于一个周期**（21×250ms 只有 5.3s，
  // 会只看到一次目标），所以加到 45×250ms ≈ 11.3s。
  const samples: Array<{
    t: number;
    breath: number;
    gazeYaw: number;
    gazePitch: number;
    targetYaw: number;
    targetPitch: number;
    legGain: number;
    thighL: number;
    thighR: number;
    headPitch: number | null;
    headYaw: number | null;
    eyePitch: number | null;
    eyeYaw: number | null;
  }> = [];
  const samplingStartedAt = Date.now();
  for (let i = 0; i < 45; i += 1) {
    const d = await readDiagnostics(window);
    const m = d?.sit?.motion ?? null;
    if (m) {
      samples.push({
        t: Date.now() - samplingStartedAt,
        breath: m.breathPx,
        gazeYaw: m.gaze.yaw,
        gazePitch: m.gaze.pitch,
        targetYaw: m.gaze.targetYaw,
        targetPitch: m.gaze.targetPitch,
        legGain: m.legs.gain,
        thighL: m.legs.thighL,
        thighR: m.legs.thighR,
        headPitch: d?.sit?.headOrientation?.pitch ?? null,
        headYaw: d?.sit?.headOrientation?.yaw ?? null,
        eyePitch: d?.sit?.eyeOrientation?.pitch ?? null,
        eyeYaw: d?.sit?.eyeOrientation?.yaw ?? null,
      });
    }
    await sleep(250);
  }
  const sitAlive = await readDiagnostics(window);
  // ADR 0051：看镜头是张望池的一等目标（权重 1/3）。这里强制一次取证：
  // 目标必须是 yaw/pitch = 0（屏幕中心方向），而不是从随机范围里碰巧回到 0。
  await window.webContents.executeJavaScript(`window.diagnostics.forceSitGaze('camera')`, true);
  await sleep(80);
  const cameraGaze = (await readDiagnostics(window))?.sit?.motion?.gaze ?? null;
  check(
    '坐姿张望：存在"看镜头"目标（targetKind=camera、yaw/pitch≈0，权重 1/3，ADR 0051）',
    cameraGaze?.targetKind === 'camera' &&
      Math.abs(cameraGaze?.targetYaw ?? 1) < 1e-6 &&
      Math.abs(cameraGaze?.targetPitch ?? 1) < 1e-6,
    cameraGaze,
  );
  const rangeOf = (values: number[]): number =>
    values.length < 2 ? 0 : Math.max(...values) - Math.min(...values);
  const breathRange = rangeOf(samples.map((s) => s.breath));
  const thighRange = rangeOf(samples.map((s) => s.thighL));
  const targets = new Set(samples.map((s) => `${s.targetYaw.toFixed(3)}/${s.targetPitch.toFixed(3)}`));
  const maxAbsTargetYaw = Math.max(0, ...samples.map((s) => Math.abs(s.targetYaw)));
  const maxAbsTargetPitch = Math.max(0, ...samples.map((s) => Math.abs(s.targetPitch)));
  const maxLeg = Math.max(0, ...samples.map((s) => Math.abs(s.thighL)), ...samples.map((s) => Math.abs(s.thighR)));
  // 交替：两条腿各自当过"主导"（A 明显比 B 抬得高，反过来也出现过）
  const legAlternating =
    samples.some((s) => Math.abs(s.thighL) - Math.abs(s.thighR) > 0.02) &&
    samples.some((s) => Math.abs(s.thighR) - Math.abs(s.thighL) > 0.02);
  // 不对称（ADR 0045 D3）：任何一帧左右都不是镜像
  const legAsymmetric = samples.some(
    (s) => Math.abs(Math.abs(s.thighL) - Math.abs(s.thighR)) > 0.004,
  );
  const headPitches = samples.map((s) => s.headPitch).filter((v): v is number => v !== null);
  const headYaws = samples.map((s) => s.headYaw).filter((v): v is number => v !== null);
  const headPitchRange = rangeOf(headPitches);
  const headYawRange = rangeOf(headYaws);

  check(
    '坐姿：停在最后一帧（playHold 的 clamp；不是循环、也不会自己站回去，ADR 0044/0051）',
    sitAlive?.sit?.done === true &&
      sitAlive?.sit?.stage === 'b' &&
      Math.abs((sitAlive?.sit?.holdAtSeconds ?? 0) - 16.2) < 1e-9 &&
      sitAlive?.hfsm.physics === 'sitting' &&
      (sitAlive?.animation?.current?.name ?? '').includes('pastmemory'),
    { sit: sitAlive?.sit ?? null, current: sitAlive?.animation?.current ?? null },
  );
  check(
    '坐姿：不发声时嘴层是静态闭嘴（speech.frame=0、driven=false，ADR 0046 D3.2）',
    sitAlive?.speech.frame === 0 && sitAlive?.speech.driven === false,
    {
      speech: sitAlive?.speech ?? null,
      mouth: sitAlive?.facial?.channel?.mouth ?? null,
      owner: sitAlive?.facial?.mouthOwner ?? null,
      shape: sitAlive?.facial?.mouthShape ?? null,
    },
  );
  check(
    '坐姿：呼吸平缓（breathPx 在 5s 内有起伏，且 |breath| ≤ 1px，ADR 0044 D2）',
    breathRange > 0.15 && samples.every((s) => Math.abs(s.breath) <= 1.0001),
    { range: Number(breathRange.toFixed(3)), samples: samples.map((s) => Number(s.breath.toFixed(3))) },
  );
  // 真机问题三：张望不能像雷达。采样窗口 ~11.5s，足够覆盖一次 5–9s 的换向周期；
  // 额外统计"同一个目标连续保持多久"，验证到位后至少静止 2s（实测会到 4.5–8s）。
  let longestStillMs = 0;
  {
    let runStartT = samples[0]?.t ?? 0;
    let runKey = samples[0] ? `${samples[0].targetYaw.toFixed(3)}/${samples[0].targetPitch.toFixed(3)}` : '';
    for (let i = 1; i < samples.length; i += 1) {
      const key = `${samples[i]!.targetYaw.toFixed(3)}/${samples[i]!.targetPitch.toFixed(3)}`;
      if (key !== runKey) {
        longestStillMs = Math.max(longestStillMs, samples[i - 1]!.t - runStartT);
        runStartT = samples[i]!.t;
        runKey = key;
      }
    }
    if (samples.length > 0) {
      longestStillMs = Math.max(longestStillMs, samples[samples.length - 1]!.t - runStartT);
    }
  }
  check(
    '坐姿：张望放慢（5–9s 换向 + 到位后 ≥2s 静止；不是雷达扫描，ADR 0049 D6）',
    samples.length > 0 &&
      maxAbsTargetYaw <= 0.3601 &&
      maxAbsTargetPitch <= 0.2201 &&
      targets.size >= 2 &&
      longestStillMs >= 2000,
    {
      targets: [...targets].slice(0, 6),
      longestStillMs,
      windowMs: samples[samples.length - 1]?.t ?? 0,
      samples: samples.length,
    },
  );
  check(
    '坐姿：上半身照抄站立姿态（胸/颈/头已记录，阶段 B 覆盖权重 ≥0.95，ADR 0048/0051）',
    sitAlive?.sit?.idleUpperCaptured === true && (sitAlive?.sit?.upperOverride ?? 0) >= 0.95,
    {
      idleUpperCaptured: sitAlive?.sit?.idleUpperCaptured ?? null,
      upperOverride: sitAlive?.sit?.upperOverride ?? null,
      headTune: sitAlive?.sit?.headTune ?? null,
    },
  );
  check(
    '坐姿：头真的在转（头骨在观测窗口内摆动 ≥0.05rad，不是只动眼，ADR 0045 D2.2）',
    headYawRange + headPitchRange >= 0.05,
    {
      headYawRange,
      headPitchRange,
      totalRange: headYawRange + headPitchRange,
      samples: headYaws.slice(0, 8).map((v) => Number(v.toFixed(3))),
    },
  );
  check(
    '坐姿：悬空晃腿（左右交替、幅度 0.12–0.18rad、包络已开，ADR 0045 D3）',
    samples.some((s) => s.legGain > 0.9) &&
      legAlternating &&
      legAsymmetric &&
      maxLeg >= 0.12 &&
      maxLeg <= 0.1801 &&
      thighRange > 0.04,
    {
      maxLeg,
      thighRange: Number(thighRange.toFixed(3)),
      legAsymmetric,
      legGain: samples.at(-1)?.legGain ?? null,
    },
  );

  check(
    '坐姿：微侧身（bodyYaw ≈ 0.15rad，不再正面死板对镜头，ADR 0046 D3.1）',
    Math.abs((sitAlive?.sit?.bodyYaw ?? 0) - 0.15) <= 0.02,
    { bodyYaw: sitAlive?.sit?.bodyYaw ?? null },
  );

  // ADR 0046 D2：**停帧不再眨眼** —— 眼皮骨（bone_eye_D_*）的位移通道已整套删除。
  // 这里只留一条"眼骨旋转确实被接管"的结构级断言（位移通道不存在，写不出来）。
  check(
    '坐姿：不再手写眼皮位移（眼骨只走旋转基底覆写，ADR 0046 D2）',
    sitAlive?.sit?.motion?.eye !== undefined &&
      Number.isFinite(sitAlive?.sit?.motion?.eye?.pitch ?? Number.NaN),
    { eye: sitAlive?.sit?.motion?.eye ?? null },
  );

  const sitDone = sitAlive;

  // ADR 0044 D3：坐姿期间**关闭光标视线**——把光标挪到左上角，视线不应再被光标带走。
  const gazeBeforeCursor = sitAlive?.gaze?.yaw ?? 0;
  await window.webContents.executeJavaScript(
    'window.petRender.setCursor(8, 8, performance.now())',
    true,
  );
  await sleep(700);
  const cursorMoved = await readDiagnostics(window);
  check(
    '坐姿：不再跟随光标（gaze.update 在坐姿期间关闭，ADR 0044 D3）',
    cursorMoved?.hfsm.physics === 'sitting' &&
      cursorMoved?.sit?.motion !== null &&
      Math.abs((cursorMoved?.gaze?.yaw ?? 0) - gazeBeforeCursor) < 0.005,
    { before: gazeBeforeCursor, after: cursorMoved?.gaze ?? null },
  );

  // 活体微动取证：6 帧 / 约 1.2s 一帧，肉眼复核"自主转头 + 悬空晃腿"（ADR 0044 D3/D5）。
  for (let i = 0; i < 6; i += 1) {
    await captureScreenshot(window, `sit-alive-0${i}.png`, `sit-alive(${i})`);
    await sleep(1100);
  }
  await window.webContents.executeJavaScript(
    'window.petRender.setCursor(211, 360, performance.now())',
    true,
  );
  const sittingShot = await captureScreenshot(window, 'window-sitting.png', 'sitting');
  // ADR 0047 取证：**脸部特写**。正交相机缩到 260px 方框，眼睛在画面里从 ~14px
  // 变成 ~90px —— 只有这个尺寸才看得清"瞳孔朝上还是朝下"。
  const faceBox = await window.webContents.executeJavaScript(
    'window.diagnostics.faceZoom(260)',
    true,
  ) as { x: number; y: number; size: number } | null;
  await sleep(260);
  const faceShot = await captureScreenshot(window, 'face-sit.png', 'face-sit');
  // 对照实验：同一张脸 + EyeMouth 贴图上的绿色准星。
  // 准星 = 我们标定出来的**眼区几何中心**（不是瞳孔位置）。
  const probeInfo = await window.webContents.executeJavaScript(
    'window.diagnostics.eyeProbe(true)',
    true,
  ) as { eyeRects: Array<{ x: number; y: number; width: number; height: number }>; texture: { width: number; height: number } } | null;
  await sleep(260);
  const probeShot = await captureScreenshot(window, 'face-probe.png', 'face-probe');
  await window.webContents.executeJavaScript('window.diagnostics.eyeProbe(false)', true);
  await window.webContents.executeJavaScript('window.diagnostics.faceZoom(0)', true);
  check(
    '脸部特写：已产出（face-sit.png 正常 / face-probe.png 带眼区准星，ADR 0047）',
    faceShot.length > 0 &&
      probeShot.length > 0 &&
      (probeInfo?.eyeRects.length ?? 0) > 0 &&
      (faceBox?.size ?? 0) === 260,
    { faceBox, faceShot, probeShot, eyeRects: probeInfo?.eyeRects ?? null, texture: probeInfo?.texture ?? null },
  );
  // ADR 0047 取证 2：**头部俯仰 A/B**。同一张脸，只在头骨上叠一个额外的 pitch：
  // - face-sit-head-down：+0.25rad（≈ 片段自带的那份低头，即"没做抬头补偿"的样子）
  // - face-sit-head-up  ：-0.12rad（再多抬一点）
  // 用途：确定"瞳孔看起来朝下"到底是头抬得不够，还是抬过头（脸卡后仰、虹膜被压扁）。
  await window.webContents.executeJavaScript('window.diagnostics.faceZoom(260)', true);
  const headPitchShots: Array<{ pitch: number; png: string }> = [];
  for (const pitch of [0.25, -0.12]) {
    await window.webContents.executeJavaScript(
      `window.diagnostics.clear(); window.diagnostics.setBone('Bip001_Head', 0, ${pitch}, 0); true`,
      true,
    );
    await sleep(260);
    const png = await captureScreenshot(
      window,
      `face-sit-head-${pitch > 0 ? 'down' : 'up'}.png`,
      `face-sit-head(${pitch})`,
    );
    headPitchShots.push({ pitch, png });
  }
  await window.webContents.executeJavaScript('window.diagnostics.clear()', true);
  // ADR 0048 D2 取证 3：**头部微调扫描**。上半身已经照抄站立姿态，这里只拧"低头/抬头"，
  // 一次拍 5 档，肉眼挑一档写死进 `SIT_HEAD_TUNE_RAD`。
  const tuneShots: Array<{ tune: number; png: string }> = [];
  for (const tune of [-0.20, -0.10, 0, 0.10, 0.20]) {
    await window.webContents.executeJavaScript(`window.diagnostics.headTune(${tune})`, true);
    await sleep(180);
    const png = await captureScreenshot(
      window,
      `face-tune-${tune >= 0 ? 'p' : 'm'}${Math.abs(tune * 100).toFixed(0)}.png`,
      `face-tune(${tune})`,
    );
    tuneShots.push({ tune, png });
  }
  await window.webContents.executeJavaScript(`window.diagnostics.headTune(${SIT_HEAD_TUNE_RAD})`, true);
  await window.webContents.executeJavaScript('window.diagnostics.faceZoom(0)', true);
  check(
    '脸部特写：坐姿头部微调扫描已产出（face-tune-*.png 五档，ADR 0048 D2）',
    tuneShots.length === 5,
    { shots: tuneShots, applied: SIT_HEAD_TUNE_RAD },
  );
  // ADR 0046 D3.2 取证：停帧姿态下把嘴型钉在 0 / 7 / 14 / 2 各截一帧。
  // 身体是静止的（playHold），四张图的差异只来自嘴 —— 用来肉眼确认"哪一帧真的像闭嘴"。
  const mouthSitShots: Array<{ frame: number; png: string }> = [];
  for (const frame of [0, 7, 14, 2]) {
    await window.webContents.executeJavaScript(`window.petRender.setMouthFrame(${frame})`, true);
    await sleep(90);
    const png = await captureScreenshot(window, `mouth-sit-${frame}.png`, `mouth-sit(${frame})`);
    mouthSitShots.push({ frame, png });
  }
  await window.webContents.executeJavaScript('window.petRender.resetMouthFrame()', true);
  check(
    '截图：停帧嘴型取证已产出（0 / 7 / 14 / 2 四帧，dist/selftest/mouth-sit-*.png）',
    mouthSitShots.length === 4,
    { shots: mouthSitShots },
  );
  // 桌面抓取（desktopCapturer）在合成透明置顶窗口时可能拿到稍早的一帧：
  // 先等坐姿停稳，再抓一次；两次写同一路径，后一次覆盖（只是验收证据，不参与断言）。
  await sleep(1500);
  const desktopShot = await captureDesktop('window-sitting-desktop.png');
  check(
    '截图：桌面合成图已产出（她坐在记事本窗口下边缘，ADR 0028 验收）',
    desktopShot !== null,
    { sittingShot, desktopShot },
  );
  // ADR 0043 D2：截图（含 ~1.5s 的桌面抓取）之后她必须**还在坐姿循环里**，
  // 而不是像旧实现那样停在末帧（也不是自己站回去）。
  const afterDesktop = await readDiagnostics(window);
  check(
    '吸附：截图之后仍停在最后一帧（done=true、physics=sitting，不会自己站回去）',
    afterDesktop?.sit?.done === true &&
      afterDesktop?.hfsm.physics === 'sitting' &&
      (afterDesktop?.animation?.current?.name ?? '').includes('pastmemory'),
    {
      after: afterDesktop?.animation?.current ?? null,
      sit: afterDesktop?.sit ?? null,
    },
  );

  // 头骨稳定性（真机 bug 回归）：坐姿 1s 内头骨本地四元数不得**持续累积**漂移。
  // 之前"头疯狂打转"实测 2.51 rad/s，就是这个量在累积（骨骼仲裁把上一帧偏移当新基底）。
  // ADR 0043 起坐姿是活的（片段循环 + 视线微动），所以阈值放到 0.6 rad —— 它只拦"发散"。
  const headA = afterDesktop?.sit?.headQuat ?? null;
  await sleep(1000);
  const headDiag = await readDiagnostics(window);
  const headB = headDiag?.sit?.headQuat ?? null;
  const headDriftRad =
    headA && headB
      ? 2 *
        Math.acos(
          Math.min(
            1,
            Math.abs(headA[0] * headB[0] + headA[1] * headB[1] + headA[2] * headB[2] + headA[3] * headB[3]),
          ),
        )
      : Number.NaN;
  check(
    '坐姿：1s 内头骨不累积漂移（回归"头在打转"，≤0.6 rad；活体微动不算）',
    Number.isFinite(headDriftRad) && headDriftRad <= 0.6,
    { headA, headB, headDriftRad, headBase: headDiag?.sit?.headBase ?? null, headWorld: headDiag?.sit?.headWorld ?? null },
  );

  // ------------------------------------------------------------------
  // 3.8.5) ADR 0049 D1：sitting 微动作池（晃腿 / 低头看手 / 抬头看远处）
  //
  // 与 idle 池同一套抽签逻辑，但条目不同：三条断言——
  // ① 压缩到 650ms 后 2.6s 内换过 ≥2 个条目（不是固定循环）；
  // ② 交叉淡入淡出（100ms 采样权重跳变 < 0.5）；
  // ③ 两个变奏真的落到头骨俯仰：低头看手（正）比抬头看远处（负）大 ≥0.15rad。
  // ------------------------------------------------------------------
  await window.webContents.executeJavaScript(
    `window.diagnostics.setMicroPoolInterval('sit', 650, 650)`,
    true,
  );
  const sitPoolSeries = JSON.parse(
    (await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const rows = [];
        const startedAt = performance.now();
        const tick = () => {
          const pool = window.diagnostics.microPool().sit;
          if (pool) rows.push({ t: performance.now() - startedAt, ...pool });
          if (performance.now() - startedAt < 2600) setTimeout(tick, 100);
          else resolve(JSON.stringify(rows));
        };
        tick();
      })`,
      true,
    )) as string,
  ) as Array<{ t: number; active: string; weights: Record<string, number>; switches: number }>;
  const sitPoolLast = sitPoolSeries[sitPoolSeries.length - 1] ?? null;
  const sitPoolKinds = new Set(sitPoolSeries.map((row) => row.active));
  let sitPoolMaxStep = 0;
  for (let i = 1; i < sitPoolSeries.length; i += 1) {
    for (const kind of ['legs', 'hands', 'far']) {
      sitPoolMaxStep = Math.max(
        sitPoolMaxStep,
        Math.abs(
          (sitPoolSeries[i]!.weights[kind] ?? 0) - (sitPoolSeries[i - 1]!.weights[kind] ?? 0),
        ),
      );
    }
  }
  check(
    'sitting 微动作池：随机抽签在 2.6s 内换过 ≥2 个条目（不是固定循环，ADR 0049 D1）',
    (sitPoolLast?.switches ?? 0) >= 2 && sitPoolKinds.size >= 2,
    { switches: sitPoolLast?.switches ?? null, kinds: [...sitPoolKinds] },
  );
  check(
    'sitting 微动作池：条目之间平滑交叉（100ms 采样权重跳变 < 0.5，不是瞬切）',
    sitPoolMaxStep > 0 && sitPoolMaxStep < 0.5,
    { maxStep: Number(sitPoolMaxStep.toFixed(3)), samples: sitPoolSeries.length },
  );

  // 变奏 A：低头看手（头/颈/眼向下，晃腿停下）
  await window.webContents.executeJavaScript(
    `window.diagnostics.forceMicroPool('sit', 'hands')`,
    true,
  );
  await sleep(900);
  const handsDiag = await readDiagnostics(window);
  const handsPitch = handsDiag?.sit?.headOrientation?.pitch ?? 0;
  const handsShot = await captureScreenshot(window, 'sit-micro-hands.png', 'sit-micro-hands');

  // 变奏 B：抬头看远处（头/眼抬起，晃腿放慢到三成）
  await window.webContents.executeJavaScript(
    `window.diagnostics.forceMicroPool('sit', 'far')`,
    true,
  );
  await sleep(900);
  const farDiag = await readDiagnostics(window);
  const farPitch = farDiag?.sit?.headOrientation?.pitch ?? 0;
  const farShot = await captureScreenshot(window, 'sit-micro-far.png', 'sit-micro-far');

  check(
    'sitting 微动作池：低头看手 vs 抬头看远处（头骨俯仰差 ≥0.15rad，ADR 0049 D1）',
    handsPitch - farPitch >= 0.15,
    {
      handsPitch,
      farPitch,
      delta: Number((handsPitch - farPitch).toFixed(4)),
      handsShot,
      farShot,
    },
  );

  // 恢复：回到默认条目 `legs`、解除强制、把间隔还原成生产的 15–30s
  await window.webContents.executeJavaScript(
    `window.diagnostics.forceMicroPool('sit', 'legs')`,
    true,
  );
  await sleep(500);
  await window.webContents.executeJavaScript(
    `window.diagnostics.forceMicroPool('sit', null); window.diagnostics.setMicroPoolInterval('sit', 15000, 30000)`,
    true,
  );

  // ------------------------------------------------------------------
  // ADR 0043 取证：落座过渡逐帧抓图（12 帧）。
  //
  // 这一轮**故意让窗口不动**：先解除坐姿、再在原地重新吸附（距离 ≤8px → 直接 commit，
  // 没有接近阶段）。这样截图里只剩"姿态交叉淡入 + 身体平移补偿"这一件事——
  // 正是上一版"snap_applied 瞬间硬套 265px 补偿 → 模型瞬移出框"的现场。
  // 窗口移动的那部分另有 window-walking.png / window-sitting-desktop.png 作证。
  // ------------------------------------------------------------------
  shell.releaseSnap();
  await waitFor(window, 3000, (diagnostics) => diagnostics?.hfsm.physics === null);
  // 等坐姿混合权重退到 0（0.35s 淡出 + 余量），否则下一轮起点不是"站着"
  await sleep(600);
  pushScriptedForeground(dipRectToPhysical(notepad.getBounds()));
  await sleep(160);
  const sequenceFrames: string[] = [];
  // 第 1 遍：只抓图。`getDiagnostics()` 单次约 300ms（含面部贴图摘要），
  // 混进循环里会把采样间隔拉到 400ms，抓不到 240ms 的半蹲——所以图与数字分开采。
  shell.snapToForeground();
  for (let step = 0; step < 12; step += 1) {
    const shot = await captureScreenshot(
      window,
      `sit-step-${String(step).padStart(2, '0')}.png`,
      `sit-sequence(${step})`,
    );
    sequenceFrames.push(shot);
    await sleep(20);
  }
  check('坐姿：落座过渡已逐帧取证（12 帧，dist/selftest/sit-step-*.png）', sequenceFrames.length >= 10, {
    frames: sequenceFrames.length,
    first: sequenceFrames[0] ?? null,
    last: sequenceFrames[sequenceFrames.length - 1] ?? null,
  });

  // 第 2 遍：同样的"原地重新落座"，只采数字（每次读诊断 ~300ms，正好均匀覆盖 1.2s）。
  // ADR 0043 D3 要证明的两件事：① 补偿 = 原始补偿 × 混合权重；② 头骨世界 x 连续、不发散。
  const sequenceTrace: Array<{
    step: number;
    blend: number | null;
    poseGain: number | null;
    offsetX: number | null;
    rawOffsetX: number | null;
    headX: number | null;
    physics: string | null;
    arrived: boolean | null;
  }> = [];
  shell.releaseSnap();
  await waitFor(window, 3000, (diagnostics) => diagnostics?.hfsm.physics === null);
  await sleep(600);
  shell.snapToForeground();
  for (let step = 0; step < 4; step += 1) {
    const trace = await readDiagnostics(window);
    sequenceTrace.push({
      step,
      blend: trace?.sit?.blend ?? null,
      poseGain: trace?.sit?.sitPoseGain ?? null,
      offsetX: trace?.sit?.offsetPx?.x ?? null,
      rawOffsetX: trace?.sit?.rawOffsetPx?.x ?? null,
      headX: trace?.sit?.headWorld?.x ?? null,
      physics: trace?.hfsm.physics ?? null,
      arrived: trace?.sit?.arrived ?? null,
    });
    await sleep(120);
  }
  {
    const heads = sequenceTrace
      .map((item) => item.headX)
      .filter((value): value is number => typeof value === 'number');
    let maxStep = 0;
    for (let i = 1; i < heads.length; i += 1) {
      maxStep = Math.max(maxStep, Math.abs(heads[i]! - heads[i - 1]!));
    }
    const scaledOk = sequenceTrace.every((item) => {
      if (typeof item.poseGain !== 'number' || typeof item.offsetX !== 'number' || typeof item.rawOffsetX !== 'number') {
        return false;
      }
      return Math.abs(item.offsetX - item.rawOffsetX * item.poseGain) < 2;
    });
    check(
      '坐姿：落座过程连续且补偿按 sitGain×sitDrop 缩放（头骨 x 跳变 < 40px、offset ≈ raw×poseGain，ADR 0043/0051）',
      heads.length >= 3 && maxStep < 40 && scaledOk,
      { trace: sequenceTrace, maxStepPx: Number(maxStep.toFixed(1)), scaledOk },
    );
  }

  // 跟随：目标窗口移动 → 她在同一个 16ms 轮询器里跟着走（节流 120ms）
  const notepadMoved = {
    x: notepadBounds.x + 90,
    y: notepadBounds.y + 24,
    width: notepadBounds.width,
    height: notepadBounds.height,
  };
  notepad.setBounds(notepadMoved);
  pushScriptedForeground(dipRectToPhysical(notepadMoved));
  const expectedEdge = notepadMoved.y + notepadMoved.height;
  let followedBounds = shell.getBounds();
  const followDeadline = Date.now() + 3000;
  while (Date.now() < followDeadline) {
    followedBounds = shell.getBounds();
    if (Math.abs(followedBounds.y + followedBounds.height - expectedEdge) <= 8) break;
    await sleep(80);
  }
  check(
    '吸附：目标窗口移动后跟着走（ADR 0028 D6，复用唯一 16ms 轮询器）',
    Math.abs(followedBounds.y + followedBounds.height - expectedEdge) <= 8 &&
      followedBounds.y !== seatedBounds.y,
    { before: seatedBounds, after: followedBounds, target: notepadMoved },
  );
  // ADR 0042 D2：目标在动的那几拍里，跟随必须进"追赶模式"（每 tick 重算，
  // 而不是 8Hz）；目标停下后自动回落到 120ms 节流。
  check(
    '吸附：目标移动期间进入跟随追赶模式（catchUpTicks ≥ 1，ADR 0042 D2）',
    (shell.snapSnapshot()?.catchUpTicks ?? 0) >= 1,
    shell.snapSnapshot(),
  );

  // 解除 1：点她一下 → 立即离开窗口边缘、站回 Idle
  const clickPoint = await findCurrentHitPoint(window);
  current = window.getContentBounds();
  const clickX = clickPoint?.x ?? body.x;
  const clickY = clickPoint?.y ?? body.y;
  pushScriptedCursor(current.x + clickX, current.y + clickY);
  await sleep(340);
  await dispatchPointer('down', clickX, clickY);
  await sleep(60);
  await dispatchPointer('up', clickX, clickY);
  const clickedOff = await waitFor(window, 3000, (diagnostics) => diagnostics?.hfsm.physics === null);
  check(
    '解除：点她一下 → Physics 退出、回到 idle（ADR 0028 D9）',
    clickedOff?.hfsm.physics === null &&
      clickedOff?.sit?.sitting === false &&
      shell.snapSnapshot()?.sitting === false,
    { hfsm: clickedOff?.hfsm ?? null, sit: clickedOff?.sit ?? null },
  );
  // `startle` 只活 120ms（clicked），而 `getDiagnostics()` 单次约 300ms —— 轮询到的
  // 那一帧很可能已经清空（历史偶发假失败）。因此同时接受渲染侧"坐姿结束 reason=clicked"
  // 这条稳定事实：该分支在设置 startle 的同一函数里，日志在就说明惊跳一定被排过。
  const clickedStandLog = (await runLogText()).includes('sitting 结束 reason=clicked');
  check(
    '解除：clicked 播放短促惊跳/起身（ADR 0034 D5）',
    clickedOff?.drag?.startle === 'clicked' ||
      clickedOff?.drag?.startle === 'command' ||
      clickedStandLog,
    { startle: clickedOff?.drag?.startle ?? null, clickedStandLog },
  );
  const clickReleaseLog = lastJsonAfter(await runLogText(), '吸附解除（ADR 0028 D9）');
  check(
    '解除：snap_released{reason:clicked} 已发出',
    clickReleaseLog?.['reason'] === 'clicked',
    clickReleaseLog,
  );

  // 解除 2：拖走她 → sitting 被 dragged 打断
  const resnap = shell.snapToForeground();
  check('重新吸附：可以再吸一次（旧目标不残留）', resnap?.ok === true, resnap ?? null);
  await waitFor(window, 3000, (diagnostics) => diagnostics?.hfsm.physics === 'sitting');
  // 等坐姿循环真正接管（权重到 1）。ADR 0043 起坐姿是**活的**（片段循环 + 呼吸 + 视线），
  // 掩膜本来就逐帧微动；这里只要保证"已经稳定坐下"，命中点由 `findCurrentHitPoint` 现场扫描。
  await waitFor(window, 3000, (diagnostics) => (diagnostics?.sit?.blend ?? 0) >= 0.98);
  await sleep(400);
  const sitPoint = await findCurrentHitPoint(window);
  check('吸附：坐姿下掩膜仍能命中她（探针随姿态变化）', sitPoint !== null, sitPoint);
  current = window.getContentBounds();
  const grabX = sitPoint?.x ?? body.x;
  const grabY = sitPoint?.y ?? body.y;
  pushScriptedCursor(current.x + grabX, current.y + grabY);
  await sleep(340);
  await dispatchPointer('down', grabX, grabY);
  await sleep(50);
  pushScriptedCursor(current.x + grabX + 70, current.y + grabY + 8);
  await sleep(180);
  const draggedOff = await readDiagnostics(window);
  check(
    '解除：拖走她 → Physics=dragged（sitting 被打断，ADR 0028 D9）',
    draggedOff?.hfsm.physics === 'dragged' && shell.snapSnapshot()?.sitting === false,
    { hfsm: draggedOff?.hfsm ?? null, snap: shell.snapSnapshot(), sitPoint },
  );
  await dispatchPointer('up', grabX, grabY);
  await waitFor(window, 4000, (diagnostics) => diagnostics?.hfsm.physics === null);
  resetScriptedCursor();
  await sleep(200);

  // 拒绝：前台全屏（游戏/视频）→ 不吸附 + 提示
  notepad.setBounds({ x: 0, y: 0, width: display.bounds.width, height: display.bounds.height });
  pushScriptedForeground(
    dipRectToPhysical({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    }),
  );
  await sleep(600);
  const refuseBaseline = await countInLog('吸附被拒绝');
  const refused = shell.snapToForeground();
  check(
    '拒绝：前台全屏（游戏/视频）→ 不吸附（ADR 0028 D3）',
    refused?.ok === false && refused.reason === 'fullscreen',
    refused ?? null,
  );
  check(
    '拒绝：给出用户可见提示（吸附被拒绝 + 托盘气泡，ADR 0028 D3）',
    (await countInLog('吸附被拒绝')) > refuseBaseline,
    { refuseBaseline },
  );

  // 解除 3：目标窗口被关掉 → 跟随轮询发现句柄失效 → 自动解除
  notepad.setBounds(notepadMoved);
  pushScriptedForeground(dipRectToPhysical(notepadMoved));
  await sleep(300);
  const restorable = shell.snapToForeground();
  check('吸附：全屏窗口恢复普通尺寸后可再次吸附', restorable?.ok === true, restorable ?? null);
  await waitFor(window, 3000, (diagnostics) => diagnostics?.hfsm.physics === 'sitting');
  // "目标窗口被关掉"：句柄失效（脚本化前台置空，等价于 IsWindow 返回 false）
  pushScriptedForeground(null);
  // 惊跳只有 320ms：必须**在等待解除的同时**轮询抓它，不能等 physics 归零后再读一次
  const startleSeen = await waitFor(window, 2500, (diagnostics) => diagnostics?.drag?.startle === 'window-gone');
  await sleep(700);
  const closedOff = await waitFor(window, 3000, (diagnostics) => diagnostics?.hfsm.physics === null);
  const closedLog = lastJsonAfter(await runLogText(), '吸附解除（ADR 0028 D9）');
  check(
    '解除：目标窗口被关闭 → 自动解除（reason=window-gone，ADR 0028 D9）',
    shell.snapSnapshot()?.sitting === false &&
      closedOff?.hfsm.physics === null &&
      closedLog?.['reason'] === 'window-gone',
    { hfsm: closedOff?.hfsm ?? null, snap: shell.snapSnapshot(), closedLog },
  );

  // ADR 0042 D4：窗沿消失后她脚下没有东西 → 必须落回工作区地面线（复用回弹弹簧）。
  let fallenBounds = shell.getBounds();
  {
    const fallDeadline = Date.now() + 5000;
    while (Date.now() < fallDeadline) {
      fallenBounds = shell.getBounds();
      if (shell.motionSnapshot()?.kind === 'idle') break;
      await sleep(80);
    }
  }
  const fallArea = workAreaFor(fallenBounds);
  const fallGroundY = fallArea.y + fallArea.height - fallenBounds.height;
  const fallDiag = await readDiagnostics(window);
  check(
    '解除：窗沿消失后落回桌面地面线（±8px，ADR 0042 D4）',
    shell.motionSnapshot()?.kind === 'idle' && Math.abs(fallenBounds.y - fallGroundY) <= 8,
    { y: fallenBounds.y, groundY: fallGroundY, motion: shell.motionSnapshot() },
  );
  // `startle` 只活 320ms，`waitFor` 的单次 `getDiagnostics()` 约 300ms —— 轮询可能整段错过
  // （历史偶发假失败，2026-11-05 复现）。渲染侧 `sitting 结束 reason=window-gone` 与设置
  // startle 在同一个函数里，日志在就说明惊跳一定被排过。
  const windowGoneStandLog = (await runLogText()).includes('sitting 结束 reason=window-gone');
  check(
    '解除：窗沿消失时先播惊跳（startle=window-gone，ADR 0034 D5 / ADR 0042 D4）',
    startleSeen?.drag?.startle === 'window-gone' || windowGoneStandLog,
    { startle: startleSeen?.drag?.startle ?? closedOff?.drag?.startle ?? null, windowGoneStandLog },
  );
  check(
    '解除：落下按"轻放"处理（不伪造冲击 → landingImpact 不触发，ADR 0040 D3 口径）',
    (fallDiag?.drag?.landingImpact ?? 0) === 0 && (fallDiag?.drag?.landingSquash ?? 1) === 0,
    fallDiag?.drag ?? null,
  );
  shell.releaseSnap();
  resetScriptedForeground();
  if (!notepad.isDestroyed()) notepad.destroy();
  await sleep(200);

  // ------------------------------------------------------------------
  // 3.8 Emotion → 面部贴图（ADR 0026 D2/D3/D4）
  //     自检直接把 intent_resolved 注入渲染页（生产路径是主进程广播），
  //     断言"图元映射 + 贴图真的变了（截图像素差）+ 情绪结束回 neutral"。
  // ------------------------------------------------------------------
  // 先把行走调度推到很远的将来：否则 1.5–2s 的间隔会在截图期间再次起走，
  // 角色转身 / 窗口位移会让"同一区域的前后像素差"失去意义。
  await window.webContents.executeJavaScript(
    `window.petRender.setWalkInterval(600000, 600001)`,
    true,
  );
  await waitFor(window, 6000, (diagnostics) => diagnostics?.motion.base === 'idle');
  await waitFor(window, 2000, (diagnostics) => Math.abs(diagnostics?.motion.walkYaw ?? 1) < 0.02);
  await waitFor(window, 2000, (diagnostics) => diagnostics?.facial?.repaints !== undefined);
  const neutralDiag = await readDiagnostics(window);
  const neutralShot = await captureToImage(window, 'window-emotion-neutral.png');
  // 噪声底：Idle 动画 + 视线漂移会让"同一状态的两张截图"天然有差异。
  // 恢复断言必须与这个噪声底比较，否则会把姿势抖动误判成"贴图没恢复"。
  const neutralNoiseShot = await captureToImage(window, 'window-emotion-neutral-b.png');
  check(
    '表情：贴图通道已标定（眼睛 + 嘴 + 红晕三层都可用）',
    neutralDiag?.facial?.channel?.calibrated === true &&
      neutralDiag?.facial?.channel?.eyeCalibrated === true &&
      neutralDiag?.facial?.blushChannel?.calibrated === true,
    neutralDiag?.facial?.channel ?? null,
  );

  const content = window.getContentBounds();
  const scale = neutralShot.image.getSize().width / Math.max(1, content.width);
  const face = faceRegion(neutralDiag, content);
  const faceRect = {
    x: face.x * scale,
    y: face.y * scale,
    width: face.width * scale,
    height: face.height * scale,
  };

  const emotionCases = [
    { emotion: 'happy', eyes: 'happy', mouth: 'smile', blush: 1, file: 'window-emotion-happy.png' },
    { emotion: 'shy', eyes: 'shy', mouth: 'small', blush: 2, file: 'window-emotion-shy.png' },
    { emotion: 'sad', eyes: 'sad', mouth: 'frown', blush: 0, file: 'window-emotion-sad.png' },
    { emotion: 'surprised', eyes: 'surprised', mouth: 'open', blush: 0, file: 'window-emotion-surprised.png' },
  ] as const;

  const emotionChanged: Record<string, number> = {};
  const emotionDigests: Record<string, string> = {};
  const neutralDigest = neutralDiag?.facial?.channel?.textureDigest ?? null;
  const neutralBlushDigest = neutralDiag?.facial?.blushChannel?.textureDigest ?? null;
  const neutralDistance = neutralDiag?.facial?.channel?.faceDistance ?? 1;
  const emotionDistances: Record<string, number> = {};
  const emotionBlush: Record<string, number> = {};
  const loadedEyes = neutralDiag?.facial?.assets?.loadedEyes ?? [];
  const blushLoaded = neutralDiag?.facial?.assets?.blushLoaded === true;
  check(
    '表情：基线贴图有指纹（贴图级断言的前提）',
    typeof neutralDigest === 'string' && neutralDigest.length === 8,
    { digest: neutralDigest, blushDigest: neutralBlushDigest },
  );
  const missingAssets = neutralDiag?.facial?.assets?.missing ?? [];
  check(
    '表情：差分加载结果自洽（已加载 + missing = 4 张眼型 + 1 张红晕）',
    loadedEyes.length + (blushLoaded ? 1 : 0) + missingAssets.length === 5,
    { loadedEyes, blushLoaded, missing: missingAssets },
  );

  // 淡入必须真的存在（§5.2 / 任务要求"不能瞬间闪现"）：切到 happy 后 60ms 读一次，
  // 此时 alpha 应处于 (0,1) 且 fading=true（0.25s 淡入的第 1–2 个量化步）。
  await pushEmotion(window, 'happy');
  await sleep(60);
  const midFade = await readDiagnostics(window);
  check(
    '表情：切换是淡入而非瞬间闪现（60ms 时 alpha < 1 且 fading=true）',
    (midFade?.facial?.alpha ?? 1) < 1 && midFade?.facial?.fading === true,
    { alpha: midFade?.facial?.alpha ?? null, fading: midFade?.facial?.fading ?? null },
  );

  for (const item of emotionCases) {
    await pushEmotion(window, item.emotion);
    const settled = await waitFor(
      window,
      3000,
      (diagnostics) =>
        diagnostics?.facial?.effective === item.emotion &&
        (diagnostics?.facial?.alpha ?? 0) >= 1 &&
        typeof diagnostics?.facial?.channel?.textureDigest === 'string',
    );
    check(
      `表情 ${item.emotion}：映射为 eyes=${item.eyes} / mouth=${item.mouth} / blush=${item.blush}`,
      settled?.facial?.effective === item.emotion &&
        settled?.facial?.eyes === item.eyes &&
        settled?.facial?.mouthShape === item.mouth &&
        settled?.facial?.blush === item.blush,
      settled?.facial ?? null,
    );

    // 贴图级证据：与"首次绘制基线"的平均绝对差（不受 Idle 动画/视线漂移影响）
    const distance = settled?.facial?.channel?.faceDistance ?? 0;
    const blushDistance = settled?.facial?.blushChannel?.faceDistance ?? 1;
    const digest = settled?.facial?.channel?.textureDigest ?? null;
    if (digest) emotionDigests[item.emotion] = digest;
    emotionDistances[item.emotion] = distance;
    emotionBlush[item.emotion] = blushDistance;

    const eyeAvailable = loadedEyes.includes(item.eyes);
    if (eyeAvailable) {
      // 有官方眼型差分：贴图必须真的变了（至少 1% 的缩略图差异）
      check(
        `表情 ${item.emotion}：眼型差分已贴到眼部 UV（贴图平均差 ≥1%）`,
        distance >= EMOTION_DISTANCE_MIN,
        { emotion: item.emotion, distance, threshold: EMOTION_DISTANCE_MIN, neutralDistance },
      );
    } else {
      // 没有官方眼型差分 → 降级：不覆盖眼睛，只可能由嘴型帧带来极小差异。
      // 注意：嘴型帧之间可能**完全一致**（同一张图集里形状相近的帧），
      // 所以这里断言的是"差异不超过眼型量级"，而不是"必须有差异"。
      check(
        `表情 ${item.emotion}：缺差分 → 降级为不覆盖眼型（贴图差异 < 眼型量级）`,
        distance < EMOTION_DISTANCE_MIN,
        { emotion: item.emotion, distance, upperBound: EMOTION_DISTANCE_MIN },
      );
    }

    if (item.blush > 0 && blushLoaded) {
      check(
        `表情 ${item.emotion}：红晕层与基线有差异（blush=${item.blush}）`,
        blushDistance >= BLUSH_DISTANCE_MIN,
        { emotion: item.emotion, blushDistance, threshold: BLUSH_DISTANCE_MIN },
      );
    } else if (item.blush > 0) {
      check(`表情 ${item.emotion}：缺红晕图 → 不叠加（降级）`, blushDistance <= BLUSH_RESTORE_MAX, {
        emotion: item.emotion,
        blushDistance,
      });
    } else {
      check(
        `表情 ${item.emotion}：无红晕时红晕层回到基线`,
        blushDistance <= BLUSH_RESTORE_MAX,
        { emotion: item.emotion, blushDistance, threshold: BLUSH_RESTORE_MAX },
      );
    }

    const shot = await captureToImage(window, item.file);
    const diff = diffRegion(neutralShot.image, shot.image, faceRect);
    emotionChanged[item.emotion] = diff.changed;
    check(
      `表情 ${item.emotion}：截图可见面部变化（≥60 px，且只动脏矩形）`,
      diff.changed >= 60,
      { emotion: item.emotion, changed: diff.changed, total: diff.total, file: shot.pngPath },
    );
    logInfo('selftest', 'capture', { emotion: item.emotion, pngPath: shot.pngPath, changed: diff.changed });
  }

  // 有官方眼型差分时，四种情绪必须给出四种不同的贴图（不是"切换了但画得一样"）；
  // 缺差分时按降级口径：只变嘴型，允许指纹重合（图集帧可能相同）。
  const distinctDigests = new Set(Object.values(emotionDigests));
  const allEyesAvailable = emotionCases.every((item) => loadedEyes.includes(item.eyes));
  check(
    allEyesAvailable
      ? '表情：四种情绪的贴图指纹互不相同'
      : '表情：缺差分时降级（不强制四种贴图互不相同）',
    allEyesAvailable ? distinctDigests.size === emotionCases.length : true,
    { digests: emotionDigests, distinct: distinctDigests.size, allEyesAvailable },
  );
  // 红晕强度分级：有红晕图时 shy(2) 必须比 happy(1) 更明显；没有红晕图时两层都必须是 0
  if (blushLoaded) {
    check(
      '表情：红晕强度分级（shy 的贴图差 > happy）',
      (emotionBlush.shy ?? 0) > (emotionBlush.happy ?? 1),
      { blushDistances: emotionBlush },
    );
  } else {
    check(
      '表情：缺红晕图 → 所有 emotion 都不叠红晕（降级）',
      Object.values(emotionBlush).every((value) => value <= BLUSH_RESTORE_MAX),
      { blushDistances: emotionBlush },
    );
  }

  // 口型优先于表情（§5.2）：说话时嘴层必须让位给图集帧
  const speakingOverride = await waitFor(
    window,
    1500,
    (diagnostics) => diagnostics?.facial?.mouthOwner === 'emotion',
  );
  check(
    '表情：非说话时嘴层归表情（mouthOwner=emotion）',
    speakingOverride?.facial?.mouthOwner === 'emotion',
    speakingOverride?.facial ?? null,
  );

  // 情绪结束 → 回 neutral（贴图恢复原样）
  await pushEmotion(window, 'neutral');
  const backToNeutral = await waitFor(
    window,
    3000,
    (diagnostics) =>
      diagnostics?.facial?.effective === 'neutral' && diagnostics?.facial?.eyes === null,
  );
  check(
    '表情：neutral 后图元清空（eyes=null / blush=0）',
    backToNeutral?.facial?.eyes === null && backToNeutral?.facial?.blush === 0,
    backToNeutral?.facial ?? null,
  );
  const neutralAgain = await captureToImage(window, 'window-emotion-neutral-again.png');
  const neutralDiff = diffRegion(neutralShot.image, neutralAgain.image, faceRect);
  const noise = diffRegion(neutralShot.image, neutralNoiseShot.image, faceRect);
  // 贴图级断言（确定性）：恢复 neutral 后两张贴图的指纹必须**完全等于**基线指纹。
  // 截图差只作为"人眼可见"的旁证——它受 Idle 动画/视线漂移影响，噪声底实测约 6000/84864。
  const restoredDistance = backToNeutral?.facial?.channel?.faceDistance ?? 1;
  const restoredBlushDistance = backToNeutral?.facial?.blushChannel?.faceDistance ?? 1;
  check(
    '表情：恢复 neutral 后贴图回到基线（平均差 ≤0.2%）',
    restoredDistance <= NEUTRAL_RESTORE_MAX && restoredBlushDistance <= BLUSH_RESTORE_MAX,
    {
      distance: restoredDistance,
      blushDistance: restoredBlushDistance,
      threshold: NEUTRAL_RESTORE_MAX,
      neutralDistance,
      emotionDistances,
      neutralDigest,
      neutralBlushDigest,
    },
  );
  // 这里**不再**用截图差断言「已还原」：截图差被 Idle 动画与视线漂移主导（噪声底实测 5–6k/84864），
  // 而「未还原」的量级随素材变化（fixture 只换一眼时约 20k），两者边界不清、会偶发失败（实测踩过）。
  // 真正确定性的判据是上面那条贴图平均差（恢复后精确为 0），这里只记录数值供人眼核对。
  logInfo('selftest', 'emotion-restore', {
    changed: neutralDiff.changed,
    noiseFloor: noise.changed,
    total: neutralDiff.total,
    emotionDiffs: emotionChanged,
  });

  // ------------------------------------------------------------------
  // 4) orchestrator + voice 降级链路
  //    本轮自检把 PET_LLM_URL / PET_TTS_URL 指到确定无人监听的端口（scripts/start.mjs），
  //    所以这里断言的是"服务不可用时必然可用的行为"，不依赖用户机器上装了什么。
  // ------------------------------------------------------------------
  const runtimeSnapshot = getRuntime()?.snapshot() ?? null;
  // 本机 .env 可能配了 TTS（PET_TTS_URL），所以这里不假设"未配置"，
  // 只断言成本红线：端点必须是回环地址（§10.2）。真正的降级由下面三条断言覆盖
  // （speech_ended{failed} / 没有 speech_started / 字幕可见）。
  check(
    '降级装配：TTS 端点为回环地址（§10.2 成本红线）',
    runtimeSnapshot !== null &&
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/.test(runtimeSnapshot.tts.baseUrl),
    runtimeSnapshot?.tts ?? null,
  );
  check(
    '降级装配：台词池与兜底集合已加载（§9.1 ③）',
    (runtimeSnapshot?.data.ruleCount ?? 0) >= 5 && (runtimeSnapshot?.data.fallbackCount ?? 0) >= 3,
    runtimeSnapshot?.data ?? null,
  );

  const speechStartedBaseline = await countInLog('speech_started');
  const speechFailedBaseline = await countInLog('speech_ended failed');

  await submitUtterance(window, '你好');
  const utteranceLog = await waitForLogJson(
    'user_utterance 发出（§6.3）',
    (json) => typeof json.utteranceId === 'string' && json.input === 'hotkey',
    3000,
  );
  check(
    '降级链路：cmd:respond → user_utterance 事件（§6.3 唯一入口）',
    typeof utteranceLog?.utteranceId === 'string',
    utteranceLog,
  );
  const ruleEntry = await waitForLogJson('intent_resolved 已发', (json) => json.route === 'rule', 5000);
  check('降级链路：规则命中 → route=rule（§9.1 ①）', ruleEntry?.route === 'rule', ruleEntry);
  const failedSpeech = await waitForLog('speech_ended failed', speechFailedBaseline + 1, 5000);
  check(
    '降级链路：TTS 不可用 → speech_ended{failed}（§11）',
    failedSpeech >= speechFailedBaseline + 1,
    { speechFailedBaseline, failedSpeech },
  );
  check(
    '降级链路：没有 speech_started（确实没有语音）',
    (await countInLog('speech_started')) === speechStartedBaseline,
  );
  const degradedSubtitle = await readSubtitle(window);
  check(
    '降级链路：字幕气泡显示回复文本（无语音时的可读输出）',
    degradedSubtitle.visible === true && (degradedSubtitle.text ?? '').includes('おはようございます'),
    degradedSubtitle,
  );

  await submitUtterance(window, '今天天气如何');
  const unavailable = await waitForLogJson(
    'LLM 路径失败，走兜底',
    (json) => json.reason === 'unavailable',
    5000,
  );
  check('降级链路：LLM 不可用 → llm_failed{unavailable}', unavailable?.reason === 'unavailable', unavailable);
  const fallbackReply = await waitForLogJson(
    'intent_resolved 已发',
    (json) => json.route === 'fallback',
    5000,
  );
  check('降级链路：LLM 不可用 → route=fallback（§8.3）', fallbackReply?.route === 'fallback', fallbackReply);
  check(
    '降级链路：LLM 已本会话熔断（§11：不再探测 ②）',
    getRuntime()?.snapshot().orchestrator.llmDisabled === true,
    getRuntime()?.snapshot().orchestrator ?? null,
  );

  // ADR 0031 D6：主动性在自检里必须默认硬关，只有显式 PET_SELFTEST_PROACTIVE=1 才开。
  // 理由：本套断言对"收尾没有在途语音"与截图像素差有强依赖，随机插话会让它们随机翻红。
  const proactiveExpected = process.env.PET_SELFTEST_PROACTIVE === '1';
  const gateSnapshot = getRuntime()?.snapshot() ?? null;
  check(
    '主动性：自检默认硬关，仅 PET_SELFTEST_PROACTIVE=1 时启用（ADR 0031 D6）',
    gateSnapshot?.proactive.enabled === proactiveExpected &&
      gateSnapshot?.orchestrator.proactiveEnabled === proactiveExpected,
    {
      expected: proactiveExpected,
      gate: gateSnapshot?.proactive ?? null,
      orchestratorProactiveEnabled: gateSnapshot?.orchestrator.proactiveEnabled ?? null,
    },
  );

  // ADR 0033：预热搬到独立心跳后，自检仍然默认**零后台推理**——不建定时器、不发任何预热请求。
  // 这条断言是那条硬约束的唯一证据：它同时覆盖"总闸关"与"真的一次都没打出去"。
  check(
    '预热：自检默认硬关（零后台推理，ADR 0033）',
    gateSnapshot?.warmup.enabled === false &&
      gateSnapshot?.warmup.running === false &&
      gateSnapshot?.warmup.attempts === 0 &&
      gateSnapshot?.warmup.warmedUp === false,
    gateSnapshot?.warmup ?? null,
  );

  const failed = checks.filter((item) => !item.pass);
  logInfo('selftest', '模型加载与 Base 层验收', {
    total: checks.length,
    failed: failed.length,
    checks,
  });

  // Idle 动作帧（ADR 0014 验收：Idle / 拖拽 / 摸头三张截图）
  await captureScreenshot(window, 'window.png', 'idle');

  await shell.stop();
  app.exit(failed.length === 0 ? 0 : 1);
}


