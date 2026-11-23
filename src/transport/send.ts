/**
 * 出站发送的公共函数 —— 每条路径在调用点直接写出自己需要哪几项能力。
 *
 * 路径与函数的对应（改路径时先看这里）：
 *   assistant 正文 / 工具结果 / 轮次失败 / 交付物提示 → session()
 *   （非当前会话署名 + 按上限分片 + 失败入队、同会话保序）
 *   命令回复 / 启动公告 / 兜底提示 → text()
 *   （按上限分片 + 网络类失败重试一次；不署名、不入队，失败抛给调用方）
 *   提问 / 审批 / 重试 / 确认卡片 → card()
 *   （先带键盘发；给了纯文本兜底就再发一遍，没给就直接抛）
 *
 * 三者的共同底层只有「怎么切分」与「怎么判失败」（chunker / outbox），
 * 其余能力由路径在调用点选用，不做通用中间件管线。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { QQTermConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { chunkMarkdownText, defuseDanglingTag, longestInlineTag, splitForLimit } from './chunker.ts';
import { classifyDeliveryError, Outbox } from './outbox.ts';
import { decorateSessionMessage } from './session-source.ts';
import { errorMessage } from '../shared/utils.ts';

/** QQ Bot 发送接口：只发静态 markdown（被动凭证由 reply-bot 补齐） */
export interface QQBotSender {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
}

/** 署名要用到的会话视图：不依赖 SessionManager，测试可直接给假实现 */
export interface SessionView {
  isCurrent(sessionId: string): boolean;
  titleOf(sessionId: string): string | undefined;
  canArchive(): boolean;
  /** 会话是否正在生成：给了才在尾部加「停止」入口，缺省视为空闲 */
  isRunning?(sessionId: string): boolean;
}

/**
 * 「发一条文本到目标」的最小形状：入站兜底、公告这类只有一句话的路径只需要它。
 * 与 Sender.text 同一实现，保证分片与网络类重试只有一份。
 */
export type SendText = (target: ReplyTarget, body: string) => Promise<void>;

/** 渠道发送端口：出站路径只认这七个方法 */
export interface Sender {
  /** 一次性消息：分片后逐条发，网络类失败重试一次；不署名、不入队 */
  text(target: ReplyTarget, body: string): Promise<void>;
  /** 会话输出：非当前会话署名，分片后交给 Outbox（失败入队、同会话保序） */
  session(sessionId: string, target: ReplyTarget, body: string, tag: string): Promise<void>;
  /** 交互卡片：先带键盘发，失败且给了 fallbackBody 时改发纯文本 */
  card(target: ReplyTarget, body: string, keyboard: InlineKeyboard, fallbackBody?: string): Promise<void>;
  /** 非当前会话：来源头 + 尾部动作行；当前会话原样返回 */
  decorate(sessionId: string, body: string): string;
  /** 网络恢复：按会话补发积压 */
  flush(): Promise<void>;
  /** 渠道失效：丢掉积压 */
  clear(): void;
  hasPending(sessionId?: string): boolean;
}

/** 通道只需要「发卡片」和「发提示」，测试可以只实现这两个 */
export type ChannelSender = Pick<Sender, 'text' | 'card'>;

/** 风控拦截后的替代文案（只发一次）：只写事实，不把 Web 会话当兜底 */
const BLOCKED_NOTICE = '❌ 上一条消息被 QQ 拦截，未送达。';

/** 超长且切到最小分片仍被拒：换掉的不是风控，别复用「被拦截」的措辞 */
const TOO_LONG_NOTICE = '❌ 上一条消息超过长度上限，切到最小分片仍被拒，未送达。';

/** 一次发送的失败分类：只对网络类重试，其它原样抛给调用方 */
async function sendOnceWithRetry(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (classifyDeliveryError(err) !== 'transient') throw err;
    await run();
  }
}

/**
 * 分片发送（命令回复 / 公告共用）：按 markdown 结构切，网络类失败重试一次。
 *
 * 导出给斜杠命令用：命令拿不到 Sender（SDK 只注入 bot 与 replyTarget），
 * 但切分与重试必须是同一份实现。
 */
