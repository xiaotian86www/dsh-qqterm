import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { SessionManager } from "../session/index.js";
import { handleInbound, createOutboundHandler } from "../transport/index.js";
import { parseStreamFrame } from "../transport/events.js";
import { ReplyLimiter } from "../transport/reply-limiter.js";
import { cacheMsgId, cacheEventId } from "../transport/msgid-cache.js";
import { resolveReplyTarget, sendResolvedMarkdown } from "../transport/reply-target.js";
import { QuestionChannel } from "../features/question-channel.js";
import { ApprovalChannel } from "../features/approval-channel.js";
import { decodeButtonData } from "../features/button-utils.js";
import { buildUserAgent } from "../shared/index.js";
import { decorateSessionMessage, sessionTitleOf } from "../transport/session-source.js";
import { setupMiddlewares } from "./middleware-setup.js";
import { startMediaCleanup } from "../media/media-cleaner.js";
import { ensureVisionInputModal, registerDescribeImageTool } from "../media/vision-tool.js";
import { registerSendFileTool } from "../media/send-file-tool.js";
import { DeliverablesDeliverer } from "../transport/deliverables.js";
import { formatPanelSummary, syncCommandPanels } from "../features/command-panel.js";
import { syncCommandMenu } from "../features/command-menu.js";
/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval）。QQ 只有一个 interaction 入口，集中路由
 * 避免多通道各自 try 导致误判。
 */
