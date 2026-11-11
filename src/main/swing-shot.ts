/**
 * 拖拽摇晃的**真机取证**（`PET_SWING_SHOT=1`，ADR 0058 D4）。
 *
 * 回答一个问题：**抓着她左右甩，头发/身体边缘还会不会被窗口边缘切掉？**
 *
 * 做法（全程走生产链路，不伪造姿态）：
 *   1. 脚本光标 + 合成 `pointerdown` → shell 的真实拖拽手势 → `drag_started`；
 *   2. 主进程按 0.8Hz 正弦推光标，**窗口跟着光标走**，于是渲染侧
 *      `supportAcceleration` 是真的，单摆是真的；
 *   3. 页面内按帧记录 `dragDigest()`（摆角/余量/补偿）与每 3 帧一次 `silhouetteCss()`
 *      （她整块在内容区里的包围盒），另每 8 帧 `capturePage()` 一张图当"录屏"。
 *
 * 为什么和 `scale:shot` 分开：这个要脚本光标，必须先开 `PET_SELFTEST=1`
 * （`scripts/start.mjs` 里 `--swing-shot` 会一起设），否则主进程读的是真实鼠标。
 */
import { BrowserWindow, app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pushScriptedCursor } from './shell/cursor-source';
import { logInfo, logWarn } from './log';
import { shell } from './shell/index';

const EVIDENCE_DIR = ['logs', 'evidence', 'swing'];
/** 两个倍率：默认 1.0x 与用户点名的 1.3x（1080p 上 1.3x 会按工作区夹到 ≈1.26x） */
const SCALES = [1.0, 1.3] as const;
const SHAKE_HZ = 0.8;
const SHAKE_AMPLITUDE_PX = 110;
const SHAKE_DURATION_MS = 2600;
const CAPTURE_EVERY = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findPetWindow(): BrowserWindow | null {
  const inputBar = shell.getInputBarWindow();
  const panel = shell.getControlPanelWindow();
  return (
    BrowserWindow.getAllWindows().find(
      (candidate) => candidate !== inputBar && candidate !== panel && !candidate.isDestroyed(),
    ) ?? null
  );
}

const INSTALL_SAMPLER = `(() => {
  window.__swingLog = [];
  window.__swingStop = false;
  const step = () => {
    if (window.__swingStop) return;
    const d = window.petRender.dragDigest();
    const css = window.__swingLog.length % 3 === 0 ? window.petRender.silhouetteCss() : null;
    window.__swingLog.push({
      t: Math.round(performance.now()),
      angle: d.angle, limit: d.angleLimit, gain: d.gain, liftPx: d.liftPx,
      accelX: d.supportAcceleration.x, width: d.content.width, height: d.content.height, css,
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return true;
})()`;

function pointerScript(type: 'pointerdown' | 'pointerup', x: number, y: number): string {
  return `(() => {
    window.dispatchEvent(new PointerEvent('${type}', {
      bubbles: true, cancelable: true, composed: true,
      clientX: ${x}, clientY: ${y},
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: ${type === 'pointerdown' ? 1 : 0},
    }));
    return true;
  })()`;
}