export async function sendChunkedText(
  bot: QQBotSender,
  target: ReplyTarget,
  body: string,
  limit: number,
): Promise<void> {
  if (body === '') return;
  for (const chunk of chunkMarkdownText(body, limit)) {
    await sendOnceWithRetry(() => bot.sendMarkdown(target, chunk));
  }
}

export interface CreateSenderOptions {
  bot: QQBotSender;
  config: QQTermConfig;
  logger: Logger;
  sessions: SessionView;
  /** 失败队列：bootstrap 创建（渠道失效回调要同时释放会话），测试可自建 */
  outbox: Outbox;
}

/** 组装发送端口：持有 bot、切分上限、会话视图与失败队列 */
export function createSender(options: CreateSenderOptions): Sender {
  const { bot, config, logger, sessions, outbox } = options;

  const decorate = (sessionId: string, body: string): string => (sessions.isCurrent(sessionId)
    ? body
    : decorateSessionMessage(
      body,
      sessionId,
      sessions.titleOf(sessionId),
      sessions.canArchive(),
      sessions.isRunning?.(sessionId) ?? false,
    ));

  const text = async (target: ReplyTarget, body: string): Promise<void> => {
    await sendChunkedText(bot, target, body, config.textChunkLimit);
  };

  /**
   * 会话输出：
   *   - 非当前会话先署名，再按上限切分（切分点感知 qqbot-cmd-input 标签）；
   *   - 每片交给 Outbox：网络抖动重试一次、仍失败入队并停发后续分片；
   *   - 超长按本条长度减半重切，切不动时按「超长」而非「被拦截」告知；内容类失败只告知一次。
   */
  const session = async (
    sessionId: string,
    target: ReplyTarget,
    body: string,
    tag: string,
  ): Promise<void> => {
    if (body === '') return;
    const composed = decorate(sessionId, body);
    const queue = splitForLimit(composed, config.textChunkLimit);
    // 残片标签发出去就是一段乱码属性，发送前统一打回纯文本
    const send = (value: string): Promise<unknown> => bot.sendMarkdown(target, defuseDanglingTag(value));
    let notified = false;

    while (queue.length > 0) {
      const part = queue.shift()!;
      const outcome = await outbox.deliver(sessionId, tag, () => send(part));

      // 暂不可用：本条与后续分片一起排队，恢复后按原顺序补发
      if (outcome === 'queued') {
        for (const rest of queue) outbox.enqueue(sessionId, tag, () => send(rest));
        return;
      }
      // 渠道判死：后续分片已经没有任何意义
      if (outcome === 'broken') return;
      if (outcome === 'sent') continue;

      // 内容类失败：超长按本条长度减半重切；切不动才告知，风控与超长各用自己的措辞
      let notice = BLOCKED_NOTICE;
      if (outcome === 'too-long') {
        // 切点不能比一条行内标签还短，否则标签只能被拦腰截断
        const smaller = splitForLimit(part, Math.max(Math.floor(part.length / 2), longestInlineTag(part)));
        if (smaller.length > 1) {
          queue.unshift(...smaller);
          continue;
        }
        notice = TOO_LONG_NOTICE;
      }
      if (!notified) {
        notified = true;
        await outbox.deliver(sessionId, 'sendBlockedNotice', () => send(notice));
      }
    }
  };

  const card = async (
    target: ReplyTarget,
    body: string,
    keyboard: InlineKeyboard,
    fallbackBody?: string,
  ): Promise<void> => {
    try {
      await bot.sendMarkdown(target, body, { keyboard });
    } catch (err) {
      if (fallbackBody === undefined) throw err;
      // 键盘通道不可用时正文仍要有下一步（例如「发 /retry」），不能静默丢消息
      logger.warn('qqterm: keyboard send failed, fallback to text: '
        + (errorMessage(err)));
      await text(target, fallbackBody);
    }
  };

  return {
    text,
    session,
    card,
    decorate,
    flush: () => outbox.flush(),
    clear: () => outbox.clear(),
    hasPending: (sessionId?: string) => outbox.hasPending(sessionId),
  };
}
