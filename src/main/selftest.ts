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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Rect } from '../shared/geometry';
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
  hiddenMeshes: string[];
  mouth: { materialName: string | null; atlasLoaded: boolean; calibrated: boolean };
  gaze: { yaw: number; pitch: number; targetYaw: number; targetPitch: number; idle: boolean };
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
    dropPx: number;
    bobPx: number;
    offsetPx?: { x: number; y: number };
    /** 头骨本地四元数（诊断"头在打转"的累积漂移） */
    headQuat?: [number, number, number, number] | null;
    headWorld?: { x: number; y: number } | null;
    headBase?: { baseFrom: string | null; yaw: number; pitch: number; roll: number } | null;
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
  pat: { active: boolean; weight: number; allowMouthChange: boolean; mouthFrame: number | null };
  speech: { frame: number; driven: boolean };
  /** ADR 0036：手/小臂顶点烘焙光照（内部诊断） */
  skin: { meshes: number; vertices: number; minShade: number; maxShade: number; meanColor: [number, number, number] } | null;
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
      const probe = (x, y) => { const s = m.probe(x, y); return { x, y, hit: s.hit, head: s.head }; };
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
    '托盘：菜单项为 两行诊断 + 呼出输入条 / 吸附 / 离开 / 重新加载桌宠 / 退出（ADR 0028 D4）',
    JSON.stringify(tray.menuLabels) ===
      JSON.stringify([
        '今天主动交互: 0 次',
        '上次未主动原因: disabled（主动性已关闭）',
        '呼出输入条',
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
      count += 1;
    }
    if (count === 0) return null;
    return {
      mean: [Math.round(r / count), Math.round(g / count), Math.round(b / count)],
      redRatio: red / count,
      whiteRatio: white / count,
      pixels: count,
    };
  } catch {
    return null;
  }
}

/** 手部诊断截图（不额外 sleep：手在 Idle 里会轻微移动，取样点必须和这一帧对齐）。 */
async function captureHandEvidence(window: BrowserWindow, fileName: string): Promise<CapturedImage> {
  const image = await window.webContents.capturePage();
  const outputDir = path.join(app.getAppPath(), 'dist', 'selftest');
  await mkdir(outputDir, { recursive: true });
  const pngPath = path.join(outputDir, fileName);
  await writeFile(pngPath, await image.toPNG());
  return { image, pngPath };
}

/**
 * 阶段 14 专用诊断：`PET_HAND_DIAG=1` 时只跑这一套。
 *
 * 目的不是"断言通过"，而是**把现象量化**：
 *  1. 枚举 SkinnedMesh / 材质 / map / colorSpace / 手部顶点数；
 *  2. 手部 UV 采到的贴图颜色；
 *  3. 只把手部顶点染红 → 证明手在哪块网格上；
 *  4. 整块 Body 材质染红 → 证明手与衣服/腿共用材质；
 *  5. 无光照 vs Toon+光照 → 证明"白"是不是缺阴影。
 */
