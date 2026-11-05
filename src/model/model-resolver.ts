/**
 * ModelResolver — 统一的模型发现与路由解析
 *
 * 职责：
 *   1. 解析当前生效的默认模型路由
 *   2. 列出可用 providers 和模型
 *   3. 管理 per-peer 的模型偏好（委托 PrefsStore）
 *
 * 优先级（从高到低）：
 *   per-peer 偏好（~/.dsh-qqbot/model-prefs.json）
 *   > config 显式指定（cordis.yml 的 provider/model）
 *   > settings.yaml 的 agent-default-model（只读，作为默认兜底）
 *   > 宿主 agentDefaultModel 服务
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { ModelRoute, ModelEntry, EffortOption, ReasoningInfo } from './types.ts';
import { PrefsStore } from './prefs-store.ts';
import { SettingsReader } from './settings-reader.ts';

/** ctx.llm 服务的最小接口（listProviders 同步，listModels / resolveModelInfo 异步） */
interface LlmServiceLike {
  listProviders(): Array<{ id: string; name: string }> | string[];
  listModels(providerId: string): Promise<readonly { id: string; name?: string }[]>;
  /**
   * 精确模型元数据（catalog 只是 advisory）。
   *
   * 思考强度只在 `reasoning` 段里，`listModels` 拿不到；宿主没挂 llm 服务或
   * 该 provider 不提供元数据时为 undefined——此时按「不支持思考强度」处理。
   */
  resolveModelInfo?(providerId: string, model: string, signal?: AbortSignal): Promise<{
    reasoning?: { efforts?: readonly EffortOption[]; defaultEffort?: string };
  }>;
}

/** ctx.agentDefaultModel 的最小接口 */
interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string };
}

export class ModelResolver {
  private readonly prefs: PrefsStore;
  private readonly settings: SettingsReader;
  private readonly ctx: Context;
  private readonly config: ImQQBotConfig;
  private readonly logger?: Logger;

  constructor(
    ctx: Context,
    config: ImQQBotConfig,
    logger?: Logger,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    this.prefs = new PrefsStore(
      config.debug ? (msg) => this.logger?.debug(msg) : undefined,
      { onError: (msg) => this.logger?.warn(`im-qqbot: ${msg}`) },
    );
    this.settings = new SettingsReader();
  }

