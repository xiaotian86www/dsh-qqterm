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
import { mkdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { resolveAgentCwd } from "../shared/dirs.js";
import { ModelResolver } from "../model/model-resolver.js";
import { IdleEvictor } from "./idle-evictor.js";
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
/** `/sessions all` 每个工作区最多为多少条会话读标题（与命令层每页条数一致） */
const TITLE_ROWS_PER_GROUP = 10;
/**
 * `/sessions all` 读标题的总量上限。
 *
 * 只对「会展示出来的行」读标题：以前取全局最新 10 条，工作区一多，靠后的组
 * 全部显示成「未命名会话」——那不是取舍，是 bug。
 */
const TITLE_FETCH_LIMIT_ALL = 40;
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
                cwd: this.host.sessionDirectory(record.agent.session) ?? await this.chatDirectory(key),
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
        // 这个聊天的工作目录：新会话落在它里面，恢复的会话以它自己的 header 为准
        let directory = await this.chatDirectory(key);
        const live = this.agents.get(sessionId);
        if (live) {
            agent = live;
            directory = this.host.sessionDirectory(agent.session) ?? directory;
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
                directory = this.host.sessionDirectory(agent.session) ?? directory;
                // 0.5.x 迁移：候选命中老会话，沿用并落盘
                this.persistSessionId(key, sessionId);
                this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
            }
            catch (err) {
                if (!(await this.mayCreateAfterResumeFailure(key, sessionId, err)))
                    throw err;
                sessionId = this.resolveCreateId(key, sessionId, candidateIsLegacy);
                mkdirSync(directory, { recursive: true });
                const created = await this.agents.create({
                    sessionId,
                    meta: {
                        cwd: directory,
                        ...(agentPreset ? { agentPreset } : {}),
                    },
                    ...(route ? { agentOptions: route } : {}),
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = created.agent;
                handle = created;
                this.persistSessionId(key, sessionId);
                this.logger.info(`created new session: key=${key} sessionId=${sessionId} preset=${agentPreset ?? 'none'} cwd=${directory}`);
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
        // 工作区跟着会话走：记下这个聊天当前目录，供下次 /new 或重启后沿用
        this.rememberDirectory(key, directory);
        // 挂载到对应工作区（侧边栏可见性）；fail-soft、异步执行，不阻塞消息处理。
        // 宿主只在客户端 session.create RPC 时挂载会话，插件会话不走那条路径，
        // 闲置回收后会从侧边栏消失（详见 host/adapter.ts 的 attachSessionToWorkspace）。
        // cwd 必须与 meta.cwd 同源，否则 attachSession 的 header.cwd 校验会失败。
        if (directory)
            void this.host.attachSessionToWorkspace(sessionId, directory);
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
    /**
     * 该聊天当前所在的工作目录。
     *
     * 工作区跟随会话：优先取当前会话的生效目录（`workingDirectory` 覆盖运行期
     * cd，回退 header.cwd），其次是持久化的 per-chat 目录（`/new` 后仍保留），
     * 再其次是映射里那个会话的 header，最后才落到宿主的默认工作区目录。
     *
     * @param key sessionKey
     */
    async chatDirectory(key) {
        const record = this.sessions.get(key);
        const live = record ? this.host.sessionDirectory(record.agent.session) : undefined;
        if (live)
            return live;
        const stored = this.modelResolver.getDirectory(key);
        if (stored)
            return stored;
        const mapped = this.modelResolver.getSessionId(key);
        if (mapped) {
            const header = await this.host.sessionHeader(mapped).catch(() => undefined);
            const cwd = header?.cwd;
            if (typeof cwd === 'string' && cwd !== '')
                return cwd;
        }
        return this.host.defaultWorkspacePath() ?? resolveAgentCwd(undefined);
    }
    /** 记录该聊天当前的工作目录（工作区跟着会话走，重启后仍然有效） */
    rememberDirectory(key, directory) {
        if (directory === undefined || directory === '')
            return;
        this.modelResolver.setDirectory(key, directory);
    }
    /** 某个 agent 所属会话当前的工作目录（qqbot_send_file 等按会话判定的白名单用） */
    directoryForAgent(agent) {
        const record = this.findByAgent(agent);
        if (!record)
            return undefined;
        return this.host.sessionDirectory(record.agent.session)
            ?? this.modelResolver.getDirectory(record.sessionKey);
    }
    // ── 会话管理（列表 / 恢复 / 归档 / 取消归档，/sessions 命令用） ──
    /**
     * 列出「当前工作区」里的会话（与 Web 侧栏同一来源）。
     *
     * 范围跟着这个聊天的会话走：切换会话后范围随之变成目标会话所在的目录，
     * 而不是插件配置里写死的目录。归档的会话也返回（带 `archived` 标记），
     * 由命令层决定默认隐藏、单独用 `/sessions archived` 查看。
     *
     * @param scope 当前 chat 作用域（用于标记 current 并定位工作区）
     * @param peerId 当前 chat 的 peer id
     * @throws 宿主列举失败时抛出，由命令层给出明确提示
     */
    async listWorkspaceSessions(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const workspace = await this.chatDirectory(key);
        const record = this.sessions.get(key);
        const currentId = record?.sessionId ?? this.modelResolver.getSessionId(key);
        const archived = this.host.archivedSessionIds();
        const visible = (await this.host.listSessions())
            .filter((session) => session.origin !== 'subagent')
            .filter((session) => session.cwd !== undefined && samePath(session.cwd, workspace))
            .sort((a, b) => b.createdAt - a.createdAt);
        // 标题要逐个读日志，只取「会展示出来的那些」：默认列表只显示未归档的前 10 条，
        // 给已归档的会话读标题纯属浪费（归档页走的是分组列举）
        const shown = visible.filter((session) => !archived.has(session.id)).slice(0, TITLE_FETCH_LIMIT);
        const titles = await this.host.sessionTitles(shown.map((s) => s.id));
        return visible.map((session) => ({
            id: session.id,
            createdAt: session.createdAt,
            current: session.id === currentId,
            live: session.live,
            isSeeded: session.isSeeded,
            archived: archived.has(session.id),
            ...(titles.has(session.id) ? { title: titles.get(session.id) } : {}),
        }));
    }
    /**
     * 这个聊天当前所在的工作区（标题 / 路径 / 目录是否还在）。
     *
     * @param scope 当前 chat 作用域
     * @param peerId 当前 chat 的 peer id
     */
    async currentWorkspaceInfo(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const workspace = await this.chatDirectory(key);
        const info = this.host.workspaceList().find((item) => samePath(item.path, workspace));
        if (info) {
            return { title: info.title, path: info.path, missing: !isDirectory(info.path) };
        }
        return { title: basename(workspace), path: workspace, missing: !isDirectory(workspace) };
    }
    /** 宿主工作区清单（`/workspace` 匹配与提示用）；registry 未挂载时为空数组 */
    listWorkspaceInfos() {
        return this.host.workspaceList().map((item) => ({
            title: item.title,
            path: item.path,
            missing: !isDirectory(item.path),
        }));
    }
    /**
     * 这个聊天的工作区还能不能改（= 还没有落盘的会话）。
     *
     * 会话的 cwd 在创建时写进 header，宿主没有改它的接口（`workingDirectory` 只读），
     * 所以工作区只能在会话落盘**之前**选：`/new` 之后，或这个聊天从没说过话。
     *
     * @param scope 当前 chat 作用域
     * @param peerId 当前 chat 的 peer id
     */
    async canChooseWorkspace(scope, peerId) {
        const blocked = await this.workspaceBlocker(this.sessionKey(scope, peerId));
        return blocked === undefined ? { canChoose: true } : { canChoose: false, sessionId: blocked };
    }
    /**
     * 改这个聊天的工作区（下一个会话落在哪个目录）。
     *
     * 参数可以是宿主工作区的标题、目录名（都大小写不敏感，支持唯一前缀），或绝对
     * 路径。只在会话还没落盘时生效：已有会话时改目录是静默无效的——resume 回来的
     * 会话以自己的 header.cwd 为准，紧接着 `rememberDirectory` 会把记录覆盖回去
     * ——所以这里直接拒绝，由命令层给出「先 /new」的下一步。
     *
     * @param scope 当前 chat 作用域
     * @param peerId 当前 chat 的 peer id
     * @param arg 工作区标题 / 目录名 / 绝对路径
     */
    async changeChatWorkspace(scope, peerId, arg) {
        const key = this.sessionKey(scope, peerId);
        const target = arg.trim();
        if (target === '')
            return { ok: false, reason: 'not-found', arg: target };
        let path;
        let title;
        let isNew = false;
        if (isAbsolute(target)) {
            path = resolve(target);
            const known = this.listWorkspaceInfos().find((item) => samePath(item.path, path));
            title = known?.title ?? basename(path);
            isNew = known === undefined;
        }
        else {
            const picked = matchWorkspace(this.listWorkspaceInfos(), target);
            if ('error' in picked)
                return picked.error;
            path = picked.workspace.path;
            title = picked.workspace.title;
        }
        if (!isDirectory(path))
            return { ok: false, reason: 'missing', path };
        const blocked = await this.workspaceBlocker(key);
        if (blocked !== undefined)
            return { ok: false, reason: 'has-session', sessionId: blocked };
        this.modelResolver.setDirectory(key, path);
        this.logger.info(`chat workspace changed: key=${key} dir=${path}`);
        return { ok: true, title, path, isNew };
    }
    /** 挡住工作区修改的会话 id；undefined = 还没有落盘的会话，可以改 */
    async workspaceBlocker(key) {
        const live = this.sessions.get(key);
        if (live)
            return live.sessionId;
        const mapped = this.modelResolver.getSessionId(key);
        if (mapped === undefined)
            return undefined;
        // undefined = 宿主没有 stat 能力，按「已有会话」处理（与 resume 同一约定）
        const exists = await this.host.sessionExists(mapped).catch(() => undefined);
        return exists === false ? undefined : mapped;
    }
    /**
     * 按宿主的 workspace 分组列出全部会话（`/sessions all`）。
     *
     * 数据来源是「registry 分组 + sessionQuery 清单」的并集：registry 提供分组、
     * 路径与手动顺序，sessionQuery 提供 live / 来源 / 创建时间等 registry 不存的字段。
     * registry 记账可能漏掉别的入口新建的会话，所以差集单独归到「未分组」。
     *
     * @param scope 当前 chat 作用域（用于标记 current）
     * @param peerId 当前 chat 的 peer id
     */
    async listWorkspaceGroups(scope, peerId) {
        const key = this.sessionKey(scope, peerId);
        const record = this.sessions.get(key);
        const currentId = record?.sessionId ?? this.modelResolver.getSessionId(key);
        const archived = this.host.archivedSessionIds();
        const pinned = this.host.pinnedSessionIds();
        const all = await this.host.listSessions();
        const sessions = all
            .filter((session) => session.origin !== 'subagent')
            .filter((session) => session.cwd !== undefined)
            .sort((a, b) => b.createdAt - a.createdAt);
        /** 分组条目：标题在分组拼好之后再补（要先知道哪些行真的会展示） */
        const asEntry = (session, workspace) => ({
            id: session.id,
            createdAt: session.createdAt,
            current: session.id === currentId,
            live: session.live,
            isSeeded: session.isSeeded,
            archived: archived.has(session.id),
            workspace,
        });
        const byId = new Map(sessions.map((session) => [session.id, session]));
        const pinOrder = [...pinned];
        const orderOf = (id) => {
            const pinnedAt = pinOrder.indexOf(id);
            return pinnedAt === -1 ? Number.MAX_SAFE_INTEGER : pinnedAt;
        };
        const groups = [];
        const consumed = new Set();
        for (const workspace of this.host.workspaceList()) {
            const accounted = workspace.sessionIds
                .map((id) => byId.get(id))
                .filter((session) => session !== undefined)
                .filter((session) => samePath(session.cwd ?? '', workspace.path));
            // registry 记账之外、cwd 落在本工作区的会话也补进来（别的入口新建、尚未 attach）
            const extra = sessions.filter((session) => !consumed.has(session.id)
                && !workspace.sessionIds.includes(session.id)
                && samePath(session.cwd ?? '', workspace.path));
            const merged = [...extra, ...accounted];
            for (const session of merged)
                consumed.add(session.id);
            merged.sort((left, right) => {
                const pin = orderOf(left.id) - orderOf(right.id);
                return pin !== 0 ? pin : right.createdAt - left.createdAt;
            });
            for (const session of merged)
                consumed.add(session.id);
            groups.push({
                id: workspace.id,
                title: workspace.title,
                path: workspace.path,
                missing: !isDirectory(workspace.path),
                sessions: merged.map((session) => asEntry(session, workspace.title)),
            });
        }
        const ungrouped = sessions.filter((session) => !consumed.has(session.id));
        if (ungrouped.length > 0) {
            groups.push({
                id: 'ungrouped',
                title: '未分组',
                path: '',
                missing: false,
                sessions: ungrouped.map((session) => asEntry(session, '未分组')),
            });
        }
        // 标题只给「会展示的行」读：每组前 N 条，总量封顶；读日志是列表的耗时大头
        const wanted = [];
        for (const group of groups) {
            for (const session of group.sessions.slice(0, TITLE_ROWS_PER_GROUP)) {
                if (wanted.length >= TITLE_FETCH_LIMIT_ALL)
                    break;
                wanted.push(session.id);
            }
        }
        const titles = await this.host.sessionTitles(wanted);
        for (const group of groups) {
            for (const session of group.sessions) {
                const title = titles.get(session.id);
                if (title !== undefined)
                    session.title = title;
            }
        }
        return groups;
    }
    /**
     * 把当前 chat 切到指定会话（恢复历史）。
     *
     * 先释放当前 agent 再改映射，失败时把映射恢复回原会话——否则 chat 会停在
     * 一个既没接上、又丢了原来上下文的中间态。
     *
     * 目标若已归档，先取消归档再恢复：归档的会话会被宿主的 `agent/pre-step`
     * 闸门拒绝，「恢复」本来就意味着让它重新可用。
     *
     * @param scope 当前 chat 作用域
     * @param peerId 当前 chat 的 peer id
     * @param sessionId 目标会话 id
     * @param senderId 当前发送者（记录进会话记录）
     * @param replyTarget 回复目标（后续出站用）
     */
    async switchSession(scope, peerId, sessionId, senderId, replyTarget) {
        const key = this.sessionKey(scope, peerId);
        // 归档即不可用：恢复前先取消归档，失败则如实报错（此时还没动映射）
        const unarchived = this.host.archivedSessionIds().has(sessionId);
        if (unarchived) {
            const restored = await this.host.unarchiveSession(sessionId);
            if (!restored.ok) {
                this.logger.warn(`session resume refused: id=${sessionId} 取消失败=${restored.reason}`);
                return {
                    ok: false,
                    reason: 'failed',
                    message: `该会话已归档，取消归档失败：${restored.message ?? restored.reason ?? '未知原因'}`,
                };
            }
        }
        const current = this.sessions.get(key);
        if (current?.sessionId === sessionId) {
            return unarchived ? { ok: true, reason: 'same', unarchived: true } : { ok: true, reason: 'same' };
        }
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
            return unarchived ? { ok: true, unarchived: true } : { ok: true };
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
     * 归档指定会话（从 Web 侧栏与 `/sessions` 列表隐藏，日志保留，可取消归档）。
     *
     * 编排顺序有讲究：
     *   1. 先释放本进程内指向它的 agent（正在生成的先 cancel）。宿主的归档闸门会
     *      检查 `workspace/session-activity`，自己的 agent 还活着就会被判成活跃；
     *   2. 再调宿主归档（带 stopActivity，顺带停掉 Web 侧可能还在跑的工作）；
     *   3. 归档成功后把仍指向它的 per-chat 映射换成新 id。归档的会话会被宿主的
     *      `agent/pre-step` 拒绝，聊天若继续挂在它上面就彻底不回话了。
     *
     * 归档失败时不动映射：聊天上下文保持原样，用户还能继续用。
     *
     * @param sessionId 待归档的会话 id
     */
    async archiveSession(sessionId) {
        // 1) 释放进程内 agent（同一会话可能被多个 chat 指向）
        for (const [key, record] of [...this.sessions]) {
            if (record.sessionId === sessionId)
                await this.disposeRecord(key, record);
        }
        const alreadyArchived = this.host.archivedSessionIds().has(sessionId);
        // 2) 写宿主的归档集
        const outcome = await this.host.archiveSession(sessionId);
        if (!outcome.ok) {
            this.logger.warn(`session archive failed: id=${sessionId} reason=${outcome.reason ?? 'unknown'} ${outcome.message ?? ''}`);
            return outcome;
        }
        // 3) 悬空映射换成新 id，下一条消息落到全新会话
        let remapped = 0;
        for (const [key, mapped] of this.modelResolver.listSessionIdEntries()) {
            if (mapped !== sessionId)
                continue;
            this.modelResolver.setSessionId(key, mintSessionId());
            remapped += 1;
        }
        this.logger.info(`session archived: id=${sessionId} remapped=${remapped} already=${alreadyArchived}`);
        return {
            ok: true,
            ...(remapped > 0 ? { remapped } : {}),
            ...(alreadyArchived ? { alreadyArchived: true } : {}),
        };
    }
    /**
     * 取消归档指定会话，让它重新出现在列表里、也能被恢复。
     *
     * 纯宿主状态操作：不碰进程内 agent，也不改 chat 映射（归档时已经改过了）。
     *
     * @param sessionId 待取消归档的会话 id
     */
    async unarchiveSession(sessionId) {
        const outcome = await this.host.unarchiveSession(sessionId);
        if (outcome.ok)
            this.logger.info(`session unarchived: id=${sessionId}`);
        else
            this.logger.warn(`session unarchive failed: id=${sessionId} reason=${outcome.reason ?? 'unknown'} ${outcome.message ?? ''}`);
        return outcome;
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
 * 空路径一律视为不匹配（`resolve('')` 会落到进程 cwd，误判成同一个目录）。
 */
function samePath(a, b) {
    if (a === '' || b === '')
        return false;
    const left = resolve(a).replace(/[\\/]+$/, '');
    const right = resolve(b).replace(/[\\/]+$/, '');
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}
/** 目录当前是否存在且真的是目录（工作区「missing-dir」提示用） */
function isDirectory(path) {
    if (path === '')
        return false;
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * 按标题 / 目录名匹配一个工作区。
 *
 * 大小写不敏感；先全等，没有全等才退到唯一前缀（和 `/sessions` 的 id 前缀同一
 * 手感）。标题一般是宿主按目录名自动生成的，但用户可能改过，所以目录名也算
 * 别名。
 */
function matchWorkspace(workspaces, raw) {
    const needle = raw.toLowerCase();
    const namesOf = (item) => [
        item.title.toLowerCase(),
        basename(item.path).toLowerCase(),
    ];
    const exact = workspaces.filter((item) => namesOf(item).includes(needle));
    const candidates = exact.length > 0
        ? exact
        : workspaces.filter((item) => namesOf(item).some((name) => name.startsWith(needle)));
    const [only] = candidates;
    if (candidates.length === 1 && only)
        return { workspace: only };
    if (candidates.length > 1) {
        return {
            error: {
                ok: false,
                reason: 'ambiguous',
                matches: candidates.map((item) => item.title),
            },
        };
    }
    return { error: { ok: false, reason: 'not-found', arg: raw } };
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