/**
 * ApprovalChannel — 把 dsh 的审批 seam（`approval/request` waterfall）桥接到 QQ。
 *
 * 接入方式：监听 `approval/request` waterfall，按 `request.agent.id` 路由到 QQ
 * 会话；非 QQ 会话委托链上其他 answerer（`next()`），多通道（Web/TUI）共存。
 *
 * 每个会话同一时间最多一个 pending 审批（审批是阻塞式的）；outcome 是 dsh
 * 协议的闭合集合，无 allow-always，只提供「允许一次 / 拒绝」两个按钮。
 */
import type { EventOptions } from '@deepseek-ai/cordis';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { randomUUID } from 'node:crypto';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { decodeButtonData } from './button-utils.ts';
import { buildApprovalKeyboard, buildApprovalText } from './approval-renderer.ts';

// ── 最小契约（对齐 dsh-user-approval，避免硬依赖） ──

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** session log 中 tool/call 事件的最小结构（commandOf 回显命令用） */
interface ApprovalSessionEvent {
  type: string;
  data?: { callId?: unknown; arguments?: unknown; [key: string]: unknown };
}

export interface ApprovalRequest {
  agent: {
    id: string;
    /**
     * dsh-agent 的 `Agent.session` 在类型上是必选，但审批请求可能来自跨进程或
     * 投影后的上下文，运行时拿不到 live session（类型契约与运行时的 gap）。此时
     * 只是无法回显命令原文，不应让整个审批失败，故这里标为可选。
     */
    session?: { snapshotEvents?(): readonly ApprovalSessionEvent[] };
  };
  toolName: string;
  /** 关联的 tool/call 事件 id，用于从 session log 找回被 gate 的命令 */
  callId?: string;
  /** asker 的人类可读解释 */
  reason?: string;
  signal?: AbortSignal;
}

// ── 依赖接口（结构化，便于单测） ──

export interface ApprovalSessionRecordLike {
  /** 宿主会话 id，按钮 data 与 pending 的键 */
  sessionId: string;
  /** 该会话属于哪个 QQ 用户（按钮点击者校验用） */
  peerId?: string;
  scope: ChatScope;
  replyTarget: ReplyTarget;
}

export interface ApprovalChannelManagerLike {
  findBySessionId(sessionId: string): ApprovalSessionRecordLike | undefined;
  getSessionRecord(scope: ChatScope, peerId: string): ApprovalSessionRecordLike | undefined;
  /** 目标是不是当前聊天接的会话；缺省按 true（非多会话部署） */
  isCurrentSession?(sessionId: string): boolean;
  /** 会话标题（非当前会话的来源行用）；缺省时来源行只有 id */
  sessionTitle?(sessionId: string): string | undefined;
}

export interface ApprovalChannelSenderLike {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: unknown }): Promise<unknown>;
}

/** 配置投影（审批按钮校验唯一绑定用户用） */
export interface ApprovalChannelConfigLike {
  access: {
    owner: string;
  };
}

/** approval/request waterfall 的 answerer handler */
export interface ApprovalChannelContext {
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    options?: EventOptions,
  ): () => boolean;
}

// ── 每会话 pending 状态 ──

interface PendingApproval {
  record: ApprovalSessionRecordLike;
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  /** 本审批的唯一标识，编码进按钮 data，点击时必须匹配（防旧卡片混淆） */
  nonce: string;
  onAbort?: () => void;
  /** 交回宿主 answerer（渠道释放时用） */
  handoff?: () => Promise<ApprovalOutcome>;
}

const COMMAND_CLIP = 500;

/**
 * 从 session log 按 callId 找回被 gate 的命令（审批请求本身不重复携带 arguments）。
 * 对齐 TUI/web 的 `commandOf` 语义。
 */
