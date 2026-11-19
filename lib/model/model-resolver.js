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
        this.prefs = new PrefsStore(config.debug ? (msg) => this.logger?.debug(msg) : undefined, { onError: (msg) => this.logger?.warn(`qqterm: ${msg}`) });
        this.settings = new SettingsReader();
    }
    /**
     * 获取指定 sessionKey 的最新 sessionId（重启恢复用）
     */
    getSessionId(sessionKey) {
        return this.prefs.getSessionId(sessionKey);
    }
    /**
     * 记录指定 sessionKey 的最新 sessionId 并持久化
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
     * 上次和这个聊天交互的 QQ 用户（启动恢复时的回复目标）
     */
    getTarget(sessionKey) {
        return this.prefs.getTarget(sessionKey);
    }
    /**
     * 上次记下的聊天工作目录（启动时优先用它当初值）
     */
    getDirectory(sessionKey) {
        return this.prefs.getDirectory(sessionKey);
    }
    /**
     * 记下这个聊天当前的工作目录（值不变时不写盘）
     */
    setDirectory(sessionKey, directory) {
        this.prefs.setDirectory(sessionKey, directory);
    }
    /**
     * 记下这个聊天的最后交互用户（值不变时不写盘）
     */
    setTarget(sessionKey, targetId) {
        this.prefs.setTarget(sessionKey, targetId);
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
            const providerId = provider.id;
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
     * 目标模型是否在宿主的模型目录里
     *
     * 与宿主切换模型前的校验同源（先看 provider 是否注册，再在它的 listModels
     * 里找 model）。有会话和没会话都先过这一关，避免把拼错的模型写进会话或部署
     * 默认值。目录读不出来时抛错，由调用方报「切换失败」。
     */
    async hasModel(provider, model) {
        const llm = this.llm;
        const providers = llm.listProviders();
        const known = providers.some((entry) => entry.id === provider);
        if (!known)
            return false;
        const models = await llm.listModels(provider);
        return models.some((entry) => entry.id === model);
    }
    /**
     * 列出可用 provider 名称
     */
    listProviders() {
        return this.llm.listProviders().map((provider) => provider.id);
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