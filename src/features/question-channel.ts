/**
 * QuestionChannel — 把 dsh 的 ask_user_question 桥接到 QQ 通道。
 *
 * 接入方式：监听 `user-questions/request` waterfall（与 approval 通道同一套
 * 官方 seam），按 `request.agent.id` 路由到 QQ 会话；非 QQ 会话 `next()` 交给
 * 链上其它 answerer（如 Web 弹出框），多通道共存。
 *
 * 早期实现包装 `userQuestions.ask`：插件 apply 时取一次服务实例，取不到
 * （服务尚未激活 / 挂载晚于本插件）就静默放弃且永不重试——通道时灵时不灵，
 * 提问会直接落到 Web 端。waterfall 不依赖服务是否就绪，服务上线后请求自然
 * 经过同一条链；`ask` / `askTimed` 两条路径也都会走到这里。
 *
 * 每会话一个显式状态机，三态语义：
 *   - 待答（pending 中）：等待当前题的回答
 *   - 逐题推进：多问题时一次问一题，答完一题再问下一题
 *   - 完成 / 中断（abort / 超时 / 会话回收）：reject(ASK_ABORTED)
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { shortSessionId } from '../shared/utils.ts';
import { sessionSourceHeader, sourceTitle } from '../transport/session-source.ts';
import { parseAnswer } from './answer-parser.ts';
import { buildKeyboard, formatQuestion } from './question-renderer.ts';
import { decodeButtonData } from './button-utils.ts';

// ── 最小契约（对齐 dsh-user-questions，避免硬依赖） ──

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
}

export interface UserQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface UserQuestionRequest {
  questions: UserQuestion[];
  agent?: { id?: string };
  signal?: AbortSignal;
}

export interface UserQuestionResult {
  answers: UserQuestionAnswer[];
}

/** 依赖接口：`user-questions/request` waterfall 的注册上下文（对齐 cordis EventOptions） */
export interface QuestionChannelContext {
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    options?: { global?: boolean; prepend?: boolean },
  ): () => boolean;
}

// ── 依赖接口（结构化，便于单测） ──

export interface QuestionSessionRecordLike {
  sessionKey: string;
  /** 宿主的 session id；缺省时退回 sessionKey（单测/旧记录兼容） */
  sessionId?: string;
  /** 该会话属于哪个 QQ 用户（按钮点击者校验用） */
  peerId?: string;
  scope: ChatScope;
  replyTarget: ReplyTarget;
}

export interface QuestionChannelManagerLike {
  findBySessionId(sessionId: string): QuestionSessionRecordLike | undefined;
  getSessionRecord(scope: ChatScope, peerId: string): QuestionSessionRecordLike | undefined;
  /** 目标是不是当前聊天接的会话；缺省按 true（非多会话部署） */
  isCurrentSession?(sessionId: string): boolean;
  /** 会话标题（非当前会话的来源行用）；缺省时来源行只有 id */
  sessionTitle?(sessionId: string): string | undefined;
}

export interface QuestionChannelSenderLike {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
}

export interface QuestionChannelConfigLike {
  askTimeoutMs: number;
  /** 唯一绑定用户；空 = 拒绝所有按钮点击 */
  access: {
    owner: string;
  };
}

// ── 错误语义（对齐 dsh-user-questions 的 UserQuestionError code 约定） ──

/** 问答中断错误码：上层（如 plan-mode）按 code 区分「用户未作答」与普通发送/网络错误 */
const ASK_ABORTED = 'ASK_ABORTED';

class QuestionChannelError extends Error {
  public readonly code: string;

  public constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'QuestionChannelError';
  }
}

/** 记录所属的会话 id（优先宿主 sessionId，旧记录退回 chatKey） */
function sessionIdOf(record: QuestionSessionRecordLike): string {
  return record.sessionId ?? record.sessionKey;
}

/**
 * QQ 投递失败（发送接口报错）。
 *
 * 与「用户没答/超时」区分：只有投递失败才允许退回 `next()` 交给 Web 端，
 * 已送达的问题再退回会导致同一个问题在两个通道各弹一次。
 */
class QuestionDeliveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'QuestionDeliveryError';
  }
}

// ── 每会话状态机 ──

interface PendingEntry {
  record: QuestionSessionRecordLike;
  request: UserQuestionRequest;
  resolve: (result: UserQuestionResult) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  /** 当前正在问的问题在 request.questions 的下标 */
  index: number;
  /** 已收集的答案 */
  collected: UserQuestionAnswer[];
}