  /**
   * 获取指定 sessionKey 的有效模型路由（create 用）
   *
   * 优先级：per-peer 偏好 > config 显式指定 > settings.yaml > 宿主服务
   */
  getEffectiveRoute(sessionKey: string): ModelRoute | undefined {
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
  getResumeRoute(sessionKey: string): ModelRoute | undefined {
    const override = this.prefs.getOverride(sessionKey);
    if (override) return override;

    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    return this.resolveDefault();
  }

  /**
   * 设置 per-peer 模型偏好并持久化到隔离文件
   */
  setOverride(sessionKey: string, route: ModelRoute): void {
    this.prefs.setOverride(sessionKey, route);
  }

  /**
   * 清除 per-peer 模型偏好并持久化
   */
  clearOverride(sessionKey: string): void {
    this.prefs.clearOverride(sessionKey);
  }

  /**
   * 是否存在指定 session 的模型偏好
   */
  hasOverride(sessionKey: string): boolean {
    return this.prefs.hasOverride(sessionKey);
  }

  /**
   * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
   */
  getSessionId(sessionKey: string): string | undefined {
    return this.prefs.getSessionId(sessionKey);
  }

  /**
   * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
   */
  setSessionId(sessionKey: string, sessionId: string): void {
    this.prefs.setSessionId(sessionKey, sessionId);
  }

  /**
   * 清除指定 sessionKey 的 sessionId 记录
   */
  clearSessionId(sessionKey: string): void {
    this.prefs.clearSessionId(sessionKey);
  }

  /**
   * 列出所有 sessionKey → sessionId 映射（删除会话后把悬空映射换成新 id）
   */
  listSessionIdEntries(): Array<[string, string]> {
    return this.prefs.sessionIdEntries();
  }

  /**
   * 获取指定 sessionKey 的 per-peer preset 覆盖
   */
  getPreset(sessionKey: string): string | undefined {
    return this.prefs.getPreset(sessionKey);
  }

  /**
   * 设置 per-peer preset 覆盖并持久化
   */
  setPreset(sessionKey: string, presetId: string): void {
    this.prefs.setPreset(sessionKey, presetId);
  }

  /**
   * 清除 per-peer preset 覆盖并持久化
   */
  clearPreset(sessionKey: string): boolean {
    return this.prefs.clearPreset(sessionKey);
  }

  /**
   * 获取指定 sessionKey 当前所在的工作目录（工作区跟随会话）
   */
  getDirectory(sessionKey: string): string | undefined {
    return this.prefs.getDirectory(sessionKey);
  }

  /**
   * 记录指定 sessionKey 当前所在的工作目录并持久化
   */
  setDirectory(sessionKey: string, directory: string): void {
    this.prefs.setDirectory(sessionKey, directory);
  }

  /**
   * 清除指定 sessionKey 的工作目录记录
   */
  clearDirectory(sessionKey: string): boolean {
    return this.prefs.clearDirectory(sessionKey);
  }

  /**
   * 模型支持的思考强度档位
   *
   * 宿主没挂 llm 服务、provider 不提供元数据、或模型本身不支持思考时返回
   * undefined——调用方据此显示「不支持」，而不是猜一组档位。
   */
  async reasoningInfo(route: ModelRoute): Promise<ReasoningInfo | undefined> {
    const llm = this.llm;
    if (!llm.resolveModelInfo) return undefined;

    try {
      const info = await llm.resolveModelInfo(route.provider, route.model);
      const raw = info?.reasoning?.efforts;
      const efforts: EffortOption[] = [];
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
          efforts.push({
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
            ...(typeof entry.description === 'string' && entry.description
              ? { description: entry.description }
              : {}),
          });
        }
      }
      if (efforts.length === 0) return undefined;

      const defaultEffort = info?.reasoning?.defaultEffort;
      return {
        efforts,
        ...(typeof defaultEffort === 'string' && defaultEffort ? { defaultEffort } : {}),
      };
    } catch (err) {
      this.logger?.debug(
        `ModelResolver: ${route.provider}/${route.model} 思考强度元数据获取失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * 解析默认模型路由（不含 per-peer 偏好）
   *
   * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
   * 最终兜底 deepseek-official/deepseek-v4-flash，确保 {{model}} 变量始终有值。
   */
  resolveDefault(): ModelRoute {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    const fromSettings = this.settings.readDefaultRoute();
    if (fromSettings) return fromSettings;

    const fromHost = this.readFromHost();
    if (fromHost) return fromHost;

    return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  }

  /**
   * 列出所有可用模型
   *
   * 走 ctx.llm 服务动态发现；单个 provider 失败只跳过该 provider。
   */
  async listModels(): Promise<ModelEntry[]> {
    const llm = this.llm;
    const providers = llm.listProviders();
    const entries: ModelEntry[] = [];
    for (const provider of providers) {
      const providerId = typeof provider === 'string' ? provider : provider.id;
      try {
        const models = await llm.listModels(providerId);
        for (const model of models) {
          entries.push({ provider: providerId, id: model.id, name: model.name });
        }
      } catch (err) {
        // 单个 provider 失败，跳过
        this.logger?.debug(
          `ModelResolver: provider ${providerId} 模型列表获取失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return entries;
  }

  /**
   * 列出可用 provider 名称
   */
  listProviders(): string[] {
    const providers = this.llm.listProviders();
    const first = providers[0];
    if (first === undefined) return [];
    if (typeof first === 'string') return providers as string[];
    return (providers as Array<{ id: string; name: string }>).map((p) => p.id);
  }

  // ── 私有方法 ──

  /** 宿主部署默认选择（inject 保证存在） */
  private readFromHost(): ModelRoute | undefined {
    const selection = this.agentDefaultModel.currentSelection();
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model };
    }
    return undefined;
  }

  /** ctx.llm 服务（inject 保证存在） */
  private get llm(): LlmServiceLike {
    return (this.ctx as unknown as { llm: LlmServiceLike }).llm;
  }

  private get agentDefaultModel(): AgentDefaultModelLike {
    return (this.ctx as unknown as { agentDefaultModel: AgentDefaultModelLike }).agentDefaultModel;
  }
}
