/**
 * QQ Bot 发送端替身 —— 只实现出站用到的 sendMarkdown，记录每次发送并可注入失败。
 *
 * 真网关（WebSocket + 被动回复凭证 + 频控）不能自动化，端到端用例断言的是
 * 「插件决定发什么、按什么顺序发、失败后怎么收场」，发送这一步是记录器。
 */
import type { ReplyTarget } from '../../src/types.ts';
import type { QQBotSender } from '../../src/transport/outbound.ts';

/** 一次成功的 sendMarkdown */
export interface SentMarkdown {
  target: ReplyTarget;
  content: string;
  /** 带键盘的发送（命令视图 / 问答 / 审批） */
  keyboard?: unknown;
}

export interface FakeQQBot extends QQBotSender {
  /** 成功发出的消息（顺序即发送顺序；失败的调用不进这个列表） */
  readonly sent: SentMarkdown[];
  /** 注入失败：接下来 count 次 sendMarkdown 抛 error（模拟 QQ 侧拒绝） */
  failNext(count?: number, error?: Error): void;
  /** 成功发出的正文，便于整段断言 */
  texts(): string[];
}

export function fakeQQBot(): FakeQQBot {
  const sent: SentMarkdown[] = [];
  let failures = 0;
  let failure = new Error('sendMarkdown failed');

  return {
    sent,
    texts: () => sent.map(message => message.content),
    failNext(count = 1, error = new Error('sendMarkdown failed')): void {
      failures += count;
      failure = error;
    },
    async sendMarkdown(target, content, opts) {
      if (failures > 0) {
        failures -= 1;
        throw failure;
      }
      sent.push({
        target,
        content,
        ...(opts?.keyboard === undefined ? {} : { keyboard: opts.keyboard }),
      });
      return {};
    },
  };
}
