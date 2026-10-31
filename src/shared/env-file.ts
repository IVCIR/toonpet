/**
 * 极简 `.env` 解析与加载（ADR 0018 D1）。
 *
 * 不引入 dotenv 等第三方依赖：这里只有字符串处理与一次本地文件读取，
 * 不联网、不执行、不探测任何外部服务（契约 §10.1）。
 *
 * 语义（与 Node 原生 `--env-file` / `process.loadEnvFile()` 对齐）：
 * 1. 只接受 `KEY=VALUE`；空行与 `#` 注释忽略；允许 `export KEY=VALUE` 写法。
 * 2. 值两端的单/双引号会被剥掉；双引号内支持 `\n` `\r` `\t` `\\` `\"` 转义。
 * 3. 未加引号的值遇到"空白 + #"即视为行尾注释。
 * 4. 文件内同名键 = 后者覆盖前者（与 dotenv 一致）。
 * 5. **进程环境变量优先**：`process.env` 里已存在的键默认不覆盖。
 *    这样 `setx`、终端临时变量与自检注入（`scripts/start.mjs`）永远压过 `.env`，
 *    `.env` 只补空缺。
 */
import { readFileSync } from 'node:fs';

export interface EnvEntry {
  key: string;
  value: string;
  /** 1 基行号，用于诊断 */
  line: number;
}

export interface EnvParseIssue {
  line: number;
  reason: string;
}

export interface ParsedEnv {
  entries: EnvEntry[];
  issues: EnvParseIssue[];
}

export interface EnvLoadResult {
  path: string;
  exists: boolean;
  /** 本次从 `.env` 写进环境变量的键（只记键名，不记值） */
  applied: string[];
  /** 因进程环境变量已存在而保留原值的键 */
  kept: string[];
  issues: EnvParseIssue[];
  /** 读取失败（权限/编码等）；文件不存在不算错误 */
  error: string | null;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ESCAPE_PATTERN = /\\([nrt"\\])/g;

function unescapeDoubleQuoted(value: string): string {
  return value.replace(ESCAPE_PATTERN, (_match, escaped: string) => {
    switch (escaped) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return escaped;
    }
  });
}

interface ValueResult {
  value: string;
  issue?: string;
}

/** 解析 `=` 右侧：引号包裹、行尾注释、转义。 */
function parseValue(raw: string): ValueResult {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    for (let index = 1; index < raw.length; index += 1) {
      const char = raw[index];
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === '\\') {
        escaped = true;
        continue;
      }
      if (char !== quote) continue;

      const inner = raw.slice(1, index);
      const rest = raw.slice(index + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) {
        return { value: inner, issue: '引号后还有多余内容（已忽略）' };
      }
      return { value: quote === '"' ? unescapeDoubleQuoted(inner) : inner };
    }
    return { value: raw.slice(1).trim(), issue: '引号未闭合（按字面值处理）' };
  }

  // 未加引号：` #` 之后是注释
  const commentAt = raw.search(/\s#/);
  const value = commentAt >= 0 ? raw.slice(0, commentAt) : raw;
  return { value: value.trim() };
}

/** 纯函数：把 `.env` 文本解析成键值对。无法解析的行进 `issues`，不抛异常。 */
export function parseEnvText(text: string): ParsedEnv {
  const entries: EnvEntry[] = [];
  const issues: EnvParseIssue[] = [];

  if (typeof text !== 'string') {
    return { entries, issues: [{ line: 0, reason: '文件内容不是字符串' }] };
  }

  // BOM 与 CRLF：Windows 记事本写出的文件很常见
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const trimmed = lines[index].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const assignment = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equalsAt = assignment.indexOf('=');
    if (equalsAt <= 0) {
      issues.push({ line, reason: '不是 KEY=VALUE' });
      continue;
    }

    const key = assignment.slice(0, equalsAt).trim();
    if (!KEY_PATTERN.test(key)) {
      issues.push({ line, reason: `非法键名：${key.slice(0, 40)}` });
      continue;
    }

    const parsed = parseValue(assignment.slice(equalsAt + 1).trim());
    if (parsed.issue) issues.push({ line, reason: `${key}：${parsed.issue}` });
    entries.push({ key, value: parsed.value, line });
  }

  return { entries, issues };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * 读取 `.env` 并补齐环境变量。
 *
 * @param filePath `.env` 的绝对路径
 * @param env 目标环境对象（默认 `process.env`，测试可注入）
 * @param options.override 为 true 时 `.env` 覆盖已有变量（默认 false：环境变量优先）
 */
export function loadEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { override?: boolean } = {},
): EnvLoadResult {
  const override = options.override === true;
  const base: EnvLoadResult = {
    path: filePath,
    exists: false,
    applied: [],
    kept: [],
    issues: [],
    error: null,
  };

  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return base;
    return { ...base, exists: true, error: describeError(error) };
  }

  const parsed = parseEnvText(text);

  // 文件内重复键：后者覆盖前者（与 dotenv 一致）
  const deduped = new Map<string, string>();
  for (const entry of parsed.entries) deduped.set(entry.key, entry.value);

  const applied: string[] = [];
  const kept: string[] = [];
  for (const [key, value] of deduped) {
    if (env[key] !== undefined && !override) {
      kept.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  return {
    path: filePath,
    exists: true,
    applied,
    kept,
    issues: parsed.issues,
    error: null,
  };
}
