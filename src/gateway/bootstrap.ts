/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { GatewayDisconnect, InteractionEvent, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { SessionManager, type DshAgentRegistry } from '../session/index.ts';
import { handleInbound, createOutboundHandler } from '../transport/index.ts';
import type { SessionLike } from '../transport/outbound.ts';
import type { RawSessionEvent } from '../transport/events.ts';
import { ReplyStore } from '../transport/reply-store.ts';
import { createReplyAwareBot } from '../transport/reply-bot.ts';
import type { ToolsRegistryLike } from '../transport/tool-presenter.ts';
import type { QQBotSender } from '../transport/outbound.ts';
import { QuestionChannel } from '../features/question-channel.ts';
import { ApprovalChannel, type ApprovalChannelContext } from '../features/approval-channel.ts';
import { RetryChannel } from '../features/retry-channel.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import { buildUserAgent, shortSessionId } from '../shared/index.ts';
import { decorateSessionMessage, sessionTitleOf } from '../transport/session-source.ts';
import type { QQTermConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { setupMiddlewares } from './middleware-setup.ts';
import { createGatewaySession } from './gateway-session.ts';
import { startMediaCleanup } from '../media/media-cleaner.ts';
import type { MediaSenderLike } from '../media/send-media.ts';
import { OutboundImages, type AttachmentReaderLike, type ImageSenderLike } from '../transport/outbound-images.ts';
import { DeliverablesDeliverer } from '../transport/deliverables.ts';
import { formatPanelSummary, syncCommandPanels, type PanelSyncResult } from '../features/command-panel.ts';
import { syncCommandMenu, type MenuSyncResult } from '../features/command-menu.ts';
import { createReloader } from '../reload/index.ts';
import { createPluginInstaller } from '../plugins/index.ts';
import { startUpdateCheck } from '../plugins/updater.ts';

/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval）。QQ 只有一个 interaction 入口，集中路由
 * 避免多通道各自 try 导致误判。
 */
function dispatchInteraction(event: InteractionEvent, manager: SessionManager): boolean {
  const raw = event.data?.resolved?.button_data;
  if (!raw) return false;
  const button = decodeButtonData(raw);
  if (!button) return false;
  if (button.t === 'question') return manager.questionChannel?.handleInteraction(event) ?? false;
  if (button.t === 'approval') return manager.approvalChannel?.handleInteraction(event) ?? false;
  if (button.t === 'retry') return manager.retryChannel?.handleInteraction(event) ?? false;
  return false;
}

/**
 * 网关「连接可用」回调：全新握手发 ready，续传（热重载 / 断线重连）只发 resumed，
 * 不会再补一条 ready。恢复流程必须挂在这两种信号上，否则重载后的新实例既不补发
 * 上一轮结果，也不会接回上次的会话。
 */
export function onGatewayConnected(
  bot: Pick<QQBot, 'on'>,
  handler: (event: 'ready' | 'resumed') => void,
): void {
  bot.on('ready', () => handler('ready'));
  bot.on('resumed', () => handler('resumed'));
}

export async function bootstrapGateway(
  ctx: Context,
  agents: DshAgentRegistry,
  config: QQTermConfig,
  logger: Logger,
): Promise<void> {
  const manager = new SessionManager(ctx, agents, config, logger);
  // 被动回复凭证：msg_id 与用量落盘，重启/热重载后仍能走被动回复
  const replyStore = new ReplyStore({ appId: config.appId, logger });
  // 热重载能力：hmr 是可选服务，profile 未启用时命令只提示、不做任何事
  const reloader = createReloader(ctx, logger);
  // 插件安装能力：pluginManager 由宿主提供（web / desktop / CLI profile 都有）
  const installer = createPluginInstaller(ctx, logger);

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  // 会话票据落盘：重载窗口里漏收的事件靠 RESUME 补发（见 gateway-session.ts）
  const gatewaySession = createGatewaySession(config.appId);
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
    userAgent,
    sessionPersistence: gatewaySession.persistence,
    logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})`);
  // 所有发送方法统一接管被动回复凭证（含 SDK 内部 slashCommand 的回复）
  createReplyAwareBot(bot, replyStore);

  // ── 中间件链 ──
  const commands = setupMiddlewares(bot, config, manager, logger, replyStore, reloader, installer);

  // ── 入站：经过中间件链后的消息交给 dsh agent ──
  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    await handleInbound(mCtx, manager, logger);
  });

  // ── 出站：dsh session/event → QQ 消息 ──
  // tools 服务（工具结果结构化展示）
  const toolsRegistry = (ctx as unknown as { tools?: ToolsRegistryLike }).tools;

  // 发送适配器：bot 已被 createReplyAwareBot 接管被动凭证，这里只做形状适配。
  const sender: QQBotSender = {
    sendMarkdown: (target, content, opts) => bot.sendMarkdown(target, content, opts),
  };

  // ── 附件发送适配器（交付物投递使用） ──
  // SDK 文件发送不支持 event_id，装饰器已按 msg_only 处理，这里直接复用实例。
  const mediaSender: MediaSenderLike = bot as unknown as MediaSenderLike;

  // 助手消息里的 image 内容块 → QQ 图片（走宿主 attachment 服务取字节）
  const outboundImages = new OutboundImages(
    bot as unknown as ImageSenderLike,
    (ctx as unknown as { attachments?: AttachmentReaderLike }).attachments,
    logger,
  );

  // 交付物投递：present 声明的文件在轮末发送到当前会话（outbound 路由触发）
  // 相对路径以「该会话当前的工作目录」为基准：工作区跟着会话走，不能再读固定配置。
  const deliverablesDeliverer = new DeliverablesDeliverer(
    sender,
    mediaSender,
    config,
    logger,
    (record) => manager.directoryForAgent(record.agent),
    // 非当前会话：来源头 + 尾部链接行（回复 / 恢复），与普通消息同一套装饰
    (record, text) => (manager.isCurrentSession(record.sessionId)
      ? text
      : decorateSessionMessage(text, record.sessionId, sessionTitleOf(record))),
  );

  const outbound = createOutboundHandler(
    manager,
    sender,
    config,
    logger,
    toolsRegistry,
    deliverablesDeliverer,
    outboundImages,
  );
  // session/event 按 agent 作用域派发；带 global 才能收到所有已获取会话的事件，
  // 不只当前会话（多会话输出都要回 QQ）。同一入口顺带跟运行期 cd：只有当前会话
  // 的 working-directory/change 会覆盖聊天工作区。
  (ctx as unknown as {
    on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void;
  }).on('session/event', ((session: SessionLike, event: RawSessionEvent) => {
    if (event.type === 'working-directory/change') {
      manager.noteWorkingDirectory(session, event.data.cwd);
    }
    outbound.routeSessionEvent(session, event);
  }) as (...args: unknown[]) => void, { global: true });

  // ── 问答通道（ask_user_question → QQ 文本 + 按钮） ──
  const questionChannel = new QuestionChannel(manager, sender, config, logger);
  manager.questionChannel = questionChannel;
  questionChannel.install(ctx);

  // ── 审批通道（approval/request → QQ 两按钮审批） ──
  const approvalChannel = new ApprovalChannel(manager, sender, config, logger);
  manager.approvalChannel = approvalChannel;
  approvalChannel.install(ctx as unknown as ApprovalChannelContext);

  // ── 重发通道（轮次失败 → 「重发 / 放弃」卡片） ──
  // 不 install：它不订阅宿主事件，只被 outbound 的失败告知与 interaction 分发调用
  manager.retryChannel = new RetryChannel(manager, sender, config, logger);

  // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
  bot.on('interaction', async (_iCtx: unknown, event: InteractionEvent) => {
    // 按钮只认绑定用户：非 owner 的点击不登记凭证、不分发、不回 ack
    if (!config.access.owner || event.user_openid !== config.access.owner) return;
    // 记录互动事件 id，作为后续被动回复候选（event_id，仅内存）
    replyStore.recordEvent('c2c', event.user_openid, event.id);

    const matched = dispatchInteraction(event, manager);
    await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => {});
  });

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
  // disconnected 事件为 SDK 1.0.5+ 新增：旧版 handlers 表缺该键，bot.on 会抛
  // TypeError（profiles 增量安装可能残留旧版 SDK）——降级为跳过监听而非崩溃
  try {
    bot.on('disconnected', (event: GatewayDisconnect) => {
      const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
      if (event.willReconnect) {
        logger.warn(`Bot disconnected (${detail}), reconnecting...`);
      } else {
        logger.error(`Bot disconnected permanently (${detail}), giving up`);
      }
    });
  } catch (err) {
    logger.warn(`qqbot-nodejs SDK 不支持 disconnected 事件（请升级 @tencent-connect/qqbot-nodejs 至 1.0.5+）: ${err instanceof Error ? err.message : String(err)}`);
  }

  onGatewayConnected(bot, (event) => {
    console.log(`[qqterm] Bot ${event}! appId=${config.appId}`);

    // 启动恢复：把上次的会话接回来，避免「/status 说未建立、下一条消息又能接回」。
    // 失败时主动推一条带重试入口的消息——重启后没有入站消息，只能发给持久化的
    // 最后交互用户（/sessions resume 是幂等的，重试安全）。
    void manager.restoreCurrentSession()
      .then(async (outcome) => {
        if (outcome.kind !== 'failed') return;
        const reason = outcome.locked ? '另一个客户端正在使用' : '宿主报错';
        const text = [
          `⚠️ 上次的会话没能恢复（${reason}）`,
          `<qqbot-cmd-input text="/sessions resume #${shortSessionId(outcome.sessionId)}" show="重试恢复"/>`,
        ].join('\n');
        await bot.sendMarkdown({ scope: 'c2c', targetId: outcome.targetId }, text);
      })
      .catch((err: unknown) => {
        logger.warn(`启动恢复会话失败: ${err instanceof Error ? err.message : String(err)}`);
      });

    // 上一次 /plugins reload 的结果只能靠状态文件带到这个 fiber：连上后补发一条被动回复
    void reloader.announce(bot).catch((err: unknown) => {
      logger.warn(`热重载结果播报失败: ${err instanceof Error ? err.message : String(err)}`);
    });

    // 插件安装可能把 qqterm 自己换掉：新 fiber 连上后补发上一次安装 / 更新的结果
    void installer.announce(bot).catch((err: unknown) => {
      logger.warn(`插件操作结果播报失败: ${err instanceof Error ? err.message : String(err)}`);
    });

    // 指令面板：连上后把当前命令推到私聊全局面板。
    // 每次连接（含续传）都同步一次，面板被外部删掉也能自愈；失败只记 warn，
    // 不影响网关（OpenAPI 未开通时这里会拿到 4xx）。
    if (config.panel.autoSync) {
      void syncCommandPanels(bot.api, commands, logger)
        .then((results: PanelSyncResult[]) => {
          logger.info(`指令面板已同步: ${formatPanelSummary(results)}`);
        })
        .catch((err: unknown) => {
          logger.warn(`指令面板同步失败: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    // 自定义菜单：单聊窗口底部的固定入口（四个按钮 + 权限 / 思考两个子菜单）
    if (config.menu.autoSync) {
      void syncCommandMenu(bot.api, logger)
        .then((result: MenuSyncResult) => {
          logger.info(`自定义菜单已同步: ${result.count} 项`);
        })
        .catch((err: unknown) => {
          logger.warn(`自定义菜单同步失败: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  // ── 富媒体过期清理（与下载开关解耦：关掉下载也要清理旧文件） ──
  startMediaCleanup(ctx, config.media.ttlHours, logger);

  // ── 后台检查插件更新（结果只进 `/plugins` 列表，不推送、不自动装） ──
  startUpdateCheck(ctx, installer, logger);

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      return async () => {
        logger.info('Shutting down');
        // 先断接收再拆会话：disposeAll 期间还开着 socket 的话，新到的消息会被
        // 半活的 fiber 收下（seq 已落盘，新实例不会补发），等于静默丢掉。
        bot.stop();
        await manager.disposeAll();
        gatewaySession.flush();
        replyStore.dispose();
      };
    }, 'qqterm.lifecycle');
}
