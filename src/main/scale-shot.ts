/**
 * 整体缩放的**真机取证**（`PET_SCALE_SHOT=1`，ADR 0057 D2）。
 *
 * 与 `panel-shot.ts` 的分工：那个证明"面板滑块 → 主进程 → 渲染侧"的链路，
 * 这个只回答一件事 —— **拖动滑块时她真的在变大变小吗？**
 *
 * 做法：把比例从 0.5x 逐档拨到 2.0x（每档 0.1），每一档用 `webContents.capturePage()`
 * 抓一张窗口内容图（透明背景，只有角色），落盘后又拨回 1.0x。帧序列可以拼成 GIF
 * （`tools/compose-scale-gif.py`），当作"录屏"看：脚底始终贴底边、窗口同比生长。
 *
 * 注意：这里**不写 `config.json`**（只改内存里的窗口），跑完自动还原 1.0x。
 */
import { BrowserWindow, app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logInfo, logWarn } from './log';
import { shell } from './shell/index';

const EVIDENCE_DIR = ['logs', 'evidence', 'scale-sweep'];
/** 帧序列：0.5x → 1.4x（再往上在 1080p 桌面上会被工作区夹住，单独记一条"被夹"的证据） */
const STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 2.0];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 主窗口 = 全部窗口里排除输入条与控制面板（与 selftest 同一手法，不新增接口） */
function findPetWindow(): BrowserWindow | null {
  const inputBar = shell.getInputBarWindow();
  const panel = shell.getControlPanelWindow();
  return (
    BrowserWindow.getAllWindows().find(
      (candidate) => candidate !== inputBar && candidate !== panel && !candidate.isDestroyed(),
    ) ?? null
  );
}

export async function runScaleShotIfRequested(): Promise<void> {
  if (process.env['PET_SCALE_SHOT'] !== '1') return;
  const appRoot = app.getAppPath();
  const dir = path.join(appRoot, ...EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });

  const window = findPetWindow();
  if (!window) {
    logWarn('scale-shot', '找不到主窗口，取证放弃');
    return;
  }
  // 等模型加载完（首帧可见）+ 视线/待机动画稳定，避免第一帧还是占位胶囊
  await sleep(1500);

  const frames: Array<{
    index: number;
    requested: number;
    effective: number;
    clamped: string;
    bounds: { x: number; y: number; width: number; height: number };
    file: string;
  }> = [];

  for (const [index, scale] of STEPS.entries()) {
    const applied = shell.setViewScale(scale, `scale-shot(${scale}x)`);
    // 让 `setBounds` → 浏览器 resize → 渲染侧重算视锥/掩码走完两帧
    await sleep(420);
    const bounds = window.getContentBounds();
    const image = await window.webContents.capturePage();
    const size = image.getSize();
    const file = path.join(dir, `frame-${String(index).padStart(2, '0')}-${scale.toFixed(1)}x.png`);
    writeFileSync(file, image.toPNG());
    frames.push({
      index,
      requested: scale,
      effective: applied.effective,
      clamped: applied.clamped,
      bounds,
      file,
    });
    logInfo('scale-shot', '缩放帧', { scale, effective: applied.effective, bounds, size });
  }

  // 还原 1.0x（内存态；config.json 未被动过）
  shell.setViewScale(1, 'scale-shot-restore');
  await sleep(300);

  const report = {
    generatedAt: new Date().toISOString(),
    workArea: shell.viewScaleSnapshot().workArea,
    base: shell.viewScaleSnapshot().base,
    frames,
  };
  const file = path.join(appRoot, 'logs', 'evidence', 'scale-sweep.json');
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  logInfo('scale-shot', '取证完成', { frames: frames.length, report: file });
  // 与 panel-shot 同一退出方式：写到证据文件后正常退出（走 before-quit 的清理路径）
  app.quit();
}