function dispatchInteraction(event, manager) {
    const raw = event.data?.resolved?.button_data;
    if (!raw)
        return false;
    const button = decodeButtonData(raw);
    if (!button)
        return false;
    if (button.t === 'question')
        return manager.questionChannel?.handleInteraction(event) ?? false;
    if (button.t === 'approval')
        return manager.approvalChannel?.handleInteraction(event) ?? false;
    return false;
}
export async function bootstrapGateway(ctx, agents, config, logger) {
    const manager = new SessionManager(ctx, agents, config, logger);
    // ── 初始化 QQ Bot SDK ──
    const userAgent = buildUserAgent();
    const bot = new QQBot({
        appId: config.appId,
        appSecret: config.appSecret,
        transport: 'websocket',
        baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        userAgent,
        logger,
    });
    logger.info(`QQBot SDK initialized (UA: ${userAgent})`);
    // ── 中间件链 ──
    const commands = setupMiddlewares(bot, config, manager, logger);
    // ── 入站：经过中间件链后的消息交给 dsh agent ──
    bot.on('message', async (mCtx) => {
        const msg = mCtx.message;
        // 记录最近 msgId，供无上下文的出站发送（文件发送显式 target、主动推送等）获取被动回复目标
        cacheMsgId('c2c', mCtx.replyTarget.targetId, mCtx.replyTarget.msgId);
        if (config.debug) {
            logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
        }
        await handleInbound(mCtx, manager, logger);
    });
    // ── 出站：dsh session/event → QQ 消息 ──
    // tools 服务（工具结果结构化展示）
    const toolsRegistry = ctx.tools;
    // 发送适配器：将 QQBot 实例适配为 QQBotSender（openStream 参数形态不同）。
    // sendMarkdown 统一做被动回复限额管控：同一 msgId 超限/过期时降级主动推送。
    const replyLimiter = new ReplyLimiter({ limit: 4 });
    const sender = {
        sendMarkdown: (target, content, opts) => sendResolvedMarkdown(bot, resolveReplyTarget(target, replyLimiter, true), content, opts),
        openStream: (target) => bot.openStream({
            target: {
                scope: target.scope,
                targetId: target.targetId,
                msgId: target.msgId,
            },
        }),
    };
    // ── 附件发送适配器（qqbot_send_file 工具与交付物投递共用） ──
    // 包装 bot：让文件发送也走 msgId 兜底 + 被动回复限额管控。
    // 注意：SDK 文件发送暂不支持 event_id，故 allowEvent=false，跳过 event 候选。
    const mediaSender = {
        sendImage: (target, source) => bot.sendImage(resolveReplyTarget(target, replyLimiter, false), source),
        sendVideo: (target, source) => bot.sendVideo(resolveReplyTarget(target, replyLimiter, false), source),
        sendVoice: (target, source) => bot.sendVoice(resolveReplyTarget(target, replyLimiter, false), source),
        sendFile: (target, source, opts) => bot.sendFile(resolveReplyTarget(target, replyLimiter, false), source, opts),
    };
    // 交付物投递：present 声明的文件在轮末发送到当前会话（outbound 路由触发）
    // 白名单/相对路径以「该会话当前的工作目录」为基准：工作区跟着会话走，不能再读固定配置。
    const deliverablesDeliverer = new DeliverablesDeliverer(sender, mediaSender, config, logger, (record) => manager.directoryForAgent(record.agent), (record, text) => (manager.isCurrentSession(record.sessionId)
        ? text
        : decorateSessionMessage(text, record.sessionId, sessionTitleOf(record))));
    const outbound = createOutboundHandler(manager, sender, config, logger, toolsRegistry, deliverablesDeliverer);
    // session/event 按 agent 作用域派发；带 global 才能收到所有已获取会话的事件，
    // 不只当前会话（多会话输出都要回 QQ）。
    ctx.on('session/event', outbound.routeSessionEvent, { global: true });
    // ── 出站流式：agent/assistant-stream → 流式帧路由 ──
    // 实时流式走瞬态 agent/assistant-stream（chunk 不进 session log）。
    // 该事件按 agent 作用域派发，根作用域监听器不带 global 会被过滤（同
    // approval/request），帧到达后自行按 agent.id 路由，非 QQ 会话在 router 内忽略。
    ctx
        .on('agent/assistant-stream', (payload) => {
        const parsed = parseStreamFrame(payload);
        if (parsed !== undefined)
            outbound.routeStreamFrame(parsed.agentId, parsed.delta);
    }, { global: true });
    // ── 问答通道（ask_user_question → QQ 文本 + 按钮） ──
    const questionChannel = new QuestionChannel(manager, sender, config, logger);
    manager.questionChannel = questionChannel;
    questionChannel.install(ctx);
    // ── 审批通道（approval/request → QQ 两按钮审批） ──
    const approvalChannel = new ApprovalChannel(manager, sender, config, logger);
    manager.approvalChannel = approvalChannel;
    approvalChannel.install(ctx);
    // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
    bot.on('interaction', async (_iCtx, event) => {
        // 只处理私聊互动：点击者以 user_openid 为准
        // 记录互动事件 id，作为后续被动回复候选（event_id）
        cacheEventId('c2c', event.user_openid, event.id);
        const matched = dispatchInteraction(event, manager);
        await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => { });
    });
    bot.on('error', (err) => {
        logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
    });
    // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
    // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
    // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
    try {
        bot.on('disconnected', (event) => {
            const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
            if (event.willReconnect) {
                logger.warn(`Bot disconnected (${detail}), reconnecting...`);
            }
            else {
                logger.error(`Bot disconnected permanently (${detail}), giving up`);
            }
        });
    }
    catch (err) {
        logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
    }
    bot.on('ready', () => {
        console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
        // 指令面板：ready 后把当前命令推到私聊全局面板。
        // 每次 ready（含重连）都同步一次，面板被外部删掉也能自愈；失败只记 warn，
        // 不影响网关（OpenAPI 未开通时这里会拿到 4xx）。
        if (config.panel?.autoSync ?? true) {
            void syncCommandPanels(bot.api, commands, logger)
                .then((results) => {
                logger.info(`指令面板已同步: ${formatPanelSummary(results)}`);
            })
                .catch((err) => {
                logger.warn(`指令面板同步失败: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        // 自定义菜单：单聊窗口底部的四个固定按钮（会话状态 / 会话列表 / 创建会话 / 压缩会话）
        if (config.menu?.autoSync ?? true) {
            void syncCommandMenu(bot.api, logger)
                .then((result) => {
                logger.info(`自定义菜单已同步: ${result.count} 项`);
            })
                .catch((err) => {
                logger.warn(`自定义菜单同步失败: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
    });
    // ── 富媒体过期清理 ──
    if (config.media.enabled) {
        startMediaCleanup(ctx, config.media.ttlHours, logger);
    }
    // ── 视觉工具注册（qqbot_describe_image，复用 dsh llm + attachments） ──
    ensureVisionInputModal(config.vision, logger);
    registerDescribeImageTool(ctx, config.vision, logger);
    // ── 附件发送工具注册（qqbot_send_file，发送器见上方 mediaSender） ──
    registerSendFileTool(ctx, mediaSender, manager, config, logger);
    // ── 生命周期 ──
    ctx
        .effect(() => {
        logger.info(`Starting bot (appId=${config.appId})`);
        bot.start().catch((err) => {
            logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return async () => {
            logger.info('Shutting down');
            await manager.disposeAll();
            bot.stop();
        };
    }, 'im-qqbot.lifecycle');
}
//# sourceMappingURL=bootstrap.js.map