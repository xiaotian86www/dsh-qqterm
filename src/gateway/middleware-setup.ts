/**
 * SDK 中间件编排
 *
 * 根据插件配置组装 SDK 内置中间件链（洋葱模型）。
 * 中间件负责过滤与上下文富化；最终消息统一由 bot.on('message') 处理转发。
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  errorHandler,
  messageFilter,
  accessPolicy,
  contentSanitizer,
  rateLimiter,
  slashCommand,
  concurrencyGuard,
  typingIndicator,
  quoteRef,
  envelopeFormatter,
} from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Reloader } from '../reload/index.ts';
import type { Logger } from '../types.ts';
import { buildCommandList } from '../commands/index.ts';
import type { CategorizedCommand } from '../commands/types.ts';
import { attachmentProcessor } from '../middleware/attachment.ts';
import { questionAnswer } from '../middleware/question-answer.ts';
import { replyRecorder } from '../middleware/reply-recorder.ts';
import { collectCommandNames, rejectUnknownCommands } from '../middleware/unknown-command.ts';
import type { ReplyStore } from '../transport/reply-store.ts';

export function setupMiddlewares(
  bot: QQBot,
  config: ImQQBotConfig,
  manager: SessionManager,
  logger: Logger,
  replyStore: ReplyStore,
  reloader?: Reloader,
): CategorizedCommand[] {
  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 3. 访问控制：唯一白名单用户，空 owner = 拒绝所有人（fail-closed）
  //    只放行 C2C 私聊：群聊消息在入口处直接拦掉，不进入后续链路
  const owner = config.access.owner.trim();
  bot.use(accessPolicy({
    c2c: {
      mode: 'allowlist',
      allow: owner === '' ? [] : [owner],
    },
    group: {
      mode: 'disabled',
    },
    onBlock: (mCtx, reason) => {
      if (owner === '') {
        logger.info(`im-qqbot: 未配置白名单用户，已拒绝私聊: sender=${mCtx.message.senderId ?? '(missing)'}`);
        return;
      }
      if (config.debug) {
        logger.debug(`Access blocked: ${reason} sender=${mCtx.message.senderId ?? '(missing)'}`);
      }
    },
  }));

  // 3.5. 被动回复凭证：登记 msgId。必须在命令分发之前——命令消息会被
  //      slashCommand 截获，不会走到 bot.on('message')。
  bot.use(replyRecorder(replyStore));

  // 4. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer({
    parseFaceTags: true,
  }));

  // 5. 三层限流（发送者 / 会话 / 全局）
  bot.use(rateLimiter());

  // 6. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
  const commandList = buildCommandList({ manager, config, logger, bot, reloader });
  const slash = slashCommand({
    // 关闭 autoHelp：help 命令由 qqbot 注册为 /bot-help，
    // 避免 SDK 再自动注册一个无前缀的 /help 造成重复
    autoHelp: false,
    // 全角 ／ 与半角 / 等价：中文输入法下很难打出半角斜杠
    prefixes: ['/', '／'],
    commands: commandList,
  });
  bot.use(slash.middleware);

  // 6.5. 待答问题截获（在 concurrencyGuard 之前，答案消息不排队直接作答）
  bot.use(questionAnswer(manager));

  // 6.6. 未知指令兜底（在 questionAnswer 之后：答案优先，别被守卫吃掉）
  //      拼错的 /xxx 直接回「没有这个指令」，不再当成提问转发给大模型
  bot.use(rejectUnknownCommands({ commandNames: collectCommandNames(commandList) }));

  // 7. 入站派发串行（同 peer 短暂排队，避免并发创建会话 / 同时写 followup）
  //    守卫只管到「消息交给宿主」为止，不等本轮 turn 结束：会话内的先后由宿主
  //    inbox 的 next-turn 队列保证，跨会话因此互不阻塞（见 transport/inbound.ts）。
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: config.maxQueue,
    maxProcessingMs: config.processingTimeoutMs,
  }));

  // 8. C2C 输入状态指示
  bot.use(typingIndicator());

  // 9. 引用消息解析（记录 + 解析被引用原文）
  bot.use(quoteRef({
    maxSize: 500,
    preferMsgElements: true,
  }));

  // 9.5. 附件下载（file 附件下载到本地，供工具访问）
  bot.use(attachmentProcessor(config, logger));

  // 10. 上下文组装（将 quote + sender 组成 envelope）
  bot.use(envelopeFormatter({
    includeQuote: true,
    includeSender: true,
  }));

  // 调用方（bootstrap）用同一份列表做指令面板同步，避免两处各建一遍
  return commandList;
}
