/**
 * 控制面板的持久化（ADR 0052 D5；ADR 0053 扩展到本地模型）。
 *
 * 文件：`<appRoot>/config.json`（可用 `PET_PANEL_CONFIG` 覆盖，自检/截图脚本用）。
 *
 * ```json
 * {
 *   "version": 1,
 *   "updatedAt": "2026-11-06T03:12:44.120Z",
 *   "tuning": { "sit.phaseAHeadTuneRad": -0.12 },
 *   "llm": { "model": "qwen3:4b" }
 * }
 * ```
 *
 * 设计要点：
 * - **只写与默认值不同的项**（`diffTunableValues`）：用户没动过的参数不冻结进文件，
 *   以后改 `constants.ts` 的默认值仍然生效。
 * - **只动 `version` / `updatedAt` / `tuning` / `llm` 四个键**：写回时保留未知顶层键
 *   （本文件不解析它们，也不删除它们）。
 * - **坏文件不阻断启动**：解析失败只返回 `error`，调用方用默认值继续（§11 的降级口径）。
 * - 写入先写临时文件再 `rename`，避免半截 JSON 把下次启动打成"配置损坏"。
 * - ADR 0053：`llm.model` 是**模型选择的唯一持久化位置**。`PET_LLM_MODEL` 仍是默认值来源，
 *   `config.json` 只在用户从面板里选过模型后才覆盖它（所以"没选过"与"选回默认值"看到的行为一致）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PANEL_MODEL_NAME_MAX_CHARS } from '../shared/constants';
import {
  LLM_PROVIDER_MAX_COUNT,
  isValidProviderId,
  sanitizeProviderConfig,
  type LlmProviderConfig,
} from '../shared/llm-providers';
import {
  clampTunableValue,
  diffTunableValues,
  isTunableId,
  TUNABLE_ORDER,
} from '../shared/tunable-params';
import type { TunableValues } from '../shared/tunable-params';

export const PANEL_CONFIG_VERSION = 1;
/** `config.json` 的默认文件名（相对工程根目录） */
export const PANEL_CONFIG_FILENAME = 'config.json';

export interface PanelConfigState {
  /** 从文件读到的覆盖值（只含合法、且在范围内的项） */
  tuning: Partial<TunableValues>;
  /** 从 `llm.model` 读到的模型名（ADR 0053 的旧格式）；缺失/非法为 `null` */
  llmModel: string | null;
  /** ADR 0055：提供商列表（空数组 = 还没配置，运行时用默认本地 Ollama） */
  llmProviders: LlmProviderConfig[];
  /** ADR 0055：当前激活的提供商 id；缺失/非法为 `null` */
  llmActiveProvider: string | null;
  /** 文件里的 `updatedAt`；缺失或非法为 `null` */
  savedAt: string | null;
  /** 读取/解析失败的可读原因；成功为 `null` */
  error: string | null;
  /** 文件是否存在 */
  exists: boolean;
}

/** 要写回文件的一组值。`llmProviders` 省略/为 `null` 时写回旧格式（或移除 `llm` 键） */
export interface PanelConfigWrite {
  values: TunableValues;
  llmModel?: string | null;
  /** 非空时写 `llm.providers` + `llm.activeProvider`（ADR 0055 新格式） */
  llmProviders?: LlmProviderConfig[] | null;
  llmActiveProvider?: string | null;
}

export const EMPTY_PANEL_CONFIG: PanelConfigState = {
  tuning: {},
  llmModel: null,
  llmProviders: [],
  llmActiveProvider: null,
  savedAt: null,
  error: null,
  exists: false,
};

/**
 * 模型名白名单：Ollama 的 `[namespace/]name[:tag]` 形态。
 *
 * 逐段限制而不是"允许一堆字符"是刻意的：`http://evil/x` 这种输入必须在这里被拒绝，
 * 否则面板的一次 IPC 就能把 `llm.model` 写成任意 URL（§10.2 的"只连回环"会被绕过）。
 */
const MODEL_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function isValidModelName(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (value === '' || value.length > PANEL_MODEL_NAME_MAX_CHARS) return false;
  return MODEL_NAME_PATTERN.test(value);
}

/**
 * 配置文件绝对路径。
 *
 * 优先级：`PET_PANEL_CONFIG`（绝对路径或相对工程根）> `<appRoot>/config.json`。
 * 允许覆盖的唯一理由是截图/自检必须**不污染**用户真实配置（脚本会先备份再还原）。
 */
