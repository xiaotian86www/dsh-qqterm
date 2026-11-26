import { errorHandler, messageFilter, accessPolicy, contentSanitizer, rateLimiter, slashCommand, concurrencyGuard, typingIndicator, quoteRef, envelopeFormatter, } from '@tencent-connect/qqbot-nodejs';
import { buildCommandList } from "../commands/index.js";
import { visibleCommands } from "../commands/availability.js";
import { attachmentProcessor } from "../middleware/attachment.js";
import { questionAnswer } from "../middleware/question-answer.js";
import { replyRecorder } from "../middleware/reply-recorder.js";
import { preserveMultilineCommands, restoreMultilineCommands } from "../middleware/multiline-command.js";
import { collectCommandNames, rejectUnknownCommands, } from "../middleware/unknown-command.js";
import { QUOTE_CONTENT_LIMIT } from "../transport/prompt-body.js";
export function setupMiddlewares(options) {
    const { bot, config, manager, logger, replyStore, reloader, installer, sendText } = options;
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
                logger.info(`qqterm: 未配置白名单用户，已拒绝私聊: sender=${mCtx.message.senderId ?? '(missing)'}`);
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
    // 5.5. 引用消息解析（记录 + 解析被引用原文）
    //      必须排在 slashCommand 之前：命令命中后 ctx.stop 截断整条链，命令 handler
    //      就拿不到 ctx.state.quote 了（带引用的 /new、/to 依赖它）。
    bot.use(quoteRef({
        maxSize: 500,
        preferMsgElements: true,
        // 与 prompt-body 的 QUOTE_CONTENT_LIMIT 一致，store 命中时才判得出是否被截断
        contentLimit: QUOTE_CONTENT_LIMIT,
    }));
    // 6. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
    // 命令 handler 执行前把换行占位符还原（见 middleware/multiline-command.ts）
    const commandList = restoreMultilineCommands(buildCommandList({ manager, config, logger, bot, reloader, installer }));
    const commandNames = collectCommandNames(commandList);
    // 守卫白名单现取可见命令：命令表是注册期快照，能力晚到/卸载都要立刻反映。
    const visibleCommandNames = () => collectCommandNames(visibleCommands(commandList));
    const slash = slashCommand({
        // 关闭 autoHelp：help 命令由 qqbot 自己注册为 /help，
        // 避免 SDK 再自动注册一个同名命令造成重复
        autoHelp: false,
        // 全角 ／ 与半角 / 等价：中文输入法下很难打出半角斜杠
        prefixes: ['/', '／'],
        commands: commandList,
    });
    // 6.1. 多行指令：SDK 的匹配正则不跨行，先把正文里的换行换成占位符（出栈还原），
    //      否则 /new、/to 这类带换行的命令会漏成普通提问。
    bot.use(preserveMultilineCommands(commandNames));
    bot.use(slash.middleware);
    // 6.5. 待答问题截获（在 concurrencyGuard 之前，答案消息不排队直接作答）
    bot.use(questionAnswer(manager));
    // 6.6. 未知指令兜底（在 questionAnswer 之后：答案优先，别被守卫吃掉）
    //      拼错的 /xxx 直接回「没有这个指令」，不再当成提问转发给大模型
    bot.use(rejectUnknownCommands({
        commandNames: visibleCommandNames,
        sendText: sendText ?? (async (target, body) => {
            await bot.sendMarkdown(target, body);
        }),
    }));
    // 7. 入站派发串行（同 peer 短暂排队，避免并发创建会话 / 同时写 followup）
    //    守卫只管到「消息交给宿主」为止，不等本轮 turn 结束：会话内的先后由宿主
    //    inbox 的 next-turn 队列保证，跨会话因此互不阻塞（见 transport/inbound.ts）。
    bot.use(concurrencyGuard({
        strategy: 'merge',
        maxQueue: config.maxQueue,
    }));
    // 8. C2C 输入状态指示
    bot.use(typingIndicator());
    // 9.1. 附件下载（file 附件下载到本地，供工具访问）
    bot.use(attachmentProcessor(config, logger));
    // 10. 上下文组装（将 quote + sender 组成 envelope）
    bot.use(envelopeFormatter({
        includeQuote: true,
        includeSender: true,
    }));
    // 调用方（bootstrap）用同一份列表做指令面板同步，避免两处各建一遍
    return commandList;
}
//# sourceMappingURL=middleware-setup.js.map