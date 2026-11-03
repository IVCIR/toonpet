// 全量片段普查（本地开发用，不参与打包）。
//
// 目的：44 段官方面积太大，肉眼逐段看胶片条成本高。先让页面按固定步长采样骨骼事实
// （头/骨盆/双手/双脚的世界坐标 + 头骨朝向），把"缩身、抬手到胸前、低头、转身"这类
// 签名先算成数字，再只对候选片段出胶片条用眼睛确认。
//
// 用法：先起 serve.mjs，再
//   node_modules\.bin\electron.cmd tools\clip-preview\census.cjs
// 产物：tools/clip-preview/shots/census.json + 控制台摘要
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5199/tools/clip-preview/';
const OUT = path.join(__dirname, 'shots');
const STEP = Number(process.env.CENSUS_STEP ?? 0.2);

app.disableHardwareAcceleration();

function bounds(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0) return null;
  return { min: Math.min(...finite), max: Math.max(...finite) };
}

/** 从时间序列里抽出"像不像摸头反应"的可读签名。 */
function summarize(clip) {
  const s = clip.samples;
  const first = s[0];
  const headY = s.map((x) => x.head?.y ?? null);
  const pelvisY = s.map((x) => x.pelvis?.y ?? null);
  const footY = s.map((x) => x.footY);
  const headPitch = s.map((x) => x.headPitch);
  const headRoll = s.map((x) => x.headRoll);
  const headYaw = s.map((x) => x.headYaw);
  const handL = s.map((x) => x.handDistL);
  const handR = s.map((x) => x.handDistR);
  const handDist = s.map((x, i) => (x.handDistL === null || x.handDistR === null ? null : Math.min(x.handDistL, x.handDistR)));

  // 身高代理：头到最低脚的距离（缩身 → 变小）
  const height = s.map((x, i) => (x.head && x.footY !== null ? x.head.y - x.footY : null));
  const heightBounds = bounds(height);
  const baseHeight = height[0] ?? heightBounds?.max ?? null;

  // 手到头的最近距离：抬到胸前/脸旁 → 明显下降
  const handBounds = bounds(handDist);
  const baseHand = handDist[0] ?? handBounds?.max ?? null;

  const pitchBounds = bounds(headPitch);
  const basePitch = headPitch[0] ?? 0;
  const rollBounds = bounds(headRoll);
  const yawBounds = bounds(headYaw);

  const minHeight = heightBounds ? heightBounds.min : null;
  const shrinkRatio = baseHeight && minHeight ? (baseHeight - minHeight) / baseHeight : null;
  const minHand = handBounds ? handBounds.min : null;
  const handRiseRatio = baseHand && minHand ? (baseHand - minHand) / baseHand : null;
  const pitchDrop = pitchBounds ? pitchBounds.min - basePitch : null;

  // 缩身出现的时刻（最矮的那一帧）
  let shrinkAt = null;
  if (height.some((h) => h !== null) && minHeight !== null) {
    const index = height.findIndex((h) => h !== null && Math.abs(h - minHeight) < 1e-6);
    shrinkAt = index >= 0 ? s[index].t : null;
  }

  return {
    name: clip.name,
    duration: Number(clip.duration.toFixed(2)),
    samples: s.length,
    baseHeight: baseHeight === null ? null : Number(baseHeight.toFixed(4)),
    minHeight: minHeight === null ? null : Number(minHeight.toFixed(4)),
    shrinkRatio: shrinkRatio === null ? null : Number(shrinkRatio.toFixed(3)),
    shrinkAt,
    baseHand: baseHand === null ? null : Number(baseHand.toFixed(4)),
    minHand: minHand === null ? null : Number(minHand.toFixed(4)),
    handRiseRatio: handRiseRatio === null ? null : Number(handRiseRatio.toFixed(3)),
    pitchRange: pitchBounds ? Number((pitchBounds.max - pitchBounds.min).toFixed(3)) : null,
    pitchDrop: pitchDrop === null ? null : Number(pitchDrop.toFixed(3)),
    rollRange: rollBounds ? Number((rollBounds.max - rollBounds.min).toFixed(3)) : null,
    yawRange: yawBounds ? Number((yawBounds.max - yawBounds.min).toFixed(3)) : null,
    // 朝向：中位数偏航角接近 0 = 正面；接近 ±1.57 = 侧身
    facing: (() => {
      const yaws = headYaw.filter((v) => typeof v === 'number');
      if (yaws.length === 0) return null;
      const sorted = [...yaws].sort((a, b) => a - b);
      return Number(sorted[Math.floor(sorted.length / 2)].toFixed(3));
    })(),
  };
}

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { offscreen: true } });
  await win.loadURL(URL);
  await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (document.querySelectorAll('.clip').length > 0) { clearInterval(timer); resolve(true); }
        if (Date.now() - started > 30000) { clearInterval(timer); resolve(false); }
      }, 200);
    })`,
  );
  await new Promise((resolve) => setTimeout(resolve, 800));

  const raw = await win.webContents.executeJavaScript(`window.__census(${JSON.stringify({ step: STEP })})`);
  if (!raw || !Array.isArray(raw.clips)) {
    console.log('[census] 页面没有返回结果');
    app.quit();
    return;
  }

  const summaries = raw.clips.map(summarize).sort((a, b) => {
    const av = (a.shrinkRatio ?? 0) * 2 + (a.handRiseRatio ?? 0);
    const bv = (b.shrinkRatio ?? 0) * 2 + (b.handRiseRatio ?? 0);
    return bv - av;
  });

  writeFileSync(
    path.join(OUT, 'census.json'),
    JSON.stringify({ step: STEP, bones: raw.bones, boneCount: raw.boneCount, summaries, clips: raw.clips }, null, 2),
  );

  console.log(`[census] bones=${JSON.stringify(raw.bones)}`);
  console.log('[census] 按"缩身 + 抬手"排序：');
  for (const item of summaries) {
    console.log(
      `  ${item.name.padEnd(42)} dur=${String(item.duration).padStart(5)} ` +
        `shrink=${String(item.shrinkRatio ?? '-').padStart(6)}@${String(item.shrinkAt ?? '-').padStart(6)}s ` +
        `hand=${String(item.handRiseRatio ?? '-').padStart(6)} ` +
        `pitch=${String(item.pitchDrop ?? '-').padStart(7)} roll=${String(item.rollRange ?? '-').padStart(6)} ` +
        `facing=${String(item.facing ?? '-').padStart(6)}`,
    );
  }
  app.quit();
});
