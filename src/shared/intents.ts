// 契约 §4.4 的 intent 有限集合。render 用它做校验，orchestrator 后续也复用它。
// 该表就是全集：新增一个值 = 契约 minor 升级 + ADR（§4.4 规则）。
import type { Intent } from './types';

export const INTENTS = [
  'none',
  'greet',
  'nod',
  'shake_head',
  'tilt_head',
  'look_at_user',
  'pat_react',
  'happy_hop',
] as const satisfies readonly Intent[];

const INTENT_SET: ReadonlySet<string> = new Set(INTENTS);

export function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && INTENT_SET.has(value);
}
