/**
 * 资产路径解析（ADR 0009 D1.3）。
 *
 * 默认取工程根目录下的模型与嘴型图集；可用 `PET_MODEL_PATH` / `PET_MOUTH_ATLAS`
 * 覆盖（相对路径按 appRoot 解析）。取景排除正则可用 `PET_FRAME_EXCLUDE` 覆盖，
 * 该字符串会原样传给渲染侧，保证两侧用同一份规则（ADR 0009 D3.3）。
 *
 * 配件隐藏（`PET_HIDE_ATTACHMENTS`，ADR 0014 D5）默认与取景排除同源；
 * 显式覆盖成不同正则时属于配置风险，由 shell 记一条 WARN。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_HIDE_ATTACHMENTS } from '../../shared/attachments';
import { EXPRESSION_FILES } from '../../shared/expression-files';
import { DEFAULT_FRAME_EXCLUDE } from '../../shared/model-frame';

export const DEFAULT_MODEL_FILE = 'CH0335.glb';
export const DEFAULT_MOUTH_ATLAS_FILE = 'Character_Mouth_Black-Due3Gpre.png';
/** 官方表情差分目录（ADR 0026 D6）；不存在时表情系统降级为"只变嘴型" */
export const DEFAULT_EXPRESSIONS_DIR = 'data/expressions';

export interface AssetConfig {
  appRoot: string;
  modelPath: string;
  mouthPath: string;
  modelExists: boolean;
  mouthExists: boolean;
  /** 官方表情差分目录（`PET_EXPRESSIONS_DIR` 可覆盖） */
  expressionsDir: string;
  expressionsExists: boolean;
  /** 目录里实际存在的差分文件（白名单内的），用于启动日志与 doctor */
  expressionFiles: string[];
  /** 取景排除正则（主进程与渲染侧共用同一个字符串） */
  frameExclude: string;
  /** 装配期配件隐藏正则（默认与 `frameExclude` 同源，ADR 0014 D5） */
  hideAttachments: string;
  modelSource: 'env' | 'default';
  mouthSource: 'env' | 'default';
  hideSource: 'env' | 'frame-exclude' | 'default';
}

function pickEnv(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePath(value: string, appRoot: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(appRoot, value);
}

export function resolveAssetConfig(
  appRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): AssetConfig {
  const modelEnv = pickEnv(env['PET_MODEL_PATH']);
  const mouthEnv = pickEnv(env['PET_MOUTH_ATLAS']);
  const excludeEnv = pickEnv(env['PET_FRAME_EXCLUDE']);
  const hideEnv = pickEnv(env['PET_HIDE_ATTACHMENTS']);
  const expressionsEnv = pickEnv(env['PET_EXPRESSIONS_DIR']);

  const modelPath = resolvePath(modelEnv ?? DEFAULT_MODEL_FILE, appRoot);
  const mouthPath = resolvePath(mouthEnv ?? DEFAULT_MOUTH_ATLAS_FILE, appRoot);
  const expressionsDir = resolvePath(expressionsEnv ?? DEFAULT_EXPRESSIONS_DIR, appRoot);

  const frameExclude = excludeEnv ?? DEFAULT_FRAME_EXCLUDE;
  // 缺省与取景排除同源：默认隐藏的正是取景时排除的那些配件（ADR 0014 D5）。
  const hideAttachments = hideEnv ?? excludeEnv ?? DEFAULT_HIDE_ATTACHMENTS;

  return {
    appRoot,
    modelPath,
    mouthPath,
    modelExists: existsSync(modelPath),
    mouthExists: existsSync(mouthPath),
    expressionsDir,
    expressionsExists: existsSync(expressionsDir),
    expressionFiles: listExpressionFiles(expressionsDir),
    frameExclude,
    hideAttachments,
    modelSource: modelEnv ? 'env' : 'default',
    mouthSource: mouthEnv ? 'env' : 'default',
    hideSource: hideEnv ? 'env' : excludeEnv ? 'frame-exclude' : 'default',
  };
}

/** 只列出白名单内且确实存在的差分文件（不做目录遍历，不猜名字）。 */
function listExpressionFiles(dir: string): string[] {
  return EXPRESSION_FILES.filter((file) => existsSync(path.join(dir, file)));
}
