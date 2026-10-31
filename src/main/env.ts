/**
 * 工程根目录 `.env` 的装配入口（ADR 0018 D1）。
 *
 * 为什么单开一个文件：
 * - `bootstrap()` 里只留一行调用，保证"最早时机"这件事在入口处一眼可见；
 * - 日志只记键名、不记值（参考文本等可能含个人信息），也不会把 `.env` 内容写进 `pet.log`。
 *
 * 位置：`<appRoot>/.env`。`appRoot` 默认取 `app.getAppPath()`（开发期就是工程根目录）。
 * 打包/安装形态不在本期目标内（契约 §13 X-8），因此不做 asar 内的特殊处理。
 */
import path from 'node:path';
import { app } from 'electron';
import { loadEnvFile } from '../shared/env-file';
import type { EnvLoadResult } from '../shared/env-file';
import { logInfo, logWarn } from './log';

export const ENV_FILE_NAME = '.env';

export interface ProjectEnvReport {
  path: string;
  exists: boolean;
  applied: string[];
  kept: string[];
  error: string | null;
}

/** 读取 `.env` 并补齐进程环境变量（已存在的变量优先，不覆盖）。永不抛异常。 */
export function loadProjectEnv(appRoot?: string): ProjectEnvReport {
  let root = appRoot;
  if (root === undefined) {
    // app.getAppPath() 在 app.ready 前通常可用；极端启动方式下不可用时退回 cwd，
    // 配置读取失败绝不能把桌宠挡在启动之外。
    try {
      root = app.getAppPath();
    } catch {
      root = process.cwd();
    }
  }
  const envPath = path.join(root, ENV_FILE_NAME);

  let result: EnvLoadResult;
  try {
    result = loadEnvFile(envPath);
  } catch (error) {
    // loadEnvFile 自身不抛；这里只是兜底，保证启动不被配置读取拖垮
    logWarn('main', '.env 加载异常（继续使用进程环境变量与默认值）', {
      path: envPath,
      error: String(error),
    });
    return { path: envPath, exists: false, applied: [], kept: [], error: String(error) };
  }

  if (result.error) {
    logWarn('main', '.env 读取失败（继续使用进程环境变量与默认值）', {
      path: envPath,
      error: result.error,
    });
    return { path: envPath, exists: result.exists, applied: [], kept: [], error: result.error };
  }

  if (!result.exists) {
    logInfo('main', '未找到 .env：只使用进程环境变量与默认值', { path: envPath });
    return { path: envPath, exists: false, applied: [], kept: [], error: null };
  }

  logInfo('main', '.env 已加载（进程环境变量优先）', {
    path: envPath,
    applied: result.applied,
    kept: result.kept,
  });
  if (result.issues.length > 0) {
    logWarn('main', '.env 有无法解析的行（已忽略）', { issues: result.issues });
  }

  return {
    path: envPath,
    exists: true,
    applied: result.applied,
    kept: result.kept,
    error: null,
  };
}
