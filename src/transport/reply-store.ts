/**
 * 被动回复凭证存储 — msg_id / event_id 的唯一事实源。
 *
 * QQ 的被动回复只认两种凭证：用户消息的 msg_id、按钮回调的 event_id。
 * 二者都受平台窗口（私聊 30 分钟）与「同一条消息最多回 N 次」的限制。
 * 这套状态以前拆在 msgid-cache（内存）与 reply-limiter（计数）里，重启即丢；
 * 这里合并成一份，并把 msg_id 连同用量一起落盘：
 *   - 落盘的是「还能用的被动凭证」，不是历史记录，载入时按 TTL 过滤；
 *   - event_id 只在内存里：平台没有承诺它跨重启可复用，落盘只会拿到失效 id；
 *   - 用量必须跟 id 一起落盘，否则重启后配额从 0 开始算，更容易撞平台限制。
 *
 * 写入是同步的（消息路径上完成，不依赖卸载钩子——强杀/崩溃时钩子不执行）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';

/** 解析结果：在「发给谁」之上补被动凭证，只有装饰层看得到 */
export interface ResolvedReplyTarget extends ReplyTarget {
  msgId?: string;
  /** 带 INTERACTION_CREATE 前缀的完整事件 id，与 msgId 互斥 */
  eventId?: string;
}

/** 被动回复凭证类型 */
export type ReplyIdKind = 'msg' | 'event';

/** 一条被动回复凭证（内存形态） */
interface ReplyEntry {
  kind: ReplyIdKind;
  /** msg: 消息 id；event: 带 INTERACTION_CREATE 前缀的完整事件 id */
  id: string;
  /** 收到时间，用于平台被动窗口判断 */
  at: number;
  /** 已用的被动回复次数 */
  used: number;
  /** 首次被动回复时间，用于计数窗口判断 */
  firstUsedAt?: number;
}

/** 落盘形态：只存 msg（event 不落盘） */
interface PersistedEntry {
  id: string;
  at: number;
  used?: number;
  firstUsedAt?: number;
}

interface PersistedTarget {
  ids?: PersistedEntry[];
}

interface PersistedFile {
  version?: number;
  targets?: Record<string, PersistedTarget>;
}

export interface ReplyStoreOptions {
  appId: string;
  logger: Logger;
  /** 落盘路径，默认 ~/.dsh-qqbot/reply-ids.json */
  file?: string;
  /** 平台被动回复窗口，默认 30 分钟 */
  ttlMs?: number;
  /** 同一条凭证最多回几次，默认 4（留 1 次余量） */
  limit?: number;
  /** 每个 target 保留几条候选，默认 3 */
  keepPerTarget?: number;
  /** 最多跟踪多少个 target，默认 200 */
  maxTargets?: number;
  /** 时间源，测试用 */
  now?: () => number;
}

const EVENT_PREFIX = 'INTERACTION_CREATE:';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LIMIT = 4;
const DEFAULT_KEEP_PER_TARGET = 3;
const DEFAULT_MAX_TARGETS = 200;

/** 默认落盘路径 */
export function defaultReplyStorePath(): string {
  return resolve(PLUGIN_HOME, 'reply-ids.json');
}

/**
 * 被动回复凭证存储。
 *
 * 单例由 gateway 创建并交给 reply-bot 装饰器；所有发送都从这里拿凭证，
 * 不再各自维护缓存。
 */
export class ReplyStore {
  private readonly appId: string;
  private readonly logger: Logger;
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly limit: number;
  private readonly keep: number;
  private readonly maxTargets: number;
  private readonly now: () => number;
  /** key = `${appId}:${scope}:${targetId}`，value 按收到时间升序 */
  private readonly targets = new Map<string, ReplyEntry[]>();

  public constructor(options: ReplyStoreOptions) {
    this.appId = options.appId;
    this.logger = options.logger;
    this.file = options.file ?? defaultReplyStorePath();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.keep = options.keepPerTarget ?? DEFAULT_KEEP_PER_TARGET;
    this.maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS;
    this.now = options.now ?? Date.now;
    this.load();
  }

