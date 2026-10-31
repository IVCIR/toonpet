/**
 * 只读本地资产协议 `pet-asset:`（ADR 0009 D1 / ADR 0026 D6）。
 *
 * 渲染页是 `file://` + sandbox，Chromium 不支持 `fetch('file://…')`，
 * 因此用一条**只映射固定路由**的自定义 scheme 把模型/图集/表情差分交给渲染进程：
 *   - `pet-asset://asset/model` → 配置里的 .glb
 *   - `pet-asset://asset/mouth` → 配置里的嘴型图集
 *   - `pet-asset://asset/expr/<file>` → 配置里的表情差分目录（**文件名白名单**）
 * 没有目录遍历面（`<file>` 必须是 `EXPRESSION_FILES` 里的固定名字）；
 * 只读本地磁盘，不联网、不承载语义消息，不属于 CONTRACTS §3.5 的模块 IPC 通道。
 */
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXPRESSION_FILES } from '../../shared/expression-files';
import { logInfo, logWarn } from '../log';
import type { AssetConfig } from './asset-config';

export const ASSET_SCHEME = 'pet-asset';
export const ASSET_MODEL_URL = `${ASSET_SCHEME}://asset/model`;
export const ASSET_MOUTH_URL = `${ASSET_SCHEME}://asset/mouth`;

/** 必须在 app ready 之前执行；本模块在 bootstrap 的 import 链里被加载，满足时序。 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let registered = false;

interface Route {
  path: string;
  contentType: string;
}

function routesFor(config: AssetConfig): Route[] {
  return [
    { path: config.modelPath, contentType: 'model/gltf-binary' },
    { path: config.mouthPath, contentType: 'image/png' },
  ];
}

/** `expr/<file>` → 绝对路径；不在白名单里返回 null（杜绝穿越与任意读盘）。 */
export function resolveExpressionRoute(config: AssetConfig, pathname: string): Route | null {
  const match = /^expr\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  const file = match[1]!;
  if (!EXPRESSION_FILES.includes(file)) return null;
  return { path: path.join(config.expressionsDir, file), contentType: 'image/png' };
}

export function registerAssetProtocol(config: AssetConfig): void {
  if (registered) return;
  registered = true;

  const routes = routesFor(config);

  protocol.handle(ASSET_SCHEME, async (request) => {
    let pathname = '';
    try {
      pathname = new URL(request.url).pathname.replace(/^\/+/, '');
    } catch {
      return new Response('bad request', { status: 400 });
    }

    const route =
      pathname === 'model'
        ? routes[0]
        : pathname === 'mouth'
          ? routes[1]
          : resolveExpressionRoute(config, pathname) ?? undefined;
    if (!route) return new Response('not found', { status: 404 });

    try {
      const data = await readFile(route.path);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'content-type': route.contentType,
          'content-length': String(data.byteLength),
          'cache-control': 'no-store',
        },
      });
    } catch (error) {
      logWarn('shell', '资产协议读取失败（渲染侧将走占位/降级回退）', {
        route: pathname,
        path: route.path,
        error: String(error),
      });
      return new Response('not found', { status: 404 });
    }
  });

  logInfo('shell', '资产协议已注册（pet-asset: model / mouth / expr 白名单）', {
    scheme: ASSET_SCHEME,
    modelPath: config.modelPath,
    modelExists: config.modelExists,
    mouthPath: config.mouthPath,
    mouthExists: config.mouthExists,
    expressionsDir: config.expressionsDir,
    expressionsExists: config.expressionsExists,
    expressionFiles: config.expressionFiles,
  });
}