export class QuestionChannel {
  /** 待答问题：sessionId → 状态机（不再按 chatKey，切走 current 不会撞 key） */
  private readonly pending = new Map<string, PendingEntry>();
  /** `/to #id` 空文本进入的「下一条消息作为回答」模式：peerId → sessionId */
  private readonly answerTargets = new Map<string, string>();
  private readonly manager: QuestionChannelManagerLike;
  private readonly sender: QuestionChannelSenderLike;
  private readonly config: QuestionChannelConfigLike;
  private readonly logger: Logger;

  public constructor(
    manager: QuestionChannelManagerLike,
    sender: QuestionChannelSenderLike,
    config: QuestionChannelConfigLike,
    logger: Logger,
  ) {
    this.manager = manager;
    this.sender = sender;
    this.config = config;
    this.logger = logger;
  }

  /** 记录所属的会话 id（优先宿主 id） */

  /**
   * 注册 `user-questions/request` waterfall answerer。
   *
   * 不探测服务是否存在：seam 未挂载时不会有请求到达，监听本身无副作用。
   * `global` 必需——该事件按 agent 作用域派发，根作用域监听器不带 global 会被
   * 过滤掉；`prepend` 让 QQ 先于 Web 端 answerer 取得请求。
   *
   * @param ctx 宿主上下文（只需 on）
   */
  public install(ctx: QuestionChannelContext): void {
    const self = this;
    ctx.on('user-questions/request', (req: unknown, next: unknown) => {
      const request = req as UserQuestionRequest;
      const nextFn = next as () => Promise<UserQuestionResult>;
      const sessionId = request.agent?.id;
      const record = sessionId ? self.manager.findBySessionId(sessionId) : undefined;
      if (!record) return nextFn();

      // 投递失败才退回 Web：已送达的问题不能再次弹出（见 QuestionDeliveryError）
      return self.askViaQQ(record, request).catch((err: unknown) => {
        if (err instanceof QuestionDeliveryError) {
          self.logger.warn(`qqterm: QQ question delivery failed, falling back to the host answerer: ${err.message}`);
          return nextFn();
        }
        throw err;
      });
    }, { global: true, prepend: true });
    this.logger.info('qqterm: QQ question channel installed (user-questions/request)');
  }

  public uninstall(): void {
    for (const [, entry] of this.pending) {
      this.clearTimer(entry);
      this.removeAbort(entry);
      entry.reject(new QuestionChannelError('QQ question channel was unloaded before the user answered', ASK_ABORTED));
    }
    this.pending.clear();
    this.answerTargets.clear();
  }

  /** 会话回收时清理其待答问题，避免 pending 悬挂导致 Promise 与闭包泄漏 */
  public cancelPending(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    this.clearAnswerTargets(sessionId);
    if (!entry) return;
    this.pending.delete(sessionId);
    this.clearTimer(entry);
    this.removeAbort(entry);
    entry.reject(new QuestionChannelError('ask_user_question was cancelled before the user answered', ASK_ABORTED));
  }

  /** 该会话是否有待答问题（`/to` 判断走答案通道还是普通 prompt） */
  public hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** `/to #id` 空文本：下一条该 peer 的普通文本作为这个会话的答案 */
  public beginAnswerMode(peerId: string, sessionId: string): void {
    this.answerTargets.set(peerId, sessionId);
    this.logger.info(`qqterm: answer mode armed peer=${peerId} sessionId=${sessionId}`);
  }

  /** 显式答复指定会话（`/to #id <答案>`），不依赖 current */
  public answer(sessionId: string, text: string): boolean {
    const entry = this.pending.get(sessionId);
    if (!entry || !text) return false;
    const current = entry.request.questions[entry.index];
    if (!current) return false;
    this.advance(entry, sessionId, parseAnswer(current, text));
    return true;
  }

  /**
   * 入站文本作答：显式 answer target > current 的 pending > 非 current 待答提示。
   *
   * 第三步只消费并提示、不转发给 current 模型：一条没有路由信息的文本不能
   * 猜着送给另一个会话（设计 §6.3）。
   */
  public tryAnswer(
    scope: ChatScope,
    peerId: string,
    text: string,
    replyTarget?: ReplyTarget,
  ): boolean {
    const explicit = this.answerTargets.get(peerId);
    if (explicit) {
      const entry = this.pending.get(explicit);
      if (!entry) {
        // 整组已经结束（答完/超时/取消）：退出模式，这条消息走常规流程
        this.answerTargets.delete(peerId);
      } else if (!text) {
        return false;
      } else {
        const current = entry.request.questions[entry.index];
        if (!current) {
          this.answerTargets.delete(peerId);
          return false;
        }
        this.advance(entry, explicit, parseAnswer(current, text));
        return true;
      }
    }

    const record = this.manager.getSessionRecord(scope, peerId);
    const currentId = record ? sessionIdOf(record) : undefined;
    if (currentId) {
      const entry = this.pending.get(currentId);
      if (entry && text) {
        const current = entry.request.questions[entry.index];
        if (!current) return false;
        this.advance(entry, currentId, parseAnswer(current, text));
        return true;
      }
    }

    // 当前会话没在等答案，但有别的已获取会话在等：提示路由，不转发给 current。
    // 只提示属于这个 QQ 用户的会话，别人的待答问题不阻塞当前用户。
    const others = [...this.pending.entries()].filter(([id, entry]) => id !== currentId
      && (entry.record.peerId === undefined || entry.record.peerId === peerId));
    if (others.length === 0 || !text) return false;
    this.sendRouteHint(others.map(([id]) => id), replyTarget ?? record?.replyTarget);
    return true;
  }

