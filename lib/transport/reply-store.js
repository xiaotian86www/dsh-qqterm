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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PLUGIN_HOME } from "../shared/dirs.js";
const EVENT_PREFIX = 'INTERACTION_CREATE:';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LIMIT = 4;
const DEFAULT_KEEP_PER_TARGET = 3;
const DEFAULT_MAX_TARGETS = 200;
/** 落盘合并窗口：最多每秒写一次，流式按片发送不会每片都全量读写 */
const PERSIST_INTERVAL_MS = 1000;
/** 默认落盘路径 */
export function defaultReplyStorePath() {
    return resolve(PLUGIN_HOME, 'reply-ids.json');
}
/**
 * 被动回复凭证存储。
 *
 * 单例由 gateway 创建并交给 reply-bot 装饰器；所有发送都从这里拿凭证，
 * 不再各自维护缓存。
 */
export class ReplyStore {
    appId;
    logger;
    file;
    ttlMs;
    limit;
    keep;
    maxTargets;
    now;
    /** key = `${appId}:${scope}:${targetId}`，value 按收到时间升序 */
    targets = new Map();
    flushTimer = null;
    lastPersistedAt = 0;
    constructor(options) {
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
    recordMessage(scope, targetId, msgId, receivedAt) {
        if (!targetId || !msgId)
            return;
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
    recordEvent(scope, targetId, eventId) {
        if (!targetId || !eventId)
            return;
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
    resolve(target, allowEvent) {
        const candidate = this.pick(target, allowEvent);
        if (candidate === undefined)
            return { scope: target.scope, targetId: target.targetId };
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
    /** 立即落盘（合并窗口内的待写内容一次性写完）；dispose 与测试用 */
    flush() {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.persist();
        this.lastPersistedAt = this.now();
    }
    /** 冲盘并清理内存 */
    dispose() {
        this.flush();
        this.targets.clear();
    }
    // ── 内部 ──
    key(scope, targetId) {
        return `${this.appId}:${scope}:${targetId}`;
    }
    /**
     * 写入候选；同一 id 只登记一次（平台窗口按原消息时间算，重推/补发不能续命）。
     * 列表始终保持按 at 升序，尾部即最新。
     */
    push(scope, targetId, entry) {
        const key = this.key(scope, targetId);
        const list = this.targets.get(key) ?? [];
        if (list.some((item) => item.id === entry.id))
            return;
        list.push(entry);
        list.sort((a, b) => a.at - b.at);
        if (list.length > this.keep)
            list.splice(0, list.length - this.keep);
        // 重新插入，让 Map 的淘汰顺序反映最近活跃
        this.targets.delete(key);
        this.targets.set(key, list);
        if (this.targets.size > this.maxTargets) {
            const oldest = this.targets.keys().next().value;
            if (oldest !== undefined)
                this.targets.delete(oldest);
        }
    }
    /** 当前仍可用的候选（过滤平台窗口），保持 at 升序 */
    live(scope, targetId) {
        const key = this.key(scope, targetId);
        const list = this.targets.get(key);
        if (list === undefined)
            return [];
        const cutoff = this.now() - this.ttlMs;
        const kept = list.filter((entry) => entry.at >= cutoff);
        if (kept.length === 0)
            this.targets.delete(key);
        else if (kept.length !== list.length)
            this.targets.set(key, kept);
        return kept;
    }
    /** 从新到旧挑一条可用凭证；不记用量 */
    pick(target, allowEvent) {
        const list = this.live(target.scope, target.targetId);
        for (let index = list.length - 1; index >= 0; index -= 1) {
            const candidate = list[index];
            if (candidate.kind === 'event' && !allowEvent)
                continue;
            if (this.canUse(candidate))
                return candidate;
        }
        return undefined;
    }
    /** 该凭证现在还能不能再用一次 */
    canUse(entry) {
        // 平台只卡「消息时间之后 60 分钟」+「最多 4 次」，没有第二个计数窗口
        return this.now() - entry.at <= this.ttlMs && entry.used < this.limit;
    }
    /** 记一次用量，返回本次的序号（事件回复用它当 msg_seq） */
    markUsed(entry) {
        entry.used += 1;
        // event 不落盘；只有 msg 的用量需要写回
        if (entry.kind === 'msg')
            this.schedulePersist();
        return entry.used;
    }
    // ── 持久化 ──
    /** 合并写盘：最多每 PERSIST_INTERVAL_MS 一次，多余的调用并进同一次写入 */
    schedulePersist() {
        if (this.flushTimer !== null)
            return;
        const wait = Math.max(0, this.lastPersistedAt + PERSIST_INTERVAL_MS - this.now());
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, wait);
        this.flushTimer.unref?.();
    }
    load() {
        let text;
        try {
            text = readFileSync(this.file, 'utf8');
        }
        catch {
            return; // 首次启动没有文件，正常
        }
        try {
            const parsed = JSON.parse(text);
            const targets = parsed?.targets;
            if (targets === null || typeof targets !== 'object')
                return;
            const cutoff = this.now() - this.ttlMs;
            for (const [key, bucket] of Object.entries(targets)) {
                const ids = Array.isArray(bucket?.ids) ? bucket.ids : [];
                const list = [];
                for (const raw of ids) {
                    if (typeof raw?.id !== 'string' || typeof raw.at !== 'number')
                        continue;
                    if (raw.at < cutoff)
                        continue; // 平台窗口已过，载入即丢
                    list.push({
                        kind: 'msg',
                        id: raw.id,
                        at: raw.at,
                        used: typeof raw.used === 'number' && raw.used > 0 ? raw.used : 0,
                    });
                }
                list.sort((a, b) => a.at - b.at);
                if (list.length > 0)
                    this.targets.set(key, list.slice(-this.keep));
            }
        }
        catch (err) {
            this.logger.warn(`被动回复缓存解析失败（按空处理）: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    persist() {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const merged = this.mergeFromDisk();
            const cutoff = this.now() - this.ttlMs;
            const targets = {};
            for (const [key, list] of merged) {
                const ids = [];
                for (const entry of list) {
                    if (entry.kind !== 'msg' || entry.at < cutoff)
                        continue;
                    ids.push({
                        id: entry.id,
                        at: entry.at,
                        ...(entry.used > 0 ? { used: entry.used } : {}),
                    });
                }
                if (ids.length > 0)
                    targets[key] = { ids };
            }
            const tmp = `${this.file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({ version: 1, targets }), 'utf8');
            renameSync(tmp, this.file);
        }
        catch (err) {
            this.logger.warn(`被动回复缓存写入失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * 写盘前与磁盘合并：同一 appId 可能被多个 profile 同时使用，
     * 合并时按 id 取最大用量，避免互相覆盖掉对方刚记下的凭证。
     */
    mergeFromDisk() {
        const merged = new Map();
        for (const [key, list] of this.targets)
            merged.set(key, [...list]);
        let text;
        try {
            text = readFileSync(this.file, 'utf8');
        }
        catch {
            return merged;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            return merged;
        }
        const cutoff = this.now() - this.ttlMs;
        const targets = parsed?.targets;
        if (targets === null || typeof targets !== 'object')
            return merged;
        for (const [key, bucket] of Object.entries(targets)) {
            const ids = Array.isArray(bucket?.ids) ? bucket.ids : [];
            const list = merged.get(key) ?? [];
            for (const raw of ids) {
                if (typeof raw?.id !== 'string' || typeof raw.at !== 'number' || raw.at < cutoff)
                    continue;
                const existing = list.find((entry) => entry.id === raw.id);
                const used = typeof raw.used === 'number' ? raw.used : 0;
                if (existing) {
                    existing.used = Math.max(existing.used, used);
                    continue;
                }
                if (list.length >= this.keep)
                    continue;
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
//# sourceMappingURL=reply-store.js.map