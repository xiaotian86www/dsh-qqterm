/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * sessionKey → sessionId 的映射存于 prefs（`model-prefs.json`），新会话 id 由
 * `mintSessionId()` 铸造（`session-` + UUID，与宿主一致）。0.5.x 的 SHA-256 确定性
 * 派生 id 仅用于探测存量会话并迁移，不再用于新建——确定性 id 跨进程必然相同，
 * 两个进程各自新建会把同一 id 写入不同 project 目录。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { legacyDerivedSessionId, mintSessionId } from "./session-id.js";
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHostAdapter } from "../host/adapter.js";
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveAgentCwd } from "../shared/dirs.js";
import { ModelResolver } from "../model/model-resolver.js";
import { IdleEvictor } from "./idle-evictor.js";
import { removeSessionDirs } from "./session-store.js";
/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS = {
    busy: '压缩服务忙，请稍后重试',
    cancelled: '压缩已取消',
    changed: '历史在压缩过程中发生变化，请重试',
    commit: '压缩提交失败',
    persistence: '压缩完成但保存失败',
};
/** 会话列表最多为多少条会话读取标题（每条都要读一遍日志，是列表的耗时大头） */
const TITLE_FETCH_LIMIT = 10;
/** 复刻宿主 latestCompletedPrefixBoundary：最后一个 turn/end 起到下一 turn 开始前的边界 */
export function latestCompletedPrefixBoundary(events) {
    const list = events;
    let lastTurnEndSeq;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const candidate = list[i];
        if (candidate?.type === 'turn/end') {
            lastTurnEndSeq = candidate.seq;
            break;
        }
    }
    if (lastTurnEndSeq === undefined)
        return undefined;
    let boundary = lastTurnEndSeq;
    for (const next of list.slice(boundary + 1)) {
        if (next.type === 'turn/start'
            || (next.type === 'user/message' && next.surfaceOp === 'append')
            || next.type === 'agent/inbox/spliced')
            break;
        if (next.seq !== undefined)
            boundary = next.seq;
    }
    return boundary;
}
export class SessionManager {
    sessions = new Map();
    /**
     * 同 key 正在进行的 getOrCreate（singleflight）。
     *
     * 斜杠命令与待答问题截获位于 concurrencyGuard 之前（见 gateway/middleware-setup），
     * 与普通消息不串行：同 key 并发进入会各自 resume/create，产出两个 agent，
     * 后写入 sessions 的覆盖前者且前者无人 dispose（泄漏）。
     */
    inflight = new Map();
    evictor;
    modelResolver;
    ctx;
    host;
    agents;
    config;
    logger;
    /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
    questionChannel;
    /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
    approvalChannel;
    constructor(ctx, agents, config, logger) {
        this.ctx = ctx;
        this.agents = agents;
        this.config = config;
        this.logger = logger;
        this.host = createHostAdapter(ctx, logger);
        this.logger.info(`host adapter capabilities: ${this.host.capabilities.join(', ')}`);
        this.modelResolver = new ModelResolver(ctx, config, logger);
        this.evictor = new IdleEvictor(this.sessions, config.sessionIdleTimeout, (key, record) => {
            this.logger.info(`evicting idle session: key=${key}`);
            this.sessions.delete(key);
            record.agent.cancel({ kind: 'user' });
            void record.handle.dispose().catch(() => { });
            // 回收会话时统一清理其待答问题/待批审批，避免 pending 悬挂泄漏
            this.questionChannel?.cancelPending(key);
            this.approvalChannel?.cancelPending(key);
        });
        this.registerScopePromptInjection();
    }
    /**
     * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
     *
     * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
     * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
     * 额外 prompt 时原样返回，不做改动。
     */
    registerScopePromptInjection() {
        const assemble = async (_assembly, context, next) => {
            const assembled = await next();
            if (!context.agent)
                return assembled;
            const record = this.findByAgent(context.agent);
            if (!record)
                return assembled;
            const prompt = record.scope === 'group' ? this.config.groupPrompt : this.config.directPrompt;
            if (!prompt)
                return assembled;
            return {
                ...assembled,
                sections: [...(assembled.sections ?? []), { name: 'qqbot:scope-prompt', order: 90, text: prompt }],
            };
        };
        this.ctx.on('system-prompt/assemble', assemble);
    }
    /**
     * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
     */
    getPresetsService() {
        try {
            return this.ctx.get('agentPresets');
        }
        catch {
            return undefined;
        }
    }
    /**
     * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
     * 读不到（服务缺失 / session 不存在 / 未记录 agentPreset）返回 undefined。
     */
    async resolvePersistedPreset(sessionId) {
        return (await this.host.sessionHeader(sessionId))?.agentPreset;
    }
    // ── 模型相关（委托给 ModelResolver） ──
    getEffectiveModel(scope, peerId) {
        return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
    }
    /**
     * 获取指定 peer 的生效 preset（per-peer 覆盖 > config.preset）
     */
    getEffectivePreset(scope, peerId) {
        return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
    }
    /** 按 sessionKey 解析生效 preset */
    getEffectivePresetByKey(key) {
        return this.modelResolver.getPreset(key) ?? this.config.preset;
    }
    /**
     * 列出所有可用 preset（/preset 命令用）
     */
    async listPresets() {
        const presets = this.getPresetsService();
        if (!presets)
            return [];
        try {
            const list = await presets.list();
            return list.map((p) => ({ id: p.id, name: p.name, description: p.description }));
        }
        catch (err) {
            this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
    /**
     * 切换模型（fork + 重建会话，保留历史）
     */
    async setModelOverride(scope, peerId, route) {
        const key = this.sessionKey(scope, peerId);
        this.modelResolver.setOverride(key, route);
        const record = this.sessions.get(key);
        if (!record) {
            this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
            return;
        }
        await this.rebuildSession(record, { route });
        this.logger.info(`model switched via fork: key=${key} → ${route.provider}/${route.model}`);
    }
    /**
     * 切换指定 peer 的 agent preset（per-peer 覆盖）
     *
     * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
     * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
     */
    async setPresetOverride(scope, peerId, presetId) {
        const key = this.sessionKey(scope, peerId);
        // 1. 校验 preset 存在 + 可加载（broken 拒绝）
        const presets = this.getPresetsService();
        if (!presets)
            return { ok: false, reason: 'unavailable' };
        let resolved;
        try {
            resolved = await presets.resolve(presetId);
        }
        catch (err) {
            return { ok: false, reason: 'unknown-preset', message: err instanceof Error ? err.message : String(err) };
        }
        if (resolved.broken !== undefined) {
            return { ok: false, reason: 'broken', message: resolved.broken };
        }
        // 2. 持久化 per-peer 覆盖（新会话生效）
        this.modelResolver.setPreset(key, presetId);
        const hasActive = this.sessions.has(key);
        this.logger.info(`preset pref saved: key=${key} → ${presetId}${hasActive ? ' (active session locked, next session applies)' : ''}`);
        return { ok: true, presetId };
    }
    /**
     * 清除 per-peer preset 覆盖，回到 config.preset / 默认（新会话生效）
     */
    async clearPresetOverride(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        this.modelResolver.clearPreset(key);
        this.logger.info(`preset pref cleared: key=${key} (next session applies)`);
        return { ok: true };
    }
    /**
     * fork + 重建会话（保留历史，换 model）
     *
     * options.route 缺省时沿用当前生效值。preset 沿用当前生效 preset（getEffectivePresetByKey）。
     * fork 不可用或失败时降级为 dispose（下次消息重建）。
     */
    async rebuildSession(record, options) {
        const key = record.sessionKey;
        // 对齐宿主官方 fork（commands.fork）：buildForkSeed 产物原样作 seed，
        // create 传 inheritedEventCount + isSeeded + parentSession
        const events = this.host.sessionEvents(record.agent.session);
        const boundary = latestCompletedPrefixBoundary(events);
        if (boundary === undefined) {
            this.logger.warn(`fork unavailable (no completed turn), fallback to dispose: key=${key}`);
            this.sessions.delete(key);
            record.agent.cancel({ kind: 'user' });
            await record.handle.dispose().catch(() => { });
            return;
        }
        const seed = await this.host.buildForkSeed(events, boundary);
        if (seed === undefined) {
            this.logger.warn(`fork seed unavailable (old host), fallback to dispose: key=${key}`);
            this.sessions.delete(key);
            record.agent.cancel({ kind: 'user' });
            await record.handle.dispose().catch(() => { });
            return;
        }
        const childId = SessionId(mintSessionId());
        const effectiveRoute = options.route ?? this.modelResolver.getEffectiveRoute(key);
        const composed = await this.composePreset(this.getEffectivePresetByKey(key));
        const created = await this.agents.create({
            sessionId: childId,
            seed,
            inheritedEventCount: boundary + 1,
            meta: {
                cwd: this.workspaceDir(),
                isSeeded: true,
                // 旧版宿主的 delivery 豁免要求 parentSession，新版忽略——都传
                parentSession: record.sessionId,
                ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
            },
            ...(effectiveRoute ? { agentOptions: effectiveRoute } : {}),
            ...(composed.setup ? { setup: composed.setup } : {}),
        });
        this.modelResolver.setSessionId(key, childId);
        const oldHandle = record.handle;
        record.sessionId = childId;
        record.agent = created.agent;
        record.handle = created;
        record.agentPreset = composed.agentPreset;
        record.lastActivity = Date.now();
        void oldHandle.dispose().catch(() => { });
        this.logger.info(`session rebuilt via fork: key=${key} preset=${composed.agentPreset ?? 'none'} sessionId=${childId}`);
    }
    clearModelOverride(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        this.modelResolver.clearOverride(key);
        this.modelResolver.clearSessionId(key);
    }
    async listAvailableModels() {
        return this.modelResolver.listModels();
    }
    listProviders() {
        return this.modelResolver.listProviders();
    }
    // ── 会话状态 / 统计 ──
    getSessionRecord(scope, peerId) {
        return this.sessions.get(this.sessionKey(scope, peerId));
    }
    getStatus(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const route = this.getEffectiveModel(scope, peerId);
        return {
            active: !!record,
            sessionId: record?.sessionId,
            provider: route?.provider,
            model: route?.model,
            preset: record?.agentPreset,
            lastActivity: record?.lastActivity,
            messageCount: this.countMessages(record),
        };
    }
    getTokenUsage(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        if (!record)
            return stats;
        const events = this.host.sessionEvents(record.agent.session);
        if (!events)
            return stats;
        for (const event of events) {
            if (event.type !== 'assistant/message')
                continue;
            // 真实形状：data.usage = { inputTokens, outputTokens, cacheReadTokens, ... }
            const nested = event.data?.usage;
            if (nested) {
                stats.input += nested.inputTokens ?? 0;
                stats.output += nested.outputTokens ?? 0;
                stats.cacheRead += nested.cacheReadTokens ?? 0;
                stats.cacheWrite += nested.cacheWriteTokens ?? 0;
                continue;
            }
            // 兼容形状：顶层 usage = { input, output, cacheRead, cacheWrite }
            if (event.usage) {
                stats.input += event.usage.input ?? 0;
                stats.output += event.usage.output ?? 0;
                stats.cacheRead += event.usage.cacheRead ?? 0;
                stats.cacheWrite += event.usage.cacheWrite ?? 0;
            }
        }
        return stats;
    }
    /**
     * 上下文占用：最后一条 assistant/message 的 totalTokens + 最后一次请求的窗口大小。
     *
     * 两个数来自不同事件：
     *   - used   ← assistant/message.data.usage.totalTokens（该轮请求的上下文大小）
     *   - window ← request/context.data.contextWindow（模型窗口，由宿主写入）
     * 都取「最后一次」，因为会话是单调增长的。
     */
    getContextUsage(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const usage = {};
        if (!record)
            return usage;
        const events = this.host.sessionEvents(record.agent.session);
        if (!events || events.length === 0)
            return usage;
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (!event)
                continue;
            if (event.type === 'assistant/message' && usage.used === undefined) {
                const total = event.data?.usage?.totalTokens;
                if (typeof total === 'number')
                    usage.used = total;
            }
            if (event.type === 'request/context' && usage.window === undefined) {
                const data = event.data;
                if (typeof data?.contextWindow === 'number')
                    usage.window = data.contextWindow;
                if (typeof data?.provider === 'string')
                    usage.provider = data.provider;
                if (typeof data?.model === 'string')
                    usage.model = data.model;
            }
            if (usage.used !== undefined && usage.window !== undefined)
                break;
        }
        return usage;
    }
    exportMarkdown(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        if (!record)
            return '';
        const events = this.host.sessionEvents(record.agent.session);
        if (!events || events.length === 0)
            return '';
        const lines = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];
        for (const event of events) {
            if (event.type === 'user/message') {
                const text = extractMessageText(event.message);
                if (text)
                    lines.push(`## 用户\n\n${text}\n`);
            }
            else if (event.type === 'assistant/message') {
                const text = extractMessageText(event.message);
                if (text)
                    lines.push(`## 助手\n\n${text}\n`);
            }
        }
        return lines.join('\n');
    }
    countMessages(record) {
        if (!record)
            return 0;
        const events = this.host.sessionEvents(record.agent.session);
        if (!events)
            return 0;
        let count = 0;
        for (const event of events) {
            if (event.type === 'user/message' || event.type === 'assistant/message') {
                count += 1;
            }
        }
        return count;
    }
    // ── Session 生命周期管理 ──
    sessionKey(scope, peerId) {
        return `qqbot:${this.config.appId}:${scope}:${peerId}`;
    }
    /** prefs 命中沿用；miss 返回 0.5.x 派生候选，由 getOrCreate 按 resume 结果迁移或铸造 */
    currentSessionId(sessionKey) {
        return this.modelResolver.getSessionId(sessionKey) ?? legacyDerivedSessionId(sessionKey);
    }
    /** 候选命中后落盘，后续永远走 prefs */
    persistSessionId(sessionKey, sessionId) {
        if (this.modelResolver.getSessionId(sessionKey) !== sessionId) {
            this.modelResolver.setSessionId(sessionKey, sessionId);
        }
    }
    async composePreset(presetId) {
        const presets = this.getPresetsService();
        if (!presets)
            return {};
        try {
            const resolved = await presets.resolve(presetId);
            const resolvedId = resolved.id;
            return {
                agentPreset: resolvedId,
                setup: async (agentCtx) => {
                    await presets.mount(agentCtx, resolvedId);
                },
            };
        }
        catch (err) {
            this.logger.warn(`im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`);
            return {};
        }
    }
    /** 获取或恢复或创建会话（get → resume → create）；同 key 并发合并为一次 */
    async getOrCreate(scope, peerId, senderId, replyTarget) {
        const key = this.sessionKey(scope, peerId);
        const existing = this.sessions.get(key);
        if (existing) {
            existing.replyTarget = replyTarget;
            existing.lastActivity = Date.now();
            return existing;
        }
        // singleflight：同 key 并发复用同一次 resume/create，后到者只更新回复目标
        const pending = this.inflight.get(key);
        if (pending) {
            const shared = await pending;
            shared.replyTarget = replyTarget;
            shared.lastActivity = Date.now();
            return shared;
        }
        const task = this.openSession(key, scope, peerId, senderId, replyTarget);
        this.inflight.set(key, task);
        try {
            return await task;
        }
        finally {
            this.inflight.delete(key);
        }
    }
    /** getOrCreate 的实际打开流程（已通过 singleflight 保证同 key 串行） */
    async openSession(key, scope, peerId, senderId, replyTarget) {
        const route = this.modelResolver.getEffectiveRoute(key);
        // prefs 命中 = 已知存量会话；miss 时取 0.5.x 派生 id 仅作存量探测候选，不用于新建
        const candidateIsLegacy = this.modelResolver.getSessionId(key) === undefined;
        let sessionId = SessionId(this.currentSessionId(key));
        this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);
        let agent;
        let handle;
        let agentPreset;
        const live = this.agents.get(sessionId);
        if (live) {
            agent = live;
            this.persistSessionId(key, sessionId);
            this.logger.info(`reusing live agent: key=${key}`);
        }
        else {
            // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
            // 优先 session 当初的 preset（started 锁定语义），无则用当前 effective preset。
            const presetId = (await this.resolvePersistedPreset(sessionId)) ?? this.getEffectivePresetByKey(key);
            const composed = await this.composePreset(presetId);
            agentPreset = composed.agentPreset;
            try {
                const resumeRoute = this.modelResolver.getResumeRoute(key);
                const resumed = await this.agents.resume({
                    resumeSessionId: sessionId,
                    ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = resumed.agent;
                handle = resumed;
                // 0.5.x 迁移：候选命中老会话，沿用并落盘
                this.persistSessionId(key, sessionId);
                this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
            }
            catch (err) {
                if (!(await this.mayCreateAfterResumeFailure(key, sessionId, err)))
                    throw err;
                sessionId = this.resolveCreateId(key, sessionId, candidateIsLegacy);
                const created = await this.agents.create({
                    sessionId,
                    meta: {
                        cwd: this.workspaceDir(),
                        ...(agentPreset ? { agentPreset } : {}),
                    },
                    ...(route ? { agentOptions: route } : {}),
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = created.agent;
                handle = created;
                this.persistSessionId(key, sessionId);
                this.logger.info(`created new session: key=${key} sessionId=${sessionId} preset=${agentPreset ?? 'none'}`);
            }
        }
        const record = {
            sessionKey: key,
            sessionId,
            agent,
            handle: handle ?? { agent, dispose: async () => { } },
            replyTarget,
            scope,
            peerId,
            senderId,
            lastActivity: Date.now(),
            agentPreset,
        };
        this.sessions.set(key, record);
        // 挂载到对应工作区（侧边栏可见性）；fail-soft、异步执行，不阻塞消息处理。
        // 宿主只在客户端 session.create RPC 时挂载会话，插件会话不走那条路径，
        // 闲置回收后会从侧边栏消失（详见 host/adapter.ts 的 attachSessionToWorkspace）。
        // cwd 必须与 meta.cwd 同源（workspaceDir()），否则 attachSession 的
        // header.cwd 校验（realpath 后须等于工作区 path）会失败。
        void this.host.attachSessionToWorkspace(sessionId, this.workspaceDir());
        return record;
    }
    /**
     * resume 失败后是否允许首次创建。
     *
     * 只有「会话确实不在盘上」才可创建：损坏/占用/后端故障沿用同一 id 重建，会把
     * 同一 sessionId 写进多个 project 目录，宿主 `list()` 随后报 duplicate，会话
     * 列表整体打不开（对齐宿主 `restoreOrCreateConfigured` 的 fail-loud 语义）。
     *
     * @returns 允许创建返回 true；拒绝时已记录 warn，调用方应抛出原 resume 错误。
     */
    async mayCreateAfterResumeFailure(key, sessionId, resumeError) {
        const context = `key=${key} sessionId=${sessionId} resumeErr=${errorText(resumeError)}`;
        let exists;
        try {
            exists = await this.host.sessionExists(sessionId);
        }
        catch (probeError) {
            // 求证本身失败（持久化后端故障）：无法断言不在盘上，按存在处理
            this.logger.warn(`refusing to recreate session, existence unknown: ${context} probeErr=${errorText(probeError)}`);
            return false;
        }
        if (exists === true) {
            this.logger.warn(`refusing to recreate existing session: ${context}`);
            return false;
        }
        if (exists === undefined) {
            // 宿主无 sessionPersistence.stat：没有求证手段，只能按 resume 结果创建（= 修复前行为）
            this.logger.warn(`creating session without existence check (host lacks sessionPersistence.stat): ${context}`);
        }
        return true;
    }
    /**
     * 确认候选会话缺失后决定用哪个 id 新建。
     *
     * - resume 等待期间 prefs 被并发改写（`/new` 换新会话）：采用 prefs 的最新 id，
     *   否则内存与 prefs 指向不同会话，重启后用户被切走；
     * - 候选来自 0.5.x 确定性派生：一律铸造新 id，确定性 id 不进入新建路径；
     * - 候选来自 prefs 且确认缺失：沿用该 id 新建，prefs 无需改写。
     */
    resolveCreateId(key, candidate, candidateIsLegacy) {
        const latest = this.modelResolver.getSessionId(key);
        if (latest !== undefined && latest !== candidate) {
            this.logger.info(`adopting concurrently written session id: key=${key} sessionId=${latest}`);
            return SessionId(latest);
        }
        if (candidateIsLegacy) {
            const minted = SessionId(mintSessionId());
            this.logger.info(`migrated to minted session id: key=${key} sessionId=${minted}`);
            return minted;
        }
        return candidate;
    }
    findBySessionId(sessionId) {
        for (const record of this.sessions.values()) {
            if (record.sessionId === sessionId)
                return record;
        }
        return undefined;
    }
    findByAgent(agent) {
        for (const record of this.sessions.values()) {
            if (record.agent === agent)
                return record;
        }
        return undefined;
    }
    async remove(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        this.modelResolver.setSessionId(key, mintSessionId());
        if (!record)
            return;
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        await record.handle.dispose().catch(() => { });
        this.logger.info(`session removed: key=${key}`);
    }
    /** Agent 工作目录：显式配置优先，缺省独立目录 ~/.dsh-qqbot/workspace（不随宿主进程 cwd） */
    workspaceCache;
    workspaceDir() {
        if (this.workspaceCache)
            return this.workspaceCache;
        const dir = resolveAgentCwd(this.config.cwd);
        mkdirSync(dir, { recursive: true });
        this.workspaceCache = dir;
        return dir;
    }
    // ── 会话管理（列表 / 恢复 / 删除，/sessions 命令用） ──
    /**
     * 列出本 agent 工作区内的全部会话（与 Web 侧栏同一来源）。
     *
     * 不过滤 per-chat：宿主里 Web 端创建的会话也要能在这里看到并接回来
     * （运营者要求「web 能看到的，qqbot 渠道都要能看到」）。子 agent 会话
     * 不单独展示，随父会话删除。
     *
     * @param scope 当前 chat 作用域（用于标记 current）
     * @param peerId 当前 chat 的 peer id
     * @throws 宿主列举失败时抛出，由命令层给出明确提示
     */
    async listWorkspaceSessions(scope, peerId) {
        const workspace = this.workspaceDir();
        const all = await this.host.listSessions();
        const record = this.sessions.get(this.sessionKey(scope, peerId));
        const currentId = record?.sessionId ?? this.modelResolver.getSessionId(this.sessionKey(scope, peerId));
        const visible = all
            .filter((session) => session.origin !== 'subagent')
            .filter((session) => session.cwd !== undefined && samePath(session.cwd, workspace))
            .sort((a, b) => b.createdAt - a.createdAt);
        // 标题要逐个读日志，只取最近若干条，避免列表变慢
        const titles = await this.host.sessionTitles(visible.slice(0, TITLE_FETCH_LIMIT).map((s) => s.id));
        return visible.map((session) => ({
            id: session.id,
            createdAt: session.createdAt,
            current: session.id === currentId,
            live: session.live,
            isSeeded: session.isSeeded,
            ...(titles.has(session.id) ? { title: titles.get(session.id) } : {}),
        }));
    }
    /**
     * 把当前 chat 切到指定会话（恢复历史）。
     *
     * 先释放当前 agent 再改映射，失败时把映射恢复回原会话——否则 chat 会停在
     * 一个既没接上、又丢了原来上下文的中间态。
     *
     * @param scope 当前 chat 作用域
     * @param peerId 当前 chat 的 peer id
     * @param sessionId 目标会话 id
     * @param senderId 当前发送者（记录进会话记录）
     * @param replyTarget 回复目标（后续出站用）
     */
    async switchSession(scope, peerId, sessionId, senderId, replyTarget) {
        const key = this.sessionKey(scope, peerId);
        const current = this.sessions.get(key);
        if (current?.sessionId === sessionId)
            return { ok: true, reason: 'same' };
        // 同一进程内一个会话只能被一个 chat 持有：直接复用 live agent 会让两个
        // chat 同时写进同一份历史，出站也会串台
        for (const [otherKey, record] of this.sessions) {
            if (otherKey !== key && record.sessionId === sessionId) {
                return { ok: false, reason: 'in-use', message: '该会话正在另一个聊天中使用' };
            }
        }
        // 存在性求证：undefined = 宿主没有 stat 能力，按存在处理（交给 resume 判定）
        const exists = await this.host.sessionExists(sessionId);
        if (exists === false)
            return { ok: false, reason: 'not-found' };
        // 映射失败时要回到的值：原会话（没有则铸一个新 id，避免停在被删/无效 id 上）
        const fallbackId = this.modelResolver.getSessionId(key) ?? mintSessionId();
        await this.disposeRecord(key, current);
        this.modelResolver.setSessionId(key, sessionId);
        try {
            const record = await this.getOrCreate(scope, peerId, senderId, replyTarget);
            if (record.sessionId !== sessionId) {
                // resume 失败后宿主可能自建了新会话：不能悄悄留在这个“新会话”上
                throw new Error(`宿主打开的是 ${record.sessionId}，不是目标会话`);
            }
            this.logger.info(`session switched: key=${key} sessionId=${sessionId}`);
            return { ok: true };
        }
        catch (err) {
            this.modelResolver.setSessionId(key, fallbackId);
            await this.disposeRecord(key, this.sessions.get(key));
            const raw = errorText(err);
            // 跨进程写所有权冲突是最常见的失败原因，补一句可操作的提示
            const message = /already ?owned|ownership/i.test(raw)
                ? `${raw}（该会话可能正被 Web 端打开，先关闭再恢复）`
                : raw;
            this.logger.warn(`session switch failed: key=${key} target=${sessionId} err=${raw}`);
            return { ok: false, reason: 'failed', message };
        }
    }
    /**
     * 删除指定会话（含磁盘日志，不可恢复）。
     *
     * 宿主没有删除 API，这里按 JSONL 后端布局在存储根目录下定位会话目录后移除。
     * 同时：释放进程内 agent（含正在生成的）、把指向该会话的 per-peer 映射换成
     * 新 id（否则下次打开会按旧 id 重建一个同名空会话）、连带删除其 subagent 子会话。
     *
     * @param sessionIds 待删除的会话 id
     */
    async deleteSessions(sessionIds) {
        const result = {
            ok: false,
            removed: [],
            failed: [],
            missing: [],
            cascaded: 0,
            remapped: 0,
        };
        const ids = new Set(sessionIds);
        const root = this.host.sessionStoreRoot();
        if (root === undefined) {
            return {
                ...result,
                reason: 'no-root',
                message: '宿主未暴露会话存储根目录（sessionPersistence.root），无法删除磁盘文件',
            };
        }
        // 连带子 agent 会话：父会话删掉后它们没有任何入口，留着只会占盘
        try {
            for (const session of await this.host.listSessions()) {
                if (session.origin === 'subagent'
                    && session.parentSession !== undefined
                    && ids.has(session.parentSession)) {
                    ids.add(session.id);
                    result.cascaded += 1;
                }
            }
        }
        catch (err) {
            this.logger.warn(`delete sessions: 列举会话失败，按给定 id 删除: ${errorText(err)}`);
        }
        // 1) 释放进程内 agent（正在生成的先 cancel）
        for (const [key, record] of [...this.sessions]) {
            if (ids.has(record.sessionId))
                await this.disposeRecord(key, record);
        }
        // 2) 悬空映射换成新 id（同一会话可能被多个 chat 指向）
        for (const [key, mapped] of this.modelResolver.listSessionIdEntries()) {
            if (!ids.has(mapped))
                continue;
            this.modelResolver.setSessionId(key, mintSessionId());
            result.remapped += 1;
        }
        // 3) 删磁盘
        const removed = removeSessionDirs(root, [...ids]);
        result.removed = removed.removed;
        result.failed = removed.failed;
        result.missing = removed.missing;
        if (result.removed.length === 0) {
            result.reason = result.failed.length > 0 ? 'failed' : 'not-found';
            result.message = result.failed.length > 0
                ? '会话目录删除失败（可能仍被 Web 端或其它进程打开）'
                : '磁盘上没有找到这些会话目录（可能从未落盘或已被删除）';
            return result;
        }
        result.ok = result.failed.length === 0;
        if (!result.ok)
            result.message = '部分会话删除失败（可能仍被其它进程占用）';
        this.logger.info(`sessions deleted: ids=${[...ids].join(',')} removed=${result.removed.length} failed=${result.failed.length} remapped=${result.remapped}`);
        return result;
    }
    /** 释放并移除一条会话记录（cancel 后再 dispose，避免生成中的 turn 悬挂） */
    async disposeRecord(key, record) {
        if (!record)
            return;
        if (this.sessions.get(key) === record)
            this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        await record.handle.dispose().catch(() => { });
    }
    /**
     * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
     *
     * compaction 是 preset 作用域服务，经 host adapter 从会话 preset 解析，
     * 全局注册的部署再兜底。这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
     */
    async compact(scope, peerId, revive) {
        const key = this.sessionKey(scope, peerId);
        let record = this.sessions.get(key);
        if (!record) {
            // 无活跃会话（重启/闲置回收）时从磁盘拉起，历史在磁盘上仍可压缩
            if (!revive)
                return { ok: false, reason: 'no-session' };
            record = await this.getOrCreate(scope, peerId, revive.senderId, revive.replyTarget);
        }
        if (record.agent.status !== 'idle')
            return { ok: false, reason: 'busy' };
        const compaction = (await this.host.serviceFor(record.agent, 'compaction')
            ?? this.host.globalService('compaction'));
        if (!compaction)
            return { ok: false, reason: 'unavailable' };
        const route = this.modelResolver.getEffectiveRoute(key);
        const agentCtx = {
            session: record.agent.session,
            options: { provider: route?.provider, model: route?.model },
            runMaintenance: record.agent.runMaintenance.bind(record.agent),
        };
        try {
            const result = await compaction.compactNow(agentCtx, new AbortController().signal);
            if (result === null)
                return { ok: true, shadowed: 0, tokens: 0 };
            return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
        }
        catch (err) {
            const code = err?.code;
            // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
            if (code === 'summary') {
                return { ok: true, shadowed: 0, tokens: 0 };
            }
            // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
            if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
                this.logger.debug(`compact declined: key=${key} code=${code}`);
                return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
            }
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`compact failed: key=${key} err=${message}`);
            return { ok: false, reason: 'failed', message };
        }
    }
    async disposeAll() {
        this.evictor.dispose();
        const records = [...this.sessions.values()];
        this.sessions.clear();
        for (const record of records) {
            record.agent.cancel({ kind: 'user' });
        }
        await Promise.allSettled(records.map((r) => r.handle.dispose()));
        this.logger.info(`all sessions disposed (count=${records.length})`);
    }
    get size() {
        return this.sessions.size;
    }
}
/** 错误文案（日志用） */
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * 两个路径是否指向同一目录。
 *
 * 会话 header 里的 cwd 由宿主原样保存（可能带尾分隔符、大小写与配置不同），
 * 直接字符串比较会把本工作区的会话漏掉；Windows 上大小写不敏感。
 */
function samePath(a, b) {
    const left = resolve(a).replace(/[\\/]+$/, '');
    const right = resolve(b).replace(/[\\/]+$/, '');
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}
/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(message) {
    const blocks = message?.content;
    if (!blocks || !Array.isArray(blocks))
        return '';
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text' && block.text) {
            parts.push(block.text);
        }
    }
    return parts.join('\n').trim();
}
//# sourceMappingURL=session-manager.js.map