  /** 按钮点击作答：按 button_data 的 `s` 找会话，旧卡片/旧题按钮忽略 */
  public handleInteraction(event: InteractionEvent): boolean {
    const peerId = event.user_openid;
    if (!peerId) return false;

    // 按钮只认唯一绑定用户；未绑定或身份不匹配直接忽略
    const owner = this.config.access.owner.trim();
    if (owner === '' || peerId !== owner) return false;

    const data = event.data?.resolved?.button_data;
    if (!data) return false;
    const button = decodeButtonData(data);
    if (!button || button.t !== 'question') return false;

    // 新按钮带 sessionId；旧卡片没有 s 时退回 current，兼容升级前发出的卡片
    const sessionId = button.s;
    if (sessionId !== undefined) {
      const entry = this.pending.get(sessionId);
      if (!entry) return false;
      if (entry.record.peerId !== undefined && entry.record.peerId !== peerId) return false;
      return this.consumeButton(entry, sessionId, button.q, button.i);
    }

    const record = this.manager.getSessionRecord('c2c', peerId);
    if (!record) return false;
    const entry = this.pending.get(sessionIdOf(record));
    if (!entry) return false;
    return this.consumeButton(entry, sessionIdOf(record), button.q, button.i);
  }

  /** 校验按钮归属题并推进状态机 */
  private consumeButton(entry: PendingEntry, sessionId: string, questionId: string, idx: number): boolean {
    const current = entry.request.questions[entry.index];
    if (!current) return false;
    // 旧题按钮在新题推进后被点击（误点/延迟事件），其 q 不等于当前题 id，直接忽略
    if (questionId !== current.id) return false;
    const opts = current.options ?? [];
    if (idx < 0 || idx >= opts.length) return false;
    this.advance(entry, sessionId, { id: current.id, selected: [opts[idx]!.label] });
    return true;
  }

  /**
   * 会话名：`#短id`，有标题时补上名字（提示语里指认会话用）。
   *
   * 只出现在「没有转发给你当前会话」这类提示里；它不是在转述另一个会话的
   * 内容，所以不套来源行。
   */
  private sessionLabel(sessionId: string): string {
    const label = `\`#${shortSessionId(sessionId)}\``;
    const title = this.manager.sessionTitle?.(sessionId);
    return title === undefined ? label : `${label}（${sourceTitle(title)}）`;
  }

  /** 会话内提示：非当前会话加来源行，用户才知道这条提示是哪条会话的事 */
  private noticeText(record: QuestionSessionRecordLike, body: string): string {
    const sessionId = sessionIdOf(record);
    if (this.manager.isCurrentSession?.(sessionId) ?? true) return body;
    return `${sessionSourceHeader(sessionId, this.manager.sessionTitle?.(sessionId))}\n\n${body}`;
  }

  /** 非 current 会话在等答案、但用户直接发了纯文本：提示用按钮或 /to，不转发 */
  private sendRouteHint(sessionIds: readonly string[], target: ReplyTarget | undefined): void {
    if (target === undefined) return;
    const text = sessionIds.length === 1
      ? [
        `⚠️ 这条属于 ${this.sessionLabel(sessionIds[0]!)}，没有转发给当前会话`,
        `用问题里的按钮或 \`/to #${shortSessionId(sessionIds[0]!)}\` 回答。`,
      ].join('\n')
      : [
        `⚠️ 有 ${sessionIds.length} 个会话在等回答，没有转发给当前会话`,
        '用各自问题里的按钮或 `/to <会话>` 回答。',
      ].join('\n');
    void this.sender.sendMarkdown(target, text).catch(() => {});
  }

  /** 清理指向某会话的 answer target（整组结束/取消时） */
  private clearAnswerTargets(sessionId: string): void {
    for (const [peerId, target] of this.answerTargets) {
      if (target === sessionId) this.answerTargets.delete(peerId);
    }
  }

