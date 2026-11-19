/**
 * ModelResolver — 统一的模型发现与路由解析
 *
 * 职责：
 *   1. 解析新建会话的默认模型路由（核心默认值）
 *   2. 列出可用 providers 和模型
 *   3. 保存「新会话创建前」的 preset（按 sessionId，创建时消费）
 *
 * 默认值（从高到低）：
 *   settings.yaml 的 agent-default-model（只读）
 *   > 宿主 agentDefaultModel 服务（核心默认）
 *   > deepseek-official/deepseek-v4-flash
 *
 * 模型选择本身由宿主记录在会话里（`model/selection`），插件不另存一份，
 * 新会话自然走上面的默认链。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QQTermConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { ModelRoute, ModelEntry, EffortOption, ReasoningInfo } from './types.ts';
import { PrefsStore } from './prefs-store.ts';
import { SettingsReader } from './settings-reader.ts';

/** ctx.llm 服务的最小接口（listProviders 同步，listModels / resolveModelInfo 异步） */
interface LlmServiceLike {
  listProviders(): readonly { id: string; name: string }[];
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
    config: QQTermConfig,
    logger?: Logger,
  ) {
    this.ctx = ctx;
    this.logger = logger;
    this.prefs = new PrefsStore(
      config.debug ? (msg) => this.logger?.debug(msg) : undefined,
      { onError: (msg) => this.logger?.warn(`qqterm: ${msg}`) },
    );
    this.settings = new SettingsReader();
  }

  /**
   * 获取指定 sessionKey 的最新 sessionId（重启恢复用）
   */
  getSessionId(sessionKey: string): string | undefined {
    return this.prefs.getSessionId(sessionKey);
  }

  /**
   * 记录指定 sessionKey 的最新 sessionId 并持久化
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
   * 这个聊天获取过的会话 id（最近获取在前）
   *
   * 重启后内存里的已获取集合是空的，`/sessions` 靠这份名册把会话当冷行列出来。
   */
  getHeldSessionIds(sessionKey: string): string[] {
    return this.prefs.getHeld(sessionKey);
  }

  /** 记下一次获取（挪到名册最前） */
  rememberHeldSession(sessionKey: string, sessionId: string): void {
    this.prefs.rememberHeld(sessionKey, sessionId);
  }

  /** 从名册里摘掉一个会话 */
  forgetHeldSession(sessionKey: string, sessionId: string): void {
    this.prefs.forgetHeld(sessionKey, sessionId);
  }

  /** 整体覆盖名册（剔除失效会话后写回） */
  setHeldSessionIds(sessionKey: string, sessionIds: readonly string[]): void {
    this.prefs.setHeld(sessionKey, sessionIds);
  }

  /**
   * 上次和这个聊天交互的 QQ 用户（启动恢复时的回复目标）
   */
  getTarget(sessionKey: string): string | undefined {
    return this.prefs.getTarget(sessionKey);
  }

  /**
   * 上次记下的聊天工作目录（启动时优先用它当初值）
   */
  getDirectory(sessionKey: string): string | undefined {
    return this.prefs.getDirectory(sessionKey);
  }

  /**
   * 记下这个聊天当前的工作目录（值不变时不写盘）
   */
  setDirectory(sessionKey: string, directory: string): void {
    this.prefs.setDirectory(sessionKey, directory);
  }

  /**
   * 记下这个聊天的最后交互用户（值不变时不写盘）
   */
  setTarget(sessionKey: string, targetId: string): void {
    this.prefs.setTarget(sessionKey, targetId);
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
      const providerId = provider.id;
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
   * 目标模型是否在宿主的模型目录里
   *
   * 与宿主切换模型前的校验同源（先看 provider 是否注册，再在它的 listModels
   * 里找 model）。有会话和没会话都先过这一关，避免把拼错的模型写进会话或部署
   * 默认值。目录读不出来时抛错，由调用方报「切换失败」。
   */
  async hasModel(provider: string, model: string): Promise<boolean> {
    const llm = this.llm;
    const providers = llm.listProviders();
    const known = providers.some((entry) => entry.id === provider);
    if (!known) return false;
    const models = await llm.listModels(provider);
    return models.some((entry) => entry.id === model);
  }

  /**
   * 列出可用 provider 名称
   */
  listProviders(): string[] {
    return this.llm.listProviders().map((provider) => provider.id);
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
