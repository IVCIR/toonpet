/**
 * 用 Electron（Chromium 解码）从 mp4 抽帧，导出 PNG。
 *
 * 为什么不用 ffmpeg：本机没有 ffmpeg，也不该为一次性分析引入依赖；
 * 工程自带 Electron，Chromium 原生支持 H.264 解码。
 *
 * 用法：electron tools/video-frames.cjs <video> <outDir> <t1,t2,...>
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [, , videoPath, outDir, timesArg] = process.argv;
const times = (timesArg || '0.5,2,4,6,8,10').split(',').map(Number);
const out = path.resolve(outDir);
fs.mkdirSync(out, { recursive: true });

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 720,
    height: 900,
    webPreferences: { offscreen: true, webSecurity: false, backgroundThrottling: false },
  });

  const src = 'file:///' + videoPath.replace(/\\/g, '/');
  const html = `<!doctype html><html><body style="margin:0;background:#111">
    <video id="v" src="${src}" muted playsinline preload="auto"></video>
  </body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  const meta = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const v = document.getElementById('v');
      if (v.readyState >= 1) return resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
      v.addEventListener('loadedmetadata', () => resolve({ w: v.videoWidth, h: v.videoHeight, d: v.duration }), { once: true });
      v.addEventListener('error', () => reject(new Error('video error ' + (v.error && v.error.code))), { once: true });
      setTimeout(() => reject(new Error('metadata timeout')), 15000);
    })
  `);
  console.log(`[frames] ${meta.w}x${meta.h} duration=${meta.d.toFixed(2)}s`);

  for (const t of times) {
    if (!Number.isFinite(t) || t < 0 || t > meta.d) continue;
    const dataUrl = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const v = document.getElementById('v');
        const draw = () => {
          const c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          c.getContext('2d').drawImage(v, 0, 0);
          resolve(c.toDataURL('image/png'));
        };
        v.addEventListener('seeked', draw, { once: true });
        v.addEventListener('error', () => reject(new Error('seek error')), { once: true });
        v.currentTime = ${t};
        setTimeout(() => reject(new Error('seek timeout')), 8000);
      })
    `);
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const file = path.join(out, `t${String(t).replace('.', '_')}.png`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    console.log(`[frames] ${path.basename(file)} ${fs.statSync(file).size}B`);
  }

  win.destroy();
  app.quit();
}).catch((error) => {
  console.error('[frames] failed', error);
  app.exit(1);
});
