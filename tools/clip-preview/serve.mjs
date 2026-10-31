// 片段预览用的最小静态服务器（仅本地开发，不做任何外部访问）。
//
// 为什么需要它：预览页要按 ES module 直接引 `node_modules/three`，
// file:// 下 importmap 拿不到同源模块，也会被 CORS 拦。这里只做三件事：
// 读文件、按扩展名给 MIME、限制在项目根目录内。
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PREVIEW_PORT ?? 5199);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = path.resolve(ROOT, '.' + pathname);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(filePath);
    if (!info.isFile()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end('not found');
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[preview] 端口 ${PORT} 已被占用；用 PREVIEW_PORT 换一个，例如 PREVIEW_PORT=5200 node tools/clip-preview/serve.mjs`,
    );
  } else {
    console.error('[preview] 启动失败：', error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[preview] http://${HOST}:${PORT}/tools/clip-preview/`);
  console.log(`[preview] 模型：${path.join(ROOT, 'CH0335.glb')}`);
});
