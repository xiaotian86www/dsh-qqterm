/**
 * 被动回复凭证存储 — msg_id / event_id 的唯一事实源。
 *
 * QQ 的被动回复只认两种凭证：用户消息的 msg_id、按钮回调的 event_id。
 * 平台窗口：单聊 60 分钟、每条消息最多回 4 次。
 * 这套状态以前拆在 msgid-cache（内存）与 reply-limiter（计数）里，重启即丢；
 * 这里合并成一份，并把 msg_id 连同用量一起落盘：
 *   - 落盘的是「还能用的被动凭证」，不是历史记录，载入时按 TTL 过滤；
 *   - event_id 只在内存里：平台没有承诺它跨重启可复用，落盘只会拿到失效 id；
 *   - 用量必须跟 id 一起落盘，否则重启后配额从 0 开始算，更容易撞平台限制。
 *   - 时间取消息自带的 timestamp（RESUME 补发的旧消息因此不会被当成新凭证）。
 *
 * 写入按最多每秒一次合并，dispose 时强制冲盘：消息路径上不做同步全量读写，
 * 强杀最多丢最后一秒的用量（重新计数会比平台多放行一次）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJsonAtomic } from '../shared/json-file.ts';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { errorMessage } from '../shared/utils.ts';

/** 解析结果：在「发给谁」之上补被动凭证，只有装饰层看得到 */
export interface ResolvedReplyTarget extends ReplyTarget {
  msgId?: string;
  /** 带 INTERACTION_CREATE 前缀的完整事件 id，与 msgId 互斥 */
  eventId?: string;
  /**
   * 事件回复的 msg_seq（仅 eventId 时有值）。平台按 (event_id, msg_seq) 去重，
   * 同一次互动回多条必须换 seq；msg_id 的 seq 由 SDK 每次随机生成。
   */
  msgSeq?: number;
}

/** 被动回复凭证类型 */
export type ReplyIdKind = 'msg' | 'event';

/** 一条被动回复凭证（内存形态） */
interface ReplyEntry {
  kind: ReplyIdKind;
  /** msg: 消息 id；event: 带 INTERACTION_CREATE 前缀的完整事件 id */
  id: string;
  /** 平台收到时间（消息自带 timestamp），用于窗口判断与新旧排序 */
  at: number;
  /** 已用的被动回复次数 */
  used: number;
}

/** 落盘形态：只存 msg（event 不落盘） */
interface PersistedEntry {
  id: string;
  at: number;
  used?: number;
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
  /** 落盘路径，默认 ~/.dsh-qqterm/reply-ids.json */
  file?: string;
  /** 平台被动回复窗口，默认 30 分钟（平台给 60 分钟，取一半留余量） */
  ttlMs?: number;
  /** 同一条凭证最多回几次，默认 4（平台上限就是 4） */
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
/** 落盘合并窗口：最多每秒写一次，连续分片发送不会每片都全量读写 */
const PERSIST_INTERVAL_MS = 1000;

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
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersistedAt = 0;

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
  public recordMessage(
    scope: ChatScope,
    targetId: string | undefined,
    msgId: string | undefined,
    receivedAt?: number,
  ): void {
    if (!targetId || !msgId) return;
    const now = this.now();
    this.push(scope, targetId, {
      kind: 'msg',
      id: msgId,
      // 平台窗口按消息时间算：RESUME 补发的旧消息不能被当成刚收到
      at: Math.min(receivedAt ?? now, now),
      used: 0,
    });
    this.schedulePersist();
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
    const used = this.markUsed(candidate);
    return candidate.kind === 'event'
      ? {
        scope: target.scope,
        targetId: target.targetId,
        eventId: candidate.id,
        msgSeq: used,
      }
      : { scope: target.scope, targetId: target.targetId, msgId: candidate.id };
  }

  /**
   * 平台明确说这条凭证已失效（msg_id 过期 / 被动窗口用完）：丢掉该 target 的
   * 全部候选，下一次发送改走主动推送。否则失效凭证会被反复取用，重试永远失败。
   */
  public forget(target: ReplyTarget): void {
    if (!this.targets.delete(this.key(target.scope, target.targetId))) return;
    this.logger.warn?.(`qqterm: 被动回复凭证已失效，改用主动推送（${target.scope}:${target.targetId}）`);
    this.schedulePersist();
  }