export function resolvePanelConfigPath(appRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env['PET_PANEL_CONFIG'];
  if (typeof override === 'string' && override.trim() !== '') {
    return path.isAbsolute(override) ? override : path.join(appRoot, override.trim());
  }
  return path.join(appRoot, PANEL_CONFIG_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析 `config.json` 的文本。任何异常都折算成 `error`，**不抛**。 */
export function parsePanelConfig(raw: string): PanelConfigState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      tuning: {},
      llmModel: null,
      llmProviders: [],
      llmActiveProvider: null,
      savedAt: null,
      error: `config.json 不是合法 JSON：${String(error)}`,
      exists: true,
    };
  }
  if (!isRecord(parsed)) {
    return {
      tuning: {},
      llmModel: null,
      llmProviders: [],
      llmActiveProvider: null,
      savedAt: null,
      error: 'config.json 顶层不是对象',
      exists: true,
    };
  }

  const tuningRaw = isRecord(parsed['tuning']) ? parsed['tuning'] : {};
  const tuning: Partial<TunableValues> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(tuningRaw)) {
    if (!isTunableId(key)) {
      rejected.push(key);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      rejected.push(key);
      continue;
    }
    tuning[key] = clampTunableValue(key, value);
  }

  let llmModel: string | null = null;
  const llmRaw = parsed['llm'];
  const providers: LlmProviderConfig[] = [];
  let activeProvider: string | null = null;
  if (isRecord(llmRaw)) {
    if ('model' in llmRaw) {
      const candidate = llmRaw['model'];
      if (isValidModelName(candidate)) llmModel = candidate.trim();
      else rejected.push('llm.model');
    }
    // ADR 0055：提供商列表。逐项清洗；坏的只跳过并记录，不影响旧格式与启动。
    const providersRaw = llmRaw['providers'];
    if (Array.isArray(providersRaw)) {
      const seen = new Set<string>();
      for (const [index, entry] of providersRaw.entries()) {
        if (!isRecord(entry)) {
          rejected.push(`llm.providers[${index}]`);
          continue;
        }
        const id = entry['id'];
        if (providers.length >= LLM_PROVIDER_MAX_COUNT) {
          rejected.push(`llm.providers[${index}]（超过上限 ${LLM_PROVIDER_MAX_COUNT} 个）`);
          continue;
        }
        if (!isValidProviderId(id) || seen.has(id)) {
          rejected.push(`llm.providers[${index}].id`);
          continue;
        }
        const sanitized = sanitizeProviderConfig(entry, { id, previous: null });
        if (!sanitized.ok) {
          rejected.push(`llm.providers[${index}]（${sanitized.error}）`);
          continue;
        }
        seen.add(id);
        providers.push(sanitized.provider);
      }
      const activeRaw = llmRaw['activeProvider'];
      if (typeof activeRaw === 'string' && providers.some((entry) => entry.id === activeRaw)) {
        activeProvider = activeRaw;
      } else if (activeRaw !== undefined) {
        rejected.push('llm.activeProvider');
      }
    }
  }

  const savedAtRaw = parsed['updatedAt'];
  const savedAt =
    typeof savedAtRaw === 'string' && Number.isFinite(Date.parse(savedAtRaw)) ? savedAtRaw : null;

  const error =
    rejected.length > 0 ? `config.json 里有 ${rejected.length} 项被忽略：${rejected.join(', ')}` : null;
  return {
    tuning,
    llmModel,
    llmProviders: providers,
    llmActiveProvider: activeProvider,
    savedAt,
    error,
    exists: true,
  };
}

/** 读文件；不存在不算错误（首次运行就是没有这个文件）。 */
export function readPanelConfigFile(filePath: string): PanelConfigState {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ...EMPTY_PANEL_CONFIG };
    return {
      tuning: {},
      llmModel: null,
      llmProviders: [],
      llmActiveProvider: null,
      savedAt: null,
      error: `config.json 读取失败：${String(error)}`,
      exists: false,
    };
  }
  return parsePanelConfig(raw);
}

/**
 * 生成写盘文本：保留未知顶层键，只覆盖 `version` / `updatedAt` / `tuning` / `llm`。
 * `previousRaw` 是本文件当前内容（可能不存在）；解析失败时按"空对象 + 覆盖"处理。
 */
export function serializePanelConfig(
  next: PanelConfigWrite,
  savedAt: string,
  previousRaw?: string | null,
): string {
  const base: Record<string, unknown> = {};
  if (typeof previousRaw === 'string' && previousRaw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(previousRaw);
      if (isRecord(parsed)) Object.assign(base, parsed);
    } catch {
      // 坏文件被"修复"成合法 JSON 是刻意的：下一次启动不该继续报同一个错
    }
  }

  const tuning = diffTunableValues(next.values);
  const llmModel =
    typeof next.llmModel === 'string' && next.llmModel.trim() !== '' ? next.llmModel.trim() : null;
  const providers = Array.isArray(next.llmProviders) ? next.llmProviders : [];
  let llm: Record<string, unknown> | null = null;
  if (providers.length > 0) {
    const ids = providers.map((entry) => entry.id);
    const active =
      typeof next.llmActiveProvider === 'string' && ids.includes(next.llmActiveProvider)
        ? next.llmActiveProvider
        : providers[0]?.id ?? null;
    llm = { activeProvider: active, providers };
  } else if (llmModel !== null) {
    llm = { model: llmModel };
  }

  // 键顺序固定：先 version / updatedAt / tuning / llm，未知键排在后面（便于人工读 diff）
  const out: Record<string, unknown> = {
    version: PANEL_CONFIG_VERSION,
    updatedAt: savedAt,
    tuning,
  };
  if (llm !== null) out['llm'] = llm;
  for (const [key, value] of Object.entries(base)) {
    if (key === 'version' || key === 'updatedAt' || key === 'tuning' || key === 'llm') continue;
    out[key] = value;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** 写盘（临时文件 + rename）。失败只返回错误，不抛。 */
export function writePanelConfigFile(
  filePath: string,
  next: PanelConfigWrite,
  savedAt: string,
): { ok: boolean; error: string | null } {
  let previousRaw: string | null = null;
  try {
    previousRaw = readFileSync(filePath, 'utf8');
  } catch {
    previousRaw = null;
  }
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, serializePanelConfig(next, savedAt, previousRaw), 'utf8');
    renameSync(temporary, filePath);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: `config.json 写入失败：${String(error)}` };
  }
}

/** 与默认值不同的项数（面板上"已改 N 项"的读数） */
export function countCustomized(values: TunableValues): number {
  return Object.keys(diffTunableValues(values)).length;
}

/** 面板显示顺序（供 UI 与日志共用；顺序的唯一出处仍是 `shared/tunable-params.ts`） */
export const PANEL_TUNING_ORDER: readonly string[] = TUNABLE_ORDER;
