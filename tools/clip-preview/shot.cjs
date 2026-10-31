// 预览页的离屏截图工具（本地开发用，不参与打包）。
//
// 用途：不打开窗口也能确认"某段片段在某个时间点长什么样"。
// 用法：先起 serve.mjs，再 `node_modules\.bin\electron.cmd tools\clip-preview\shot.cjs`
// 产物：tools/clip-preview/shots/<clip>@<time>.png + shots/report.json
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5199/tools/clip-preview/';
const OUT = path.join(__dirname, 'shots');
const SHOTS = [
  { clip: 'CH0335_Cafe_Idle', at: 1.0 },
  { clip: 'CH0335_Cafe_Walk', at: 1.2 },
  { clip: 'CH0335_Formation_Pickup', at: 1.0 },
  { clip: 'CH0335_Cafe_Reaction', at: 1.0 },
  { clip: 'CH0335_Carrier_Idle', at: 0.8 },
  { clip: 'CH0335_Victory_Start', at: 1.2 },
];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { offscreen: true },
  });

  await win.loadURL(URL);
  const loaded = await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const count = document.getElementById('list').children.length;
        if (count > 0 || Date.now() - started > 20000) {
          clearInterval(timer);
          resolve({ count, status: document.getElementById('status').textContent });
        }
      }, 200);
    })`,
  );
  console.log('[shot] loaded', JSON.stringify(loaded));

  const report = [];
  for (const shot of SHOTS) {
    const info = await win.webContents.executeJavaScript(
      `(async () => {
        const buttons = [...document.querySelectorAll('.clip')];
        const target = buttons.find((el) => el.dataset.name === ${JSON.stringify(shot.clip)});
        if (!target) return { ok: false, reason: 'clip not found' };
        target.click();
        const hud = document.getElementById('hud');
        await new Promise((r) => setTimeout(r, ${Math.round(shot.at * 1000)}));
        return { ok: true, hud: hud.textContent };
      })()`,
    );
    const image = await win.webContents.capturePage();
    const file = path.join(OUT, `${shot.clip}@${shot.at}s.png`);
    writeFileSync(file, image.toPNG());
    report.push({ ...shot, file: path.relative(process.cwd(), file), ...info });
    console.log('[shot]', shot.clip, info.ok ? info.hud.replace(/\n/g, ' ') : info.reason);
  }

  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  app.quit();
});