async function runHandDiagnostics(window: BrowserWindow): Promise<void> {
  const diagnostics = await waitFor(
    window,
    MODEL_LOAD_TIMEOUT_MS,
    (d) => d !== null && (d.ready || (!d.loading && d.error !== null)),
  );
  if (!diagnostics?.ready) {
    logWarn('selftest', '手部诊断：模型未就绪', { error: diagnostics?.error ?? null });
    app.exit(1);
    return;
  }
  await sleep(1200);

  const outputDir = path.join(app.getAppPath(), 'dist', 'diagnostics');
  await mkdir(outputDir, { recursive: true });
  const content = window.getContentBounds();
  const width = content.width;
  const height = content.height;

  const materials = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.diagnostics.inspectMaterials())',
      true,
    )) as string,
  ) as Array<Record<string, unknown>>;
  logInfo('selftest', '手部诊断：网格与材质', materials);

  interface Point {
    x: number;
    y: number;
  }
  const points = JSON.parse(
    (await window.webContents.executeJavaScript(
      'JSON.stringify(window.diagnostics.handScreenPoints())',
      true,
    )) as string,
  ) as { left: Point | null; right: Point | null };

  const box = (p: Point): Rect => ({
    x: Math.max(0, p.x - 45),
    y: Math.max(0, p.y - 45),
    width: Math.min(90, width - Math.max(0, p.x - 45)),
    height: Math.min(90, height - Math.max(0, p.y - 45)),
  });

  const shots: Array<{
    step: string;
    file: string;
    left: RegionColorStats | null;
    right: RegionColorStats | null;
  }> = [];

  async function captureStep(step: string, file: string): Promise<void> {
    const captured = await captureHandEvidence(window, file);
    const currentPoints = JSON.parse(
      (await window.webContents.executeJavaScript(
        'JSON.stringify(window.diagnostics.handScreenPoints())',
        true,
      )) as string,
    ) as { left: Point | null; right: Point | null };
    shots.push({
      step,
      file: path.relative(app.getAppPath(), captured.pngPath),
      left: currentPoints.left ? regionColorStats(captured.image, box(currentPoints.left), width) : null,
      right: currentPoints.right ? regionColorStats(captured.image, box(currentPoints.right), width) : null,
    });
    logInfo('selftest', '手部诊断：截图', shots[shots.length - 1]);
  }

  // A/B 对照：同一姿态、同一帧光源下，先关掉烘焙（还原模型原始白色顶点色），再打开。
  await window.webContents.executeJavaScript('window.diagnostics.setSkinBake(false)', true);
  await sleep(120);
  await captureStep('before-bake-white', 'hand-00-before-bake.png');
  await window.webContents.executeJavaScript('window.diagnostics.setSkinBake(true)', true);
  await sleep(120);
  await captureStep('baseline-basic', 'hand-00-baseline.png');

  const tintHand = await window.webContents.executeJavaScript(
    "JSON.stringify(window.diagnostics.tintSkin('hand'))",
    true,
  );
  await sleep(120);
  await captureStep('tint-hand-red', 'hand-01-tint-hand.png');

  const tintBoth = await window.webContents.executeJavaScript(
    "JSON.stringify(window.diagnostics.tintSkin('both'))",
    true,
  );
  await sleep(120);
  await captureStep('tint-hand-forearm-red', 'hand-02-tint-both.png');

  await window.webContents.executeJavaScript("window.diagnostics.tintSkin('none')", true);

  const shadeSoft = await window.webContents.executeJavaScript(
    'JSON.stringify(window.diagnostics.shadeSkin({ambient:0.80,diffuse:0.20,light:[-0.35,0.65,0.68],tint:[1,0.95,0.91]}))',
    true,
  );
  await sleep(120);
  await captureStep('shade-soft', 'hand-03-shade-soft.png');

  const shadeStrong = await window.webContents.executeJavaScript(
    'JSON.stringify(window.diagnostics.shadeSkin({ambient:0.68,diffuse:0.32,light:[-0.35,0.65,0.68],tint:[1,0.92,0.86]}))',
    true,
  );
  await sleep(120);
  await captureStep('shade-strong', 'hand-04-shade-strong.png');

  const shadeWarm = await window.webContents.executeJavaScript(
    'JSON.stringify(window.diagnostics.shadeSkin({ambient:0.78,diffuse:0.22,light:[-0.35,0.65,0.68],tint:[1,0.90,0.85]}))',
    true,
  );
  await sleep(120);
  await captureStep('shade-warm', 'hand-05-shade-warm.png');

  await window.webContents.executeJavaScript("window.diagnostics.tintSkin('none')", true);
  const bodyRed = await window.webContents.executeJavaScript(
    'JSON.stringify(window.diagnostics.testHandMaterial(0xff0000))',
    true,
  );
  await sleep(120);
  await captureStep('body-material-red', 'hand-06-body-red.png');
  await window.webContents.executeJavaScript('window.diagnostics.resetMaterials()', true);

  const toonBody = await window.webContents.executeJavaScript(
    "JSON.stringify(window.diagnostics.setShading('toon-body'))",
    true,
  );
  await sleep(250);
  await captureStep('toon-body-only', 'hand-07-toon-body.png');

  const toonAll = await window.webContents.executeJavaScript(
    "JSON.stringify(window.diagnostics.setShading('toon-all'))",
    true,
  );
  await sleep(250);
  await captureStep('toon-all-materials', 'hand-08-toon-all.png');

  await window.webContents.executeJavaScript("window.diagnostics.setShading('basic')", true);
  await sleep(200);
  await captureStep('restored-basic', 'hand-09-restored.png');
  await window.webContents.executeJavaScript('window.diagnostics.resetMaterials()', true);

  const summary = {
    at: new Date().toISOString(),
    content,
    diagnostics: {
      modelId: diagnostics.modelId,
      meshNames: diagnostics.meshNames,
      hiddenMeshes: diagnostics.hiddenMeshes,
    },
    materials,
    handScreenPoints: points,
    tintHand: JSON.parse(tintHand as string),
    tintBoth: JSON.parse(tintBoth as string),
    shadeSoft: JSON.parse(shadeSoft as string),
    shadeStrong: JSON.parse(shadeStrong as string),
    shadeWarm: JSON.parse(shadeWarm as string),
    bodyMaterialReplacement: JSON.parse(bodyRed as string),
    toonBody: JSON.parse(toonBody as string),
    toonAll: JSON.parse(toonAll as string),
    shots,
  };
  await writeFile(
    path.join(outputDir, 'hand-diagnosis.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  logInfo('selftest', '手部诊断：汇总', {
    json: 'dist/diagnostics/hand-diagnosis.json',
    shots: shots.map((shot) => ({
      step: shot.step,
      left: shot.left,
      right: shot.right,
    })),
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

  // 手部发白诊断（阶段 14）：`PET_HAND_DIAG=1` 时只跑这一套，落截图 + JSON 后退出。
  if (process.env.PET_HAND_DIAG === '1') {
    await runHandDiagnostics(window);
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
  // ADR 0036：手部发白修复的回归断言（几何级，不依赖截图里的姿势/背景）
  const skin = diagnostics?.skin ?? null;
  check(
    '肤色：手/小臂已烘焙暖色明暗（不再是纯白板，ADR 0036）',
    skin !== null &&
      skin.meshes === 1 &&
      skin.vertices >= 200 &&
      skin.minShade >= 0.7 &&
      skin.maxShade <= 1.0001 &&
      skin.meanColor[0] < 0.95 &&
      skin.meanColor[0] > skin.meanColor[1] &&
      skin.meanColor[1] > skin.meanColor[2],
    skin,
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
  const points = await resolvePoints(window);
  check('掩膜：找到头部带命中点', points.head !== null, {
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

  // ADR 0023 D4：摸头现在播官方整身片段（~3.1s，角色会缩起身子），
  // 片段播放期间头部已经离开固定探针点，所以等它播完、姿态回到 Idle 再点第二次。
  await sleep(3300);
  await dispatchPointer('down', head.x, head.y);
  await sleep(50);
  await dispatchPointer('up', head.x, head.y);
  await sleep(150);
  check(
    '摸头：冷却结束后可再次触发',
    (await countInLog('head_patted 发出')) === patAfterFirst + 1,
  );

  // 摸头反应（ADR 0014 D6）：HFSM overlay=reacting、pat 权重、嘴型帧、截图
  const patDiag = await readDiagnostics(window);
  check(
    '摸头：HFSM overlay=reacting（head_patted → reacting，§4.1）',
    patDiag?.hfsm.overlay === 'reacting' && patDiag?.hfsm.reaction?.kind === 'head_patted',
    patDiag?.hfsm ?? null,
  );
  check(
    '摸头：非说话时满权重（0.4 上限只用于 speaking）且切到 shy 嘴型帧',
    patDiag?.pat.active === true &&
      patDiag?.pat.weight === 1 &&
      patDiag?.pat.allowMouthChange === true &&
      patDiag?.pat.mouthFrame === 4,
    patDiag?.pat ?? null,
  );
  check(
    '摸头：状态投影 emotion=shy（§4.5，反应结束回到原 emotion）',
    (await window.webContents.executeJavaScript('window.petRender.getState().emotion', true)) === 'shy',
  );
  await captureScreenshot(window, 'window-pat.png', 'pat-react');

  // §5.3 必测组合：说话时被摸头 —— pat 以 ≤0.4 权重叠加、不改嘴型、overlay 仍投影 speaking
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
    pat: { active: boolean; weight: number; allowMouthChange: boolean; mouthFrame: number | null };
    state: { overlay: string | null; emotion: string };
  };
  check(
    '说话时被摸头：overlay 字段投影保持 speaking（§5.1 + §7.1 单字段）',
    speakingPat.hfsm.overlay === 'speaking' && speakingPat.state.overlay === 'speaking',
    speakingPat.hfsm,
  );
  check(
    '说话时被摸头：pat 权重封顶 0.4 且不改嘴型（§5.3 口型通道最高优先级）',
    speakingPat.pat.active === true &&
      speakingPat.pat.weight === 0.4 &&
      speakingPat.pat.allowMouthChange === false &&
      speakingPat.pat.mouthFrame === 0,
    speakingPat.pat,
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

  // D-6 末速度只看抬手前 ~100ms 的光标采样；截图会停住光标，松手前补两次位移
  pushScriptedCursor(current.x + body.x + 135, current.y + body.y - 28);
  await sleep(30);
  pushScriptedCursor(current.x + body.x + 150, current.y + body.y - 34);
  await sleep(30);
  const boundsBeforeRelease = shell.getBounds();

  await dispatchPointer('up', body.x, body.y);
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
  check(
    '落地：按向下峰值速度分级触发下蹲（impact > 0，ADR 0035 D4）',
    typeof settledDiag?.drag?.landingImpact === 'number' && settledDiag.drag.landingImpact > 0,
    settledDiag?.drag ?? null,
  );

  await sleep(300);
  const pausedMs = lastPausedMs(await runLogText());
  check(
    '松手：500ms 沉降窗口后掩膜恢复采集（R-8）',
    (await countInLog('掩膜采集恢复')) > resumeBaseline && pausedMs !== null && pausedMs >= 500,
    { pausedMs },
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
        : ['fullscreen', 'invalid-rect', 'geometry', 'shell-window', 'own-window'].includes(
            realSnap.reason,
          )),
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
    '吸附：播放官方坐姿片段（pastmemory 11.2–13.5s），不是程序化降级（ADR 0028 D8）',
    (seated?.animation?.current?.name ?? '').includes('pastmemory') &&
      seated?.sit?.procedural === false,
    { current: seated?.animation?.current ?? null, sit: seated?.sit ?? null },
  );
  check(
    '吸附：行走调度已关闭（walking=null、nextWalkInMs=null）',
    seated?.motion.walking === null && seated?.motion.nextWalkInMs === null,
    seated?.motion ?? null,
  );

  const sitDone = await waitFor(window, 6000, (diagnostics) => diagnostics?.sit?.done === true);
  check(
    '吸附：坐姿片段播完停在最后一帧（playHold，不会自己站回去）',
    sitDone?.sit?.done === true &&
      (sitDone?.animation?.current?.name ?? '').includes('pastmemory'),
    { sit: sitDone?.sit ?? null, current: sitDone?.animation?.current ?? null },
  );

  // ADR 0034 D5：坐姿不锁死上身——视线通道仍在跑（把光标放到左上角，头部 yaw 应变化）
  const gazeBefore = sitDone?.gaze?.yaw ?? 0;
  await window.webContents.executeJavaScript(
    'window.petRender.setCursor(8, 8, performance.now())',
    true,
  );
  await sleep(600);
  const gazeSitting = await readDiagnostics(window);
  check(
    '坐姿：视线仍跟随光标（sitting 不锁死上身，ADR 0034 D5）',
    gazeSitting?.hfsm.physics === 'sitting' &&
      Math.abs((gazeSitting?.gaze?.yaw ?? 0) - gazeBefore) > 0.01,
    { before: gazeBefore, after: gazeSitting?.gaze ?? null },
  );
  await window.webContents.executeJavaScript(
    'window.petRender.setCursor(211, 360, performance.now())',
    true,
  );
  const sittingShot = await captureScreenshot(window, 'window-sitting.png', 'sitting');
  // 桌面抓取（desktopCapturer）在合成透明置顶窗口时可能拿到稍早的一帧：
  // 先等坐姿停稳，再抓一次；两次写同一路径，后一次覆盖（只是验收证据，不参与断言）。
  await sleep(1500);
  const desktopShot = await captureDesktop('window-sitting-desktop.png');
  check(
    '截图：桌面合成图已产出（她坐在记事本窗口下边缘，ADR 0028 验收）',
    desktopShot !== null,
    { sittingShot, desktopShot },
  );
  // 停帧语义：截图（含 ~1s 的桌面抓取）之后姿态必须还在最后一帧，不能自己循环/漂移
  const afterDesktop = await readDiagnostics(window);
  check(
    '吸附：截图之后姿态仍停在最后一帧（playHold 的 clamp 生效）',
    afterDesktop?.sit?.done === true &&
      Math.abs(
        (afterDesktop?.animation?.current?.time ?? 0) -
          (sitDone?.animation?.current?.time ?? 0),
      ) < 0.05,
    {
      before: sitDone?.animation?.current ?? null,
      after: afterDesktop?.animation?.current ?? null,
      sit: afterDesktop?.sit ?? null,
    },
  );

  // 头骨稳定性（真机 bug 回归）：坐姿停帧后，头骨本地四元数在 1s 内不得漂移。
  // 之前"头疯狂打转"就是这个量在累积——骨骼仲裁把上一帧的偏移当成新基底。
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
    '吸附：坐姿 1s 内头骨不漂移（回归"头在打转"，≤0.15 rad）',
    Number.isFinite(headDriftRad) && headDriftRad <= 0.15,
    { headA, headB, headDriftRad, headBase: headDiag?.sit?.headBase ?? null, headWorld: headDiag?.sit?.headWorld ?? null },
  );

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
  check(
    '解除：clicked 播放短促惊跳/起身（ADR 0034 D5）',
    clickedOff?.drag?.startle === 'clicked' || clickedOff?.drag?.startle === 'command',
    clickedOff?.drag ?? null,
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
  // 等坐姿片段播完（姿态静止）：片段播放中身体一直在动，掩膜逐帧变化，
  // 探针可能在"扫描命中"与"按下"之间变成透明（本轮踩到，按下被 D-2 拒绝）。
  await waitFor(window, 6000, (diagnostics) => diagnostics?.sit?.done === true);
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
