// 生成"胶片条"：同一片段多个时间点拼一张图，用来决定裁到第几秒（本地开发用）。
// 用法：
//   node_modules\.bin\electron.cmd tools\clip-preview\filmstrip.cjs
//   FILM_JOBS='[{"clip":"CH0335_Cafe_Reaction","times":[0.2,1,2]}]' node_modules\.bin\electron.cmd tools\clip-preview\filmstrip.cjs
//   FILM_CLIP=CH0335_Cafe_Reaction FILM_TIMES=0.2,1,2 ... filmstrip.cjs
// 环境变量：FILM_JOBS（JSON 数组，优先）/ FILM_CLIP + FILM_TIMES（逗号分隔秒数）/ FILM_TILE（瓦片宽度）
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5199/tools/clip-preview/';
const OUT = path.join(__dirname, 'shots');
const TILE = Number(process.env.FILM_TILE ?? 520);

const DEFAULT_JOBS = [
  { clip: 'CH0335_Cafe_Reaction', times: [0.2, 1, 2, 3.5, 5, 7, 9, 10.5] },
  { clip: 'CH0335_Formation_Pickup', times: [0.2, 0.8, 1.5, 2.5, 4, 6, 8, 10, 12, 13.8] },
];

function resolveJobs() {
  if (process.env.FILM_JOBS) {
    const parsed = JSON.parse(process.env.FILM_JOBS);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  }
  if (process.env.FILM_CLIP) {
    const times = String(process.env.FILM_TIMES ?? '0,0.5,1,1.5,2')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));
    return [{ clip: process.env.FILM_CLIP, times }];
  }
  return DEFAULT_JOBS;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { offscreen: true } });
  await win.loadURL(URL);
  await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const timer = setInterval(() => {
        if (document.querySelectorAll('.clip').length > 0) { clearInterval(timer); resolve(true); }
      }, 200);
    })`,
  );
  await new Promise((resolve) => setTimeout(resolve, 800));

  for (const job of resolveJobs()) {
    const dataUrl = await win.webContents.executeJavaScript(
      `window.__filmstrip(${JSON.stringify(job.clip)}, ${JSON.stringify(job.times)}, ${JSON.stringify(TILE)})`,
    );
    if (!dataUrl) {
      console.log('[film] skip', job.clip);
      continue;
    }
    const file = path.join(OUT, `film-${job.clip}.png`);
    writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('[film]', path.relative(process.cwd(), file));
  }
  app.quit();
});