  /** 走 QQ 通道：发送首题 + 挂起 Promise，等待逐题作答 */
  private async askViaQQ(record: QuestionSessionRecordLike, request: UserQuestionRequest): Promise<UserQuestionResult> {
    const sessionId = sessionIdOf(record);
    // 会话回收/取消可能在发送前发生：signal 已 abort 则直接失败，避免悬挂
    if (request.signal?.aborted) {
      throw new QuestionChannelError('ask_user_question was aborted before delivery', ASK_ABORTED);
    }
    // 同会话已有待答问题（理论上不会发生：回合阻塞在第一个问题上）→ 拒绝旧的
    const prev = this.pending.get(sessionId);
    if (prev) {
      this.pending.delete(sessionId);
      this.clearTimer(prev);
      this.removeAbort(prev);
      prev.reject(new QuestionChannelError('superseded by a new question', ASK_ABORTED));
    }

    const first = request.questions[0];
    if (!first) throw new Error('ask_user_question with empty questions');

    await this.sendQuestion(record, first);

    return new Promise<UserQuestionResult>((resolve, reject) => {
      const entry: PendingEntry = { record, request, resolve, reject, index: 0, collected: [] };
      if (request.signal) {
        const onAbort = (): void => {
          if (this.pending.get(sessionId) !== entry) return;
          this.pending.delete(sessionId);
          this.clearTimer(entry);
          reject(new QuestionChannelError('ask_user_question was aborted before the user answered', ASK_ABORTED));
        };
        entry.onAbort = onAbort;
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
      entry.timer = setTimeout(() => this.onTimeout(sessionId), this.config.askTimeoutMs);
      this.pending.set(sessionId, entry);
      this.logger.info(`qqterm: question sent to QQ, waiting for answer sessionId=${sessionId}`);
    });
  }

  /** 推进状态机：收集答案 → 有下一题则发送，否则 resolve 全部答案 */
  private advance(entry: PendingEntry, sessionId: string, answer: UserQuestionAnswer): void {
    entry.collected.push(answer);
    entry.index += 1;

    if (entry.index < entry.request.questions.length) {
      const next = entry.request.questions[entry.index]!;
      this.resetTimer(entry, sessionId);
      void this.sendQuestion(entry.record, next).catch((err) => {
        this.pending.delete(sessionId);
        this.clearAnswerTargets(sessionId);
        this.clearTimer(entry);
        this.removeAbort(entry);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      });
      return;
    }

    this.pending.delete(sessionId);
    this.clearAnswerTargets(sessionId);
    this.clearTimer(entry);
    this.removeAbort(entry);
    this.logger.info(`qqterm: question answered via QQ sessionId=${sessionId}`);
    entry.resolve({ answers: entry.collected });
  }

  /** 发送单个问题：优先带按钮，按钮发送失败降级纯文本 */
  private async sendQuestion(record: QuestionSessionRecordLike, question: UserQuestion): Promise<void> {
    const sessionId = sessionIdOf(record);
    const isCurrent = this.manager.isCurrentSession?.(sessionId) ?? true;
    const context = { sessionId, isCurrent, title: this.manager.sessionTitle?.(sessionId) };
    const keyboard = buildKeyboard(question, sessionId);
    try {
      if (keyboard) {
        try {
          await this.sender.sendMarkdown(record.replyTarget, formatQuestion(question, true, context), { keyboard });
          return;
        } catch (err) {
          // 同上：宿主 logger 在 headless profile 不可见，stderr 才是唯一线索
          console.warn('[qqterm] keyboard send failed:', err);
          this.logger.warn(`qqterm: keyboard send failed, fallback to text: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await this.sender.sendMarkdown(record.replyTarget, formatQuestion(question, false, context));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`qqterm: question send failed sessionId=${sessionId}: ${msg}`);
      throw new QuestionDeliveryError(`failed to deliver question to QQ: ${msg}`);
    }
  }

  private onTimeout(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    this.pending.delete(sessionId);
    this.clearAnswerTargets(sessionId);
    this.removeAbort(entry);
    entry.timer = undefined;
    void this.sender.sendMarkdown(
      entry.record.replyTarget,
      this.noticeText(entry.record, '⚠️ 提问已超时，未收到回答。'),
    ).catch(() => {});
    entry.reject(new QuestionChannelError('ask_user_question timed out before the user answered', ASK_ABORTED));
  }

  private resetTimer(entry: PendingEntry, sessionId: string): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.onTimeout(sessionId), this.config.askTimeoutMs);
  }

  private clearTimer(entry: PendingEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private removeAbort(entry: PendingEntry): void {
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort);
    }
  }
}
