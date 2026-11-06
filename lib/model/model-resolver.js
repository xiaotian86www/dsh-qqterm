import { PrefsStore } from "./prefs-store.js";
import { SettingsReader } from "./settings-reader.js";
export class ModelResolver {
    prefs;
    settings;
    ctx;
    logger;
    constructor(ctx, config, logger) {
        this.ctx = ctx;
        this.logger = logger;
        this.prefs = new PrefsStore(config.debug ? (msg) => this.logger?.debug(msg) : undefined, { onError: (msg) => this.logger?.warn(`im-qqbot: ${msg}`) });
        this.settings = new SettingsReader();
    }
    /**
     * 会话自己保存的模型路由（`/model` 切换时按 sessionId 写入）
     */
    getSessionModel(sessionId) {
        return this.prefs.getOverride(sessionId);
    }
    /**
     * 设置会话自己的模型路由并持久化（只影响这个会话）
     */
    setSessionModel(sessionId, route) {
        this.prefs.setOverride(sessionId, route);
    }
    /**
     * 清除会话自己的模型路由
     */
    clearSessionModel(sessionId) {
        this.prefs.clearOverride(sessionId);
    }
    /**
     * 获取 resume 时覆盖 session 的模型路由
     *
     * 优先级：该会话自己的偏好 > 核心默认值。这里不返回 undefined，因为没装
     * installModelSelection 时 system-prompt 的 {{model}} 变量直接读
     * agent.options.model——无值会抛 "prompt variable {{model}} has no value"。
     */
    getResumeRoute(sessionId) {
        return this.prefs.getOverride(sessionId) ?? this.resolveDefault();
    }
    /**
     * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
     */
    getSessionId(sessionKey) {
        return this.prefs.getSessionId(sessionKey);
    }
    /**
     * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
     */
    setSessionId(sessionKey, sessionId) {
        this.prefs.setSessionId(sessionKey, sessionId);
    }
    /**
     * 清除指定 sessionKey 的 sessionId 记录
     */
    clearSessionId(sessionKey) {
        this.prefs.clearSessionId(sessionKey);
    }
    /**
     * 列出所有 sessionKey → sessionId 映射（删除会话后把悬空映射换成新 id）
     */
    listSessionIdEntries() {
        return this.prefs.sessionIdEntries();
    }
    /**
     * 获取指定会话的 preset 覆盖（只在会话还没创建时存在）
     */
    getSessionPreset(sessionId) {
        return this.prefs.getPreset(sessionId);
    }
    /**
     * 设置指定会话的 preset（新会话创建前）并持久化
     */
    setSessionPreset(sessionId, presetId) {
        this.prefs.setPreset(sessionId, presetId);
    }
    /**
     * 清除指定会话的 preset 并持久化
     */
    clearSessionPreset(sessionId) {
        return this.prefs.clearPreset(sessionId);
    }
    /**
     * 获取指定 sessionKey 当前所在的工作目录（工作区跟随会话）
     */
    getDirectory(sessionKey) {
        return this.prefs.getDirectory(sessionKey);
    }
    /**
     * 记录指定 sessionKey 当前所在的工作目录并持久化
     */
    setDirectory(sessionKey, directory) {
        this.prefs.setDirectory(sessionKey, directory);
    }
    /**
     * 清除指定 sessionKey 的工作目录记录
     */
    clearDirectory(sessionKey) {
        return this.prefs.clearDirectory(sessionKey);
    }
    /**
     * 模型支持的思考强度档位
     *
     * 宿主没挂 llm 服务、provider 不提供元数据、或模型本身不支持思考时返回
     * undefined——调用方据此显示「不支持」，而不是猜一组档位。
     */
    async reasoningInfo(route) {
        const llm = this.llm;
        if (!llm.resolveModelInfo)
            return undefined;
        try {
            const info = await llm.resolveModelInfo(route.provider, route.model);
            const raw = info?.reasoning?.efforts;
            const efforts = [];
            if (Array.isArray(raw)) {
                for (const entry of raw) {
                    if (!entry || typeof entry.id !== 'string' || !entry.id)
                        continue;
                    efforts.push({
                        id: entry.id,
                        name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
                        ...(typeof entry.description === 'string' && entry.description
                            ? { description: entry.description }
                            : {}),
                    });
                }
            }
            if (efforts.length === 0)
                return undefined;
            const defaultEffort = info?.reasoning?.defaultEffort;
            return {
                efforts,
                ...(typeof defaultEffort === 'string' && defaultEffort ? { defaultEffort } : {}),
            };
        }
        catch (err) {
            this.logger?.debug(`ModelResolver: ${route.provider}/${route.model} 思考强度元数据获取失败: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    }
    /**
     * 解析默认模型路由（新建会话一律用它）
     *
     * 优先级：settings.yaml（只读） > 宿主 agentDefaultModel（核心默认）。
     * 最终兜底 deepseek-official/deepseek-v4-flash，确保 {{model}} 变量始终有值。
     */
    resolveDefault() {
        const fromSettings = this.settings.readDefaultRoute();
        if (fromSettings)
            return fromSettings;
        const fromHost = this.readFromHost();
        if (fromHost)
            return fromHost;
        return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
    }
    /**
     * 列出所有可用模型
     *
     * 走 ctx.llm 服务动态发现；单个 provider 失败只跳过该 provider。
     */
    async listModels() {
        const llm = this.llm;
        const providers = llm.listProviders();
        const entries = [];
        for (const provider of providers) {
            const providerId = typeof provider === 'string' ? provider : provider.id;
            try {
                const models = await llm.listModels(providerId);
                for (const model of models) {
                    entries.push({ provider: providerId, id: model.id, name: model.name });
                }
            }
            catch (err) {
                // 单个 provider 失败，跳过
                this.logger?.debug(`ModelResolver: provider ${providerId} 模型列表获取失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return entries;
    }
    /**
     * 列出可用 provider 名称
     */
    listProviders() {
        const providers = this.llm.listProviders();
        const first = providers[0];
        if (first === undefined)
            return [];
        if (typeof first === 'string')
            return providers;
        return providers.map((p) => p.id);
    }
    // ── 私有方法 ──
    /** 宿主部署默认选择（inject 保证存在） */
    readFromHost() {
        const selection = this.agentDefaultModel.currentSelection();
        if (selection?.provider && selection?.model) {
            return { provider: selection.provider, model: selection.model };
        }
        return undefined;
    }
    /** ctx.llm 服务（inject 保证存在） */
    get llm() {
        return this.ctx.llm;
    }
    get agentDefaultModel() {
        return this.ctx.agentDefaultModel;
    }
}
//# sourceMappingURL=model-resolver.js.map