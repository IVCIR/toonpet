// 契约 §4.5 的 emotion 有限集合。orchestrator 用它做 LLM 输出校验与台词池校验。
// 该表就是全集：新增一个值 = 契约 minor 升级 + ADR（§4.5）。
import type { Emotion } from './types';

export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'surprised',
  'shy',
  'angry',
  'sleepy',
] as const satisfies readonly Emotion[];

const EMOTION_SET: ReadonlySet<string> = new Set(EMOTIONS);

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === 'string' && EMOTION_SET.has(value);
}