  /** 记录一条入站消息的 msgId（会落盘） */
  public recordMessage(scope: ChatScope, targetId: string | undefined, msgId: string | undefined): void {
    if (!targetId || !msgId) return;
    this.push(scope, targetId, { kind: 'msg', id: msgId, at: this.now(), used: 0 });
    this.persist();
  }

  /** 记录一次互动事件的 eventId（只在内存，不落盘） */
  public recordEvent(scope: ChatScope, targetId: string | undefined, eventId: string | undefined): void {
    if (!targetId || !eventId) return;
    this.push(scope, targetId, {
      kind: 'event',
      id: `${EVENT_PREFIX}${eventId}`,
      at: this.now(),
      used: 0,
    });
  }

  /**
   * 解析出一条可用的被动回复目标。
   *
   * 候选按收到时间倒序，事件候选只在 allowEvent 时参与。全部不可用则返回
   * 不带凭证的 target，发送层据此降级为主动推送。
   *
   * 解析成功即记一次用量（与旧实现的 limiter.record 时机一致）。
   */
  public resolve(target: ReplyTarget, allowEvent: boolean): ResolvedReplyTarget {
    const candidate = this.pick(target, allowEvent);
    if (candidate === undefined) return { scope: target.scope, targetId: target.targetId };
    this.markUsed(candidate);
    return candidate.kind === 'event'
      ? { scope: target.scope, targetId: target.targetId, eventId: candidate.id }
      : { scope: target.scope, targetId: target.targetId, msgId: candidate.id };
  }

  /** 当前是否还有可用凭证（只查询，不计用量）；流式等能力判断用 */
  public canReply(target: ReplyTarget, allowEvent = false): boolean {
    return this.pick(target, allowEvent) !== undefined;
  }

  /** 清理运行时资源（当前无定时器，保留给后续扩展） */
  public dispose(): void {
    this.targets.clear();
  }

  // ── 内部 ──

  private key(scope: ChatScope, targetId: string): string {
    return `${this.appId}:${scope}:${targetId}`;
  }

