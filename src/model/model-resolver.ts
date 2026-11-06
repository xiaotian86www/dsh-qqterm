/**
 * ModelResolver — 统一的模型发现与路由解析
 *
 * 职责：
 *   1. 解析新建会话的默认模型路由（核心默认值）
 *   2. 列出可用 providers 和模型
 *   3. 按 sessionId 保存会话自己的模型 / preset 选择（委托 PrefsStore）
 *
 * 默认值（从高到低）：
 *   settings.yaml 的 agent-default-model（只读）
 *   > 宿主 agentDefaultModel 服务（核心默认）
 *   > deepseek-official/deepseek-v4-flash
 *
 * 会话自己的选择只对它自己的 sessionId 生效，新会话永远走上面的默认链。
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
  private readonly logger?: Logger;

  constructor(
    ctx: Context,
    config: ImQQBotConfig,
    logger?: Logger,
  ) {
    this.ctx = ctx;
    this.logger = logger;
    this.prefs = new PrefsStore(
      config.debug ? (msg) => this.logger?.debug(msg) : undefined,
      { onError: (msg) => this.logger?.warn(`im-qqbot: ${msg}`) },
    );
    this.settings = new SettingsReader();
  }

  /**
   * 会话自己保存的模型路由（`/model` 切换时按 sessionId 写入）
   */
  getSessionModel(sessionId: string): ModelRoute | undefined {
    return this.prefs.getOverride(sessionId);
  }

  /**
   * 设置会话自己的模型路由并持久化（只影响这个会话）
   */
  setSessionModel(sessionId: string, route: ModelRoute): void {
    this.prefs.setOverride(sessionId, route);
  }

  /**
   * 清除会话自己的模型路由
   */
  clearSessionModel(sessionId: string): void {
    this.prefs.clearOverride(sessionId);
  }

  /**
   * 获取 resume 时覆盖 session 的模型路由
   *
   * 优先级：该会话自己的偏好 > 核心默认值。这里不返回 undefined，因为没装
   * installModelSelection 时 system-prompt 的 {{model}} 变量直接读
   * agent.options.model——无值会抛 "prompt variable {{model}} has no value"。
   */
  getResumeRoute(sessionId: string): ModelRoute {
    return this.prefs.getOverride(sessionId) ?? this.resolveDefault();
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
   * 获取指定会话的 preset 覆盖（只在会话还没创建时存在）
   */
  getSessionPreset(sessionId: string): string | undefined {
    return this.prefs.getPreset(sessionId);
  }

  /**
   * 设置指定会话的 preset（新会话创建前）并持久化
   */
  setSessionPreset(sessionId: string, presetId: string): void {
    this.prefs.setPreset(sessionId, presetId);
  }

  /**
   * 清除指定会话的 preset 并持久化
   */
  clearSessionPreset(sessionId: string): boolean {
    return this.prefs.clearPreset(sessionId);
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
   * 解析默认模型路由（新建会话一律用它）
   *
   * 优先级：settings.yaml（只读） > 宿主 agentDefaultModel（核心默认）。
   * 最终兜底 deepseek-official/deepseek-v4-flash，确保 {{model}} 变量始终有值。
   */
  resolveDefault(): ModelRoute {
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
