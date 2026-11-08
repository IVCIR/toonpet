/**
 * 角色卡文件（`data/character-card.md`）的读写（ADR 0053）。
 *
 * 为什么单独成模块：控制面板要"读原文 → 编辑 → 原子写回"，而 `runtime` 要"读一次注入 system 段"。
 * 两处必须是同一条路径、同一套归一化（BOM / CRLF / 尾随空白），否则面板显示的字数会和
 * 实际注入的正文对不上，用户会以为保存失败了。
 *
 * 三条边界：
 * - **不解析人格**：角色卡是自由文本，这里只做字节层归一化，不认识"人格/语气"这些概念；
 * - **不做热更新广播**：写盘成功后由调用方（面板控制器）通知 `runtime` 换掉内存里的 card；
 * - **空卡允许存在但不能保存**：删空文件等于让她失去身份，保存时直接拒绝并给出可读原因。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PANEL_CARD_MAX_CHARS } from '../shared/constants';

/**
 * 角色卡缺失时的最小身份行（不编造人格细节，只保证 LLM 有基本口吻）。
 * 与 ADR 0015 D1.8 的降级口径一致：读不到就用它，不阻断对话。
 */
export const MINIMAL_CHARACTER_CARD =
  '你是天童凯伊，千年科学学园的学生，曾与爱丽丝共用同一人格。请用平实、克制、略带傲娇的语气回答，称呼用户为“老师”。';

export interface CharacterCardRead {
  ok: boolean;
  exists: boolean;
  /** 归一化后的字符数（`[...text].length`，与面板显示一致） */
  chars: number;
  /** 归一化后的正文（不存在/读失败时为空串） */
  text: string;
  error: string | null;
}

export interface CharacterCardWrite {
  ok: boolean;
  chars: number;
  /** 写回并归一化后的正文（成功时） */
  text: string;
  error: string | null;
}

/**
 * 归一化：去 BOM（Windows 记事本会写）、CRLF/CR → LF、去掉首尾空白。
 * **不**动正文内部的空行与缩进——那是作者写给人格看的排版。
 */
export function normalizeCardText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function readCharacterCard(filePath: string): CharacterCardRead {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const text = normalizeCardText(raw);
    return { ok: true, exists: true, chars: [...text].length, text, error: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, exists: false, chars: 0, text: '', error: '角色卡文件不存在' };
    }
    return {
      ok: false,
      exists: false,
      chars: 0,
      text: '',
      error: `角色卡读取失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 原子写：先写 `.tmp` 再 `rename`。
 *
 * 拒绝三种输入：空正文（等于删除人格）、超过 `PANEL_CARD_MAX_CHARS`（每一轮 prompt 都会变长）、
 * 路径不是绝对路径（避免写到相对 cwd 的意外位置）。
 */
export function writeCharacterCard(
  filePath: string,
  raw: unknown,
  options: { maxChars?: number } = {},
): CharacterCardWrite {
  const maxChars = options.maxChars ?? PANEL_CARD_MAX_CHARS;
  if (typeof filePath !== 'string' || filePath.trim() === '' || !path.isAbsolute(filePath)) {
    return { ok: false, chars: 0, text: '', error: '角色卡路径必须是绝对路径' };
  }
  const text = normalizeCardText(raw);
  const chars = [...text].length;
  if (chars === 0) {
    return { ok: false, chars: 0, text: '', error: '角色卡不能为空（可以把内容改成别的，但不能删光）' };
  }
  if (chars > maxChars) {
    return {
      ok: false,
      chars,
      text,
      error: `角色卡太长：${chars} 字，上限 ${maxChars} 字`,
    };
  }
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, `${text}\n`, 'utf8');
    renameSync(temporary, filePath);
    return { ok: true, chars, text, error: null };
  } catch (error) {
    return {
      ok: false,
      chars,
      text,
      error: `角色卡写入失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
