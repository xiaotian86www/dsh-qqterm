/**
 * 插件操作状态文件
 *
 * 安装 / 更新会 reconcile profile，可能把 qqterm 自己换掉：命令处理器所在的
 * fiber 被 dispose 后，内存里的结果就没了。因此「这一轮在装什么、结果如何、
 * 往哪回」必须落盘，由新 fiber 的 ready 或下一条命令前的补发读回来。
 *
 * 路径按 profile 隔离（`~/.dsh-qqterm/plugin-ops/<sha1(profileDir)>.json`）：
 * web 与开发 profile 常同时开着，共用一份文件会互相覆盖通知与结果。
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import { readJsonFile, writeJsonFile } from '../shared/json-file.ts';
import { formatRelativeTime } from '../shared/utils.ts';
import type { Logger } from '../types.ts';

export type PluginAction = 'install' | 'update' | 'enable' | 'disable';

/** 这一轮的结论；undefined 表示还在跑（只有 startedAt 与 notify） */
export type PluginOpPhase = 'done' | 'failed';

/** 结果通知目标：操作后只剩 targetId 能定位「回复给谁」 */
export interface PluginOpNotice {
  targetId: string;
}

export interface PluginOpState {
  startedAt: number;
  phase?: PluginOpPhase;
  action: PluginAction;
  /** install 的 spec 或 update 的包名：既用于展示，也用于重试按钮 */
  target: string;
  /** 宿主认定的包名（install 完成后才知道；展示优先用它） */
  name?: string;
  notify?: PluginOpNotice;
  /** 装上的版本 */
  version?: string;
  /** 更新前后的版本 */
  from?: string;
  to?: string;
  /** 宿主的 application（applied / restart-required / overridden） */
  application?: string;
  /** 失败原因码（宿主 ManagementError.code 或本模块自造的 pending-builds/timeout） */
  code?: string;
  /** 失败详情（已截断） */
  error?: string;
  /** 被构建脚本策略拦下的包名，需用户显式批准 */
  pendingBuilds?: string[];
  /** 更新失败后是否已装回旧版本 */
  rolledBack?: boolean;
  /** registry 上没有更新的版本 */
  upToDate?: boolean;
}

const STATE_DIR = resolve(PLUGIN_HOME, 'plugin-ops');

/** 状态文件路径（profile 维度，避免多 profile 同时运行时互相覆盖） */
export function pluginOpStatePath(profileDir?: string | null): string {
  const digest = createHash('sha1').update(profileDir ?? '').digest('hex').slice(0, 8);
  return resolve(STATE_DIR, `${digest}.json`);
}

/** 后台检查出来的可更新版本：包名 → 新版本号 */
export interface PluginUpdateCache {
  checkedAt: number;
  versions: Record<string, string>;
}

/** 一次更新检查的结果：手上没有就能回执（手动 `/plugins check` 用，后台检查忽略返回值） */
export interface PluginUpdateCheck {
  /** 本轮参与检查的包数（registry 安装的第三方插件） */
  checked: number;
  /** 可更新的包 → 新版本；查询失败的包沿用上一轮已知结果 */
  versions: Record<string, string>;
  /** 这一轮没查通的包名 */
  failed: string[];
}

/** 检查结果路径：与操作状态同目录，多 profile 各自一份 */
export function pluginUpdateCachePath(profileDir?: string | null): string {
  const digest = createHash('sha1').update(profileDir ?? '').digest('hex').slice(0, 8);
  return resolve(STATE_DIR, `updates-${digest}.json`);
}

/** 读检查结果：文件不存在或损坏当作「还没查过」，列表不显示版本箭头 */
export function readPluginUpdateCache(path: string, logger?: Logger): PluginUpdateCache | undefined {
  const parsed = readJsonFile(path, '插件更新检查结果', logger);
  if (parsed === undefined) return undefined;
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const raw = (parsed as { versions?: unknown }).versions;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const versions: Record<string, string> = {};
  for (const [name, version] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof version === 'string' && version !== '') versions[name] = version;
  }
  const checkedAt = (parsed as { checkedAt?: unknown }).checkedAt;
  return { checkedAt: typeof checkedAt === 'number' ? checkedAt : 0, versions };
}

export function writePluginUpdateCache(path: string, cache: PluginUpdateCache, logger?: Logger): void {
  writeJsonFile(path, cache, { label: '插件更新检查结果', logger });
}

/** 读状态：文件不存在或损坏一律当「没有记录」，不让排障信息挡住主流程 */
export function readPluginOpState(path: string, logger?: Logger): PluginOpState | undefined {
  const parsed = readJsonFile(path, '插件操作状态', logger) as Partial<PluginOpState> | null | undefined;
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const action = parsed.action;
  if (action !== 'install' && action !== 'update' && action !== 'enable' && action !== 'disable') return undefined;
  if (parsed.phase !== undefined && parsed.phase !== 'done' && parsed.phase !== 'failed') return undefined;
  return {
    ...parsed,
    action,
    target: typeof parsed.target === 'string' ? parsed.target : '',
    phase: parsed.phase,
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
  };
}

/** 写状态：原子写，失败只 warn（结果通知丢了也不该挡住命令本身） */
export function writePluginOpState(path: string, state: PluginOpState, logger?: Logger): void {
  writeJsonFile(path, state, { label: '插件操作状态', logger });
}

/** 状态的一句话描述（`/status` 用）；无记录时返回 undefined */
export function describePluginOpState(state: PluginOpState | undefined): string | undefined {
  if (state === undefined) return undefined;
  const when = formatRelativeTime(state.startedAt);
  const label = state.action === 'install' ? '安装'
    : state.action === 'update' ? '更新'
    : state.action === 'enable' ? '启用' : '停用';
  if (state.phase === undefined) return `🔄 ${label}中 · ${when}`;
  if (state.phase === 'failed') return `❌ ${label}失败 · ${when}`;
  return `✅ 已${label} · ${when}`;
}
