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
import { mainRepositoryRoot, WORKTREE_TIMEOUT_MS, WorktreeError, worktreeFailureText, worktreeNotice, worktreeSourceRoot } from "./worktree.js";
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHostAdapter, } from "../host/adapter.js";
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { resolveAgentCwd } from "../shared/dirs.js";
import { optionalService } from "../shared/index.js";
import { sessionTitleOf } from "../transport/session-source.js";
import { ModelResolver } from "../model/model-resolver.js";
/** 没有活跃会话时，部署默认选择用的串行化键 */
const DEFAULT_SELECTION_KEY = '@default';
/** agent preset 默认值所在的配置条目（与设置页写的是同一个 namespace） */
const PRESET_SETTINGS_NS = 'agent-preset-registry';
/** 权限预设默认值所在的配置条目（与设置页写的是同一个 namespace） */
const PERMISSION_SETTINGS_NS = 'permission';
/** 会话列表最多为多少条会话读取标题（每条都要读一遍日志，是列表的耗时大头） */
const TITLE_FETCH_LIMIT = 10;
/**
 * `/sessions` 持有列表一次最多读多少条标题。
 *
 * 只对会展示的行读：读日志是列表的耗时大头，全部读会让命令卡住。
 */
const TITLE_FETCH_LIMIT_HELD = 40;
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
    /**
     * 选择写入的串行化链：sessionId（或部署默认值键）→ 上一次写入的完成信号。
     *
     * `/model` 与 `/reasoning` 都是「读当前选择 → 拼新选择 → 写回」，并发进入会
     * 用旧值覆盖对方。只串 QQ 渠道自己的写入；Web 端并发改同一个会话不在链上。
     */
    selectionChains = new Map();
    /**
     * 当前这个聊天的工作目录（内存态，唯一读写来源）。
     *
     * 构造时优先读回上次记下的目录，没有或已不存在才取宿主默认工作区；
     * 之后只由 acquire / 切换会话 / `/new <工作区>` / 运行期 `cd` 覆盖并落盘；
     * 读取不做任何回退。
     */
    chatDir;
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
    /** 由 bootstrap 注入的会话确认通道（`/clear`、`/new` 的二次确认） */
    sessionConfirmChannel;
    /** 最近一次读到的有效部署默认权限预设（部署默认被写坏时用它回正） */
    lastKnownDefaultPermission;
    constructor(ctx, agents, config, logger) {
        this.ctx = ctx;
        this.agents = agents;
        this.config = config;
        this.logger = logger;
        this.host = createHostAdapter(ctx, logger);
        this.chatDir = this.host.defaultWorkspacePath() ?? resolveAgentCwd(undefined);
        this.logger.info(`host adapter capabilities: ${this.host.capabilities.join(', ')}`);
        this.modelResolver = new ModelResolver(ctx, config, logger);
        // 启动时优先用上次记下的工作目录；目录已不存在才退回默认值。
        // 旧版本可能把工作树路径写进这里，读回时同样归一到主仓库根
        const savedDir = this.modelResolver.getDirectory(this.sessionKey());
        if (savedDir !== undefined && isDirectory(savedDir))
            this.chatDir = this.workspaceDirOf(savedDir);
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
            this.selectionChains.delete(agent.id);
            this.cancelPendingFor(agent.id);
            this.logger.info(`acquired session disposed externally: sessionId=${agent.id}`);
        }, { global: true });
    }
    /**
     * agentPresets 服务（可选，不在 inject 里）
     *
     * 部署里可能没有 agent-preset-registry（base / headless / 自组 profile）。
     * 必须走 `ctx.get('agentPresets')`：不在 inject 里时属性访问会直接抛
     * `cannot get property "agentPresets" without inject`，可选链兜不住。
     * 取不到时 /preset 整条不注册，新建 / 恢复的会话不挂 preset，走宿主默认组合。
     */
    getPresetsService() {
        return optionalService(this.ctx, 'agentPresets');
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
     * 部署里有没有 agentPresets 服务（决定 /preset 是否注册：没有就整条命令不出现）
     */
    presetsAvailable() {
        return this.getPresetsService() !== undefined;
    }
    /**
     * 部署里有没有 worktrees 服务（决定 /worktree 是否注册：没有就整条命令不出现）
     */
    worktreesAvailable() {
        return this.host.worktrees() !== undefined;
    }
    /** 之后新建的会话是否开工作树（默认开） */
    worktreeEnabled() {
        return this.modelResolver.getWorktreeDefault() ?? true;
    }
    /** 设置之后新建的会话是否开工作树；已有会话与其树不受影响 */
    setWorktreeEnabled(enabled) {
        this.modelResolver.setWorktreeDefault(enabled);
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
     * 切换模型
     *
     * 有活跃会话时把选择写进这个会话的 `model/selection`（宿主 dsh-agent 的
     * `agent.model.select`，与 Web 端切模型落的是同一条事件）：下一轮生效，会话
     * 历史不重建、插件不另存偏好。没有活跃会话时写部署默认值
     * （`agentDefaultModel.saveSelection`），之后新建的会话用它。
     *
     * 整段「读当前值 → 校验 → 写回」在 `serializeSelection` 里跑：QQ 侧并发的
     * `/model` 与 `/reasoning` 不能互相覆盖。Web 端同时改同一个会话不在这里处理。
     */
    async setModelOverride(scope, peerId, route) {
        const key = this.sessionKey();
        const record = this.getSessionRecord(scope, peerId);
        return this.serializeSelection(record?.sessionId ?? DEFAULT_SELECTION_KEY, async () => {
            const current = record ? this.routeOf(record) : this.modelResolver.resolveDefault();
            if (current.provider === route.provider && current.model === route.model) {
                this.logger.debug(`model switch skipped (already current): key=${key} → ${route.provider}/${route.model}`);
                return { ...route, unchanged: true };
            }
            // 拼错的路由一律不落盘：没有会话时不写默认值，有会话时不写进会话日志
            let known;
            try {
                known = await this.modelResolver.hasModel(route.provider, route.model);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn(`model switch failed: key=${key} err=${message}`);
                return { ...route, reason: 'failed', message };
            }
            if (!known) {
                this.logger.debug(`model switch refused (unknown model): key=${key} → ${route.provider}/${route.model}`);
                return { ...route, reason: 'unknown-model' };
            }
            if (!record) {
                const keepEffort = await this.keepEffortFor(route, this.defaultSelection()?.reasoningEffort);
                try {
                    await this.agentDefaultModel.saveSelection({
                        provider: route.provider,
                        model: route.model,
                        ...(keepEffort !== undefined ? { reasoningEffort: keepEffort } : {}),
                    });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.logger.warn(`default model switch failed: key=${key} err=${message}`);
                    return { ...route, reason: 'failed', message };
                }
                this.logger.info(`default model set: key=${key} → ${route.provider}/${route.model}`);
                return { ...route };
            }
            const keepEffort = await this.keepEffortFor(route, this.hostSelection(record.agent)?.reasoningEffort);
            const selected = {
                provider: route.provider,
                model: route.model,
                ...(keepEffort !== undefined ? { reasoningEffort: keepEffort } : {}),
            };
            try {
                record.agent.model.select(selected);
                this.persistDefaultSelection(selected, key);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn(`model switch failed: key=${key} err=${message}`);
                return { ...route, reason: 'failed', message };
            }
            this.logger.info(`model switched: key=${key} → ${route.provider}/${route.model}`);
            return { ...route };
        });
    }
    /**
     * 换模型时把当前的思考强度一起带过去（Web 端也传整份选择）。
     *
     * 目标模型不支持的档位丢弃，交给它的默认值；直接不传 effort 会被宿主当成
     * 「模型默认」，等于把用户选的档位清掉。
     */
    async keepEffortFor(route, effort) {
        if (effort === undefined)
            return undefined;
        const reasoning = await this.modelResolver.reasoningInfo(route);
        return reasoning?.efforts.some((option) => option.id === effort) ? effort : undefined;
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
     * 写进当前会话的 `model/selection`（`agent.model.select`）：下一轮生效，
     * `effort` 为 undefined 表示恢复模型默认值。没有活跃会话时写部署默认值。
     * 与 `/model` 共用 `serializeSelection`，同一会话的选择写入不交错。
     */
    async selectEffort(scope, peerId, effort) {
        const key = this.sessionKey();
        const record = this.getSessionRecord(scope, peerId);
        return this.serializeSelection(record?.sessionId ?? DEFAULT_SELECTION_KEY, async () => {
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
            // 未显式选择时「选中模型默认档位」不产生变化，不写会话
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
        });
    }
    /**
     * 把思考强度选择写进会话或部署默认值。
     *
     * 有会话时 `agent.model.select`：选择记进当前会话，同时按核心行为写成新的
     * 部署默认值（新会话沿用）。没有会话时直接写 `agentDefaultModel.saveSelection`。
     */
    async applySelection(route, effort, record) {
        const selected = {
            provider: route.provider,
            model: route.model,
            ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        };
        if (!record) {
            try {
                await this.agentDefaultModel.saveSelection(selected);
                return { ok: true, ...(effort !== undefined ? { effort } : {}) };
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn(`default reasoning effort switch failed: ${message}`);
                return { ok: false, reason: 'failed', message };
            }
        }
        try {
            record.agent.model.select(selected);
            this.persistDefaultSelection(selected, this.sessionKey());
            return { ok: true, ...(effort !== undefined ? { effort } : {}) };
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
        // 部署里没有注册表（base / headless / 自组 profile）：没有可切换的 preset
        const presets = this.getPresetsService();
        if (!presets)
            return { ok: false, reason: 'unavailable' };
        // 1. 校验 preset 存在 + 可加载（broken 拒绝）
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
    /**
     * 可切换的权限预设。
     *
     * 有会话时是宿主的 names（配置表 + 在线的 auto，只作用于这个会话）；没有会话时
     * 只列能当部署默认的配置预设（宿主 catalog 的 defaultOptions）——auto 写不进
     * 部署默认，列出来也切不了。
     */
    listPermissionPresets() {
        const presets = this.getPermissionPresetsService();
        try {
            const names = this.currentRecord() ? this.permissionNames(presets) : this.deploymentDefaultNames(presets);
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
    /** 宿主的全量预设名（配置表顺序 + 在线的 auto） */
    permissionNames(presets) {
        return Array.isArray(presets.names) ? presets.names : [];
    }
    /** 能当部署默认的预设名：宿主 defaultOptions；投影缺失时退回配置键（去掉会话级的 auto） */
    deploymentDefaultNames(presets) {
        try {
            const options = presets.catalog?.().defaultOptions;
            if (options)
                return options.map((option) => option.value);
        }
        catch (err) {
            this.logger.debug(`permission catalog unavailable: ${errorText(err)}`);
        }
        return this.permissionNames(presets).filter((name) => name !== 'auto' && name !== 'custom');
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
            const preset = presets.defaultPreset;
            this.lastKnownDefaultPermission = preset;
            return preset;
        }
        catch (err) {
            // 部署默认被写成了 auto 这类不能当默认的预设时，宿主 defaultSettings 抛错，
            // 不但这一行读不出来，之后新建会话也会失败。回正到最近一次读到的有效值。
            const fallback = this.lastKnownDefaultPermission ?? this.deploymentDefaultNames(presets)[0];
            if (!fallback)
                return undefined;
            this.logger.warn(`default permission preset unreadable, restoring ${fallback}: ${errorText(err)}`);
            this.restoreDefaultPermission(fallback);
            return fallback;
        }
    }
    /** 这个预设能不能当部署默认（会话级 auto 与派生的 custom 不行） */
    isDeploymentDefault(presets, preset) {
        return this.deploymentDefaultNames(presets).includes(preset);
    }
    /** 写回部署默认预设（自愈，失败只记日志，不影响展示） */
    restoreDefaultPermission(preset) {
        try {
            void this.getSettingsService()
                .update(PERMISSION_SETTINGS_NS, { defaultPreset: preset })
                .catch((err) => {
                this.logger.warn(`default permission restore failed: preset=${preset} ${errorText(err)}`);
            });
        }
        catch (err) {
            this.logger.warn(`default permission restore failed: preset=${preset} ${errorText(err)}`);
        }
    }
    /**
     * 切换权限预设（沙箱模式 + 审批策略立即生效）。
     *
     * 有会话时只动这一次会话，`/new` 之后的新会话回到 profile 默认预设。没有活跃
     * 会话时改写部署默认预设（`settings.update('permission', { defaultPreset })`，
     * 与设置页同一个入口），之后新建的会话用它；不为「切换」拉起一个空会话。
     */
    async setPermissionPreset(scope, peerId, preset) {
        const key = this.sessionKey();
        const presets = this.getPermissionPresetsService();
        if (!presets.names.includes(preset))
            return { ok: false, reason: 'unknown-preset' };
        const record = this.currentRecord(key);
        // 可重入：目标就是当前生效的预设（有会话看会话，没有会话看部署默认）时直接返回
        if (this.getPermissionPreset(scope, peerId) === preset) {
            this.logger.debug(`permission switch skipped (already current): key=${key} preset=${preset}`);
            return { ok: true, preset, unchanged: true };
        }
        if (!record) {
            // 没有会话时只能选能当部署默认的预设：auto 是会话级选项，写成部署默认会让
            // 宿主 defaultSettings 抛 `unknown default preset`，读默认值与新建会话都会失败
            if (!this.isDeploymentDefault(presets, preset))
                return { ok: false, reason: 'unknown-preset' };
            try {
                await this.getSettingsService().update(PERMISSION_SETTINGS_NS, { defaultPreset: preset });
            }
            catch (err) {
                const message = errorText(err);
                this.logger.warn(`default permission switch failed: key=${key} preset=${preset} err=${message}`);
                return { ok: false, reason: 'failed', message };
            }
            this.logger.info(`default permission preset set: key=${key} preset=${preset}`);
            return { ok: true, preset };
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
            const usage = event.data?.usage;
            if (!usage)
                continue;
            stats.input += usage.inputTokens ?? 0;
            stats.output += usage.outputTokens ?? 0;
            stats.cacheRead += usage.cacheReadTokens ?? 0;
            stats.cacheWrite += usage.cacheWriteTokens ?? 0;
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
    /**
     * 生成中的现场：本轮耗时、当前步骤、正在执行的动作与重试退避。
     *
     * 只读事件流，不持有状态、不挂监听：/status 每次现算，不为进度增加生命周期。
     * 找不到未结束的 turn 时返回 undefined（刚结束，或日志被压缩过）。
     */
    getTurnProgress(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        if (!record)
            return undefined;
        const events = this.host.sessionEvents(record.agent.session);
        if (!events || events.length === 0)
            return undefined;
        // 末尾往回找本轮起点；先遇到 turn/end 说明本轮已结束
        let startIndex = -1;
        for (let i = events.length - 1; i >= 0; i--) {
            const type = events[i]?.type;
            if (type === 'turn/end')
                return undefined;
            if (type === 'turn/start') {
                startIndex = i;
                break;
            }
        }
        if (startIndex === -1)
            return undefined;
        const startedAt = events[startIndex]?.time;
        if (typeof startedAt !== 'number')
            return undefined;
        let step;
        let waitingSince = startedAt;
        let retry;
        // callId → 工具名与开始时间；并行调用时展示最早未完成的那个
        const pending = new Map();
        for (let i = startIndex + 1; i < events.length; i++) {
            const event = events[i];
            if (!event)
                continue;
            const data = event.data;
            const time = typeof event.time === 'number' ? event.time : waitingSince;
            switch (event.type) {
                case 'step/start': {
                    const value = data?.step;
                    if (typeof value === 'number')
                        step = value;
                    waitingSince = time;
                    break;
                }
                case 'tool/call': {
                    const callId = data?.callId;
                    const name = data?.name;
                    if (typeof callId === 'string' && typeof name === 'string') {
                        pending.set(callId, { name, since: time });
                    }
                    waitingSince = time;
                    retry = undefined;
                    break;
                }
                case 'tool/result': {
                    const message = data?.message;
                    const callId = typeof message?.callId === 'string' ? message.callId : undefined;
                    if (callId !== undefined) {
                        pending.delete(callId);
                    }
                    else {
                        // 没有 callId 的旧日志按先进先出配对
                        const oldest = pending.keys().next();
                        if (!oldest.done)
                            pending.delete(oldest.value);
                    }
                    waitingSince = time;
                    break;
                }
                case 'assistant/message': {
                    waitingSince = time;
                    retry = undefined;
                    break;
                }
                case 'llm/retry': {
                    const attempt = data?.retry;
                    const delayMs = data?.delayMs;
                    if (typeof attempt === 'number' && typeof delayMs === 'number') {
                        retry = { attempt, delayMs, since: time };
                    }
                    break;
                }
                case 'llm/retry-started': {
                    retry = undefined;
                    waitingSince = time;
                    break;
                }
            }
        }
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        if (pending.size > 0) {
            let oldest;
            for (const item of pending.values()) {
                if (!oldest || item.since < oldest.since)
                    oldest = item;
            }
            return {
                elapsedMs,
                step,
                waiting: 'tool',
                waitingSince: oldest?.since ?? waitingSince,
                toolName: oldest?.name,
                retry,
            };
        }
        return { elapsedMs, step, waiting: 'model', waitingSince, retry };
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
    /**
     * 同一个会话的选择写入串行化。
     *
     * `/model` 与 `/reasoning` 都是「读当前选择 → 拼新选择 → 写回」，并发进入会
     * 用旧值覆盖对方（例如 /reasoning 读到 A 模型后 /model 换成 B，再把 A 写回）。
     * 没有活跃会话时用 DEFAULT_SELECTION_KEY 串部署默认值。只保护 QQ 渠道自己的
     * 写入：Web 端同时改同一个会话时不在这条链上（两边都只是 append 一条选择事件）。
     */
    serializeSelection(sessionId, operation) {
        const previous = this.selectionChains.get(sessionId) ?? Promise.resolve();
        const result = previous.then(operation);
        this.selectionChains.set(sessionId, result.then(() => undefined, () => undefined));
        return result;
    }
    /**
     * 会话内改完选择后把部署默认一起写掉（宿主 controller 也是这么做的：新会话
     * 沿用最近一次选择）。失败只记 warn，不影响本次切换。
     */
    persistDefaultSelection(selection, key) {
        void this.agentDefaultModel.saveSelection(selection).catch((err) => {
            this.logger.warn(`session model selection saved but default not: key=${key} err=${errorText(err)}`);
        });
    }
    /** 宿主命令登记簿（inject 保证存在） */
    get commands() {
        return this.ctx.commands;
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
        let directory = this.chatDirectory();
        // 已经获取过这个会话（`/to` 先拿到、或 `/sessions resume` 接上）：直接复用记录
        const known = this.records.get(sessionId);
        if (known) {
            this.touch(known, scope, peerId, senderId, replyTarget);
            this.setCurrent(key, sessionId);
            this.setChatDir(this.host.sessionDirectory(known.agent.session) ?? directory);
            return known;
        }
        let agent;
        let handle;
        let agentPreset;
        let worktree;
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
                try {
                    directory = await this.restoreWorktree(agent, directory);
                }
                catch (err) {
                    // 目录回不来就别把这个 agent 留在宿主里跑：先还句柄再上抛
                    await handle.dispose().catch(() => { });
                    throw err;
                }
                const resumedRoute = this.hostSelection(agent) ?? this.modelResolver.resolveDefault();
                this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumedRoute.provider}/${resumedRoute.model}`);
            }
            catch (err) {
                // 目录重建失败不是「会话不存在」：换个会话也不能把树找回来，直接上抛
                if (err instanceof WorktreeError)
                    throw err;
                if (!(await this.mayCreateAfterResumeFailure(key, sessionId, err)))
                    throw err;
                mkdirSync(directory, { recursive: true });
                const created = await this.spawnSession(key, sessionId, directory, agentPreset, composed.setup);
                agent = created.agent;
                handle = created.handle;
                directory = created.directory;
                worktree = created.worktree;
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
        if (worktree !== undefined)
            record.worktreeNotice = worktreeNotice(worktree);
        this.records.set(sessionId, record);
        this.setCurrent(key, sessionId);
        // 工作区跟着会话走：这个聊天当前目录以会话为准
        if (directory)
            this.setChatDir(directory);
        // 挂载到对应工作区（侧边栏可见性）；fail-soft、异步执行，不阻塞消息处理。
        // 宿主只在客户端 session.create RPC 时挂载会话，插件会话不走那条路径，
        // 所以这里补挂一次（幂等，升级后老会话也会补上）。
        // 必须传 header.cwd（建会话时的目录）：attachSession 校验它等于工作区路径，
        // 传工作树路径会凭空长出一个以树名命名的工作区。
        const attachCwd = this.headerCwd(agent) ?? directory;
        if (attachCwd)
            void this.host.attachSessionToWorkspace(sessionId, attachCwd);
        return record;
    }
    /**
     * 新会话要不要开在工作树里：要就返回建树的基点（主仓库根）。
     *
     * 四处不建：部署没有 worktrees 服务、用户用 /worktree off 关掉了、当前目录不是
     * 主仓库、默认策略只读——宿主每条 git 命令都按会话策略包，只读下建目录、写
     * .git/worktrees 必然被拒。
     */
    worktreeBase(directory) {
        if (this.host.worktrees() === undefined)
            return undefined;
        if (!this.worktreeEnabled())
            return undefined;
        if (this.host.sandboxMode() === 'read-only')
            return undefined;
        return mainRepositoryRoot(directory);
    }
    /**
     * 新建会话：能开工作树就开在树里，否则就地。
     *
     * 宿主不回滚建树的半成品（分支与检出可能留下），这里只关掉刚创建的 agent：
     * 指针与已获取集都不动，用户重发一次就会重新尝试。
     */
    async spawnSession(key, sessionId, directory, agentPreset, setup) {
        const base = this.worktreeBase(directory);
        const created = await this.agents.create({
            sessionId,
            // 树的池与 .git/worktrees 登记都落在基点下，所以 header.cwd 必须是基点
            meta: {
                cwd: base ?? directory,
                ...(agentPreset ? { agentPreset } : {}),
            },
            agentOptions: this.agentOptionsFor(),
            ...(setup ? { setup } : {}),
        });
        const worktrees = this.host.worktrees();
        if (base === undefined || worktrees === undefined) {
            return { agent: created.agent, handle: created, directory };
        }
        try {
            const tree = await worktrees.create(created.agent, {}, AbortSignal.timeout(WORKTREE_TIMEOUT_MS));
            this.logger.info(`created worktree: key=${key} branch=${tree.branch} path=${tree.path}`);
            return { agent: created.agent, handle: created, directory: tree.path, worktree: tree };
        }
        catch (err) {
            this.logger.warn(`worktree creation failed: key=${key} ${err instanceof Error ? err.message : String(err)}`);
            created.agent.cancel({ kind: 'user' });
            await created.dispose().catch(() => { });
            throw new WorktreeError('create', worktreeFailureText(err), err);
        }
    }
    /**
     * 恢复会话的工作目录：树被归档清理删掉时就地重建。
     *
     * 宿主 restore 只重建检出、不切调用方目录，所以成功后才轮到插件把目录改回树
     * 路径。目录还在、会话不在树里（非仓库 / headless）时原样返回。
     */
    async restoreWorktree(agent, directory) {
        const worktrees = this.host.worktrees();
        if (worktrees === undefined)
            return directory;
        const creation = this.worktreeCreations(agent).find((entry) => entry.owned)?.worktree;
        if (creation === undefined || existsSync(creation.path))
            return directory;
        if (!samePath(directory, creation.path))
            return directory;
        try {
            const restored = await worktrees.restore(agent, creation, AbortSignal.timeout(WORKTREE_TIMEOUT_MS));
            this.logger.info(`restored worktree: path=${restored.path} branchRecreated=${restored.branchRecreated}`);
            return restored.path;
        }
        catch (err) {
            this.logger.warn(`worktree restore failed: ${err instanceof Error ? err.message : String(err)}`);
            throw new WorktreeError('restore', worktreeFailureText(err), err);
        }
    }
    /**
     * 会话创建时的目录（= header.cwd），工作区挂载与建树都按它算。
     *
     * 运行期 cd 只改 workingDirectory，不该把工作区挂载点或建树基点带走。
     */
    headerCwd(agent) {
        const header = agent.session?.header;
        return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
    }
    /**
     * 会话日志里的工作树投影（创建顺序）；没有该投影返回空数组。
     *
     * 模型自己调 `create_worktree` 建的树也写同一条记录，所以这里不等于「插件建的」。
     */
    worktreeCreations(agent) {
        try {
            const state = this.sessionProjections.stateOf(agent.session, 'worktree');
            return Array.isArray(state?.created) ? state.created : [];
        }
        catch (err) {
            this.logger.debug(`worktree projection unavailable: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
    /** 当前会话所在的工作树（/status 用）；没有投影返回 undefined */
    worktreeOf(scope, peerId) {
        const record = this.getSessionRecord(scope, peerId);
        if (record === undefined)
            return undefined;
        const creations = this.worktreeCreations(record.agent);
        if (creations.length === 0)
            return undefined;
        const current = this.host.sessionDirectory(record.agent.session);
        const match = current === undefined
            ? undefined
            : creations.find((entry) => samePath(entry.worktree.path, current));
        const picked = (match ?? creations[creations.length - 1])?.worktree;
        return picked === undefined
            ? undefined
            : { branch: picked.branch, baseCommit: picked.baseCommit, path: picked.path };
    }
    /** 已获取会话有没有工作树（归档回执用）；冷会话查不到，按没有处理 */
    hasWorktree(sessionId) {
        const record = this.records.get(sessionId);
        return record !== undefined && this.worktreeCreations(record.agent).length > 0;
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
     * 该聊天当前所在的工作目录（内存态，唯一来源）。
     *
     * 初值在构造时取宿主默认工作区；acquire、切换会话、`/new <工作区>` 与运行期
     * `cd` 会覆盖它。这里不再回退会话 header / 持久化记录 / 默认工作区。
     */
    chatDirectory() {
        return this.chatDir;
    }
    /**
     * 工作区的归属目录：链接工作树里的路径取主仓库根，其它原样返回。
     *
     * 树是会话的运行目录，不是工作区——宿主给工作树会话写的 header.cwd 就是主
     * 仓库根，`/status` 的「工作区」与 `/sessions` 的分组都按它算。建树后宿主
     * 追加的 `working-directory/change` 因此不改工作区。
     */
    workspaceDirOf(directory) {
        return worktreeSourceRoot(directory) ?? directory;
    }
    /**
     * 覆盖聊天工作目录并落盘（启动时优先读回的记忆）。
     *
     * 内存仍是唯一读写来源；磁盘只做镜像，值没变不写。所有入口都在这里归一，
     * 工作树路径不会落成工作区。
     */
    setChatDir(directory) {
        const workspace = this.workspaceDirOf(directory);
        if (this.chatDir === workspace)
            return;
        this.chatDir = workspace;
        this.modelResolver.setDirectory(this.sessionKey(), workspace);
    }
    /**
     * 运行期 `cd`：宿主在会话里追加 `working-directory/change`。
     *
     * 只认当前会话的目录变化；非当前会话的 `cd` 不影响这个聊天的工作区。
     */
    noteWorkingDirectory(session, cwd) {
        if (typeof cwd !== 'string' || cwd === '')
            return;
        const record = this.currentRecord();
        if (record === undefined)
            return;
        // 事件里的 session 可能是宿主的投影包装，先按 id 认，再退回引用相等
        const sessionLike = session;
        const id = sessionLike?.header?.id ?? sessionLike?.id;
        if (id !== record.sessionId && record.agent.session !== session)
            return;
        const workspace = this.workspaceDirOf(cwd);
        if (this.chatDir === workspace)
            return;
        this.setChatDir(workspace);
        this.logger.info(`chat working directory changed: dir=${workspace}`);
    }
    /** 某个 agent 所属会话当前的工作目录（交付物投递、`/get` 相对路径的基准） */
    directoryForAgent(agent) {
        const record = this.findByAgent(agent);
        if (!record)
            return undefined;
        return this.host.sessionDirectory(record.agent.session);
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
        const workspace = this.chatDirectory();
        const currentId = this.currentSessionId(key);
        const archived = this.host.archivedSessionIds();
        const visible = (await this.host.listSessions())
            .filter((session) => session.origin !== 'subagent')
            .filter((session) => session.cwd !== undefined && samePath(session.cwd, workspace))
            .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : 1));
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
                updatedAt: session.updatedAt,
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
        // 子代理会话：宿主只把子会话的 parentSession 指向父会话。运行中的子会话
        // （origin 为 subagent 且 live）挂到父条目下，隔代（子代理再起子代理）也收；
        // 兄弟按活跃时间倒序，保证刚更新过的子会话排在前面。
        const subagentsByParent = new Map();
        for (const info of hostSessions) {
            if (info.origin !== 'subagent' || !info.live)
                continue;
            const parent = info.parentSession;
            if (parent === undefined)
                continue;
            const siblings = subagentsByParent.get(parent);
            if (siblings === undefined)
                subagentsByParent.set(parent, [info]);
            else
                siblings.push(info);
        }
        for (const siblings of subagentsByParent.values()) {
            siblings.sort((left, right) => right.updatedAt - left.updatedAt);
        }
        const descendantsOf = (rootId) => {
            const collected = [];
            const visited = new Set([rootId]);
            const walk = (parentId) => {
                for (const child of subagentsByParent.get(parentId) ?? []) {
                    if (visited.has(child.id))
                        continue;
                    visited.add(child.id);
                    collected.push(child);
                    walk(child.id);
                }
            };
            walk(rootId);
            return collected;
        };
        const childrenById = new Map(ordered.map((record) => [record.sessionId, descendantsOf(record.sessionId)]));
        // 标题读取有上限：先给持有会话，再用剩余名额补子会话
        const titleIds = ordered.slice(0, TITLE_FETCH_LIMIT_HELD).map((record) => record.sessionId);
        for (const record of ordered) {
            for (const child of childrenById.get(record.sessionId) ?? []) {
                if (titleIds.length >= TITLE_FETCH_LIMIT_HELD)
                    break;
                if (!titleIds.includes(child.id))
                    titleIds.push(child.id);
            }
        }
        const titles = await this.host
            .sessionTitles(titleIds)
            .catch(() => new Map());
        const workspaces = this.host.workspaceList();
        return ordered.map((record) => {
            const info = byId.get(record.sessionId);
            const directory = info?.cwd ?? this.host.sessionDirectory(record.agent.session);
            const workspace = directory === undefined
                ? undefined
                : workspaces.find((item) => samePath(item.path, directory));
            const workspacePath = workspace?.path ?? directory;
            // 没有 registry 时只有路径：不拿目录名冒充工作区名，分组标题只显示路径
            const workspaceTitle = workspace?.title
                ?? (this.host.supportsWorkspaceRegistry() && directory !== undefined ? basename(directory) : undefined);
            const children = (childrenById.get(record.sessionId) ?? []).map((child) => ({
                id: child.id,
                ...(titles.has(child.id) ? { title: titles.get(child.id) } : {}),
                createdAt: child.createdAt,
                updatedAt: child.updatedAt,
                current: false,
                live: true,
                held: false,
                running: true,
                isSeeded: child.isSeeded,
                archived: false,
                subagent: true,
            }));
            return {
                id: record.sessionId,
                ...(titles.has(record.sessionId) ? { title: titles.get(record.sessionId) } : {}),
                createdAt: info?.createdAt ?? record.acquiredAt,
                updatedAt: info?.updatedAt ?? info?.createdAt ?? record.acquiredAt,
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
                ...(children.length > 0 ? { children } : {}),
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
        const workspace = this.chatDirectory();
        const info = this.host.workspaceList().find((item) => samePath(item.path, workspace));
        if (info) {
            return { title: info.title, path: info.path, missing: !isDirectory(info.path) };
        }
        // 没有 registry 时只有目录，不拿末段目录名冒充工作区名
        const title = this.host.supportsWorkspaceRegistry() ? basename(workspace) : '';
        return { title, path: workspace, missing: !isDirectory(workspace) };
    }
    /**
     * 部署里是否有 workspaceRegistry（决定工作区名、置顶 / 归档）。
     *
     * 没有这个服务时列表仍按目录路径分组，但组标题只有路径；归档子命令按未知
     * 子命令处理，也不能按名字新建会话。
     */
    workspaceRegistryAvailable() {
        return this.host.supportsWorkspaceRegistry();
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
            // 工作树路径不是工作区：会话总从主仓库开新树，报给用户的也按主仓库算
            path = this.workspaceDirOf(resolve(target));
            const known = this.listWorkspaceInfos().find((item) => samePath(item.path, path));
            title = known?.title ?? basename(path);
            isNew = known === undefined;
        }
        else if (!this.host.supportsWorkspaceRegistry()) {
            // 没有 registry 就没有工作区名可匹配：只认绝对路径
            return { ok: false, reason: 'unavailable', arg: target };
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
     * 只覆盖内存里的工作目录，等下一个会话创建时生效；当前已获取的会话不受影响。
     *
     * @param scope 当前 chat 作用域
     * @param peerId 当前 chat 的 peer id
     * @param arg 工作区标题 / 目录名 / 绝对路径
     */
    async changeChatWorkspace(_scope, _peerId, arg) {
        const resolved = this.resolveWorkspace(arg);
        if (!resolved.ok)
            return resolved;
        this.setChatDir(resolved.path);
        this.logger.info(`chat workspace changed: dir=${resolved.path}`);
        return resolved;
    }
    /**
     * 按宿主的 workspace 分组列出全部会话（`/sessions all`）。
     *
     * 与 Web 侧栏同一口径：分组只认 registry 的 `sessionIds` 记账，记账之外
     * （哪怕 cwd 正好落在某个工作区）一律进「未分组」；可见性只保留 live 或
     * 带 cwd 的 cold 会话，blank 会话只留当前那个。数据字段来自 sessionQuery。
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
            // 与 Web 的列表口径一致：live 会话全部可见，cold 会话只留带 cwd 的
            .filter((session) => session.live || session.cwd !== undefined)
            // Web 侧栏只显示当前打开的那个 blank 会话
            .filter((session) => !session.blank || session.id === currentId)
            .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : 1));
        /** 分组条目：标题由调用方按需补（fillSessionTitles，只读要展示的行） */
        const asEntry = (session, workspace) => {
            const record = this.records.get(session.id);
            return {
                id: session.id,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                current: session.id === currentId,
                live: session.live,
                held: record !== undefined,
                running: record?.agent.status === 'running',
                isSeeded: session.isSeeded,
                archived: archived.has(session.id),
                workspace,
            };
        };
        // 没有 registry 时不按会话记账分组：按会话所在目录聚合，组标题只有路径
        if (!this.host.supportsWorkspaceRegistry()) {
            const groups = [];
            const byPath = new Map();
            for (const session of sessions) {
                const dir = (session.cwd ?? '').trim();
                // Windows 大小写不敏感；其它平台保留原样，避免合并仅大小写不同的目录
                const folded = process.platform === 'win32' ? dir.toLowerCase() : dir;
                const key = dir === '' ? 'ungrouped' : `path:${folded}`;
                let group = byPath.get(key);
                if (group === undefined) {
                    group = dir === ''
                        ? { id: 'ungrouped', title: '未分组', path: '', missing: false, sessions: [] }
                        : { id: key, title: '', path: dir, missing: !isDirectory(dir), sessions: [] };
                    byPath.set(key, group);
                    groups.push(group);
                }
                group.sessions.push(asEntry(session, group.title));
            }
            return groups;
        }
        const byId = new Map(sessions.map((session) => [session.id, session]));
        const pinOrder = [...pinned];
        const orderOf = (id) => {
            const pinnedAt = pinOrder.indexOf(id);
            return pinnedAt === -1 ? Number.MAX_SAFE_INTEGER : pinnedAt;
        };
        const groups = [];
        const consumed = new Set();
        for (const workspace of this.host.workspaceList()) {
            // 与 Web 一致：只认 registry 记账，不再按 cwd 兜底归组
            const merged = workspace.sessionIds
                .filter((id) => !consumed.has(id))
                .map((id) => byId.get(id))
                .filter((session) => session !== undefined);
            for (const session of merged)
                consumed.add(session.id);
            merged.sort((left, right) => {
                const pin = orderOf(left.id) - orderOf(right.id);
                if (pin !== 0)
                    return pin;
                // 与 Web 侧栏默认排序一致：最近人类消息时间倒序，同时间按 id 升序
                const recency = right.updatedAt - left.updatedAt;
                return recency !== 0 ? recency : left.id < right.id ? -1 : 1;
            });
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
        return groups;
    }
    /**
     * 给列表条目补标题（读日志是列表的耗时大头，只补调用方要展示的那几条）。
     *
     * 分组列表分页在命令层，这里不知道哪一页会展示，所以不在 listWorkspaceGroups
     * 里盲读；命令按当前页切片后调这里。读不到就保持 undefined，渲染层回退成
     * 「未命名会话」。已带标题的条目跳过，重复调用不会重复读。
     */
    async fillSessionTitles(entries) {
        const missing = entries.filter((entry) => entry.title === undefined);
        if (missing.length === 0)
            return;
        const titles = await this.host.sessionTitles(missing.map((entry) => entry.id));
        for (const entry of missing) {
            const title = titles.get(entry.id);
            if (title !== undefined)
                entry.title = title;
        }
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
            this.setChatDir(this.host.sessionDirectory(existing.agent.session) ?? this.chatDir);
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
                try {
                    // 树被归档清理删掉时在切换阶段就重建，别把会话接回一个不存在的目录
                    await this.restoreWorktree(agent, this.host.sessionDirectory(agent.session) ?? this.chatDirectory());
                }
                catch (err) {
                    await handle.dispose().catch(() => { });
                    return { ok: false, reason: 'failed', message: errorText(err) };
                }
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
        const directory = this.host.sessionDirectory(agent.session) ?? this.chatDirectory();
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
        if (directory)
            this.setChatDir(directory);
        // 同 openSession：挂工作区用 header.cwd（工作树会话即主仓库根），
        // 传运行期目录（树路径）会凭空长出一个以树名命名的工作区
        const attachCwd = this.headerCwd(agent) ?? directory;
        if (attachCwd)
            void this.host.attachSessionToWorkspace(sessionId, attachCwd);
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
        // 确认卡按聊天只留一张，会话一变就作废，免得点下去停掉别的会话
        this.sessionConfirmChannel?.cancelPending();
    }
    /**
     * 释放会话但保留宿主里的请求：挂起的提问 / 审批交回宿主其它通道。
     *
     * 重发卡片没有宿主等价物，只能清掉定时器；它不阻塞任何东西。
     */
    handoffPendingFor(sessionId) {
        this.questionChannel?.handoffPending(sessionId);
        void this.approvalChannel?.handoffPending(sessionId);
        this.retryChannel?.cancelPending(sessionId);
    }
    /**
     * 渠道不可用（鉴权失效 / 网关永久断开）：释放全部持有的会话。
     *
     * 与 disposeAll 的差别是不 cancel、不 dispose：会话仍在宿主里跑，Web 端照常
     * 可见，只是插件不再持有、不再往 QQ 送（详见 outbound 的 findBySessionId）。
     * 当前会话指针一起清掉——渠道不自动恢复，重新扫码后由用户 `/sessions resume`
     * 接回，免得下次启动又自动接上一条连不上的连接。
     */
    releaseAll(reason) {
        const records = [...this.records.values()];
        this.records.clear();
        const keys = [...this.currentByKey.keys()];
        for (const key of keys)
            this.clearCurrent(key);
        this.sessionConfirmChannel?.cancelPending();
        for (const record of records)
            this.handoffPendingFor(record.sessionId);
        this.logger.warn(`qqterm: channel released (reason=${reason}, sessions=${records.length})`);
    }
    /**
     * 执行宿主斜杠命令。
     *
     * 只做机械部分：查登记簿确认命令可见、参数拼成一行、把 { kind, text } 原样交回。
     * 成败判定、文案主题、要不要先判 idle 都留给宿主与调用方——例如 /compact 的
     * "busy" 由宿主压缩锁自己判，插件不再前置检查 status（既假阳性又 TOCTOU，
     * 还与 Web 端行为不一致）。
     */
    async runHostCommand(agent, name, args = []) {
        const commands = this.commands;
        if (commands.find(agent, name) === undefined)
            return { kind: 'unsupported' };
        const line = args.length === 0 ? `/${name}` : `/${name} ${args.join(' ')}`;
        try {
            const executed = await commands.execute(agent, line, [], new AbortController().signal);
            if (executed === undefined)
                return { kind: 'unsupported' };
            const { kind, text } = executed.result;
            return text === undefined ? { kind } : { kind, text };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`host command failed: name=${name} err=${message}`);
            return { kind: 'threw', message };
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
        this.sessionConfirmChannel?.cancelPending();
        const owned = [];
        for (const record of records) {
            if (record.handle) {
                // 自己创建的会话：卸载即结束，给挂起的提问 / 审批一个确定终态
                this.cancelPendingFor(record.sessionId);
                record.agent.cancel({ kind: 'user' });
                owned.push(record);
            }
            else {
                // 借来的会话：宿主还要继续用，只摘引用，阻塞式请求交回宿主
                this.handoffPendingFor(record.sessionId);
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