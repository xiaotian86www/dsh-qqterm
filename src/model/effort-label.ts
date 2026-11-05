/**
 * 思考强度档位的中文展示名
 *
 * 宿主 adapter 给出的 name 是英文（Off / Low / High / Max），QQ 侧统一用中文短名；
 * 未知 id 沿用 adapter 的 name，不猜。
 */
import type { EffortOption } from './types.ts';

/** 常见档位 id → 中文短名（对齐 DeepSeek adapter 的 off/low/high/max） */
const EFFORT_LABELS: Record<string, string> = {
  off: '关闭',
  none: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  mid: '中',
  high: '高',
  max: '最高',
  xhigh: '极高',
};

/** 档位展示名：已知 id 用中文，其余沿用 adapter 的 name */
export function effortLabel(effort: Pick<EffortOption, 'id' | 'name'>): string {
  return EFFORT_LABELS[effort.id] ?? effort.name;
}