export async function runSwingShotIfRequested(): Promise<void> {
  if (process.env['PET_SWING_SHOT'] !== '1') return;
  const appRoot = app.getAppPath();
  const dir = path.join(appRoot, ...EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });

  const window = findPetWindow();
  if (!window) {
    logWarn('swing-shot', '找不到主窗口，取证放弃');
    return;
  }
  // 等模型加载 + 掩膜就绪（首帧还是占位胶囊时拖拽没有意义）
  await sleep(2000);

  const steps: Array<Record<string, unknown>> = [];

  for (const scale of SCALES) {
    const applied = shell.setViewScale(scale, `swing-shot(${scale}x)`);
    await sleep(700);
    const content = window.getContentBounds();
    const head = (await window.webContents.executeJavaScript(
      'window.petRender.getDiagnostics().probePoints.head',
      true,
    )) as { x: number; y: number } | null;
    if (!head) {
      logWarn('swing-shot', '拿不到头骨探针点，跳过这一档', { scale });
      continue;
    }
    const grabScreenX = content.x + head.x;
    const grabScreenY = content.y + head.y;
    pushScriptedCursor(grabScreenX, grabScreenY);
    await sleep(320);

    await window.webContents.executeJavaScript(INSTALL_SAMPLER, true);
    await window.webContents.executeJavaScript(pointerScript('pointerdown', head.x, head.y), true);
    await sleep(40);
    // 越过 D-2 的 4px 阈值 → 真实拖拽；再等悬空片段权重满 + 下沉补偿测完
    pushScriptedCursor(grabScreenX + 20, grabScreenY);
    await sleep(460);

    const frames: string[] = [];
    const startedAt = Date.now();
    let index = 0;
    while (Date.now() - startedAt < SHAKE_DURATION_MS) {
      const t = (Date.now() - startedAt) / 1000;
      pushScriptedCursor(
        grabScreenX + 20 + Math.sin(t * Math.PI * 2 * SHAKE_HZ) * SHAKE_AMPLITUDE_PX,
        grabScreenY,
      );
      index += 1;
      if (index % CAPTURE_EVERY === 0) {
        const image = await window.webContents.capturePage();
        const file = path.join(
          dir,
          `frame-${scale.toFixed(1).replace('.', '')}-${String(frames.length).padStart(2, '0')}.png`,
        );
        writeFileSync(file, image.toPNG());
        frames.push(file);
      }
      await sleep(16);
    }
    await window.webContents.executeJavaScript('window.__swingStop = true;', true);
    const raw = (await window.webContents.executeJavaScript(
      'JSON.stringify(window.__swingLog)',
      true,
    )) as string;
    const log = JSON.parse(raw) as Array<{
      t: number;
      angle: number;
      limit: number;
      gain: number;
      liftPx: number;
      width: number;
      height: number;
      css: { minX: number; minY: number; maxX: number; maxY: number } | null;
    }>;

    // 松手 + 让回弹走完，避免影响下一档
    pushScriptedCursor(grabScreenX + 20, grabScreenY);
    await sleep(60);
    const release = window.getContentBounds();
    await window.webContents.executeJavaScript(
      pointerScript('pointerup', head.x + 20, head.y),
      true,
    );
    await sleep(700);

    const measured = log.filter((row) => row.gain > 0.9);
    const outside = measured.filter(
      (row) =>
        row.css !== null &&
        (row.css.minX < 0 || row.css.maxX > row.width || row.css.minY < 0 || row.css.maxY > row.height + 1),
    );    const maxAngle = measured.reduce((max, row) => Math.max(max, Math.abs(row.angle)), 0);
    const maxLift = measured.reduce((max, row) => Math.max(max, row.liftPx), 0);
    steps.push({
      scale,
      effectiveScale: applied.effective,
      clamped: applied.clamped,
      content,
      releaseBounds: release,
      frames,
      samples: measured.length,
      maxAngleRad: Number(maxAngle.toFixed(4)),
      angleLimitRad: measured[0]?.limit ?? null,
      maxLiftPx: Number(maxLift.toFixed(1)),
      outsideSamples: outside.length,
      outsideDetail: outside.slice(0, 6).map((row) => ({
        t: row.t,
        angle: row.angle,
        liftPx: row.liftPx,
        css: row.css,
      })),
      cssFrames: measured.filter((row) => row.css !== null).length,
      worstX: measured.reduce(
        (acc, row) =>
          row.css
            ? { minX: Math.min(acc.minX, row.css.minX), maxX: Math.max(acc.maxX, row.css.maxX) }
            : acc,
        { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY },
      ),
    });
    logInfo('swing-shot', '摇晃取证完成', {
      scale,
      effective: applied.effective,
      samples: measured.length,
      maxAngle: Number(maxAngle.toFixed(3)),
      outside: outside.length,
      frames: frames.length,
    });
  }

  shell.setViewScale(1, 'swing-shot-restore');
  await sleep(300);
  const file = path.join(appRoot, 'logs', 'evidence', 'swing.json');
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        shake: { hz: SHAKE_HZ, amplitudePx: SHAKE_AMPLITUDE_PX, durationMs: SHAKE_DURATION_MS },
        steps,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  logInfo('swing-shot', '取证完成', { steps: steps.length, report: file });
  app.quit();
}