  /** 写入候选；同 id 重复记录时只刷新时间，不重置用量 */
  private push(scope: ChatScope, targetId: string, entry: ReplyEntry): void {
    const key = this.key(scope, targetId);
    const list = this.targets.get(key) ?? [];
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      const previous = list[index]!;
      list.splice(index, 1);
      list.push({ ...previous, at: entry.at });
    } else {
      list.push(entry);
    }
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    // 重新插入，让 Map 的淘汰顺序反映最近活跃
    this.targets.delete(key);
    this.targets.set(key, list);
    if (this.targets.size > this.maxTargets) {
      const oldest = this.targets.keys().next().value;
      if (oldest !== undefined) this.targets.delete(oldest);
    }
  }

  /** 当前仍可用的候选（过滤平台窗口） */
  private live(scope: ChatScope, targetId: string): ReplyEntry[] {
    const key = this.key(scope, targetId);
    const list = this.targets.get(key);
    if (list === undefined) return [];
    const cutoff = this.now() - this.ttlMs;
    const kept = list.filter((entry) => entry.at >= cutoff);
    if (kept.length !== list.length) this.targets.set(key, kept);
    return kept;
  }

  /** 按「最近收到优先」挑一条当前可用的凭证；不记用量 */
  private pick(target: ReplyTarget, allowEvent: boolean): ReplyEntry | undefined {
    const ordered = [...this.live(target.scope, target.targetId)].sort((a, b) => b.at - a.at);
    for (const candidate of ordered) {
      if (candidate.kind === 'event' && !allowEvent) continue;
      if (!this.canUse(candidate)) continue;
      return candidate;
    }
    return undefined;
  }

  /** 该凭证现在还能不能再用一次 */
  private canUse(entry: ReplyEntry): boolean {
    const now = this.now();
    // 平台被动窗口（以收到时间为起点）
    if (now - entry.at > this.ttlMs) return false;
    if (entry.used <= 0) return true;
    // 计数窗口：首次回复后 1 小时内最多 limit 次
    const startedAt = entry.firstUsedAt ?? entry.at;
    if (now - startedAt > 60 * 60 * 1000) return false;
    return entry.used < this.limit;
  }

  private markUsed(entry: ReplyEntry): void {
    entry.used += 1;
    entry.firstUsedAt ??= this.now();
    // event 不落盘；只有 msg 的用量需要写回
    if (entry.kind === 'msg') this.persist();
  }

  // ── 持久化 ──

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return; // 首次启动没有文件，正常
    }
    try {
      const parsed = JSON.parse(text) as PersistedFile;
      const targets = parsed?.targets;
      if (targets === null || typeof targets !== 'object') return;
      const cutoff = this.now() - this.ttlMs;
      for (const [key, bucket] of Object.entries(targets)) {
        const ids = Array.isArray(bucket?.ids) ? bucket.ids : [];
        const list: ReplyEntry[] = [];
        for (const raw of ids) {
          if (typeof raw?.id !== 'string' || typeof raw.at !== 'number') continue;
          if (raw.at < cutoff) continue; // 平台窗口已过，载入即丢
          list.push({
            kind: 'msg',
            id: raw.id,
            at: raw.at,
            used: typeof raw.used === 'number' && raw.used > 0 ? raw.used : 0,
            ...(typeof raw.firstUsedAt === 'number' ? { firstUsedAt: raw.firstUsedAt } : {}),
          });
        }
        list.sort((a, b) => a.at - b.at);
        if (list.length > 0) this.targets.set(key, list.slice(-this.keep));
      }
    } catch (err) {
      this.logger.warn(`被动回复缓存解析失败（按空处理）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const merged = this.mergeFromDisk();
      const cutoff = this.now() - this.ttlMs;
      const targets: Record<string, PersistedTarget> = {};
      for (const [key, list] of merged) {
        const ids: PersistedEntry[] = [];
        for (const entry of list) {
          if (entry.kind !== 'msg' || entry.at < cutoff) continue;
          ids.push({
            id: entry.id,
            at: entry.at,
            ...(entry.used > 0 ? { used: entry.used } : {}),
            ...(entry.firstUsedAt === undefined ? {} : { firstUsedAt: entry.firstUsedAt }),
          });
        }
        if (ids.length > 0) targets[key] = { ids };
      }
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, targets } satisfies PersistedFile), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      this.logger.warn(`被动回复缓存写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 写盘前与磁盘合并：同一 appId 可能被多个 profile 同时使用，
   * 合并时按 id 取最大用量，避免互相覆盖掉对方刚记下的凭证。
   */
  private mergeFromDisk(): Map<string, ReplyEntry[]> {
    const merged = new Map<string, ReplyEntry[]>();
    for (const [key, list] of this.targets) merged.set(key, [...list]);

    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return merged;
    }
    let parsed: PersistedFile;
    try {
      parsed = JSON.parse(text) as PersistedFile;
    } catch {
      return merged;
    }
    const cutoff = this.now() - this.ttlMs;
    const targets = parsed?.targets;
    if (targets === null || typeof targets !== 'object') return merged;

    for (const [key, bucket] of Object.entries(targets)) {
      const ids = Array.isArray(bucket?.ids) ? bucket.ids : [];
      const list = merged.get(key) ?? [];
      for (const raw of ids) {
        if (typeof raw?.id !== 'string' || typeof raw.at !== 'number' || raw.at < cutoff) continue;
        const existing = list.find((entry) => entry.id === raw.id);
        const used = typeof raw.used === 'number' ? raw.used : 0;
        if (existing) {
          existing.used = Math.max(existing.used, used);
          if (existing.firstUsedAt === undefined && typeof raw.firstUsedAt === 'number') {
            existing.firstUsedAt = raw.firstUsedAt;
          }
          continue;
        }
        if (list.length >= this.keep) continue;
        list.push({
          kind: 'msg',
          id: raw.id,
          at: raw.at,
          used,
          ...(typeof raw.firstUsedAt === 'number' ? { firstUsedAt: raw.firstUsedAt } : {}),
        });
      }
      if (list.length > 0) merged.set(key, list);
    }
    return merged;
  }
}
