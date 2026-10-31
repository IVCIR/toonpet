// 预览页诊断：确认 WebGL 是否真的画出了东西（本地开发用）。
// 用法：node_modules\.bin\electron.cmd tools\clip-preview\diag.cjs
const { app, BrowserWindow } = require('electron');

const URL = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5199/tools/clip-preview/';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[page:${level}] ${message}`);
  });
  await win.loadURL(URL);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const diag = await win.webContents.executeJavaScript(
    `(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      return {
        diag: typeof window.__previewDiag === 'function' ? window.__previewDiag() : null,
        gl: gl ? gl.getParameter(gl.VERSION) : 'no context',
        renderer: gl ? (() => { const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'; })() : 'n/a',
        listCount: document.getElementById('list').children.length,
      };
    })()`,
  );
  console.log(JSON.stringify(diag, null, 2));
  app.quit();
});