function commandOf(req: ApprovalRequest): string | undefined {
  if (req.callId === undefined) return undefined;
  // 审批请求可能来自没有 live session 的上下文（例如跨进程/投影后的 Agent），
  // 此时只是拿不到命令原文，不能因此让整个审批失败。
  const events = req.agent.session?.snapshotEvents?.();
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== 'tool/call') continue;
    const data = event.data;
    if (String(data?.callId) !== String(req.callId)) continue;
    const raw = data?.arguments;
    if (typeof raw !== 'string') return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
        const command = (parsed as { command?: unknown }).command;
        if (typeof command === 'string') return command;
      }
    } catch {
      // 非 JSON，回退到原始字符串
    }
    return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`;
  }
  return undefined;
}

export class ApprovalChannel {
  private readonly pending = new Map<string, PendingApproval>();
  /** 正在投递卡片（entry 还没建）的会话：渠道在这期间被释放要记下来 */
  private readonly inFlight = new Set<string>();
  /** 投递期间收到释放请求的会话：发完立刻交回宿主 */
  private readonly handoffRequested = new Set<string>();
  private readonly manager: ApprovalChannelManagerLike;
  private readonly sender: ApprovalChannelSenderLike;
  private readonly logger: Logger;
  private readonly config: ApprovalChannelConfigLike;

  public constructor(
    manager: ApprovalChannelManagerLike,
    sender: ApprovalChannelSenderLike,
    config: ApprovalChannelConfigLike,
    logger: Logger,
  ) {
    this.manager = manager;
    this.sender = sender;
    this.config = config;
    this.logger = logger;
  }

  /**
   * 注册 approval/request waterfall answerer。
   *
   * 不再探测 approval 服务是否已挂载：它是 optional peer，挂载时机可能晚于
   * 本插件的 apply，一次性探测失败会让通道永久失效。监听事件本身不依赖服务
   * 存在——服务就绪后请求自然经过同一条瀑布，未挂载时不会有请求到达。
   *
   * `global` 是必需的：approval/request 按 agent 作用域派发，根作用域注册的
   * 监听器不带 global 会被作用域过滤掉。
   */
  public install(ctx: ApprovalChannelContext): void {
    const self = this;
    ctx.on('approval/request', (req: unknown, next: unknown) => {
      const request = req as ApprovalRequest;
      const nextFn = next as () => Promise<ApprovalOutcome>;
      const record = self.manager.findBySessionId(request.agent.id);
      if (record) return self.park(record, request, nextFn);
      return nextFn();
    }, { global: true, prepend: true });
    this.logger.info('qqterm: QQ approval channel installed');
  }

  /** 会话回收时清理其 pending 审批，避免 Promise 悬挂 */
  public cancelPending(sessionId: string): void {
    this.handoffRequested.delete(sessionId);
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    this.pending.delete(sessionId);
    this.removeAbort(entry);
    entry.resolve('cancelled');
  }

  /**
   * 渠道释放时把待批审批交回宿主：删掉本地状态，再走 nextFn。
   *
   * 不 await 调用方（Web 端可能很久才决策）；no answerer 时按「未决策」结束。
   */
  public async handoffPending(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId);
    if (entry === undefined) {
      if (this.inFlight.has(sessionId)) this.handoffRequested.add(sessionId);
      return;
    }
    this.pending.delete(sessionId);
    this.removeAbort(entry);
    if (entry.handoff === undefined) {
      entry.resolve('cancelled');
      return;
    }
    try {
      entry.resolve(await entry.handoff());
    } catch (err) {
      this.logger.error(`qqterm: no answerer accepted the approval after release: ${err instanceof Error ? err.message : String(err)}`);
      entry.resolve('cancelled');
    }
  }

  /** 按钮点击决策：按 button_data 的 `s` 找会话，校验点击者后 settle pending 审批 */
  public handleInteraction(event: InteractionEvent): boolean {
    const peerId = event.user_openid;
    if (!peerId) return false;

    const data = event.data?.resolved?.button_data;
    if (!data) return false;
    const button = decodeButtonData(data);
    if (!button || button.t !== 'approval') return false;

    const sessionId = button.s;
    if (!sessionId) return false;
    const entry = this.pending.get(sessionId);
    if (!entry) return false;

    // 按钮属于哪个会话，就只能由那个会话的 QQ 用户点
    if (entry.record.peerId !== undefined && entry.record.peerId !== peerId) return false;

    // nonce 必须匹配 pending：旧卡片/其它会话的卡片点击不 settle（#94-3）
    if (button.n !== entry.nonce) {
      this.logger.warn(`qqterm: approval button nonce mismatch: sessionId=${entry.record.sessionId}`);
      return false;
    }

    // 审批只认唯一绑定用户；点击者身份缺失同样拒绝（fail-closed）
    const clicker = event.user_openid;
    const owner = this.config.access.owner.trim();
    if (owner === '' || clicker !== owner) {
      this.logger.warn(`qqterm: approval button rejected (clicker not owner): user=${clicker ?? '(missing)'} sessionId=${entry.record.sessionId}`);
      return false;
    }

    this.pending.delete(entry.record.sessionId);
    this.removeAbort(entry);
    entry.resolve(button.d === 'allow' ? 'allowed-once' : 'rejected');
    return true;
  }

  /** 走 QQ 通道：发审批消息 + 挂起 Promise，等待用户决策 */
  private async park(
    record: ApprovalSessionRecordLike,
    request: ApprovalRequest,
    delegate: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const sessionId = record.sessionId;
    // 会话回收/取消可能在发送前发生：signal 已 abort 则直接失败
    if (request.signal?.aborted) return 'cancelled';

    this.inFlight.add(sessionId);
    const command = commandOf(request);
    const nonce = randomUUID().slice(0, 8);
    const isCurrent = this.manager.isCurrentSession?.(sessionId) ?? true;
    const title = this.manager.sessionTitle?.(sessionId);
    try {
      await this.sender.sendMarkdown(
        record.replyTarget,
        buildApprovalText(request, command, { sessionId, isCurrent, title }),
        { keyboard: buildApprovalKeyboard(nonce, sessionId) },
      );
    } catch (err) {
      this.inFlight.delete(sessionId);
      // 投递失败本身就会走宿主兜底，释放标记不再需要
      this.handoffRequested.delete(sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`qqterm: approval send failed sessionId=${sessionId}: ${msg}`);
      // 卡片没送到 QQ 时不能把请求吞掉：交回链上其他通道（Web GUI 仍可弹窗）。
      this.logger.warn('qqterm: QQ approval delivery failed, falling back to the host answerer');
      try {
        return await delegate();
      } catch (nextErr) {
        // 链上也没有 answerer 了：两条通道都投不出去，按「未决策」结束（fail-closed），
        // 不让 rejection 冒成宿主的未捕获错误。
        const nextMsg = nextErr instanceof Error ? nextErr.message : String(nextErr);
        this.logger.error(`qqterm: no answerer accepted the approval: ${nextMsg}`);
        return 'cancelled';
      }
    }

    this.inFlight.delete(sessionId);
    // 发卡期间渠道被释放：卡片已经没人能点了，直接交回宿主
    if (this.handoffRequested.delete(sessionId)) return this.delegateToHost(delegate);

    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingApproval = { record, request, resolve, nonce, handoff: delegate };
      if (request.signal) {
        const onAbort = (): void => {
          if (this.pending.get(sessionId) !== entry) return;
          this.pending.delete(sessionId);
          resolve('cancelled');
        };
        entry.onAbort = onAbort;
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(sessionId, entry);
      this.logger.info(`qqterm: approval sent to QQ, waiting for decision sessionId=${sessionId}`);
    });
  }

  /** 交回宿主 answerer；链上没有 answerer 时按「未决策」结束（fail-closed） */
  private async delegateToHost(delegate: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    try {
      return await delegate();
    } catch (err) {
      this.logger.error(`qqterm: no answerer accepted the approval: ${err instanceof Error ? err.message : String(err)}`);
      return 'cancelled';
    }
  }

  private removeAbort(entry: PendingApproval): void {
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort);
    }
  }
}
