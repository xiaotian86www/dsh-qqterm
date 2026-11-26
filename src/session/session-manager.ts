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
 * 已获取集合不落盘，但 prefs 里另存一份会话名册（`held`）：重启后 `/sessions`
 * 把名册里的会话当冷行列出来，current 仍从指针恢复。
 *
 * sessionKey → sessionId 的映射存于 prefs（`model-prefs.json`），新会话 id 由
 * `mintSessionId()` 铸造（`session-` + UUID，与宿主一致）。没有映射即视为全新会话：
 * 不复用旧版按聊天保存的会话与偏好。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { mintSessionId } from './session-id.ts';
import { createQQUserMessage } from './user-message.ts';
import {
  mainRepositoryRoot,
  WORKTREE_TIMEOUT_MS,
  WorktreeError,
  worktreeFailureText,
  worktreeNotice,
  worktreeSkipNotice,
  worktreeSourceRoot,
} from './worktree.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import {
  createHostAdapter,
  type CreatedWorktreeLike,
  type HostAdapter,
  type HostSessionInfo,
} from '../host/adapter.ts';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { resolveAgentCwd } from '../shared/dirs.ts';
import { optionalService } from '../shared/index.ts';
import { sessionTitleOf } from '../transport/session-source.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { QQTermConfig } from '../config.ts';
import { ModelResolver } from '../model/model-resolver.ts';
import type { ModelRoute, ModelEntry, ReasoningInfo, EffortOption } from '../model/types.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import type { RetryChannel } from '../features/retry-channel.ts';
import type { SessionConfirmChannel } from '../features/session-confirm.ts';
import type {
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  PresetEntry,
  PresetSwitchOutcome,
  ModelSwitchOutcome,
  EffortView,
  EffortSwitchOutcome,
  AgentOptionsLike,
  SettingsLike,
  RequestHeaderLike,
  PermissionPresetsLike,
  PermissionPresetEntry,
  PermissionSwitchOutcome,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  SessionContextUsage,
  SessionTurnProgress,
  HostCommandRun,
  WorkspaceSession,
  WorkspaceGroup,
  WorkspaceInfo,
  ChangeWorkspaceOutcome,
  SwitchSessionOutcome,
  RestoreOutcome,
  RenameSessionOutcome,
  ArchiveSessionOutcome,
  SendToOutcome,
  PromptPlacement,
  PromptSubmission,
  SteerQueuedOutcome,
  RetryPromptOutcome,
  WorktreeInfo,
} from './types.ts';
import { errorMessage } from '../shared/utils.ts';

/** 没有活跃会话时，部署默认选择用的串行化键 */
const DEFAULT_SELECTION_KEY = '@default';

/** agent preset 默认值所在的配置条目（与设置页写的是同一个 namespace） */
const PRESET_SETTINGS_NS = 'agent-preset-registry';

/** 权限预设默认值所在的配置条目（与设置页写的是同一个 namespace） */
const PERMISSION_SETTINGS_NS = 'permission';

/** 会话页「生成中发送」设置的命名空间与字段（宿主 ui-conversation） */
const BUSY_ENTER_SETTINGS_NS = 'ui-conversation';
const BUSY_ENTER_FIELD = 'busyEnter';

/** 会话列表最多为多少条会话读取标题（每条都要读一遍日志，是列表的耗时大头） */
const TITLE_FETCH_LIMIT = 10;

/**
 * `/sessions` 持有列表一次最多读多少条标题。
 *
 * 只对会展示的行读：读日志是列表的耗时大头，全部读会让命令卡住。
 */
const TITLE_FETCH_LIMIT_HELD = 40;

/** 复刻宿主 latestCompletedPrefixBoundary：最后一个 turn/end 起到下一 turn 开始前的边界 */
export function latestCompletedPrefixBoundary(events: readonly unknown[]): number | undefined {
  const list = events as Array<{ type?: string; seq?: number; surfaceOp?: string }>;
  let lastTurnEndSeq: number | undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const candidate = list[i];
    if (candidate?.type === 'turn/end') {
      lastTurnEndSeq = candidate.seq;
      break;
    }
  }
  if (lastTurnEndSeq === undefined) return undefined;
  let boundary = lastTurnEndSeq;
  for (const next of list.slice(boundary + 1)) {
    if (next.type === 'turn/start'
      || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break;
    if (next.seq !== undefined) boundary = next.seq;
  }
  return boundary;
}

/** 宿主 modelSelection projection 的状态（键 'modelSelection'） */
/** 本次新建出来的工作树：树本身 + 拉出它的父分支（detached HEAD 时没有） */
interface SpawnedWorktree {
  tree: CreatedWorktreeLike;
  parent?: string;
}

interface SelectionState {
  lastUsed?: HostSelection | null;
  pending?: HostSelection | null;
}

/** 会话创建过的一棵检出（宿主 worktree 投影的一项） */
interface WorktreeCreationLike {
  worktree: CreatedWorktreeLike;
  owned: boolean;
}

/** 宿主 worktree projection 的状态（键 'worktree'） */
interface WorktreeProjectionLike {
  created?: readonly WorktreeCreationLike[];
}

/** 宿主 sessionProjections 最小接口（按 key 读任一投影的状态） */
interface SessionProjectionsLike {
  stateOf(session: unknown, key: string): unknown;
}

/** 宿主命令登记簿最小接口（/compact 的判定与执行都走它） */
interface CommandsRegistryLike {
  find(agent: unknown, name: string): unknown;
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ result: { kind: 'success' | 'error'; text?: string } } | undefined>;
}

/** 宿主 agentDefaultModel 最小接口 */
interface AgentDefaultModelLike {
  currentSelection(): HostSelection;
  /** 写部署默认选择（没有活跃会话时 /model、/reasoning 用它） */
  saveSelection(selection: HostSelection): Promise<void>;
}

/** 会话在一次请求/选择里用的模型与思考强度 */
interface HostSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** projection / 请求头产物统一成 HostSelection */
function toHostSelection(input: {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}): HostSelection | undefined {
  if (!input.provider || !input.model) return undefined;
  return {
    provider: input.provider,
    model: input.model,
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: String(input.reasoningEffort) } : {}),
  };
}

export class SessionManager {
  /** 已获取集合：sessionId → 记录（普通消息 / resume / /to 实际拿到 agent 的） */
  private readonly records = new Map<string, SessionRecord>();
  /** 每个聊天当前接的会话：chatKey → sessionId；无会话就是没有这一项 */
  private readonly currentByKey = new Map<string, string>();
  /**
   * 同 key 正在进行的 getOrCreate（singleflight）。
   *
   * 斜杠命令与待答问题截获位于 concurrencyGuard 之前（见 gateway/middleware-setup），
   * 与普通消息不串行：同 key 并发进入会各自 resume/create，产出两个 agent，
   * 后写入 records 的覆盖前者且前者无人 dispose（泄漏）。
   */
  private inflight = new Map<string, Promise<SessionRecord>>();
  /**
   * 选择写入的串行化链：sessionId（或部署默认值键）→ 上一次写入的完成信号。
   *
   * `/model` 与 `/reasoning` 都是「读当前选择 → 拼新选择 → 写回」，并发进入会
   * 用旧值覆盖对方。只串 QQ 渠道自己的写入；Web 端并发改同一个会话不在链上。
   */
  private readonly selectionChains = new Map<string, Promise<void>>();
  /**
   * 当前这个聊天的工作目录（内存态，唯一读写来源）。
   *
   * 只记下一会话的落点（工作区目录）：建会话、切换会话、`/new --dir <工作区>` 写它；
   * 运行期 `cd` 不写（那是会话的运行目录，宿主记在会话里、重启回放恢复）。
   * 构造时优先读回上次记下的目录，没有或已不存在才取宿主默认工作区；读取不回退。
   */
  private chatDir: string;
  /**
   * `/new --worktree` 的意图：下一个新建会话开工作树。
   *
   * 只记「要不要」，基线到创建那一刻才读（chatDir 的 HEAD），所以 `/new` 与第一条
   * 消息之间切目录、切分支都按最终目录算。内存态，重启即丢；切走、恢复、删除都清。
   */
  private pendingWorktree = false;
  private readonly modelResolver: ModelResolver;
  private readonly ctx: Context;
  private readonly host: HostAdapter;
  private readonly agents: DshAgentRegistry;
  private readonly config: QQTermConfig;
  private readonly logger: Logger;
  /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话释放时清理其待答问题 */
  public questionChannel?: QuestionChannel;
  /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话释放时清理其待批审批 */
  public approvalChannel?: ApprovalChannel;
  /** 由 bootstrap 注入的重发通道（失败卡片 → 「重发 / 放弃」），会话释放时清理其待确认卡片 */
  public retryChannel?: RetryChannel;
  /** 由 bootstrap 注入的会话确认通道（`/clear`、`/clear all` 的二次确认） */
  public sessionConfirmChannel?: SessionConfirmChannel;
  /** 最近一次读到的有效部署默认权限预设（部署默认被写坏时用它回正） */
  private lastKnownDefaultPermission?: string;

  constructor(
    ctx: Context,
    agents: DshAgentRegistry,
    config: QQTermConfig,
    logger: Logger,
  ) {
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
    if (savedDir !== undefined && isDirectory(savedDir)) {
      this.chatDir = this.workspaceDirOf(savedDir);
      // 旧版本可能把树路径写进 prefs：顺手改掉磁盘镜像，别让它一直留着旧值
      if (this.chatDir !== savedDir) this.modelResolver.setDirectory(this.sessionKey(), this.chatDir);
    }

    this.registerAgentDisposed();
  }

