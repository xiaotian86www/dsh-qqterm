/**
 * 热重载状态文件
 *
 * 重载会 dispose 当前 fiber：命令处理器写下的「通知谁、什么时候开始」在内存里
 * 活不过一次 dispose，结果也只能靠落盘传给新 fiber。因此状态文件是这条链路
 * 唯一的事实来源，只存那一轮重载最必要的事实。
 *
 * 路径按 profile 隔离（`~/.dsh-qqterm/reload/<sha1(profileDir)>.json`）：web 与
 * 开发 profile 经常同时开着，共用一份文件会互相覆盖 notify 与结果。
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';
import { errorText, formatRelativeTime } from '../shared/utils.ts';
import type { Logger } from '../types.ts';

export { errorText };

export type ReloadPhase = 'done' | 'failed';

/** 重载结果的通知目标：重载后只剩 targetId 能定位「回复给谁」 */
export interface ReloadNotice {
  targetId: string;
}

export interface ReloadState {
  /** 这一轮的结论；undefined 表示还没跑完（只有 startedAt 与 notify） */
  phase?: ReloadPhase;
  /** 这一轮重载的发起时间（毫秒） */
  startedAt: number;
  notify?: ReloadNotice;
  /** 这一轮实际被替换的 entry（空数组 = 没有任何变化）；undefined = 判不出来 */
  replaced?: string[];
  /** `reconcileProfile` 返回值里的重启原因：非空表示部分改动要重启才生效 */
  restartReason?: string;
  /** 失败原因（已截断） */
  error?: string;
}

const STATE_DIR = resolve(PLUGIN_HOME, 'reload');

/** 状态文件路径（profile 维度，避免多 profile 同时运行时互相覆盖） */
export function reloadStatePath(profileDir?: string | null): string {
  const digest = createHash('sha1').update(profileDir ?? '').digest('hex').slice(0, 8);
  return resolve(STATE_DIR, `${digest}.json`);
}

/** 读状态：文件不存在或损坏一律当「没有记录」，不让排障信息挡住重载主流程 */
export function readReloadState(path: string, logger?: Logger): ReloadState | undefined {
  const parsed = readJsonFile(path, '热重载状态', logger) as Partial<ReloadState> | null | undefined;
  if (parsed === null || typeof parsed !== 'object') return undefined;
  if (parsed.phase !== undefined && parsed.phase !== 'done' && parsed.phase !== 'failed') {
    return undefined;
  }
  return {
    ...parsed,
    phase: parsed.phase,
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
  };
}

/** 写状态：原子写，失败只 warn（结果通知丢了也不该挡住重载本身） */
export function writeReloadState(path: string, state: ReloadState, logger?: Logger): void {
  writeJsonFile(path, state, { label: '热重载状态', logger });
}

/** 状态的一句话描述（`/status` 用）；无记录时返回 undefined */
export function describeReloadState(state: ReloadState | undefined): string | undefined {
  if (state === undefined) return undefined;
  const when = formatRelativeTime(state.startedAt);
  if (state.phase === undefined) return `🔄 进行中 · ${when}`;
  if (state.phase === 'failed') return `❌ 失败 · ${when}`;
  return state.restartReason === undefined
    ? `✅ 已应用 · ${when}`
    : `⚠️ 已应用，部分改动需重启 · ${when}`;
}
