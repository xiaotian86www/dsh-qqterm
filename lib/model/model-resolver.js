import { PrefsStore } from "./prefs-store.js";
import { SettingsReader } from "./settings-reader.js";
export class ModelResolver {
    prefs;
    settings;
    ctx;
    config;
    logger;
    constructor(ctx, config, logger) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        this.prefs = new PrefsStore(config.debug ? (msg) => this.logger?.debug(msg) : undefined, { onError: (msg) => this.logger?.warn(`im-qqbot: ${msg}`) });
        this.settings = new SettingsReader();
    }
    /**
     * 获取指定 sessionKey 的有效模型路由（create 用）
     *
     * 优先级：per-peer 偏好 > config 显式指定 > settings.yaml > 宿主服务
     */
    getEffectiveRoute(sessionKey) {
        return this.prefs.getOverride(sessionKey) ?? this.resolveDefault();
    }
    /**
     * 获取 resume 时覆盖 session 的模型路由
     *
     * 优先级：per-peer 偏好 > cordis.yml 显式配置 > 默认链（settings.yaml > host）
     *
     * 这里不返回 undefined，因为未装 installModelSelection，system-prompt 的
     * {{model}} 变量直接读 agent.options.model——若无值会抛
     * "prompt variable {{model}} has no value for this assembly"。
     * 因此兜底到默认链，确保 agent.options.model 始终有值。
     */
    getResumeRoute(sessionKey) {
        const override = this.prefs.getOverride(sessionKey);
        if (override)
            return override;
        if (this.config.provider && this.config.model) {
            return { provider: this.config.provider, model: this.config.model };
        }
        return this.resolveDefault();
    }
    /**
     * 设置 per-peer 模型偏好并持久化到隔离文件
     */
    setOverride(sessionKey, route) {
        this.prefs.setOverride(sessionKey, route);
    }
    /**
     * 清除 per-peer 模型偏好并持久化
     */
    clearOverride(sessionKey) {
        this.prefs.clearOverride(sessionKey);
    }
    /**
     * 是否存在指定 session 的模型偏好
     */
    hasOverride(sessionKey) {
        return this.prefs.hasOverride(sessionKey);
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
     * 获取指定 sessionKey 的 per-peer preset 覆盖
     */
    getPreset(sessionKey) {
        return this.prefs.getPreset(sessionKey);
    }
    /**
     * 设置 per-peer preset 覆盖并持久化
     */
    setPreset(sessionKey, presetId) {
        this.prefs.setPreset(sessionKey, presetId);
    }
    /**
     * 清除 per-peer preset 覆盖并持久化
     */
    clearPreset(sessionKey) {
        return this.prefs.clearPreset(sessionKey);
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
     * 解析默认模型路由（不含 per-peer 偏好）
     *
     * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
     * 最终兜底 deepseek-official/deepseek-v4-flash，确保 {{model}} 变量始终有值。
     */
    resolveDefault() {
        if (this.config.provider && this.config.model) {
            return { provider: this.config.provider, model: this.config.model };
        }
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