  /**
   * 监听宿主的 `agent/disposed`：agent 被 Web/TUI 或宿主自己关掉时，
   * 把它从已获取集合里摘掉，后续事件不再转发、也不再向死 agent 发 prompt。
   *
   * 事件按 agent 作用域派发，根作用域监听器必须带 `global` 才能收到。
   */
  private registerAgentDisposed(): void {
    (this.ctx as unknown as {
      on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void;
    }).on('agent/disposed', (payload: unknown) => {
      const agent = (payload as { agent?: DshAgent } | null)?.agent;
      if (!agent) return;
      const record = this.records.get(agent.id);
      if (!record || record.agent !== agent) return;
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
  private getPresetsService(): AgentPresetsLike | undefined {
    return optionalService<AgentPresetsLike>(this.ctx, 'agentPresets');
  }

  /**
   * settings 服务（已加入 inject）：写核心默认 preset 的唯一入口
   */
  private getSettingsService(): SettingsLike {
    return (this.ctx as unknown as { settings: SettingsLike }).settings;
  }

  /**
   * 部署默认 preset（新建会话用它）
   *
   * 由核心 agent-preset-registry 的配置持有（`selectedDefault ?? default`），
   * 插件只读不存。
   */
  private defaultPresetId(): string | undefined {
    try {
      return this.getPresetsService()?.defaultId;
    } catch (err) {
      this.logger.debug(`default preset unavailable: ${errorText(err)}`);
      return undefined;
    }
  }

  /**
   * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
   * 读不到（服务缺失 / session 不存在 / 未记录 agentPreset）返回 undefined。
   */
  private async resolvePersistedPreset(sessionId: string): Promise<string | undefined> {
    return (await this.host.sessionHeader(sessionId))?.agentPreset;
  }

  // ── 模型相关（委托给 ModelResolver） ──

  /**
   * 当前会话的生效模型：会话自己记录的选择 → 核心默认值
   *
   * 选择由宿主记录在会话日志的 `model/selection` 事件里（Web 端切模型走同一条），
   * 插件不再另存一份；没有活跃会话时显示核心默认值。
   */
  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute {
    const record = this.getSessionRecord(scope, peerId);
    return record ? this.routeOf(record) : this.modelResolver.resolveDefault();
  }

  /** 某个会话实际生效的路由（宿主选择 → 默认链） */
  private routeOf(record: SessionRecord): ModelRoute {
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
  getEffectivePreset(scope: ChatScope, peerId: string): string | undefined {
    const record = this.getSessionRecord(scope, peerId);
    return record ? record.agentPreset : this.defaultPresetId();
  }

  /**
   * 部署里有没有 agentPresets 服务（/preset 每次现查：没有就按未知指令处理）
   */
  presetsAvailable(): boolean {
    // 与 canSteer 同一来源：每次现查，不在构造期固化缺失。
    try {
      return this.getPresetsService() !== undefined;
    } catch (err) {
      this.logger.debug(`presetsAvailable 探测失败: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * 部署里有没有 worktrees 服务（决定 `/new --worktree` 认不认这个参数：没有就按
   * 未知参数处理，不解释部署差异）
   */
  worktreesAvailable(): boolean {
    return this.host.worktrees() !== undefined;
  }

  /**
   * `/new --worktree`：下一个新建会话开工作树。
   *
   * 只是内存里的意图，基线在创建那一刻才读（chatDir 的 HEAD），所以 `/new` 与
   * 第一条消息之间切目录、切分支都按最终目录算。不落盘，重启即丢。
   */
  armWorktree(): void {
    this.pendingWorktree = true;
  }

  /** 默认策略只读：建不了树，`/new --worktree` 提前拒绝 */
  readOnlySandbox(): boolean {
    return this.host.sandboxMode() === 'read-only';
  }

  /**
   * 列出所有可用 preset（/preset 命令用）
   */
  async listPresets(): Promise<PresetEntry[]> {
    const presets = this.getPresetsService();
    if (!presets) return [];
    try {
      const list = await presets.list();
      const defaultId = this.defaultPresetId();
      return list.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        isDefault: p.isDefault ?? (defaultId !== undefined && p.id === defaultId),
      }));
    } catch (err) {
      this.logger.warn(`list presets failed: ${errorMessage(err)}`);
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
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<ModelSwitchOutcome> {
    const key = this.sessionKey();
    const record = this.getSessionRecord(scope, peerId);

    return this.serializeSelection(record?.sessionId ?? DEFAULT_SELECTION_KEY, async (): Promise<ModelSwitchOutcome> => {
      const current = record ? this.routeOf(record) : this.modelResolver.resolveDefault();
      if (current.provider === route.provider && current.model === route.model) {
        this.logger.debug(`model switch skipped (already current): key=${key} → ${route.provider}/${route.model}`);
        return { ...route, unchanged: true };
      }

      // 拼错的路由一律不落盘：没有会话时不写默认值，有会话时不写进会话日志
      let known: boolean;
      try {
        known = await this.modelResolver.hasModel(route.provider, route.model);
      } catch (err) {
        const message = errorMessage(err);
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
        } catch (err) {
          const message = errorMessage(err);
          this.logger.warn(`default model switch failed: key=${key} err=${message}`);
          return { ...route, reason: 'failed', message };
        }

        this.logger.info(`default model set: key=${key} → ${route.provider}/${route.model}`);
        return { ...route };
      }

      const keepEffort = await this.keepEffortFor(route, this.hostSelection(record.agent)?.reasoningEffort);
      const selected: HostSelection = {
        provider: route.provider,
        model: route.model,
        ...(keepEffort !== undefined ? { reasoningEffort: keepEffort } : {}),
      };
      try {
        record.agent.model.select(selected);
        this.persistDefaultSelection(selected, key);
      } catch (err) {
        const message = errorMessage(err);
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
  private async keepEffortFor(route: ModelRoute, effort: string | undefined): Promise<string | undefined> {
    if (effort === undefined) return undefined;
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
  async getEffortView(scope: ChatScope, peerId: string): Promise<EffortView> {
    const record = this.getSessionRecord(scope, peerId);
    const selection = this.hostSelection(record?.agent);
    const route = this.getEffectiveModel(scope, peerId)
      ?? selection
      ?? this.modelResolver.resolveDefault();
    const reasoning = await this.modelResolver.reasoningInfo(route);
    if (!reasoning || reasoning.efforts.length === 0) return { defaulted: true };

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
  async selectEffort(
    scope: ChatScope,
    peerId: string,
    effort: string | undefined,
  ): Promise<EffortSwitchOutcome> {
    const key = this.sessionKey();
    const record = this.getSessionRecord(scope, peerId);

    return this.serializeSelection(record?.sessionId ?? DEFAULT_SELECTION_KEY, async (): Promise<EffortSwitchOutcome> => {
      const selection = this.hostSelection(record?.agent);
      const route = this.getEffectiveModel(scope, peerId)
        ?? selection
        ?? this.modelResolver.resolveDefault();
      const reasoning = await this.modelResolver.reasoningInfo(route);
      if (!reasoning) return { ok: false, reason: 'unsupported' };

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
      if (!applied.ok) return applied;

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
  private async applySelection(
    route: ModelRoute,
    effort: string | undefined,
    record: SessionRecord | undefined,
  ): Promise<{ ok: true; effort?: string } | EffortSwitchOutcome> {
    const selected: HostSelection = {
      provider: route.provider,
      model: route.model,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    };

    if (!record) {
      try {
        await this.agentDefaultModel.saveSelection(selected);
        return { ok: true, ...(effort !== undefined ? { effort } : {}) };
      } catch (err) {
        const message = errorMessage(err);
        this.logger.warn(`default reasoning effort switch failed: ${message}`);
        return { ok: false, reason: 'failed', message };
      }
    }

    try {
      record.agent.model.select(selected);
      this.persistDefaultSelection(selected, this.sessionKey());
      return { ok: true, ...(effort !== undefined ? { effort } : {}) };
    } catch (err) {
      const message = errorMessage(err);
      this.logger.warn(`reasoning effort switch failed: ${message}`);
      return { ok: false, reason: 'failed', message };
    }
  }

  /**
   * 会话当前选择：projection 待生效的选择 → 最近请求头（排除 adapter 默认）
   * → 部署默认选择。都没有时返回 undefined。
   */
  private hostSelection(agent?: DshAgent): HostSelection | undefined {
    if (agent) {
      const state = this.selectionState(agent);
      if (state?.pending) return toHostSelection(state.pending);

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

      if (state?.lastUsed) return toHostSelection(state.lastUsed);
    }
    return this.defaultSelection();
  }

  /** 宿主的 modelSelection projection（未注册时返回 undefined） */
  private selectionState(agent: DshAgent): SelectionState | undefined {
    try {
      const state = this.sessionProjections.stateOf(agent.session, 'modelSelection') as SelectionState | undefined;
      return state ?? undefined;
    } catch (err) {
      this.logger.debug(
        `modelSelection projection unavailable: ${errorMessage(err)}`,
      );
      return undefined;
    }
  }

  /** 宿主最近一次请求头 */
  private requestHeader(agent: DshAgent): RequestHeaderLike | undefined {
    try {
      return agent.session.requestHeader?.();
    } catch {
      return undefined;
    }
  }

  /** 部署默认选择（agentDefaultModel.currentSelection） */
  private defaultSelection(): HostSelection | undefined {
    const selection = this.agentDefaultModel.currentSelection();
    return selection?.provider && selection.model ? toHostSelection(selection) : undefined;
  }

  /** 宿主选择里的档位，只有选择的就是当前路由时才算数 */
  private selectedEffortOf(selection: HostSelection | undefined, route: ModelRoute): string | undefined {
    if (!selection) return undefined;
    if (selection.provider !== route.provider || selection.model !== route.model) return undefined;
    return selection.reasoningEffort;
  }

  /** 模型默认档位：defaultEffort，没有时用第一项 */
  private modelDefault(reasoning: ReasoningInfo): EffortOption | undefined {
    if (reasoning.defaultEffort !== undefined) {
      const hit = reasoning.efforts.find((option) => option.id === reasoning.defaultEffort);
      if (hit) return hit;
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
  private agentOptionsFor(): AgentOptionsLike {
    const fallback = (): ModelRoute => this.modelResolver.resolveDefault();
    const current = (): HostSelection | undefined => this.defaultSelection();
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
  async setPresetOverride(_scope: ChatScope, _peerId: string, presetId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey();

    // 部署里没有注册表（base / headless / 自组 profile）：没有可切换的 preset
    const presets = this.getPresetsService();
    if (!presets) return { ok: false, reason: 'unavailable' };

    // 1. 校验 preset 存在 + 可加载（broken 拒绝）
    let resolved: { id: string; broken?: string };
    try {
      resolved = await presets.resolve(presetId);
    } catch (err) {
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
    } catch (err) {
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
  private getPermissionPresetsService(): PermissionPresetsLike {
    return (this.ctx as unknown as { permissionPresets: PermissionPresetsLike }).permissionPresets;
  }

  /**
   * 可切换的权限预设。
   *
   * 有会话时是宿主的 names（配置表 + 在线的 auto，只作用于这个会话）；没有会话时
   * 只列能当部署默认的配置预设（宿主 catalog 的 defaultOptions）——auto 写不进
   * 部署默认，列出来也切不了。
   */
  listPermissionPresets(): PermissionPresetEntry[] {
    const presets = this.getPermissionPresetsService();
    try {
      const names = this.currentRecord() ? this.permissionNames(presets) : this.deploymentDefaultNames(presets);
      return names.map((name) => {
        const option = presets.optionOf?.(name);
        return { id: name, name: option?.name, description: option?.description };
      });
    } catch (err) {
      // 目录读不出来不该让 /permission 抛到命令层（宿主投影缺失等）
      this.logger.warn(`list permission presets failed: ${errorText(err)}`);
      return [];
    }
  }

  /** 宿主的全量预设名（配置表顺序 + 在线的 auto） */
  private permissionNames(presets: PermissionPresetsLike): readonly string[] {
    return Array.isArray(presets.names) ? presets.names : [];
  }

  /** 能当部署默认的预设名：宿主 defaultOptions；投影缺失时退回配置键（去掉会话级的 auto） */
  private deploymentDefaultNames(presets: PermissionPresetsLike): readonly string[] {
    try {
      const options = presets.catalog?.().defaultOptions;
      if (options) return options.map((option) => option.value);
    } catch (err) {
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
  getPermissionPreset(_scope: ChatScope, _peerId: string): string | undefined {
    const presets = this.getPermissionPresetsService();

    const record = this.currentRecord();
    if (record) {
      try {
        return presets.current(record.agent.session);
      } catch (err) {
        this.logger.debug(`permission state unavailable: key=${record.sessionKey} ${errorText(err)}`);
      }
    }

    try {
      const preset = presets.defaultPreset;
      this.lastKnownDefaultPermission = preset;
      return preset;
    } catch (err) {
      // 部署默认被写成了 auto 这类不能当默认的预设时，宿主 defaultSettings 抛错，
      // 不但这一行读不出来，之后新建会话也会失败。回正到最近一次读到的有效值。
      const fallback = this.lastKnownDefaultPermission ?? this.deploymentDefaultNames(presets)[0];
      if (!fallback) return undefined;
      this.logger.warn(`default permission preset unreadable, restoring ${fallback}: ${errorText(err)}`);
      this.restoreDefaultPermission(fallback);
      return fallback;
    }
  }

  /** 这个预设能不能当部署默认（会话级 auto 与派生的 custom 不行） */
  private isDeploymentDefault(presets: PermissionPresetsLike, preset: string): boolean {
    return this.deploymentDefaultNames(presets).includes(preset);
  }

  /** 写回部署默认预设（自愈，失败只记日志，不影响展示） */
  private restoreDefaultPermission(preset: string): void {
    try {
      void this.getSettingsService()
        .update(PERMISSION_SETTINGS_NS, { defaultPreset: preset })
        .catch((err: unknown) => {
          this.logger.warn(`default permission restore failed: preset=${preset} ${errorText(err)}`);
        });
    } catch (err) {
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
  async setPermissionPreset(
    scope: ChatScope,
    peerId: string,
    preset: string,
  ): Promise<PermissionSwitchOutcome> {
    const key = this.sessionKey();
    const presets = this.getPermissionPresetsService();
    if (!presets.names.includes(preset)) return { ok: false, reason: 'unknown-preset' };

    const record = this.currentRecord(key);

    // 可重入：目标就是当前生效的预设（有会话看会话，没有会话看部署默认）时直接返回
    if (this.getPermissionPreset(scope, peerId) === preset) {
      this.logger.debug(`permission switch skipped (already current): key=${key} preset=${preset}`);
      return { ok: true, preset, unchanged: true };
    }

    if (!record) {
      // 没有会话时只能选能当部署默认的预设：auto 是会话级选项，写成部署默认会让
      // 宿主 defaultSettings 抛 `unknown default preset`，读默认值与新建会话都会失败
      if (!this.isDeploymentDefault(presets, preset)) return { ok: false, reason: 'unknown-preset' };

      try {
        await this.getSettingsService().update(PERMISSION_SETTINGS_NS, { defaultPreset: preset });
      } catch (err) {
        const message = errorText(err);
        this.logger.warn(`default permission switch failed: key=${key} preset=${preset} err=${message}`);
        return { ok: false, reason: 'failed', message };
      }

      this.logger.info(`default permission preset set: key=${key} preset=${preset}`);
      return { ok: true, preset };
    }

    try {
      presets.set(record.agent.session, preset);
    } catch (err) {
      // auto 的准入检查失败（集成下线）也会走到这里：如实报错，不静默降级
      const message = errorText(err);
      this.logger.warn(`permission switch failed: key=${key} preset=${preset} err=${message}`);
      return { ok: false, reason: 'failed', message };
    }

    this.logger.info(`permission switched: key=${key} preset=${preset}`);
    return { ok: true, preset };
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(_scope: ChatScope, _peerId: string): SessionRecord | undefined {
    return this.currentRecord();
  }

  /**
   * 当前聊天接的会话 id（内存指针优先，其次 prefs 里落盘的映射）。
   *
   * 两处都为空 = 这个聊天还没有会话（首次使用或刚 `/new`），不是错误状态。
   */
  currentSessionId(key: string = this.sessionKey()): string | undefined {
    return this.currentByKey.get(key) ?? this.modelResolver.getSessionId(key);
  }

  /** 某个 sessionId 是不是当前聊天正在接的会话 */
  isCurrentSession(sessionId: string): boolean {
    return this.currentSessionId() === sessionId;
  }

  /** 会话是否正在生成：非当前会话的署名据此决定给不给「停止」入口 */
  isRunningSession(sessionId: string): boolean {
    return this.findBySessionId(sessionId)?.agent.status === 'running';
  }

  /**
   * 会话标题（非当前会话的消息头 / 提问 / 审批共用）。
   *
   * 标题由宿主异步生成，取不到时返回 undefined，调用方用兜底名。
   */
  sessionTitle(sessionId: string): string | undefined {
    const record = this.findBySessionId(sessionId);
    return record === undefined ? undefined : sessionTitleOf(record);
  }

  /** 当前聊天有没有可操作的会话（已获取记录，或进程内仍活着的 agent） */
  hasCurrentSession(): boolean {
    const sessionId = this.currentSessionId();
    if (sessionId === undefined) return false;
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
  renameCurrentSession(title: string): RenameSessionOutcome {
    const record = this.currentRecord();
    if (record) return this.renameRecord(record, title);

    const sessionId = this.currentSessionId();
    const live = sessionId === undefined ? undefined : this.agents.get(sessionId);
    if (live === undefined) return { ok: false, reason: 'no-session' };
    return this.renameLive(live.id, live.session, title);
  }

  /**
   * 给指定会话改标题（`/sessions rename`）。
   *
   * 目标必须在已获取集合里，或至少有一个 live agent；冷会话不在这里静默
   * resume——那是 `/sessions resume` 的职责。
   */
  renameSession(sessionId: string, title: string): RenameSessionOutcome {
    const record = this.findBySessionId(sessionId);
    if (record) return this.renameRecord(record, title);

    const live = this.agents.get(sessionId);
    if (live === undefined) return { ok: false, reason: 'no-session' };
    return this.renameLive(sessionId, live.session, title);
  }

  private renameRecord(record: SessionRecord, title: string): RenameSessionOutcome {
    return this.renameLive(record.sessionId, record.agent.session, title);
  }

  /** 统一入口：标题写入宿主日志 + 留痕；空标题在动宿主前就拒绝 */
  private renameLive(
    sessionId: string,
    session: DshAgent['session'],
    title: string,
  ): RenameSessionOutcome {
    const trimmed = title.trim();
    if (trimmed === '') return { ok: false, reason: 'invalid', message: '新标题不能为空' };

    const outcome = this.host.renameSession(session, trimmed);
    if (outcome.ok) {
      this.logger.info(`session renamed: sessionId=${sessionId} title=${outcome.title}`);
    } else {
      this.logger.warn(`session rename failed: sessionId=${sessionId} reason=${outcome.reason}${outcome.message ? ` err=${outcome.message}` : ''}`);
    }
    return outcome;
  }

  /** 已获取会话快照（出站 / 问答 / 审批共用） */
  listAcquiredSessions(): readonly SessionRecord[] {
    return [...this.records.values()];
  }

  /**
   * 中止所有正在生成的已获取会话（`/stop all`）。
   *
   * QQ 侧只有一个聊天，已获取会话本来就都回同一个聊天，所以不再按 peer
   * 过滤。返回被中止的会话 id；没有正在生成的会话时返回空数组。
   */
  cancelAllRunning(): string[] {
    const cancelled: string[] = [];
    for (const record of [...this.records.values()]) {
      if (record.agent.status !== 'running') continue;
      record.agent.cancel({ kind: 'user' });
      this.cancelPendingFor(record.sessionId);
      cancelled.push(record.sessionId);
    }
    return cancelled;
  }

  /** 当前聊天接的会话记录；没有获取过（或已被外部关掉）返回 undefined */
  private currentRecord(key: string = this.sessionKey()): SessionRecord | undefined {
    const sessionId = this.currentSessionId(key);
    return sessionId === undefined ? undefined : this.findBySessionId(sessionId);
  }

  getStatus(scope: ChatScope, peerId: string): SessionStatus {
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

  getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats {
    const record = this.getSessionRecord(scope, peerId);
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (!record) return stats;

    const events = this.host.sessionEvents(record.agent.session) as readonly SessionEventLike[];
    if (!events) return stats;

    for (const event of events) {
      if (event.type !== 'assistant/message') continue;

      const usage = event.data?.usage;
      if (!usage) continue;
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
  getContextUsage(scope: ChatScope, peerId: string): SessionContextUsage {
    const record = this.getSessionRecord(scope, peerId);
    const usage: SessionContextUsage = {};
    if (!record) return usage;

    const events = this.host.sessionEvents(record.agent.session) as readonly SessionEventLike[];
    if (!events || events.length === 0) return usage;

    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (!event) continue;

      if (event.type === 'assistant/message' && usage.used === undefined) {
        const total = event.data?.usage?.totalTokens;
        if (typeof total === 'number') usage.used = total;
      }

      if (event.type === 'request/context' && usage.window === undefined) {
        const data = event.data as
          | { contextWindow?: unknown; provider?: unknown; model?: unknown }
          | undefined;
        if (typeof data?.contextWindow === 'number') usage.window = data.contextWindow;
        if (typeof data?.provider === 'string') usage.provider = data.provider;
        if (typeof data?.model === 'string') usage.model = data.model;
      }

      if (usage.used !== undefined && usage.window !== undefined) break;
    }

    return usage;
  }

  /**
   * 生成中的现场：本轮耗时、当前步骤、正在执行的动作与重试退避。
   *
   * 只读事件流，不持有状态、不挂监听：/status 每次现算，不为进度增加生命周期。
   * 找不到未结束的 turn 时返回 undefined（刚结束，或日志被压缩过）。
   */
  getTurnProgress(scope: ChatScope, peerId: string): SessionTurnProgress | undefined {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return undefined;

    const events = this.host.sessionEvents(record.agent.session) as readonly SessionEventLike[];
    if (!events || events.length === 0) return undefined;

    // 末尾往回找本轮起点；先遇到 turn/end 说明本轮已结束
    let startIndex = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const type = events[i]?.type;
      if (type === 'turn/end') return undefined;
      if (type === 'turn/start') {
        startIndex = i;
        break;
      }
    }
    if (startIndex === -1) return undefined;

    const startedAt = events[startIndex]?.time;
    if (typeof startedAt !== 'number') return undefined;

    let step: number | undefined;
    let waitingSince = startedAt;
    let retry: SessionTurnProgress['retry'];
    // callId → 工具名与开始时间；并行调用时展示最早未完成的那个
    const pending = new Map<string, { name: string; since: number }>();

    for (let i = startIndex + 1; i < events.length; i++) {
      const event = events[i];
      if (!event) continue;
      const data = event.data as Record<string, unknown> | undefined;
      const time = typeof event.time === 'number' ? event.time : waitingSince;

      switch (event.type) {
        case 'step/start': {
          const value = data?.step;
          if (typeof value === 'number') step = value;
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
          const message = data?.message as { callId?: unknown } | undefined;
          const callId = typeof message?.callId === 'string' ? message.callId : undefined;
          if (callId !== undefined) {
            pending.delete(callId);
          } else {
            // 没有 callId 的旧日志按先进先出配对
            const oldest = pending.keys().next();
            if (!oldest.done) pending.delete(oldest.value);
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
      let oldest: { name: string; since: number } | undefined;
      for (const item of pending.values()) {
        if (!oldest || item.since < oldest.since) oldest = item;
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

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = this.host.sessionEvents(record.agent.session) as readonly SessionEventLike[];
    if (!events || events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  private countMessages(record: SessionRecord | undefined): number {
    if (!record) return 0;
    const events = this.host.sessionEvents(record.agent.session) as readonly SessionEventLike[];
    if (!events) return 0;

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
  private sessionKey(): string {
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
  private serializeSelection<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.selectionChains.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    this.selectionChains.set(sessionId, result.then(() => undefined, () => undefined));
    return result;
  }

  /**
   * 会话内改完选择后把部署默认一起写掉（宿主 controller 也是这么做的：新会话
   * 沿用最近一次选择）。失败只记 warn，不影响本次切换。
   */
  private persistDefaultSelection(selection: HostSelection, key: string): void {
    void this.agentDefaultModel.saveSelection(selection).catch((err) => {
      this.logger.warn(`session model selection saved but default not: key=${key} err=${errorText(err)}`);
    });
  }

  /** 宿主命令登记簿（inject 保证存在） */
  private get commands(): CommandsRegistryLike {
    return (this.ctx as unknown as { commands: CommandsRegistryLike }).commands;
  }

  /** 宿主会话 projection 注册表（inject 保证存在） */
  private get sessionProjections(): SessionProjectionsLike {
    return (this.ctx as unknown as { sessionProjections: SessionProjectionsLike }).sessionProjections;
  }

  /** 宿主部署默认模型选择（inject 保证存在） */
  private get agentDefaultModel(): AgentDefaultModelLike {
    return (this.ctx as unknown as { agentDefaultModel: AgentDefaultModelLike }).agentDefaultModel;
  }

  /** 把当前会话 id 落盘，后续（重启、切换、并发调用）一律以 prefs 为准 */
  private persistSessionId(sessionKey: string, sessionId: string): void {
    if (this.modelResolver.getSessionId(sessionKey) !== sessionId) {
      this.modelResolver.setSessionId(sessionKey, sessionId);
    }
  }

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    const presets = this.getPresetsService();
    if (!presets) return {};

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      this.logger.warn(
        `qqterm: preset ${presetId ?? '(default)'} unavailable: ${errorMessage(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 获取或恢复或创建当前会话（get → resume → create）；同 key 并发合并为一次 */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
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
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * 收到一条消息后刷新会话记录上的「当前聊天」信息。
   *
   * 同一条记录可能被多个 QQ 窗口复用（聊天会话只有一个），这几项必须跟着最后
   * 一条消息走，否则 prompt、提问作答与回复目标会停在第一个说话的窗口上。
   */
  private touch(
    record: SessionRecord,
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): void {
    record.replyTarget = replyTarget;
    record.scope = scope;
    record.peerId = peerId;
    record.senderId = senderId;
    // 记下最后说话的人：重启恢复会话时没有入站消息，只能靠它做回复目标
    if (replyTarget.targetId !== '') this.modelResolver.setTarget(record.sessionKey, replyTarget.targetId);
  }

  /** 改当前会话指针并落盘（prefs 仍只记 current） */
  private setCurrent(key: string, sessionId: string): void {
    this.currentByKey.set(key, sessionId);
    this.persistSessionId(key, sessionId);
    this.pendingWorktree = false;
  }

  /**
   * 清掉当前指针：“这个聊天现在没有会话，下一条消息再建”。
   *
   * 内存与 prefs 一起清，避免 `currentSessionId()` 的两处来源指向不同状态；
   * 目录保留，新会话仍落在上次的工作区。删空不是中间态，而是与“从未聊过”
   * 完全相同的空状态——不需要为它另设展示分支。
   */
  private clearCurrent(key: string): void {
    this.currentByKey.delete(key);
    if (this.modelResolver.getSessionId(key) !== undefined) this.modelResolver.clearSessionId(key);
    this.pendingWorktree = false;
  }

  /** getOrCreate 的实际打开流程（已通过 singleflight 保证同 key 串行） */
  private async openSession(
    key: string,
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    // prefs 命中 = 已知存量会话；miss = 全新会话（含刚按过 `/new`），铸一个新 id 后创建
    const mapped = this.modelResolver.getSessionId(key);
    const sessionId = SessionId(mapped ?? mintSessionId());
    this.logger.info(`getOrCreate: key=${key} sessionId=${sessionId}`);

    // 这个聊天的工作区：新会话落在它里面，恢复的会话以它自己的 header 为准。
    // 存进来的已经是工作区目录（写点归一），这里不再二次归一
    let directory = this.chatDirectory();

    // 已经获取过这个会话（`/to` 先拿到、或 `/sessions resume` 接上）：直接复用记录
    const known = this.records.get(sessionId);
    if (known) {
      this.touch(known, scope, peerId, senderId, replyTarget);
      this.setCurrent(key, sessionId);
      this.setChatDir(this.headerCwd(known.agent) ?? directory);
      return known;
    }

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;
    let worktree: SpawnedWorktree | undefined;
    let worktreeSkipped: 'not-repo' | 'read-only' | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      agentPreset = await this.resolvePersistedPreset(sessionId);
      directory = this.host.sessionDirectory(agent.session) ?? directory;
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
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
        } catch (err) {
          // 目录回不来就别把这个 agent 留在宿主里跑：先还句柄再上抛
          await handle.dispose().catch(() => {});
          throw err;
        }
        const resumedRoute = this.hostSelection(agent) ?? this.modelResolver.resolveDefault();
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumedRoute.provider}/${resumedRoute.model}`);
      } catch (err) {
        // 目录重建失败不是「会话不存在」：换个会话也不能把树找回来，直接上抛
        if (err instanceof WorktreeError) throw err;
        if (!(await this.mayCreateAfterResumeFailure(key, sessionId, err))) throw err;
        mkdirSync(directory, { recursive: true });
        const created = await this.spawnSession(
          key,
          sessionId,
          directory,
          agentPreset,
          composed.setup,
          this.pendingWorktree,
        );
        agent = created.agent;
        handle = created.handle;
        directory = created.directory;
        worktree = created.worktree;
        worktreeSkipped = created.worktreeSkipped;
        this.logger.info(`created new session: key=${key} sessionId=${sessionId} preset=${agentPreset ?? 'none'} cwd=${directory}`);
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      ...(handle ? { handle } : {}),
      replyTarget,
      scope,
      peerId,
      senderId,
      ...(agentPreset ? { agentPreset } : {}),
    };

    if (worktree !== undefined) {
      record.worktreeNotice = worktreeNotice(worktree.tree, worktree.parent);
    } else if (worktreeSkipped !== undefined) {
      record.worktreeNotice = worktreeSkipNotice(worktreeSkipped);
    }

    this.records.set(sessionId, record);
    this.rememberHeld(sessionId);
    this.setCurrent(key, sessionId);

    // 工作区跟着会话走：落点取会话的工作区（header.cwd），不是它的运行目录（树路径）
    const workspace = this.headerCwd(agent) ?? directory;
    if (workspace) this.setChatDir(workspace);

    // 挂载到对应工作区（侧边栏可见性）；fail-soft、异步执行，不阻塞消息处理。
    // 宿主只在客户端 session.create RPC 时挂载会话，插件会话不走那条路径，
    // 所以这里补挂一次（幂等，升级后老会话也会补上）。
    // 必须传 header.cwd（建会话时的目录）：attachSession 校验它等于工作区路径，
    // 传工作树路径会凭空长出一个以树名命名的工作区。
    const attachCwd = this.headerCwd(agent) ?? directory;
    if (attachCwd) void this.host.attachSessionToWorkspace(sessionId, attachCwd);

    return record;
  }


  /**
   * 新会话要不要开在工作树里：要就返回建树的基点（主仓库根）。
   *
   * 只有 `/new --worktree` 显式要求才建。三处不建：部署没有 worktrees 服务、
   * 默认策略只读、当前目录不是主仓库——后两种由调用方就地开会话并说明原因，
   * 服务缺失不提（部署差异）。
   */
  private worktreeBase(directory: string, wanted: boolean): string | undefined {
    if (!wanted) return undefined;
    if (this.host.worktrees() === undefined) return undefined;
    if (this.host.sandboxMode() === 'read-only') return undefined;
    return mainRepositoryRoot(directory);
  }

  /**
   * 新建会话：要求开树（`/new --worktree`、`/new --background -w`）就开在树里，否则就地。
   *
   * `wanted` 由调用方传入（当前指针的意图，或后台启动自带的要求），这里不读也不清
   * `pendingWorktree`：清意图只发生在 `setCurrent`（成功接上当前会话）那一步。
   *
   * 宿主不回滚建树的半成品（分支与检出可能留下），这里只关掉刚创建的 agent：
   * 指针与已获取集都不动；意图保留，用户重发一次就会重新尝试。
   * 读不到 chatDir 的 HEAD 时直接抛 `base` 错误，agent 都还没有创建。
   */
  private async spawnSession(
    key: string,
    sessionId: SessionId,
    directory: string,
    agentPreset: string | undefined,
    setup: PresetComposition['setup'],
    wanted: boolean,
  ): Promise<{
    agent: DshAgent;
    handle: DshAgentHandle;
    directory: string;
    worktree?: SpawnedWorktree;
    worktreeSkipped?: 'not-repo' | 'read-only';
  }> {
    const base = this.worktreeBase(directory, wanted);
    // 基点按 chatDir 的 HEAD 算：宿主默认取 repository root 的 HEAD，在树里再开会话
    // 会从主检出而不是当前分支拉出。读不到 HEAD 就不建会话——不降级到主检出。
    const plan = base === undefined
      ? undefined
      : { base, head: await this.headForWorktree(directory) };
    const created = await this.agents.create({
      sessionId,
      // 树的池与 .git/worktrees 登记都落在基点下，所以 header.cwd 必须是基点
      meta: {
        cwd: plan?.base ?? directory,
        ...(agentPreset ? { agentPreset } : {}),
      },
      agentOptions: this.agentOptionsFor(),
      ...(setup ? { setup } : {}),
    });

    const worktrees = this.host.worktrees();
    if (plan === undefined || worktrees === undefined) {
      // 明确要求过却没开成：意图用完即弃，并把原因带回回执
      if (!wanted) return { agent: created.agent, handle: created, directory };
      if (worktrees === undefined) return { agent: created.agent, handle: created, directory };
      const reason = this.host.sandboxMode() === 'read-only' ? 'read-only' as const : 'not-repo' as const;
      return { agent: created.agent, handle: created, directory, worktreeSkipped: reason };
    }

    try {
      const tree = await worktrees.create(
        created.agent,
        { from: plan.head.commit },
        AbortSignal.timeout(WORKTREE_TIMEOUT_MS),
      );
      this.logger.info(`created worktree: key=${key} branch=${tree.branch} path=${tree.path}`);
      return {
        agent: created.agent,
        handle: created,
        directory: tree.path,
        worktree: {
          tree,
          ...(plan.head.branch === undefined ? {} : { parent: plan.head.branch }),
        },
      };
    } catch (err) {
      this.logger.warn(`worktree creation failed: key=${key} ${errorMessage(err)}`);
      created.agent.cancel({ kind: 'user' });
      await created.dispose().catch(() => {});
      throw new WorktreeError('create', worktreeFailureText(err), err, plan.head.branch);
    }
  }

  /**
   * 读 chatDir 的 HEAD 提交；读不到就建不了树，本次会话不创建（不降级到主检出 HEAD）。
   */
  private async headForWorktree(directory: string): Promise<{ commit: string; branch?: string }> {
    const head = await this.host.headOf(directory);
    if (head === undefined) {
      this.logger.warn(`worktree base unreadable: directory=${directory}`);
      throw new WorktreeError('base', '没能读到当前分支的提交');
    }
    return head;
  }

  /**
   * 恢复会话的工作目录：树被归档清理删掉时就地重建。
   *
   * 宿主 restore 只重建检出、不切调用方目录，所以成功后才轮到插件把目录改回树
   * 路径。目录还在、会话不在树里（非仓库 / headless）时原样返回。
   */
  private async restoreWorktree(agent: DshAgent, directory: string): Promise<string> {
    const worktrees = this.host.worktrees();
    if (worktrees === undefined) return directory;
    const creation = this.worktreeCreations(agent).find((entry) => entry.owned)?.worktree;
    if (creation === undefined || existsSync(creation.path)) return directory;
    if (!samePath(directory, creation.path)) return directory;
    try {
      const restored = await worktrees.restore(agent, creation, AbortSignal.timeout(WORKTREE_TIMEOUT_MS));
      this.logger.info(`restored worktree: path=${restored.path} branchRecreated=${restored.branchRecreated}`);
      return restored.path;
    } catch (err) {
      this.logger.warn(`worktree restore failed: ${errorMessage(err)}`);
      throw new WorktreeError('restore', worktreeFailureText(err), err);
    }
  }

  /**
   * 会话创建时的目录（= header.cwd），工作区挂载与建树都按它算。
   *
   * 运行期 cd 只改 workingDirectory，不该把工作区挂载点或建树基点带走。
   */
  private headerCwd(agent: DshAgent): string | undefined {
    const header = (agent.session as { header?: { cwd?: unknown } } | undefined)?.header;
    return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined;
  }

  /**
   * 会话日志里的工作树投影（创建顺序）；没有该投影返回空数组。
   *
   * 模型自己调 `create_worktree` 建的树也写同一条记录，所以这里不等于「插件建的」。
   */
  private worktreeCreations(agent: DshAgent): readonly WorktreeCreationLike[] {
    try {
      const state = this.sessionProjections.stateOf(agent.session, 'worktree') as WorktreeProjectionLike | undefined;
      return Array.isArray(state?.created) ? state.created : [];
    } catch (err) {
      this.logger.debug(`worktree projection unavailable: ${errorMessage(err)}`);
      return [];
    }
  }

  /** 当前会话所在的工作树（/status 用）；没有投影返回 undefined */
  worktreeOf(scope: ChatScope, peerId: string): WorktreeInfo | undefined {
    const record = this.getSessionRecord(scope, peerId);
    if (record === undefined) return undefined;
    const creations = this.worktreeCreations(record.agent);
    if (creations.length === 0) return undefined;
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
  hasWorktree(sessionId: string): boolean {
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
  private async mayCreateAfterResumeFailure(key: string, sessionId: string, resumeError: unknown): Promise<boolean> {
    const context = `key=${key} sessionId=${sessionId} resumeErr=${errorText(resumeError)}`;
    let exists: boolean | undefined;
    try {
      exists = await this.host.sessionExists(sessionId);
    } catch (probeError) {
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
  findBySessionId(sessionId: string): SessionRecord | undefined {
    const record = this.records.get(sessionId);
    if (!record) return undefined;
    const live = this.agents.get(sessionId);
    if (live !== undefined && live !== record.agent) {
      this.records.delete(sessionId);
      this.cancelPendingFor(sessionId);
      this.logger.info(`acquired session replaced externally, dropped: sessionId=${sessionId}`);
      return undefined;
    }
    return record;
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    const record = this.records.get(agent.id);
    return record?.agent === agent ? record : undefined;
  }

  /** 某个 sessionId 是否还有 live agent（`/to` 的目标校验用） */
  hasLiveSession(sessionId: string): boolean {
    return this.agents.get(sessionId) !== undefined;
  }

  /**
   * `/new`：清掉当前指针，下一条消息再建会话。
   *
   * 旧会话仍然 live、仍在已获取集合里，继续把输出发回 QQ（带 `#短id`）；
   * 不 cancel、不 dispose、不清 pending。这里不预先铸 id：没有会话就是没有
   * 指针，`/sessions` 不会显示一条点「恢复」必然失败的当前项。
   */
  async remove(): Promise<void> {
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
  async resetCurrentSession(): Promise<boolean> {
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
  async resetAllSessions(): Promise<number> {
    const key = this.sessionKey();
    const records = [...this.records.values()];
    // 先清指针：循环里的 await 期间新消息不能落回任何一个旧会话
    this.clearCurrent(key);

    for (const record of records) {
      await this.dropRecord(record, { cancel: true, dispose: true });
    }
    // 名册里可能还有重启前的冷会话：/clear all 之后列表也得是真的空
    this.modelResolver.setHeldSessionIds(key, []);

    this.logger.info(`all sessions reset: key=${key} (stopped=${records.length})`);
    return records.length;
  }

  /**
   * 把一条 prompt 交给宿主，记下落点与消息 id。
   *
   * 生成中按宿主 `ui-conversation.busyEnter` 决定：`steer` 走 `agent.steer`
   * （下一步消费），其余一律 `followup`（排队到本轮之后）。空闲永远 followup。
   * 设置读不到时按 queue——`followup` 就是宿主的排队原语，插件不另存默认值。
   */
  public submitPrompt(record: SessionRecord, text: string): PromptSubmission {
    const body = text.trim();
    // 原文留档：轮次失败后「重发」要用（宿主没有重跑已结束一轮的 API）
    record.lastPrompt = body;
    const message = createQQUserMessage(body);
    const running = record.agent.status === 'running';
    const steering = running && this.busyEnterBehavior() === 'steer';
    if (steering) record.agent.steer(message);
    else record.agent.followup(message);
    const placement: PromptPlacement = !running ? 'started' : steering ? 'steered' : 'queued';
    return { messageId: message.id, placement };
  }

  /** 宿主 `ui-conversation.busyEnter`：只有显式 steer 才插话，其余（含读不到）排队 */
  private busyEnterBehavior(): 'queue' | 'steer' {
    try {
      const descriptor = this.getSettingsService()
        .describe()
        .find((entry) => entry.ns === BUSY_ENTER_SETTINGS_NS);
      return descriptor?.value?.[BUSY_ENTER_FIELD] === 'steer' ? 'steer' : 'queue';
    } catch (err) {
      this.logger.debug(`busyEnter unavailable: ${errorText(err)}`);
      return 'queue';
    }
  }

  /** 部署是否有插话入口（sessionController.updateQueue） */
  public canSteer(): boolean {
    return this.host.supportsQueueSteer();
  }

  /** 把一条仍在排队的消息改成插话；不 cancel、不改当前指针 */
  public async steerQueued(sessionId: string, itemId: string): Promise<SteerQueuedOutcome> {
    const outcome = await this.host.steerQueuedMessage(sessionId, itemId);
    return outcome.ok
      ? { ok: true }
      : {
        ok: false,
        reason: outcome.reason,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      };
  }

  /** 目标会话是否在等一条回答（`/to` 据此拒绝带引用的整条消息：答案不接受引用） */
  isAwaitingAnswer(sessionId: string): boolean {
    return this.questionChannel?.hasPending(sessionId) ?? false;
  }

  /**
   * `/to <会话> -- <文本>`：向指定会话发 prompt，或在它等答案时提交答案。
   *
   * 目标还没打开时先按 id 打开，走 `/sessions resume` 同一条路；只是不把指针挪过去，
   * 回复别的会话不改「当前会话」。打开失败如实报错，绝不 create。
   */
  async sendTo(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    sessionId: string,
    text: string,
    replyTarget: ReplyTarget,
  ): Promise<SendToOutcome> {
    const body = text.trim();

    // 归档是界面上已有的状态，/to 不替人改它：已归档的会话直接拒发，
    // 要不要接回来由 /sessions unarchive 决定
    if (this.host.archivedSessionIds().has(sessionId)) {
      return { ok: false, reason: 'archived', sessionId };
    }

    let record = this.findBySessionId(sessionId);
    // 借来的记录没有 handle，只能靠 registry 判断是否还活着；已死的当作没获取过，
    // 下面重新打开一遍
    if (record && record.handle === undefined && this.agents.get(sessionId) === undefined) {
      this.records.delete(sessionId);
      this.cancelPendingFor(sessionId);
      record = undefined;
    }
    if (record) {
      if (record.peerId !== peerId) {
        return { ok: false, reason: 'forbidden', sessionId };
      }
      this.touch(record, scope, peerId, senderId, replyTarget);
    } else {
      // 回复是使用方明确要做的动作，不该先让他去 `/sessions resume` 走一趟：
      // 目标只在磁盘上也照样接回来，只是不把它变成当前会话。
      const opened = await this.switchSession(scope, peerId, sessionId, senderId, replyTarget, { openOnly: true });
      if (!opened.ok) {
        const message = opened.message === undefined ? {} : { message: opened.message };
        switch (opened.reason) {
          case 'not-found':
            return { ok: false, reason: 'not-found', sessionId };
          case 'archived':
            return { ok: false, reason: 'archived', sessionId };
          case 'locked':
            return { ok: false, reason: 'locked', sessionId };
          default:
            return { ok: false, reason: 'failed', sessionId, ...message };
        }
      }
      record = this.findBySessionId(sessionId);
      if (!record) return { ok: false, reason: 'failed', sessionId };
    }

    const questions = this.questionChannel;
    if (questions?.hasPending(sessionId)) {
      if (body === '') {
        questions.beginAnswerMode(peerId, sessionId);
        return { ok: true, kind: 'answer-mode', sessionId };
      }
      if (questions.answer(sessionId, body)) return { ok: true, kind: 'answered', sessionId };
      return { ok: false, reason: 'failed', sessionId, message: '答案解析失败' };
    }

    if (body === '') return { ok: false, reason: 'empty', sessionId };

    let submitted: PromptSubmission;
    try {
      submitted = this.submitPrompt(record, body);
    } catch (err) {
      const message = errorText(err);
      this.logger.warn(`/to prompt failed: sessionId=${sessionId} err=${message}`);
      return { ok: false, reason: 'failed', sessionId, message };
    }
    this.logger.info(`prompt sent via /to: sessionId=${sessionId} placement=${submitted.placement}`);
    if (submitted.placement === 'started') return { ok: true, kind: 'sent', sessionId };
    return { ok: true, kind: submitted.placement, sessionId, messageId: submitted.messageId };
  }

  /**
   * 重发当前会话最近一条用户消息（`/retry` 与失败卡片的「重发」共用）。
   *
   * 宿主没有「重跑已结束一轮」的 API：只能靠记住的原文再开一轮，历史里因此会
   * 多出一条相同的用户消息——这是换取「不重打原文就能再试一次」的既定代价。
   */
  public retryLastPrompt(scope: ChatScope, peerId: string): RetryPromptOutcome {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return { ok: false, reason: 'no-session' };
    const prompt = record.lastPrompt;
    if (prompt === undefined || prompt.trim() === '') return { ok: false, reason: 'no-prompt' };
    let submitted: PromptSubmission;
    try {
      submitted = this.submitPrompt(record, prompt);
    } catch (err) {
      const message = errorText(err);
      this.logger.warn(`/retry prompt failed: sessionId=${record.sessionId} err=${message}`);
      return { ok: false, reason: 'failed', message };
    }
    this.logger.info(`prompt resent: sessionId=${record.sessionId} placement=${submitted.placement}`);
    return { ok: true, sessionId: record.sessionId, ...submitted };
  }

  /**
   * `/new <提示词>`：开新会话并把提示词作为第一条消息发出去。
   *
   * 走普通入站消息同一条路：原文留在 `lastPrompt`（轮次失败后的「重发」要用），
   * `followup` 写进宿主的 next-turn inbox。建树回执不在这里发——命令层要把它
   * 并进同一条回执，所以取走并从记录上摘掉，免得下一条普通消息再发一次。
   */
  async promptNewSession(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    prompt: string,
    replyTarget: ReplyTarget,
  ): Promise<{ sessionId: string; worktreeNotice?: string }> {
    const record = await this.getOrCreate(scope, peerId, senderId, replyTarget);
    this.submitPrompt(record, prompt);
    const notice = record.worktreeNotice;
    if (notice !== undefined) delete record.worktreeNotice;
    this.logger.info(`prompt sent with /new: sessionId=${record.sessionId}`);
    return notice === undefined
      ? { sessionId: record.sessionId }
      : { sessionId: record.sessionId, worktreeNotice: notice };
  }

  /**
   * `/new --background`：另开一条会话并把提示词发出去，不接管当前聊天。
   *
   * 与 `/new <提示词>` 的唯一区别是不动当前指针与聊天工作区：这条会话只进已获取
   * 集合，输出、提问、审批照样回 QQ（带 `#短id` 署名），切过去用 `/sessions resume`。
   * `--worktree` 的建树要求从参数进来，不经过 `pendingWorktree`，回执同样交给命令层。
   */
  async startBackgroundSession(input: {
    directory: string;
    worktree: boolean;
    prompt: string;
    scope: ChatScope;
    peerId: string;
    senderId: string;
    replyTarget: ReplyTarget;
  }): Promise<{ sessionId: string; worktreeNotice?: string }> {
    const key = this.sessionKey();
    const sessionId = SessionId(mintSessionId());
    const presetId = await this.resolvePersistedPreset(sessionId);
    const composed = await this.composePreset(presetId);
    const directory = input.directory;
    mkdirSync(directory, { recursive: true });
    const created = await this.spawnSession(
      key,
      sessionId,
      directory,
      composed.agentPreset,
      composed.setup,
      input.worktree,
    );

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent: created.agent,
      handle: created.handle,
      replyTarget: input.replyTarget,
      scope: input.scope,
      peerId: input.peerId,
      senderId: input.senderId,
      ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
    };
    this.records.set(sessionId, record);
    this.rememberHeld(sessionId);

    // 挂到工作区以便侧栏可见；指针与聊天工作区都不动，切过去才成为当前会话
    const attachCwd = this.headerCwd(created.agent) ?? directory;
    if (attachCwd) void this.host.attachSessionToWorkspace(sessionId, attachCwd);

    this.submitPrompt(record, input.prompt);
    this.logger.info(
      `background session started: sessionId=${sessionId} dir=${created.directory} worktree=${input.worktree}`,
    );

    const notice = created.worktree !== undefined
      ? worktreeNotice(created.worktree.tree, created.worktree.parent)
      : created.worktreeSkipped === undefined
        ? undefined
        : worktreeSkipNotice(created.worktreeSkipped);
    return notice === undefined ? { sessionId } : { sessionId, worktreeNotice: notice };
  }

  /**
   * 该聊天当前所在的工作目录（内存态，唯一来源）。
   *
   * 初值在构造时取宿主默认工作区；建会话、切换会话、`/new --dir <工作区>` 会覆盖它。
   * 运行期 `cd` 不改它（那只动会话的运行目录）。这里不回退会话 header /
   * 持久化记录 / 默认工作区。
   */
  private chatDirectory(): string {
    return this.chatDir;
  }

  /**
   * 工作区的归属目录：链接工作树里的路径取主仓库根，其它原样返回。
   *
   * 只在写落点前用一次（读回旧 prefs、`/new --dir <路径>`），以及 `/sessions` 比会话用。
   * 树是会话的运行目录，不是工作区：一旦写进落点，新会话的 header.cwd 就变成
   * 树路径，凭空长出一个以树名命名的工作区。
   */
  private workspaceDirOf(directory: string): string {
    return worktreeSourceRoot(directory) ?? directory;
  }

  /**
   * 覆盖聊天工作目录并落盘（启动时优先读回的记忆）。
   *
   * 内存仍是唯一读写来源；磁盘只做镜像，值没变不写。存工作区目录（下一会话的
   * 落点），不存会话的运行目录；旧数据里的树路径由 {@link workspaceDirOf} 归一。
   */
  private setChatDir(directory: string): void {
    if (this.chatDir === directory) return;
    this.chatDir = directory;
    this.modelResolver.setDirectory(this.sessionKey(), directory);
  }

  /** 某个 agent 所属会话当前的工作目录（交付物投递、`/get` 相对路径的基准） */
  directoryForAgent(agent: DshAgent): string | undefined {
    const record = this.findByAgent(agent);
    if (!record) return undefined;
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
  async listWorkspaceSessions(_scope: ChatScope, _peerId: string): Promise<WorkspaceSession[]> {
    const key = this.sessionKey();
    // 落点本身就是工作区目录；旧数据里的树路径在写入时已归一，这里不再算
    const workspace = this.chatDirectory();
    const currentId = this.currentSessionId(key);
    const archived = this.host.archivedSessionIds();

    const visible = (await this.host.listSessions())
      .filter((session) => session.origin !== 'subagent')
      .filter((session) => session.cwd !== undefined && samePath(this.workspaceDirOf(session.cwd), workspace))
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
   * 顺序是「最近人类消息时间倒序 → 同时间按 id 升序」，与 `/sessions all`、
   * Web 侧栏同一口径；活记录与冷行混排，时间未知（0）的沉底。宿主列表暂时
   * 没有返回的持有会话也保留（目录取 agent 的，时间留空），避免刚切过去就
   * 从列表消失。冷行是重启前获取过、这次还没打开的会话：标题 / 时间 / 目录都
   * 取宿主快照，状态按空闲列出。标题读取失败不影响列表本身，取不到就显示
   * 「未命名会话」。
   *
   * @param scope 当前 chat 作用域（用于标记 current）
   * @param peerId 当前 chat 的 peer id
   */
  async listHeldSessions(_scope: ChatScope, _peerId: string): Promise<WorkspaceSession[]> {
    const key = this.sessionKey();
    const currentId = this.currentSessionId(key);
    const archived = this.host.archivedSessionIds();
    // 行顺序在最后统一按 updatedAt 排；这里只决定冷行过滤与取标题的先后
    const ordered = [...this.records.values()]
      .filter((record) => !archived.has(record.sessionId));

    // 重启后已获取集合是空的：名册里剩下的会话当冷行列出，用户能看到、能 resume。
    // 盘上已经明确不存在的摘掉；读不出来就留着——一次读失败不能当「会话没了」。
    const roster = this.modelResolver.getHeldSessionIds(key);
    const known = new Set(ordered.map((record) => record.sessionId));
    const coldIds = roster.filter((id) => !known.has(id));
    const gone = new Set<string>();
    await Promise.all(coldIds.map(async (id) => {
      try {
        if ((await this.host.sessionExists(id)) === false) gone.add(id);
      } catch {
        // 宿主临时读不到：保留这一行，下次列表再问
      }
    }));
    const cold = coldIds.filter((id) => !gone.has(id) && !archived.has(id));
    if (cold.length !== coldIds.length) {
      this.modelResolver.setHeldSessionIds(key, [...known, ...cold]);
    }
    if (ordered.length === 0 && cold.length === 0) return [];

    const hostSessions = await this.host.listSessions().catch(() => []);
    const byId = new Map(hostSessions.map((session) => [session.id, session]));

    // 子代理会话：宿主只把子会话的 parentSession 指向父会话。运行中的子会话
    // （origin 为 subagent 且 live）挂到父条目下，隔代（子代理再起子代理）也收；
    // 兄弟按活跃时间倒序，保证刚更新过的子会话排在前面。
    const subagentsByParent = new Map<string, HostSessionInfo[]>();
    for (const info of hostSessions) {
      if (info.origin !== 'subagent' || !info.live) continue;
      const parent = info.parentSession;
      if (parent === undefined) continue;
      const siblings = subagentsByParent.get(parent);
      if (siblings === undefined) subagentsByParent.set(parent, [info]);
      else siblings.push(info);
    }
    for (const siblings of subagentsByParent.values()) {
      siblings.sort((left, right) => right.updatedAt - left.updatedAt);
    }
    const descendantsOf = (rootId: string): HostSessionInfo[] => {
      const collected: HostSessionInfo[] = [];
      const visited = new Set<string>([rootId]);
      const walk = (parentId: string): void => {
        for (const child of subagentsByParent.get(parentId) ?? []) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          collected.push(child);
          walk(child.id);
        }
      };
      walk(rootId);
      return collected;
    };
    const childrenById = new Map(
      ordered.map((record) => [record.sessionId, descendantsOf(record.sessionId)]),
    );

    // 标题读取有上限：先给持有会话与冷行，再用剩余名额补子会话
    const titleIds = [...ordered.map((record) => record.sessionId), ...cold]
      .slice(0, TITLE_FETCH_LIMIT_HELD);
    for (const record of ordered) {
      for (const child of childrenById.get(record.sessionId) ?? []) {
        if (titleIds.length >= TITLE_FETCH_LIMIT_HELD) break;
        if (!titleIds.includes(child.id)) titleIds.push(child.id);
      }
    }
    const titles = await this.host
      .sessionTitles(titleIds)
      .catch(() => new Map<string, string>());
    const workspaces = this.host.workspaceList();

    const rows: WorkspaceSession[] = ordered.map((record) => {
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
        // 宿主列表暂时没返回这条：时间未知按 0 处理（沉底、不显示时间），
        // 不拿本地加入时间顶替——那不是会话的活动时间
        createdAt: info?.createdAt ?? 0,
        updatedAt: info?.updatedAt ?? info?.createdAt ?? 0,
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

    // 冷行：held / live / running 全 false，状态层按空闲展示，标题与时间取宿主快照
    for (const id of cold) {
      const info = byId.get(id);
      const directory = info?.cwd;
      const workspace = directory === undefined
        ? undefined
        : workspaces.find((item) => samePath(item.path, directory));
      const workspacePath = workspace?.path ?? directory;
      const workspaceTitle = workspace?.title
        ?? (this.host.supportsWorkspaceRegistry() && directory !== undefined ? basename(directory) : undefined);
      rows.push({
        id,
        ...(titles.has(id) ? { title: titles.get(id) } : {}),
        createdAt: info?.createdAt ?? 0,
        updatedAt: info?.updatedAt ?? info?.createdAt ?? 0,
        current: id === currentId,
        live: false,
        held: false,
        running: false,
        isSeeded: info?.isSeeded ?? false,
        archived: false,
        ...(workspaceTitle !== undefined ? { workspace: workspaceTitle } : {}),
        ...(workspacePath !== undefined
          ? { workspacePath, workspaceMissing: !isDirectory(workspacePath) }
          : {}),
      });
    }

    // 与 `/sessions all`、Web 侧栏一致：最近人类消息时间倒序，同时间按 id 升序。
    // 当前项不置顶——列表按活跃度说话，当前行只靠 ✅ 标记；活记录与冷行混排，
    // 时间未知（0）的沉底
    return rows.sort((left, right) =>
      (right.updatedAt - left.updatedAt)
      || (left.id < right.id ? -1 : 1));
  }

  /**
   * 这个聊天当前的工作目录（`/get`、`/ls` 的相对路径基准）。
   *
   * 取会话的 live 目录：工作树里的会话就是树路径，运行期 cd 也跟着变。
   * `/status` 要的是工作区，见 {@link chatWorkspaceInfo}。
   */
  async currentWorkspaceInfo(
    _scope: ChatScope,
    _peerId: string,
  ): Promise<{ title: string; path: string; missing: boolean } | undefined> {
    // 运行目录偏离会话自己的工作区（cd、或会话落在树里）时按运行目录算，树里的
    // `/get a.txt` 才不会指到主仓库去；没偏离就以落点为准——`/new --dir <工作区>` 之后、
    // 下一条消息之前，基准已经是新工作区
    const record = this.currentRecord();
    const live = record === undefined ? undefined : this.host.sessionDirectory(record.agent.session);
    const workspace = record === undefined ? undefined : this.headerCwd(record.agent);
    const directory = live !== undefined && (workspace === undefined || !samePath(live, workspace))
      ? live
      : this.chatDirectory();
    return this.workspaceInfoOf(directory);
  }

  /**
   * 这个聊天当前的工作区（`/status` 的工作区行）。
   *
   * 工作区是会话创建时的目录（header.cwd）：工作树里的会话活在树里，工作区仍是
   * 主仓库，与 `/sessions` 的分组同一来源。没有会话时就是聊天工作目录，也就是
   * 下一条消息建会话的地方。
   *
   * `branch` 是「这个工作区目录」的当前分支，不是会话运行目录的：树会话的分支由
   * `/status` 的工作树行给。非 Git 仓库、detached HEAD 或读不到时省略。
   */
  async chatWorkspaceInfo(
    _scope: ChatScope,
    _peerId: string,
  ): Promise<{ title: string; path: string; missing: boolean; branch?: string } | undefined> {
    const record = this.currentRecord();
    const directory =
      record === undefined
        ? this.chatDirectory()
        : this.workspaceDirOf(this.headerCwd(record.agent) ?? this.chatDirectory());
    const info = this.workspaceInfoOf(directory);
    // 目录已不存在时不再白跑一次 git：headOf 只会失败
    const branch = info.missing ? undefined : (await this.host.headOf(info.path))?.branch;
    return branch === undefined ? info : { ...info, branch };
  }

  /** 目录对应的工作区：有 registry 用它的标题，没有就只给路径（不拿末段目录名冒充） */
  private workspaceInfoOf(directory: string): { title: string; path: string; missing: boolean } {
    const info = this.host.workspaceList().find((item) => samePath(item.path, directory));
    if (info) return { title: info.title, path: info.path, missing: !isDirectory(info.path) };
    const title = this.host.supportsWorkspaceRegistry() ? basename(directory) : '';
    return { title, path: directory, missing: !isDirectory(directory) };
  }

  /**
   * 部署里是否有 workspaceRegistry（决定工作区名、置顶 / 归档）。
   *
   * 没有这个服务时列表仍按目录路径分组，但组标题只有路径；归档子命令按未知
   * 子命令处理，也不能按名字新建会话。
   */
  workspaceRegistryAvailable(): boolean {
    return this.host.supportsWorkspaceRegistry();
  }

  /** 宿主工作区清单（`/new --dir <工作区>` 匹配用） */
  listWorkspaceInfos(): WorkspaceInfo[] {
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
   * 只做解析与目录校验，不看会话状态、不写任何记录。`/new --dir <工作区>` 要先用它
   * 验一遍：路径写错不该把当前会话弄丢。
   *
   * @param arg 工作区标题 / 目录名 / 绝对路径
   */
  resolveWorkspace(arg: string): ChangeWorkspaceOutcome {
    const target = arg.trim();
    if (target === '') return { ok: false, reason: 'not-found', arg: target };

    let path: string;
    let title: string;
    let isNew = false;

    if (isAbsolute(target)) {
      // 工作树路径不是工作区：会话总从主仓库开新树，报给用户的也按主仓库算
      path = this.workspaceDirOf(resolve(target));
      const known = this.listWorkspaceInfos().find((item) => samePath(item.path, path));
      title = known?.title ?? basename(path);
      isNew = known === undefined;
    } else if (!this.host.supportsWorkspaceRegistry()) {
      // 没有 registry 就没有工作区名可匹配：只认绝对路径
      return { ok: false, reason: 'unavailable', arg: target };
    } else {
      const picked = matchWorkspace(this.listWorkspaceInfos(), target);
      if ('error' in picked) return picked.error;
      path = picked.workspace.path;
      title = picked.workspace.title;
    }

    if (!isDirectory(path)) return { ok: false, reason: 'missing', path };
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
  async changeChatWorkspace(
    _scope: ChatScope,
    _peerId: string,
    arg: string,
  ): Promise<ChangeWorkspaceOutcome> {
    const resolved = this.resolveWorkspace(arg);
    if (!resolved.ok) return resolved;

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
  async listWorkspaceGroups(_scope: ChatScope, _peerId: string): Promise<WorkspaceGroup[]> {
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
    const asEntry = (session: HostSessionInfo, workspace: string): WorkspaceSession => {
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
      const groups: WorkspaceGroup[] = [];
      const byPath = new Map<string, WorkspaceGroup>();
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
    const orderOf = (id: string): number => {
      const pinnedAt = pinOrder.indexOf(id);
      return pinnedAt === -1 ? Number.MAX_SAFE_INTEGER : pinnedAt;
    };

    const groups: WorkspaceGroup[] = [];
    const consumed = new Set<string>();

    for (const workspace of this.host.workspaceList()) {
      // 与 Web 一致：只认 registry 记账，不再按 cwd 兜底归组
      const merged = workspace.sessionIds
        .filter((id) => !consumed.has(id))
        .map((id) => byId.get(id))
        .filter((session): session is HostSessionInfo => session !== undefined);
      for (const session of merged) consumed.add(session.id);

      merged.sort((left, right) => {
        const pin = orderOf(left.id) - orderOf(right.id);
        if (pin !== 0) return pin;
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
  async fillSessionTitles(entries: readonly WorkspaceSession[]): Promise<void> {
    const missing = entries.filter((entry) => entry.title === undefined);
    if (missing.length === 0) return;
    const titles = await this.host.sessionTitles(missing.map((entry) => entry.id));
    for (const entry of missing) {
      const title = titles.get(entry.id);
      if (title !== undefined) entry.title = title;
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
  async restoreCurrentSession(): Promise<RestoreOutcome> {
    const key = this.sessionKey();
    const sessionId = this.modelResolver.getSessionId(key);
    if (sessionId === undefined) return { kind: 'none' };

    // 盘上已经没有了就别试：resume 失败后宿主也不会允许重建，白跑一趟。
    // 指针一并清掉：留着会让 `/sessions` 把死会话当冷行列出来，
    // 点「恢复当前」又只会报没有匹配的会话。目录保留，下一条消息仍落在上次工作区。
    if ((await this.host.sessionExists(sessionId).catch(() => undefined)) === false) {
      this.modelResolver.clearSessionId(key);
      this.logger.info(`启动恢复跳过：会话已不存在，已清除指针 sessionId=${sessionId}`);
      return { kind: 'none' };
    }

    // 重启后没有入站消息可回，只能用上次交互记下的 openid 做回复目标
    const targetId = this.modelResolver.getTarget(key) ?? '';
    const target: ReplyTarget = { scope: 'c2c', targetId };
    try {
      await this.getOrCreate('c2c', targetId, targetId, target);
    } catch (err) {
      const message = errorText(err);
      const locked = (err as { name?: string } | null)?.name === 'SessionAlreadyOwnedError'
        || /already ?owned|ownership|write handle/i.test(message);
      this.logger.warn(`启动恢复会话失败: sessionId=${sessionId} err=${message}`);
      if (targetId === '') return { kind: 'none' };
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
   * `openOnly` 只把人接进已获取集合，指针留在原处（`/to` 用）。
   *
   * 目标若已归档，先取消归档再恢复：归档的会话会被宿主的 `agent/pre-step`
   * 闸门拒绝，「恢复」本来就意味着让它重新可用。
   *
   * @param scope 当前 chat 作用域
   * @param peerId 当前 chat 的 peer id
   * @param sessionId 目标会话 id
   * @param senderId 当前发送者（记录进会话记录）
   * @param replyTarget 回复目标（后续出站用）
   * @param options.openOnly 只接进已获取集合、不切指针（`/to` 用）
   */
  async switchSession(
    scope: ChatScope,
    peerId: string,
    sessionId: string,
    senderId: string,
    replyTarget: ReplyTarget,
    options: { openOnly?: boolean } = {},
  ): Promise<SwitchSessionOutcome> {
    const key = this.sessionKey();
    const openOnly = options.openOnly === true;

    // 归档即不可用：恢复前先取消归档，失败则如实报错（此时还没动映射）。
    // `/to` 不替人改归档状态，已归档就拒发，由人决定要不要接回来。
    const unarchived = this.host.archivedSessionIds().has(sessionId);
    if (unarchived && openOnly) return { ok: false, reason: 'archived' };
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
      if (!openOnly) {
        this.setCurrent(key, sessionId);
        this.setChatDir(this.headerCwd(existing.agent) ?? this.host.sessionDirectory(existing.agent.session) ?? this.chatDir);
      }
      this.logger.info(`session switched (already acquired): key=${key} sessionId=${sessionId}`);
      return wasCurrent
        ? (unarchived ? { ok: true, reason: 'same', unarchived: true } : { ok: true, reason: 'same' })
        : (unarchived ? { ok: true, unarchived: true } : { ok: true });
    }

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      agentPreset = await this.resolvePersistedPreset(sessionId);
    } else {
      // 存在性求证：live agent 已经在上面接住了，走到这里只能从盘上恢复。
      // undefined = 宿主没有 stat 能力，按存在处理（交给 resume 判定）
      const exists = await this.host.sessionExists(sessionId);
      if (exists === false) return { ok: false, reason: 'not-found' };
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
        } catch (err) {
          await handle.dispose().catch(() => {});
          return { ok: false, reason: 'failed', message: errorText(err) };
        }
      } catch (err) {
        const raw = errorText(err);
        const locked = (err as { name?: string } | null)?.name === 'SessionAlreadyOwnedError'
          || /already ?owned|ownership|write handle/i.test(raw);
        this.logger.warn(`session switch failed: key=${key} target=${sessionId} err=${raw}`);
        return locked
          ? { ok: false, reason: 'locked' }
          : { ok: false, reason: 'failed', message: raw };
      }
    }

    const directory = this.host.sessionDirectory(agent.session) ?? this.chatDirectory();
    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      ...(handle ? { handle } : {}),
      replyTarget,
      scope,
      peerId,
      senderId,
      ...(agentPreset ? { agentPreset } : {}),
    };
    this.records.set(sessionId, record);
    this.rememberHeld(sessionId);
    if (!openOnly) {
      this.setCurrent(key, sessionId);
      this.setChatDir(this.headerCwd(agent) ?? directory);
    }
    // 挂工作区用 header.cwd（工作树会话即主仓库根），传运行期目录（树路径）会凭空长出一个以树名命名的工作区
    const attachCwd = this.headerCwd(agent) ?? directory;
    if (attachCwd) void this.host.attachSessionToWorkspace(sessionId, attachCwd);

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
  async archiveSession(sessionId: string): Promise<ArchiveSessionOutcome> {
    // 1) 释放本进程内指向它的 agent（正在生成的先 cancel；借来的只能 cancel）
    const record = this.records.get(sessionId);
    if (record) await this.dropRecord(record, { cancel: true, dispose: true });

    const alreadyArchived = this.host.archivedSessionIds().has(sessionId);

    // 2) 写宿主的归档集
    const outcome = await this.host.archiveSession(sessionId);
    if (!outcome.ok) {
      this.logger.warn(`session archive failed: id=${sessionId} reason=${outcome.reason ?? 'unknown'} ${outcome.message ?? ''}`);
      return outcome;
    }

    // 没有活记录（重启后只在名册里的冷会话）：归档成功即从名册摘掉
    if (!record) this.modelResolver.forgetHeldSession(this.sessionKey(), sessionId);

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
  async unarchiveSession(sessionId: string): Promise<ArchiveSessionOutcome> {
    const outcome = await this.host.unarchiveSession(sessionId);
    if (outcome.ok) this.logger.info(`session unarchived: id=${sessionId}`);
    else this.logger.warn(`session unarchive failed: id=${sessionId} reason=${outcome.reason ?? 'unknown'} ${outcome.message ?? ''}`);
    return outcome;
  }

  /** 记下这次获取（重启后列表靠名册；写盘失败只影响列表，不打断消息路径） */
  private rememberHeld(sessionId: string): void {
    this.modelResolver.rememberHeldSession(this.sessionKey(), sessionId);
  }

  /**
   * 摘掉一条已获取记录。
   *
   * dispose 只对 create/resume 拿到的 handle 可用；`agents.get()` 借来的 agent
   * 只能 cancel，不能替宿主 dispose。
   */
  private async dropRecord(
    record: SessionRecord,
    options: { cancel?: boolean; dispose?: boolean } = {},
  ): Promise<void> {
    if (this.records.get(record.sessionId) === record) this.records.delete(record.sessionId);
    this.modelResolver.forgetHeldSession(record.sessionKey, record.sessionId);
    if (options.cancel) record.agent.cancel({ kind: 'user' });
    this.cancelPendingFor(record.sessionId);
    if (options.dispose && record.handle) {
      await record.handle.dispose().catch(() => {});
    }
  }

  /** 释放会话时统一清理其待答问题/待批审批/待确认重发，避免 pending 悬挂泄漏 */
  private cancelPendingFor(sessionId: string): void {
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
  private handoffPendingFor(sessionId: string): void {
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
  public releaseAll(reason: string): void {
    const records = [...this.records.values()];
    this.records.clear();
    const keys = [...this.currentByKey.keys()];
    for (const key of keys) this.clearCurrent(key);
    this.sessionConfirmChannel?.cancelPending();
    for (const record of records) this.handoffPendingFor(record.sessionId);
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
  async runHostCommand(
    agent: DshAgent,
    name: string,
    args: readonly string[] = [],
  ): Promise<HostCommandRun> {
    const commands = this.commands;
    if (commands.find(agent, name) === undefined) return { kind: 'unsupported' };
    const line = args.length === 0 ? `/${name}` : `/${name} ${args.join(' ')}`;

    try {
      const executed = await commands.execute(agent, line, [], new AbortController().signal);
      if (executed === undefined) return { kind: 'unsupported' };
      const { kind, text } = executed.result;
      return text === undefined ? { kind } : { kind, text };
    } catch (err) {
      const message = errorMessage(err);
      this.logger.warn(`host command failed: name=${name} err=${message}`);
      return { kind: 'threw', message };
    }
  }

  /**
   * 插件卸载：有 handle 的 cancel + dispose；`agents.get()` 借来的只清引用，
   * 不替宿主决定生命周期。
   */
  async disposeAll(): Promise<void> {
    const records = [...this.records.values()];
    this.records.clear();
    this.currentByKey.clear();
    this.sessionConfirmChannel?.cancelPending();

    const owned: SessionRecord[] = [];
    for (const record of records) {
      if (record.handle) {
        // 自己创建的会话：卸载即结束，给挂起的提问 / 审批一个确定终态
        this.cancelPendingFor(record.sessionId);
        record.agent.cancel({ kind: 'user' });
        owned.push(record);
      } else {
        // 借来的会话：宿主还要继续用，只摘引用，阻塞式请求交回宿主
        this.handoffPendingFor(record.sessionId);
      }
    }
    await Promise.allSettled(owned.map((record) => record.handle!.dispose()));
    this.logger.info(`all acquired sessions released (count=${records.length}, owned=${owned.length})`);
  }

  get size(): number {
    return this.records.size;
  }
}

/** 错误文案（日志用） */
function errorText(err: unknown): string {
  return errorMessage(err);
}

/**
 * 两个路径是否指向同一目录。
 *
 * 会话 header 里的 cwd 由宿主原样保存（可能带尾分隔符、大小写与配置不同），
 * 直接字符串比较会把本工作区的会话漏掉；Windows 上大小写不敏感。
 * 空路径一律视为不匹配（`resolve('')` 会落到进程 cwd，误判成同一个目录）。
 */
function samePath(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const left = resolve(a).replace(/[\\/]+$/, '');
  const right = resolve(b).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** 目录当前是否存在且真的是目录（工作区「missing-dir」提示用） */
function isDirectory(path: string): boolean {
  if (path === '') return false;
  try {
    return statSync(path).isDirectory();
  } catch {
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
function matchWorkspace(
  workspaces: readonly WorkspaceInfo[],
  raw: string,
): { workspace: WorkspaceInfo } | { error: ChangeWorkspaceOutcome } {
  const needle = raw.toLowerCase();
  const namesOf = (item: WorkspaceInfo): string[] => [
    item.title.toLowerCase(),
    basename(item.path).toLowerCase(),
  ];

  const exact = workspaces.filter((item) => namesOf(item).includes(needle));
  const candidates = exact.length > 0
    ? exact
    : workspaces.filter((item) => namesOf(item).some((name) => name.startsWith(needle)));

  const [only] = candidates;
  if (candidates.length === 1 && only) return { workspace: only };
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
function extractMessageText(
  message: SessionEventLike['message'],
): string {
  const blocks = message?.content;
  if (!blocks || !Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