  /** 立即落盘（合并窗口内的待写内容一次性写完）；dispose 与测试用 */
  public flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.persist();
    this.lastPersistedAt = this.now();
  }

  /** 冲盘并清理内存 */
  public dispose(): void {
    this.flush();
    this.targets.clear();
  }

  // ── 内部 ──

  private key(scope: ChatScope, targetId: string): string {
    return `${this.appId}:${scope}:${targetId}`;
  }

  /**
   * 写入候选；同一 id 只登记一次（平台窗口按原消息时间算，重推/补发不能续命）。
   * 列表始终保持按 at 升序，尾部即最新。
   */
  private push(scope: ChatScope, targetId: string, entry: ReplyEntry): void {
    const key = this.key(scope, targetId);
    const list = this.targets.get(key) ?? [];
    if (list.some((item) => item.id === entry.id)) return;
    list.push(entry);
    list.sort((a, b) => a.at - b.at);
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    // 重新插入，让 Map 的淘汰顺序反映最近活跃
    this.targets.delete(key);
    this.targets.set(key, list);
    if (this.targets.size > this.maxTargets) {
      const oldest = this.targets.keys().next().value;
      if (oldest !== undefined) this.targets.delete(oldest);
    }
  }

  /** 当前仍可用的候选（过滤平台窗口），保持 at 升序 */
  private live(scope: ChatScope, targetId: string): ReplyEntry[] {
    const key = this.key(scope, targetId);
    const list = this.targets.get(key);
    if (list === undefined) return [];
    const cutoff = this.now() - this.ttlMs;
    const kept = list.filter((entry) => entry.at >= cutoff);
    if (kept.length === 0) this.targets.delete(key);
    else if (kept.length !== list.length) this.targets.set(key, kept);
    return kept;
  }

  /** 从新到旧挑一条可用凭证；不记用量 */
  private pick(target: ReplyTarget, allowEvent: boolean): ReplyEntry | undefined {
    const list = this.live(target.scope, target.targetId);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const candidate = list[index]!;
      if (candidate.kind === 'event' && !allowEvent) continue;
      if (this.canUse(candidate)) return candidate;
    }
    return undefined;
  }

  /** 该凭证现在还能不能再用一次 */
  private canUse(entry: ReplyEntry): boolean {
    // 平台只卡「消息时间之后 60 分钟」+「最多 4 次」，没有第二个计数窗口
    return this.now() - entry.at <= this.ttlMs && entry.used < this.limit;
  }

  /** 记一次用量，返回本次的序号（事件回复用它当 msg_seq） */
  private markUsed(entry: ReplyEntry): number {
    entry.used += 1;
    // event 不落盘；只有 msg 的用量需要写回
    if (entry.kind === 'msg') this.schedulePersist();
    return entry.used;
  }

  // ── 持久化 ──

  /** 合并写盘：最多每 PERSIST_INTERVAL_MS 一次，多余的调用并进同一次写入 */
  private schedulePersist(): void {
    if (this.flushTimer !== null) return;
    const wait = Math.max(0, this.lastPersistedAt + PERSIST_INTERVAL_MS - this.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
    this.flushTimer.unref?.();
  }

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
          });
        }
        list.sort((a, b) => a.at - b.at);
        if (list.length > 0) this.targets.set(key, list.slice(-this.keep));
      }
    } catch (err) {
      this.logger.warn(`被动回复缓存解析失败（按空处理）: ${errorMessage(err)}`);
    }
  }

  private persist(): void {
    try {
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
          });
        }
        if (ids.length > 0) targets[key] = { ids };
      }
      writeJsonAtomic(this.file, { version: 1, targets } satisfies PersistedFile);
    } catch (err) {
      this.logger.warn(`被动回复缓存写入失败: ${errorMessage(err)}`);
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
          continue;
        }
        if (list.length >= this.keep) continue;
        list.push({ kind: 'msg', id: raw.id, at: raw.at, used });
      }
      if (list.length > 0) {
        list.sort((a, b) => a.at - b.at);
        merged.set(key, list);
      }
    }
    return merged;
  }
}
