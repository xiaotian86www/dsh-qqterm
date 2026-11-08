/**
 * SessionManager — 管理聊天会话 → dsh Agent 的映射和生命周期
 *
 * 聊天会话只有一个，key 固定为 `qqterm:${appId}:chat`：任何 QQ 私聊窗口续写、
 * 看到的都是同一个聊天会话。后台会话（宿主里的 session）仍是多份，
 * `/sessions` 列出、`/sessions resume` 切换、`/new` 新开。
 *
 * 运行期维护两份内存索引：
 *   - `records: Map<sessionId, SessionRecord>`：QQ 已经获取的会话（普通消息 /
 *     `/sessions resume` / `/to` 实际拿到 agent 的那些），所有已获取会话的
 *     输出、提问、审批都会回到 QQ；
 *   - `currentByKey: Map<chatKey, sessionId>`：每个聊天当前接的是哪个会话。
 * 已获取集合不落盘，重启后只有 current 从 prefs 恢复。
 *
 * sessionKey → sessionId 的映射存于 prefs（`model-prefs.json`），新会话 id 由
 * `mintSessionId()` 铸造（`session-` + UUID，与宿主一致）。没有映射即视为全新会话：
 * 不复用旧版按聊天保存的会话与偏好。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { mintSessionId } from "./session-id.js";
import { createQQUserMessage } from "./user-message.js";
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHostAdapter } from "../host/adapter.js";
import { mkdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { resolveAgentCwd } from "../shared/dirs.js";
import { sessionTitleOf } from "../transport/session-source.js";
import { ModelResolver } from "../model/model-resolver.js";
/** agent preset 默认值所在的配置条目（与设置页写的是同一个 namespace） */
const PRESET_SETTINGS_NS = 'agent-preset-registry';
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
/** projection / 请求头产物统一成 HostSelection */
function toHostSelection(input) {
    if (!input.provider || !input.model)
        return undefined;
    return {
        provider: input.provider,
        model: input.model,
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: String(input.reasoningEffort) } : {}),
    };
}
export class SessionManager {
    /** 已获取集合：sessionId → 记录（普通消息 / resume / /to 实际拿到 agent 的） */
    records = new Map();
    /** 每个聊天当前接的会话：chatKey → sessionId；无会话就是没有这一项 */
    currentByKey = new Map();
    /**
     * 同 key 正在进行的 getOrCreate（singleflight）。
     *
     * 斜杠命令与待答问题截获位于 concurrencyGuard 之前（见 gateway/middleware-setup），
     * 与普通消息不串行：同 key 并发进入会各自 resume/create，产出两个 agent，
     * 后写入 records 的覆盖前者且前者无人 dispose（泄漏）。
     */
    inflight = new Map();
    modelResolver;
    ctx;
    host;
    agents;
    config;
    logger;
    /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话释放时清理其待答问题 */
    questionChannel;
    /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话释放时清理其待批审批 */
    approvalChannel;
    /** 由 bootstrap 注入的重发通道（失败卡片 → 「重发 / 放弃」），会话释放时清理其待确认卡片 */
    retryChannel;
    constructor(ctx, agents, config, logger) {
        this.ctx = ctx;
        this.agents = agents;
        this.config = config;
        this.logger = logger;
        this.host = createHostAdapter(ctx, logger);
        this.logger.info(`host adapter capabilities: ${this.host.capabilities.join(', ')}`);
        this.modelResolver = new ModelResolver(ctx, config, logger);
        this.registerDirectPromptInjection();
        this.registerAgentDisposed();
    }
    /**
     * 监听宿主的 `agent/disposed`：agent 被 Web/TUI 或宿主自己关掉时，
     * 把它从已获取集合里摘掉，后续事件不再转发、也不再向死 agent 发 prompt。
     *
     * 事件按 agent 作用域派发，根作用域监听器必须带 `global` 才能收到。
     */
    registerAgentDisposed() {
        this.ctx.on('agent/disposed', (payload) => {
            const agent = payload?.agent;
            if (!agent)
                return;
            const record = this.records.get(agent.id);
            if (!record || record.agent !== agent)
                return;
            this.records.delete(agent.id);
            this.cancelPendingFor(agent.id);
            this.logger.info(`acquired session disposed externally: sessionId=${agent.id}`);
        }, { global: true });
    }
    /**
     * 通过 system-prompt/assemble waterfall 注入私聊额外 system prompt。
     *
     * 该事件在每次 turn 构建 request 时触发；此处把 `directPrompt` 作为额外
     * prompt section 追加。会话尚未建立（首次 assemble）或未配置额外 prompt
     * 时原样返回，不做改动。
     */
    registerDirectPromptInjection() {
        const assemble = async (_assembly, context, next) => {
            const assembled = await next();
            if (!context.agent)
                return assembled;
            const record = this.findByAgent(context.agent);
            if (!record)
                return assembled;
            const prompt = this.config.directPrompt;
            if (!prompt)
                return assembled;
            return {
                ...assembled,
                sections: [...(assembled.sections ?? []), { name: 'qqterm:scope-prompt', order: 90, text: prompt }],
            };
        };
        this.ctx.on('system-prompt/assemble', assemble);
    }
    /**
     * agentPresets 服务（已加入 inject，缺服务时插件不激活）
     */
    getPresetsService() {
        return this.ctx.agentPresets;
    }
    /**
     * settings 服务（已加入 inject）：写核心默认 preset 的唯一入口
     */
    getSettingsService() {
        return this.ctx.settings;
    }
    /**
     * 部署默认 preset（新建会话用它）
     *
     * 由核心 agent-preset-registry 的配置持有（`selectedDefault ?? default`），
     * 插件只读不存。
     */
    defaultPresetId() {
        try {
            return this.getPresetsService()?.defaultId;
        }
        catch (err) {
            this.logger.debug(`default preset unavailable: ${errorText(err)}`);
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
    /**
     * 当前会话的生效模型：会话自己记录的选择 → 核心默认值
     *
     * 选择由宿主记录在会话日志的 `model/selection` 事件里（Web 端切模型走同一条），
     * 插件不再另存一份；没有活跃会话时显示核心默认值。
     */
    getEffectiveModel(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        return record ? this.routeOf(record) : this.modelResolver.resolveDefault();
    }
    /** 某个会话实际生效的路由（宿主选择 → 默认链） */
    routeOf(record) {
        const selection = this.hostSelection(record.agent);
        if (selection) {
            return {
                provider: selection.provider,
                model: selection.model,
                ...(selection.reasoningEffort !== undefined
                    ? { reasoningEffort: selection.reasoningEffort }
                    : {}),
            };
        }
        return this.modelResolver.resolveDefault();
    }
    /**
     * 当前会话的 preset（已开始的会话取它锁定的值，未开始的取部署默认值）
     */
    getEffectivePreset(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        return record ? record.agentPreset : this.defaultPresetId();
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
            const defaultId = this.defaultPresetId();
            return list.map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                isDefault: p.isDefault ?? (defaultId !== undefined && p.id === defaultId),
            }));
        }
        catch (err) {
            this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
    /**
     * 切换当前会话的模型
     *
     * 走宿主 `sessionController.selectModel`（Web 端切模型同一条路径）：选择记进
     * 这个会话的 `model/selection` 事件，下一轮生效；会话历史不重建、插件不另存偏好。
     * 宿主只接受 live 会话，没有活跃会话时如实拒绝。
     */
    async setModelOverride(scope, peerId, route) {
        const key = this.sessionKey();
        const record = this.getSessionRecord(scope, peerId);
        if (!record) {
            this.logger.debug(`model switch refused (no active session): key=${key}`);
            return { ...route, reason: 'no-session' };
        }
        const current = this.routeOf(record);
        if (current.provider === route.provider && current.model === route.model) {
            this.logger.debug(`model switch skipped (already current): key=${key} → ${route.provider}/${route.model}`);
            return { ...route, unchanged: true };
        }
        // 换模型时把当前的思考强度一起带过去（Web 端也传整份选择）。目标模型不支持的档位丢弃，
        // 交给它的默认值；直接不传 effort 会被宿主当成「模型默认」，等于把用户选的档位清掉。
        const effort = this.hostSelection(record.agent)?.reasoningEffort;
        const keepEffort = effort === undefined
            ? undefined
            : (await this.modelResolver.reasoningInfo(route))?.efforts.some((option) => option.id === effort)
                ? effort
                : undefined;
        try {
            await this.sessionController.selectModel({
                sessionId: record.sessionId,
                provider: route.provider,
                model: route.model,
                ...(keepEffort !== undefined ? { reasoningEffort: keepEffort } : {}),
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`model switch failed: key=${key} err=${message}`);
            return { ...route, reason: 'failed', message };
        }
        // 宿主没装 model-selection projection 时 agent.model.current() 不会变，
        // 但 selectModel 已把选择写进会话日志，下一轮请求仍按它走。
        this.logger.info(`model switched: key=${key} → ${route.provider}/${route.model}`);
        return { ...route };
    }
    /**
     * 当前会话的思考强度视图（/reasoning、/model、/status 用）
     *
     * 只读宿主状态：会话自己的选择（projection 的 pending / 最近请求头）→
     * 部署默认选择 → 模型默认值。这里不维护第二份偏好。
     * 宿主拿不到元数据时 options 为 undefined：命令层据此显示「不支持」。
     */
    async getEffortView(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        const selection = this.hostSelection(record?.agent);
        const route = this.getEffectiveModel(scope, peerId)
            ?? selection
            ?? this.modelResolver.resolveDefault();
        const reasoning = await this.modelResolver.reasoningInfo(route);
        if (!reasoning || reasoning.efforts.length === 0)
            return { defaulted: true };
        const selectedEffort = this.selectedEffortOf(selection, route);
        const chosen = selectedEffort === undefined
            ? undefined
            : reasoning.efforts.find((option) => option.id === selectedEffort);
        const current = chosen ?? this.modelDefault(reasoning);
        return {
            options: reasoning.efforts,
            ...(current ? { current } : {}),
            defaulted: chosen === undefined,
        };
    }
    /**
     * 切换思考强度
     *
     * 走宿主 `sessionController.selectModel`：当前会话下一轮生效，默认值由宿主
     * 自己保存（新会话沿用）。`effort` 为 undefined 表示恢复模型默认值。
     */
    async selectEffort(scope, peerId, effort) {
        const key = this.sessionKey();
        const record = this.getSessionRecord(scope, peerId);
        const selection = this.hostSelection(record?.agent);
        const route = this.getEffectiveModel(scope, peerId)
            ?? selection
            ?? this.modelResolver.resolveDefault();
        const reasoning = await this.modelResolver.reasoningInfo(route);
        if (!reasoning)
            return { ok: false, reason: 'unsupported' };
        const target = effort === undefined
            ? undefined
            : reasoning.efforts.find((option) => option.id === effort);
        if (effort !== undefined && target === undefined) {
            return { ok: false, reason: 'unknown-effort', options: reasoning.efforts };
        }
        const selectedEffort = this.selectedEffortOf(selection, route);
        const current = selectedEffort === undefined
            ? undefined
            : reasoning.efforts.find((option) => option.id === selectedEffort);
        // 未显式选择时「选中模型默认档位」不产生变化，不写宿主
        const sameAsCurrent = target?.id === current?.id
            || (target !== undefined && current === undefined && target.id === this.modelDefault(reasoning)?.id);
        if (sameAsCurrent || (target === undefined && selectedEffort === undefined)) {
            this.logger.debug(`reasoning effort skipped (already current): key=${key} → ${target?.id ?? 'model default'}`);
            const shown = target ?? current;
            return { ok: true, ...(shown ? { effort: shown.id } : {}), unchanged: true };
        }
        const applied = await this.applySelection(route, target?.id, record);
        if (!applied.ok)
            return applied;
        const display = applied.effort !== undefined
            ? reasoning.efforts.find((option) => option.id === applied.effort) ?? this.modelDefault(reasoning)
            : this.modelDefault(reasoning);
        this.logger.info(`reasoning effort switched: key=${key} → ${display?.id ?? 'model default'}`);
        return { ok: true, ...(display ? { effort: display.id } : {}) };
    }
    /**
     * 把思考强度选择交给宿主 `sessionController`。
     *
     * 与核心一致：选择记进当前会话，同时成为新的部署默认值（接受这一点，
     * 不再写回旧默认）。`selectModel` 只对 live 会话生效：没有会话时如实拒绝。
     */
    async applySelection(route, effort, record) {
        if (!record)
            return { ok: false, reason: 'no' };
        try {
            const { selected } = await this.sessionController.selectModel({
                sessionId: record.sessionId,
                provider: route.provider,
                model: route.model,
                ...(effort !== undefined ? { reasoningEffort: effort } : {}),
            });
            return { ok: true, ...(selected.reasoningEffort !== undefined ? { effort: selected.reasoningEffort } : {}) };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`reasoning effort switch failed: ${message}`);
            return { ok: false, reason: 'failed', message };
        }
    }
    /**
     * 会话当前选择：projection 待生效的选择 → 最近请求头（排除 adapter 默认）
     * → 部署默认选择。都没有时返回 undefined。
     */
    hostSelection(agent) {
        if (agent) {
            const state = this.selectionState(agent);
            if (state?.pending)
                return toHostSelection(state.pending);
            const header = this.requestHeader(agent);
            if (header?.config?.provider && header.config.model) {
                const effort = header.adapterDefaults?.reasoningEffort === true
                    ? undefined
                    : header.config.reasoningEffort;
                return {
                    provider: header.config.provider,
                    model: header.config.model,
                    ...(effort !== undefined ? { reasoningEffort: String(effort) } : {}),
                };
            }
            if (state?.lastUsed)
                return toHostSelection(state.lastUsed);
        }
        return this.defaultSelection();
    }
    /** 宿主的 modelSelection projection（未注册时返回 undefined） */
    selectionState(agent) {
        try {
            const state = this.sessionProjections.stateOf(agent.session, 'modelSelection');
            return state ?? undefined;
        }
        catch (err) {
            this.logger.debug(`modelSelection projection unavailable: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    }
    /** 宿主最近一次请求头 */
    requestHeader(agent) {
        try {
            return agent.session.requestHeader?.();
        }
        catch {
            return undefined;
        }
    }
    /** 部署默认选择（agentDefaultModel.currentSelection） */
    defaultSelection() {
        const selection = this.agentDefaultModel.currentSelection();
        return selection?.provider && selection.model ? toHostSelection(selection) : undefined;
    }
    /** 宿主选择里的档位，只有选择的就是当前路由时才算数 */
    selectedEffortOf(selection, route) {
        if (!selection)
            return undefined;
        if (selection.provider !== route.provider || selection.model !== route.model)
            return undefined;
        return selection.reasoningEffort;
    }
    /** 模型默认档位：defaultEffort，没有时用第一项 */
    modelDefault(reasoning) {
        if (reasoning.defaultEffort !== undefined) {
            const hit = reasoning.efforts.find((option) => option.id === reasoning.defaultEffort);
            if (hit)
                return hit;
        }
        return reasoning.efforts[0];
    }
    /**
     * create / resume 的 agentOptions
     *
     * 与宿主核心一致：传响应式 getter，读 agentDefaultModel 的当前选择。会话一旦
     * 记录过 `model/selection`，宿主优先用会话自己的选择；getter 只在「这个会话
     * 还没选过模型」时生效，新会话因此始终跟随核心默认值。
     */
    agentOptionsFor() {
        const fallback = () => this.modelResolver.resolveDefault();
        const current = () => this.defaultSelection();
        return {
            get provider() {
                return current()?.provider ?? fallback().provider;
            },
            get model() {
                return current()?.model ?? fallback().model;
            },
            get reasoningEffort() {
                return current()?.reasoningEffort;
            },
        };
    }
    /**
     * 切换部署默认 preset
     *
     * preset 决定新建会话的工具集与提示词，由核心 agent-preset-registry 持有：
     * 这里写它的 `selectedDefault`（与设置页「设为默认」同一个入口），之后新建的
     * 会话用它；已经开始的会话保持自己的值。插件不另存待定 preset。
     */
    async setPresetOverride(_scope, _peerId, presetId) {
        const key = this.sessionKey();
        // 1. 校验 preset 存在 + 可加载（broken 拒绝）
        const presets = this.getPresetsService();
        let resolved;
        try {
            resolved = await presets.resolve(presetId);
        }
        catch (err) {
            return { ok: false, reason: 'unknown-preset', message: errorText(err) };
        }
        if (resolved.broken !== undefined) {
            return { ok: false, reason: 'broken', message: resolved.broken };
        }
        // 2. 写核心默认值；目标就是默认值时不再写（列表里的默认项也走这条命令）
        const targetId = resolved.id;
        if (this.defaultPresetId() === targetId) {
            this.logger.debug(`preset switch skipped (already default): key=${key} → ${targetId}`);
            return { ok: true, presetId: targetId, unchanged: true };
        }
        try {
            await this.getSettingsService().update(PRESET_SETTINGS_NS, { selectedDefault: targetId });
        }
        catch (err) {
            const message = errorText(err);
            this.logger.warn(`preset switch failed: key=${key} → ${targetId} err=${message}`);
            return { ok: false, reason: 'failed', message };
        }
        this.logger.info(`default preset set: key=${key} → ${targetId}`);
        return { ok: true, presetId: targetId };
    }
    // ── 权限预设（permission-presets，可选服务） ──
    /**
     * permissionPresets 服务（已加入 inject，缺服务时插件不激活）
     *
     * 它是「沙箱模式 + 审批策略」这一对旋钮的唯一写入口。
     */
    getPermissionPresetsService() {
        return this.ctx.permissionPresets;
    }
    /** 可切换的权限预设（含在线的 auto） */
    listPermissionPresets() {
        const presets = this.getPermissionPresetsService();
        try {
            const names = Array.isArray(presets.names) ? presets.names : [];
            return names.map((name) => {
                const option = presets.optionOf?.(name);
                return { id: name, name: option?.name, description: option?.description };
            });
        }
        catch (err) {
            // 目录读不出来不该让 /permission 抛到命令层（宿主投影缺失等）
            this.logger.warn(`list permission presets failed: ${errorText(err)}`);
            return [];
        }
    }
    /**
     * 某 chat 当前会话生效的权限预设。
     *
     * 会话还在内存里就读它自己的投影；会话还没起来（新聊天、刚 `/new`、重启后尚未打开）
     * 时退回宿主默认预设——下一条消息创建出来的会话就是按这个默认值走的，展示
     * 默认值比什么都不显示更接近「当前」。
     */
    getPermissionPreset(_scope, _peerId) {
        const presets = this.getPermissionPresetsService();
        const record = this.currentRecord();
        if (record) {
            try {
                return presets.current(record.agent.session);
            }
            catch (err) {
                this.logger.debug(`permission state unavailable: key=${record.sessionKey} ${errorText(err)}`);
            }
        }
        try {
            return presets.defaultPreset;
        }
        catch {
            return undefined;
        }
    }
    /**
     * 切换当前 chat 会话的权限预设（沙箱模式 + 审批策略立即生效）。
     *
     * 与宿主的 `/permission` 同语义：只动这一次会话，`/new` 之后的新会话回到
     * profile 默认预设。没有活跃会话时如实拒绝，不为了「切换」拉起一个空会话。
     */
    async setPermissionPreset(scope, peerId, preset) {
        const key = this.sessionKey();
        const presets = this.getPermissionPresetsService();
        if (!presets.names.includes(preset))
            return { ok: false, reason: 'unknown-preset' };
        const record = this.currentRecord(key);
        if (!record)
            return { ok: false, reason: 'no-session' };
        // 可重入：目标就是该会话当前的预设时直接返回
        if (this.getPermissionPreset(scope, peerId) === preset) {
            this.logger.debug(`permission switch skipped (already current): key=${key} preset=${preset}`);
            return { ok: true, preset, unchanged: true };
        }
        try {
            presets.set(record.agent.session, preset);
        }
        catch (err) {
            // auto 的准入检查失败（集成下线）也会走到这里：如实报错，不静默降级
            const message = errorText(err);
            this.logger.warn(`permission switch failed: key=${key} preset=${preset} err=${message}`);
            return { ok: false, reason: 'failed', message };
        }
        this.logger.info(`permission switched: key=${key} preset=${preset}`);
        return { ok: true, preset };
    }
    async listAvailableModels() {
        return this.modelResolver.listModels();
    }
    listProviders() {
        return this.modelResolver.listProviders();
    }
    // ── 会话状态 / 统计 ──
    getSessionRecord(_scope, _peerId) {
        return this.currentRecord();
    }
    /**
     * 当前聊天接的会话 id（内存指针优先，其次 prefs 里落盘的映射）。
     *
     * 两处都为空 = 这个聊天还没有会话（首次使用或刚 `/new`），不是错误状态。
     */
    currentSessionId(key = this.sessionKey()) {
        return this.currentByKey.get(key) ?? this.modelResolver.getSessionId(key);
    }
    /** 某个 sessionId 是不是当前聊天正在接的会话 */
    isCurrentSession(sessionId) {
        return this.currentSessionId() === sessionId;
    }
    /**
     * 会话标题（非当前会话的消息头 / 提问 / 审批共用）。
     *
     * 标题由宿主异步生成，取不到时返回 undefined，调用方用兜底名。
     */
    sessionTitle(sessionId) {
        const record = this.findBySessionId(sessionId);
        return record === undefined ? undefined : sessionTitleOf(record);
    }
    /** 当前聊天有没有可操作的会话（已获取记录，或进程内仍活着的 agent） */
    hasCurrentSession() {
        const sessionId = this.currentSessionId();
        if (sessionId === undefined)
            return false;
        return this.currentRecord() !== undefined || this.agents.get(sessionId) !== undefined;
    }
    /**
     * `/rename`：给当前会话改标题。
     *
     * 宿主的标题服务只接受**存活**的 session（它要往会话日志追加
     * `session/title` 事件），所以这里先找已获取记录；记录不在但进程内还有
     * live agent（Web / TUI 打开的同一会话）时也允许改名。冷会话返回
     * `no-session`，由命令层如实拒绝。
     */
    renameCurrentSession(title) {
        const record = this.currentRecord();
        if (record)
            return this.renameRecord(record, title);
        const sessionId = this.currentSessionId();
        const live = sessionId === undefined ? undefined : this.agents.get(sessionId);
        if (live === undefined)
            return { ok: false, reason: 'no-session' };
        return this.renameLive(live.id, live.session, title);
    }
    /**
     * 给指定会话改标题（`/sessions rename`）。
     *
     * 目标必须在已获取集合里，或至少有一个 live agent；冷会话不在这里静默
     * resume——那是 `/sessions resume` 的职责。
     */
    renameSession(sessionId, title) {
        const record = this.findBySessionId(sessionId);
        if (record)
            return this.renameRecord(record, title);
        const live = this.agents.get(sessionId);
        if (live === undefined)
            return { ok: false, reason: 'no-session' };
        return this.renameLive(sessionId, live.session, title);
    }
    renameRecord(record, title) {
        return this.renameLive(record.sessionId, record.agent.session, title);
    }
    /** 统一入口：标题写入宿主日志 + 留痕；空标题在动宿主前就拒绝 */
    renameLive(sessionId, session, title) {
        const trimmed = title.trim();
        if (trimmed === '')
            return { ok: false, reason: 'invalid', message: '新标题不能为空' };
        const outcome = this.host.renameSession(session, trimmed);
        if (outcome.ok) {
            this.logger.info(`session renamed: sessionId=${sessionId} title=${outcome.title}`);
        }
        else {
            this.logger.warn(`session rename failed: sessionId=${sessionId} reason=${outcome.reason}${outcome.message ? ` err=${outcome.message}` : ''}`);
        }
        return outcome;
    }
    /** 已获取会话快照（出站 / 问答 / 审批共用） */
    listAcquiredSessions() {
        return [...this.records.values()];
    }
    /**
     * 中止所有正在生成的已获取会话（`/stop all`）。
     *
     * QQ 侧只有一个聊天，已获取会话本来就都回同一个聊天，所以不再按 peer
     * 过滤。返回被中止的会话 id；没有正在生成的会话时返回空数组。
     */
    cancelAllRunning() {
        const cancelled = [];
        for (const record of [...this.records.values()]) {
            if (record.agent.status !== 'running')
                continue;
            record.agent.cancel({ kind: 'user' });
            this.cancelPendingFor(record.sessionId);
            cancelled.push(record.sessionId);
        }
        return cancelled;
    }
    /** 当前聊天接的会话记录；没有获取过（或已被外部关掉）返回 undefined */
    currentRecord(key = this.sessionKey()) {
        const sessionId = this.currentSessionId(key);
        return sessionId === undefined ? undefined : this.findBySessionId(sessionId);
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
    /** 聊天会话只有一个：任何私聊窗口都指向同一个 key */
    sessionKey() {
        return `qqterm:${this.config.appId}:chat`;
    }
    /** 宿主会话控制服务（inject 保证存在） */
    get sessionController() {
        return this.ctx.sessionController;
    }
    /** 宿主会话 projection 注册表（inject 保证存在） */
    get sessionProjections() {
        return this.ctx.sessionProjections;
    }
    /** 宿主部署默认模型选择（inject 保证存在） */
    get agentDefaultModel() {
        return this.ctx.agentDefaultModel;
    }
    /** 把当前会话 id 落盘，后续（重启、切换、并发调用）一律以 prefs 为准 */
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
            this.logger.warn(`qqterm: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`);
            return {};
        }
    }
    /** 获取或恢复或创建当前会话（get → resume → create）；同 key 并发合并为一次 */
    async getOrCreate(scope, peerId, senderId, replyTarget) {
        const key = this.sessionKey();
        const existing = this.currentRecord(key);
        if (existing) {
            this.touch(existing, scope, peerId, senderId, replyTarget);
            return existing;
        }
        // singleflight：同 key 并发复用同一次 resume/create，后到者只更新回复目标
        const pending = this.inflight.get(key);
        if (pending) {
            const shared = await pending;
            this.touch(shared, scope, peerId, senderId, replyTarget);
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
    /**
     * 收到一条消息后刷新会话记录上的「当前聊天」信息。
     *
     * 同一条记录可能被多个 QQ 窗口复用（聊天会话只有一个），这几项必须跟着最后
     * 一条消息走，否则 prompt、提问作答与回复目标会停在第一个说话的窗口上。
     */
    touch(record, scope, peerId, senderId, replyTarget) {
        record.replyTarget = replyTarget;
        record.scope = scope;
        record.peerId = peerId;
        record.senderId = senderId;
        // 记下最后说话的人：重启恢复会话时没有入站消息，只能靠它做回复目标
        if (replyTarget.targetId !== '')
            this.modelResolver.setTarget(record.sessionKey, replyTarget.targetId);
    }
    /** 改当前会话指针并落盘（prefs 仍只记 current） */
    setCurrent(key, sessionId) {
        this.currentByKey.set(key, sessionId);
        this.persistSessionId(key, sessionId);
    }
    /**
     * 清掉当前指针：“这个聊天现在没有会话，下一条消息再建”。
     *
     * 内存与 prefs 一起清，避免 `currentSessionId()` 的两处来源指向不同状态；
     * 目录保留，新会话仍落在上次的工作区。删空不是中间态，而是与“从未聊过”
     * 完全相同的空状态——不需要为它另设展示分支。
     */
    clearCurrent(key) {
        this.currentByKey.delete(key);
        if (this.modelResolver.getSessionId(key) !== undefined)
            this.modelResolver.clearSessionId(key);
    }
    /** getOrCreate 的实际打开流程（已通过 singleflight 保证同 key 串行） */
    async openSession(key, scope, peerId, senderId, replyTarget) {
        // prefs 命中 = 已知存量会话；miss = 全新会话（含刚按过 `/new`），铸一个新 id 后创建
        const mapped = this.modelResolver.getSessionId(key);
        const sessionId = SessionId(mapped ?? mintSessionId());
        this.logger.info(`getOrCreate: key=${key} sessionId=${sessionId}`);
        // 这个聊天的工作目录：新会话落在它里面，恢复的会话以它自己的 header 为准
        let directory = await this.chatDirectory(key);
        // 已经获取过这个会话（`/to` 先拿到、或 `/sessions resume` 接上）：直接复用记录
        const known = this.records.get(sessionId);
        if (known) {
            this.touch(known, scope, peerId, senderId, replyTarget);
            this.setCurrent(key, sessionId);
            this.rememberDirectory(key, this.host.sessionDirectory(known.agent.session) ?? directory);
            return known;
        }
        let agent;
        let handle;
        let agentPreset;
        const live = this.agents.get(sessionId);
        if (live) {
            agent = live;
            agentPreset = await this.resolvePersistedPreset(sessionId);
            directory = this.host.sessionDirectory(agent.session) ?? directory;
            this.logger.info(`reusing live agent: key=${key}`);
        }
        else {
            // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
            // 优先 session 当初的 preset（started 锁定语义）；新会话用核心默认值。
            const presetId = await this.resolvePersistedPreset(sessionId);
            const composed = await this.composePreset(presetId);
            agentPreset = composed.agentPreset;
            try {
                // 与核心一致：agentOptions 是响应式 getter，会话里记录过的选择优先
                const resumeOptions = this.agentOptionsFor();
                const resumed = await this.agents.resume({
                    resumeSessionId: sessionId,
                    agentOptions: resumeOptions,
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = resumed.agent;
                handle = resumed;
                directory = this.host.sessionDirectory(agent.session) ?? directory;
                const resumedRoute = this.hostSelection(agent) ?? this.modelResolver.resolveDefault();
                this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumedRoute.provider}/${resumedRoute.model}`);
            }
            catch (err) {
                if (!(await this.mayCreateAfterResumeFailure(key, sessionId, err)))
                    throw err;
                mkdirSync(directory, { recursive: true });
                const createOptions = this.agentOptionsFor();
                const created = await this.agents.create({
                    sessionId,
                    meta: {
                        cwd: directory,
                        ...(agentPreset ? { agentPreset } : {}),
                    },
                    agentOptions: createOptions,
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = created.agent;
                handle = created;
                this.logger.info(`created new session: key=${key} sessionId=${sessionId} preset=${agentPreset ?? 'none'} cwd=${directory}`);
            }
        }
        const record = {
            sessionKey: key,
            sessionId,
            agent,
            ...(handle ? { handle } : {}),
            replyTarget,
            scope,
            peerId,
            senderId,
            ...(agentPreset ? { agentPreset } : {}),
            acquiredAt: Date.now(),
        };
        this.records.set(sessionId, record);
        this.setCurrent(key, sessionId);
        // 工作区跟着会话走：记下这个聊天当前目录，供下次 /new 或重启后沿用
        this.rememberDirectory(key, directory);
        // 挂载到对应工作区（侧边栏可见性）；fail-soft、异步执行，不阻塞消息处理。
        // 宿主只在客户端 session.create RPC 时挂载会话，插件会话不走那条路径，
        // 所以这里补挂一次（幂等，升级后老会话也会补上）。
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
     * 按 sessionId 查已获取记录。
     *
     * 宿主把同一个 id 换成了另一个 live agent（外部 dispose 后重开）时，旧记录
     * 已经失效：摘掉并返回 undefined，避免把事件转发到死 agent。
     */
    findBySessionId(sessionId) {
        const record = this.records.get(sessionId);
        if (!record)
            return undefined;
        const live = this.agents.get(sessionId);
        if (live !== undefined && live !== record.agent) {
            this.records.delete(sessionId);
            this.cancelPendingFor(sessionId);
            this.logger.info(`acquired session replaced externally, dropped: sessionId=${sessionId}`);
            return undefined;
        }
        return record;
    }
    findByAgent(agent) {
        const record = this.records.get(agent.id);
        return record?.agent === agent ? record : undefined;
    }
    /** 某个 sessionId 是否还有 live agent（`/to` 的目标校验用） */
    hasLiveSession(sessionId) {
        return this.agents.get(sessionId) !== undefined;
    }
    /**
     * `/new`：清掉当前指针，下一条消息再建会话。
     *
     * 旧会话仍然 live、仍在已获取集合里，继续把输出发回 QQ（带 `#短id`）；
     * 不 cancel、不 dispose、不清 pending。这里不预先铸 id：没有会话就是没有
     * 指针，`/sessions` 不会显示一条点「恢复」必然失败的当前项。
     */
    async remove() {
        const key = this.sessionKey();
        this.clearCurrent(key);
        this.logger.info(`new session: key=${key} (current cleared; previously acquired sessions stay live)`);
    }
    /**
     * `/clear` `/reset`：停掉当前会话，再清空指针。
     *
     * 与 `remove()` 的区别：这里会把当前会话从已获取集合里摘掉——cancel 正在
     * 生成的回合，有 handle 的 dispose，借来的只丢引用；它不再回 QQ。其它已获取
     * 会话不受影响，工作区也不变。
     *
     * @returns 是否真的停掉了一个已获取的当前会话
     */
    async resetCurrentSession() {
        const key = this.sessionKey();
        const record = this.currentRecord(key);
        // 先清指针再释放：dispose 可能要等，期间新消息不能又落回旧会话
        this.clearCurrent(key);
        if (!record) {
            this.logger.info(`new session: key=${key} (no current session to stop)`);
            return false;
        }
        await this.dropRecord(record, { cancel: true, dispose: true });
        this.logger.info(`session reset: key=${key} (stopped sessionId=${record.sessionId})`);
        return true;
    }
    /**
     * `/clear all` `/reset all`：停掉所有已获取会话，再清空指针。
     *
     * 不分 running / idle：全部 cancel、清 pending、有 handle 的 dispose，
     * 清空已获取集合后回到“没有会话”。工作区不变。
     *
     * @returns 被停掉的会话数
     */
    async resetAllSessions() {
        const key = this.sessionKey();
        const records = [...this.records.values()];
        // 先清指针：循环里的 await 期间新消息不能落回任何一个旧会话
        this.clearCurrent(key);
        for (const record of records) {
            await this.dropRecord(record, { cancel: true, dispose: true });
        }
        this.logger.info(`all sessions reset: key=${key} (stopped=${records.length})`);
        return records.length;
    }
    /**
     * `/to <会话> <文本>`：向指定会话发 prompt，或在它等答案时提交答案。
     *
     * 目标必须已经在已获取集合里，或者至少有一个 live agent（`agents.get` 命中）。
     * 冷会话（只在磁盘上）拒绝，不在这里 resume——resume 是 `/sessions resume` 的事。
     * 无论哪种情况都不改 current。
     */
    async sendTo(scope, peerId, senderId, sessionId, text, replyTarget) {
        const key = this.sessionKey();
        const body = text.trim();
        let record = this.findBySessionId(sessionId);
        // current 是聊天自己的会话：重启后尚未打开时，允许走普通消息同一条打开路径。
        // 其它冷会话仍然拒绝，避免 /to 偷偷复活一个任意的磁盘会话。
        if (!record && sessionId === this.currentSessionId()) {
            try {
                record = await this.getOrCreate(scope, peerId, senderId, replyTarget);
            }
            catch (err) {
                const message = errorText(err);
                this.logger.warn(`/to current session open failed: sessionId=${sessionId} err=${message}`);
                return { ok: false, reason: 'failed', sessionId, message };
            }
        }
        if (record) {
            // 借来的记录没有 handle，只能靠 registry 判断是否还活着；已死的不要往里发
            if (record.handle === undefined && this.agents.get(sessionId) === undefined) {
                this.records.delete(sessionId);
                this.cancelPendingFor(sessionId);
                return { ok: false, reason: 'not-running', sessionId };
            }
            if (record.peerId !== peerId) {
                return { ok: false, reason: 'forbidden', sessionId };
            }
            this.touch(record, scope, peerId, senderId, replyTarget);
        }
        else {
            const live = this.agents.get(sessionId);
            if (!live)
                return { ok: false, reason: 'not-running', sessionId };
            const agentPreset = await this.resolvePersistedPreset(sessionId);
            record = {
                sessionKey: key,
                sessionId,
                agent: live,
                replyTarget,
                scope,
                peerId,
                senderId,
                ...(agentPreset ? { agentPreset } : {}),
                acquiredAt: Date.now(),
            };
            this.records.set(sessionId, record);
            this.logger.info(`session acquired via /to: sessionId=${sessionId}`);
        }
        const questions = this.questionChannel;
        if (questions?.hasPending(sessionId)) {
            if (body === '') {
                questions.beginAnswerMode(peerId, sessionId);
                return { ok: true, kind: 'answer-mode', sessionId };
            }
            if (questions.answer(sessionId, body))
                return { ok: true, kind: 'answered', sessionId };
            return { ok: false, reason: 'failed', sessionId, message: '答案解析失败' };
        }
        if (body === '')
            return { ok: false, reason: 'empty', sessionId };
        try {
            // 原文留档：轮次失败后「重发」要用（宿主没有重跑已结束一轮的 API）
            record.lastPrompt = body;
            record.agent.followup(createQQUserMessage(body));
        }
        catch (err) {
            const message = errorText(err);
            this.logger.warn(`/to followup failed: sessionId=${sessionId} err=${message}`);
            return { ok: false, reason: 'failed', sessionId, message };
        }
        this.logger.info(`prompt sent via /to: sessionId=${sessionId}`);
        return { ok: true, kind: 'sent', sessionId };
    }
    /**
     * 重发当前会话最近一条用户消息（`/retry` 与失败卡片的「重发」共用）。
     *
     * 宿主没有「重跑已结束一轮」的 API：只能靠记住的原文再开一轮，历史里因此会
     * 多出一条相同的用户消息——这是换取「不重打原文就能再试一次」的既定代价。
     */
    retryLastPrompt(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        if (!record)
            return { ok: false, reason: 'no-session' };
        const prompt = record.lastPrompt;
        if (prompt === undefined || prompt.trim() === '')
            return { ok: false, reason: 'no-prompt' };
        try {
            record.agent.followup(createQQUserMessage(prompt));
        }
        catch (err) {
            const message = errorText(err);
            this.logger.warn(`/retry followup failed: sessionId=${record.sessionId} err=${message}`);
            return { ok: false, reason: 'failed', message };
        }
        this.logger.info(`prompt resent: sessionId=${record.sessionId}`);
        return { ok: true, sessionId: record.sessionId };
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
        const record = this.currentRecord(key);
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
    async listWorkspaceSessions(_scope, _peerId) {
        const key = this.sessionKey();
        const workspace = await this.chatDirectory(key);
        const currentId = this.currentSessionId(key);
        const archived = this.host.archivedSessionIds();
        const visible = (await this.host.listSessions())
            .filter((session) => session.origin !== 'subagent')
            .filter((session) => session.cwd !== undefined && samePath(session.cwd, workspace))
            .sort((a, b) => b.createdAt - a.createdAt);
        // 这里只列当前工作区，但条目也要带工作区字段：归档候选 / 归档页按它分组，
        // 缺了就会全部落进「未分组」。
        const workspaceInfo = this.host.workspaceList().find((item) => samePath(item.path, workspace));
        const workspaceTitle = workspaceInfo?.title ?? basename(workspace);
        const workspaceMissing = workspaceInfo !== undefined
            ? !isDirectory(workspaceInfo.path)
            : !isDirectory(workspace);
        const workspaceFields = workspace === ''
            ? {}
            : {
                ...(workspaceTitle !== '' ? { workspace: workspaceTitle } : {}),
                workspacePath: workspace,
                workspaceMissing,
            };
        // 标题要逐个读日志，只取「会展示出来的那些」：默认列表只显示未归档的前 10 条，
        // 给已归档的会话读标题纯属浪费（归档页走的是分组列举）
        const shown = visible.filter((session) => !archived.has(session.id)).slice(0, TITLE_FETCH_LIMIT);
        const titles = await this.host.sessionTitles(shown.map((s) => s.id));
        return visible.map((session) => {
            const record = this.records.get(session.id);
            return {
                id: session.id,
                createdAt: session.createdAt,
                current: session.id === currentId,
                live: session.live,
                held: record !== undefined,
                running: record?.agent.status === 'running',
                isSeeded: session.isSeeded,
                archived: archived.has(session.id),
                ...(titles.has(session.id) ? { title: titles.get(session.id) } : {}),
                ...workspaceFields,
            };
        });
    }
    /**
     * 列出 QQ 已获取的会话（跨工作区，`/sessions` 默认视图）。
     *
     * 顺序是「当前 → 其它持有」，同组按获取时间倒序；宿主列表暂时没有返回的
     * 持有会话也保留（用 agent 的目录与获取时间兜底），避免刚切过去就从列表消失。
     * 标题读取失败不影响列表本身，取不到就显示「未命名会话」。
     *
     * @param scope 当前 chat 作用域（用于标记 current）
     * @param peerId 当前 chat 的 peer id
     */
    async listHeldSessions(_scope, _peerId) {
        const key = this.sessionKey();
        const currentId = this.currentSessionId(key);
        const archived = this.host.archivedSessionIds();
        const records = [...this.records.values()].filter((record) => !archived.has(record.sessionId));
        if (records.length === 0)
            return [];
        const hostSessions = await this.host.listSessions().catch(() => []);
        const byId = new Map(hostSessions.map((session) => [session.id, session]));
        const ordered = records.sort((left, right) => {
            const currentDiff = Number(right.sessionId === currentId) - Number(left.sessionId === currentId);
            return currentDiff !== 0 ? currentDiff : right.acquiredAt - left.acquiredAt;
        });
        const titles = await this.host
            .sessionTitles(ordered.slice(0, TITLE_FETCH_LIMIT_ALL).map((record) => record.sessionId))
            .catch(() => new Map());
        const workspaces = this.host.workspaceList();
        return ordered.map((record) => {
            const info = byId.get(record.sessionId);
            const directory = info?.cwd ?? this.host.sessionDirectory(record.agent.session);
            const workspace = directory === undefined
                ? undefined
                : workspaces.find((item) => samePath(item.path, directory));
            const workspacePath = workspace?.path ?? directory;
            const workspaceTitle = workspace?.title ?? (directory === undefined ? undefined : basename(directory));
            return {
                id: record.sessionId,
                ...(titles.has(record.sessionId) ? { title: titles.get(record.sessionId) } : {}),
                createdAt: info?.createdAt ?? record.acquiredAt,
                current: record.sessionId === currentId,
                live: true,
                held: true,
                running: record.agent.status === 'running',
                isSeeded: info?.isSeeded ?? false,
                archived: false,
                ...(workspaceTitle !== undefined ? { workspace: workspaceTitle } : {}),
                ...(workspacePath !== undefined
                    ? { workspacePath, workspaceMissing: !isDirectory(workspacePath) }
                    : {}),
            };
        });
    }
    /**
     * 这个聊天当前所在的工作区（标题 / 路径 / 目录是否还在）。
     *
     * @param scope 当前 chat 作用域
     * @param peerId 当前 chat 的 peer id
     */
    async currentWorkspaceInfo(_scope, _peerId) {
        const key = this.sessionKey();
        const workspace = await this.chatDirectory(key);
        const info = this.host.workspaceList().find((item) => samePath(item.path, workspace));
        if (info) {
            return { title: info.title, path: info.path, missing: !isDirectory(info.path) };
        }
        return { title: basename(workspace), path: workspace, missing: !isDirectory(workspace) };
    }
    /** 宿主工作区清单（`/new <工作区>` 匹配用） */
    listWorkspaceInfos() {
        return this.host.workspaceList().map((item) => ({
            title: item.title,
            path: item.path,
            missing: !isDirectory(item.path),
        }));
    }
    /**
     * 解析工作区参数：宿主工作区的标题、目录名（大小写不敏感，支持唯一前缀）
     * 或绝对路径。
     *
     * 只做解析与目录校验，不看会话状态、不写任何记录。`/new <工作区>` 要先用它
     * 验一遍：路径写错不该把当前会话弄丢。
     *
     * @param arg 工作区标题 / 目录名 / 绝对路径
     */
    resolveWorkspace(arg) {
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
        return { ok: true, title, path, isNew };
    }
    /**
     * 改这个聊天的工作区（下一个会话落在哪个目录）。
     *
     * 只在会话还没落盘时生效：已有会话时改目录是静默无效的——resume 回来的会话
     * 以自己的 header.cwd 为准，紧接着 `rememberDirectory` 会把记录覆盖回去——所以
     * 这里直接拒绝，由调用方给出下一步。
     *
     * @param scope 当前 chat 作用域
     * @param peerId 当前 chat 的 peer id
     * @param arg 工作区标题 / 目录名 / 绝对路径
     */
    async changeChatWorkspace(_scope, _peerId, arg) {
        const resolved = this.resolveWorkspace(arg);
        if (!resolved.ok)
            return resolved;
        const key = this.sessionKey();
        const blocked = await this.workspaceBlocker(key);
        if (blocked !== undefined)
            return { ok: false, reason: 'has-session', sessionId: blocked };
        this.modelResolver.setDirectory(key, resolved.path);
        this.logger.info(`chat workspace changed: key=${key} dir=${resolved.path}`);
        return resolved;
    }
    /** 挡住工作区修改的会话 id；undefined = 还没有落盘的会话，可以改 */
    async workspaceBlocker(key) {
        const live = this.currentRecord(key);
        if (live)
            return live.sessionId;
        const mapped = this.currentSessionId(key);
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
    async listWorkspaceGroups(_scope, _peerId) {
        const key = this.sessionKey();
        const currentId = this.currentSessionId(key);
        const archived = this.host.archivedSessionIds();
        const pinned = this.host.pinnedSessionIds();
        const all = await this.host.listSessions();
        const sessions = all
            .filter((session) => session.origin !== 'subagent')
            .filter((session) => session.cwd !== undefined)
            .sort((a, b) => b.createdAt - a.createdAt);
        /** 分组条目：标题在分组拼好之后再补（要先知道哪些行真的会展示） */
        const asEntry = (session, workspace) => {
            const record = this.records.get(session.id);
            return {
                id: session.id,
                createdAt: session.createdAt,
                current: session.id === currentId,
                live: session.live,
                held: record !== undefined,
                running: record?.agent.status === 'running',
                isSeeded: session.isSeeded,
                archived: archived.has(session.id),
                workspace,
            };
        };
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
     * 启动时把上次的会话接回来（网关在 QQ ready 后调用，失败不抛出）。
     *
     * 不接的话，重启后 record 为空、prefs 指针还在：`/status` 说「未建立」、
     * `/model` 说「没有会话」，可下一条普通消息又能接回旧会话——同一件事两种
     * 说法。接回之后「有会话」与「有 record」始终同真同假，不需要再为中间态
     * 设计任何一种展示分支。
     *
     * 走 getOrCreate 而不是裸 resume：它自带 singleflight，启动瞬间正好来消息
     * 也只会 resume 一次。
     */
    async restoreCurrentSession() {
        const key = this.sessionKey();
        const sessionId = this.modelResolver.getSessionId(key);
        if (sessionId === undefined)
            return { kind: 'none' };
        // 盘上已经没有了就别试：resume 失败后宿主也不会允许重建，白跑一趟。
        // 指针一并清掉：留着会让 `/sessions` 把死会话显示成「待恢复」，
        // 点「恢复当前」又只会报没有匹配的会话。目录保留，下一条消息仍落在上次工作区。
        if ((await this.host.sessionExists(sessionId).catch(() => undefined)) === false) {
            this.modelResolver.clearSessionId(key);
            this.logger.info(`启动恢复跳过：会话已不存在，已清除指针 sessionId=${sessionId}`);
            return { kind: 'none' };
        }
        // 重启后没有入站消息可回，只能用上次交互记下的 openid 做回复目标
        const targetId = this.modelResolver.getTarget(key) ?? '';
        const target = { scope: 'c2c', targetId };
        try {
            await this.getOrCreate('c2c', targetId, targetId, target);
        }
        catch (err) {
            const message = errorText(err);
            const locked = err?.name === 'SessionAlreadyOwnedError'
                || /already ?owned|ownership|write handle/i.test(message);
            this.logger.warn(`启动恢复会话失败: sessionId=${sessionId} err=${message}`);
            if (targetId === '')
                return { kind: 'none' };
            return { kind: 'failed', sessionId, targetId, locked, message };
        }
        this.logger.info(`启动已恢复会话: sessionId=${sessionId}`);
        return { kind: 'ok', sessionId };
    }
    /**
     * 把当前 chat 切到指定会话（接上历史继续）。
     *
     * 只改 current 指针：旧会话不 cancel、不 dispose、不退出已获取集合，仍继续
     * 把输出发回 QQ（带 `#短id`）。目标已在内存里就直接接上；不在就 `agents.get`
     * 拿 live agent，拿不到才 `agents.resume`。**resume 失败只报错，不 create**。
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
        const key = this.sessionKey();
        // 归档即不可用：恢复前先取消归档，失败则如实报错（此时还没动映射）
        const unarchived = this.host.archivedSessionIds().has(sessionId);
        if (unarchived) {
            const restored = await this.host.unarchiveSession(sessionId);
            if (!restored.ok) {
                this.logger.warn(`session resume refused: id=${sessionId} 取消失败=${restored.reason}`);
                return {
                    ok: false,
                    reason: 'failed',
                    message: `该会话已归档，取消归档失败: ${restored.message ?? restored.reason ?? '未知原因'}`,
                };
            }
        }
        const wasCurrent = this.currentSessionId(key) === sessionId;
        // 已经获取过：只把指针挪过去，不动 agent 生命周期
        const existing = this.findBySessionId(sessionId);
        if (existing) {
            this.touch(existing, scope, peerId, senderId, replyTarget);
            this.setCurrent(key, sessionId);
            this.rememberDirectory(key, this.host.sessionDirectory(existing.agent.session));
            this.logger.info(`session switched (already acquired): key=${key} sessionId=${sessionId}`);
            return wasCurrent
                ? (unarchived ? { ok: true, reason: 'same', unarchived: true } : { ok: true, reason: 'same' })
                : (unarchived ? { ok: true, unarchived: true } : { ok: true });
        }
        // 存在性求证：undefined = 宿主没有 stat 能力，按存在处理（交给 resume 判定）
        const exists = await this.host.sessionExists(sessionId);
        if (exists === false)
            return { ok: false, reason: 'not-found' };
        let agent;
        let handle;
        let agentPreset;
        const live = this.agents.get(sessionId);
        if (live) {
            agent = live;
            agentPreset = await this.resolvePersistedPreset(sessionId);
        }
        else {
            const presetId = await this.resolvePersistedPreset(sessionId);
            const composed = await this.composePreset(presetId);
            agentPreset = composed.agentPreset;
            try {
                // 与核心一致：agentOptions 读部署默认值，会话自己的选择由宿主回放优先
                const resumeOptions = this.agentOptionsFor();
                const resumed = await this.agents.resume({
                    resumeSessionId: sessionId,
                    agentOptions: resumeOptions,
                    ...(composed.setup ? { setup: composed.setup } : {}),
                });
                agent = resumed.agent;
                handle = resumed;
            }
            catch (err) {
                const raw = errorText(err);
                const locked = err?.name === 'SessionAlreadyOwnedError'
                    || /already ?owned|ownership|write handle/i.test(raw);
                this.logger.warn(`session switch failed: key=${key} target=${sessionId} err=${raw}`);
                return locked
                    ? { ok: false, reason: 'locked' }
                    : { ok: false, reason: 'failed', message: raw };
            }
        }
        const directory = this.host.sessionDirectory(agent.session) ?? await this.chatDirectory(key);
        const record = {
            sessionKey: key,
            sessionId,
            agent,
            ...(handle ? { handle } : {}),
            replyTarget,
            scope,
            peerId,
            senderId,
            ...(agentPreset ? { agentPreset } : {}),
            acquiredAt: Date.now(),
        };
        this.records.set(sessionId, record);
        this.setCurrent(key, sessionId);
        this.rememberDirectory(key, directory);
        if (directory)
            void this.host.attachSessionToWorkspace(sessionId, directory);
        this.logger.info(`session switched: key=${key} sessionId=${sessionId} acquired=${handle ? 'owned' : 'borrowed'}`);
        return wasCurrent
            ? (unarchived ? { ok: true, reason: 'same', unarchived: true } : { ok: true, reason: 'same' })
            : (unarchived ? { ok: true, unarchived: true } : { ok: true });
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
        // 1) 释放本进程内指向它的 agent（正在生成的先 cancel；借来的只能 cancel）
        const record = this.records.get(sessionId);
        if (record)
            await this.dropRecord(record, { cancel: true, dispose: true });
        const alreadyArchived = this.host.archivedSessionIds().has(sessionId);
        // 2) 写宿主的归档集
        const outcome = await this.host.archiveSession(sessionId);
        if (!outcome.ok) {
            this.logger.warn(`session archive failed: id=${sessionId} reason=${outcome.reason ?? 'unknown'} ${outcome.message ?? ''}`);
            return outcome;
        }
        // 3) 清掉指向归档会话的映射，下一条消息落到全新会话
        let remapped = 0;
        const key = this.sessionKey();
        if (this.currentSessionId(key) === sessionId) {
            this.clearCurrent(key);
            remapped = 1;
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
    /**
     * 摘掉一条已获取记录。
     *
     * dispose 只对 create/resume 拿到的 handle 可用；`agents.get()` 借来的 agent
     * 只能 cancel，不能替宿主 dispose。
     */
    async dropRecord(record, options = {}) {
        if (this.records.get(record.sessionId) === record)
            this.records.delete(record.sessionId);
        if (options.cancel)
            record.agent.cancel({ kind: 'user' });
        this.cancelPendingFor(record.sessionId);
        if (options.dispose && record.handle) {
            await record.handle.dispose().catch(() => { });
        }
    }
    /** 释放会话时统一清理其待答问题/待批审批/待确认重发，避免 pending 悬挂泄漏 */
    cancelPendingFor(sessionId) {
        this.questionChannel?.cancelPending(sessionId);
        this.approvalChannel?.cancelPending(sessionId);
        this.retryChannel?.cancelPending(sessionId);
    }
    /**
     * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
     *
     * compaction 是 preset 作用域服务，只从会话绑定的 preset 解析；
     * preset 没挂压缩引擎就明确失败，不退回宿主面。
     */
    async compact(scope, peerId, revive) {
        const key = this.sessionKey();
        let record = this.currentRecord(key);
        if (!record) {
            // 无活跃会话（重启后尚未打开）时从磁盘拉起，历史在磁盘上仍可压缩
            if (!revive)
                return { ok: false, reason: 'no-session' };
            record = await this.getOrCreate(scope, peerId, revive.senderId, revive.replyTarget);
        }
        if (record.agent.status !== 'idle')
            return { ok: false, reason: 'busy' };
        const compaction = (await this.host.serviceFor(record.agent, 'compaction'));
        if (!compaction)
            return { ok: false, reason: 'no-compaction' };
        const route = this.routeOf(record);
        const agentCtx = {
            session: record.agent.session,
            options: { provider: route.provider, model: route.model },
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
    /**
     * 插件卸载：有 handle 的 cancel + dispose；`agents.get()` 借来的只清引用，
     * 不替宿主决定生命周期。
     */
    async disposeAll() {
        const records = [...this.records.values()];
        this.records.clear();
        this.currentByKey.clear();
        const owned = [];
        for (const record of records) {
            this.cancelPendingFor(record.sessionId);
            if (record.handle) {
                record.agent.cancel({ kind: 'user' });
                owned.push(record);
            }
        }
        await Promise.allSettled(owned.map((record) => record.handle.dispose()));
        this.logger.info(`all acquired sessions released (count=${records.length}, owned=${owned.length})`);
    }
    get size() {
        return this.records.size;
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