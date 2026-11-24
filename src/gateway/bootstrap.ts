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
import { createSender, type Sender } from '../transport/send.ts';
import { Outbox } from '../transport/outbox.ts';
import { QuestionChannel } from '../features/question-channel.ts';
import { ApprovalChannel, type ApprovalChannelContext } from '../features/approval-channel.ts';
import { RetryChannel } from '../features/retry-channel.ts';
import { SessionConfirmChannel } from '../features/session-confirm.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import { buildUserAgent, isOwner, shortSessionId } from '../shared/index.ts';
import { commandLink } from '../shared/inline.ts';
import type { QQTermConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
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
import { errorMessage } from '../shared/utils.ts';

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
  if (button.t === 'confirm') return manager.sessionConfirmChannel?.handleInteraction(event) ?? false;
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

  // ── 发送端口 ──
  // 所有「发到 QQ 的文本」都走它：分片、网络类重试、非当前会话署名、失败入队都在
  // 这里。先于中间件链创建：未知指令兜底、入站兜底、重载/插件公告都要用它，
  // 否则每条路径各写一份裸发送，失败处理就会慢慢长歪。
  const senderHolder: { current?: Sender } = {};
  const outbox = new Outbox({
    logger,
    // 鉴权失败 = 整条渠道没了：丢掉积压，释放全部持有（会话仍在宿主里跑）
    onChannelBroken: (reason: string) => {
      senderHolder.current?.clear();
      manager.releaseAll(`auth: ${reason}`);
    },
  });
  const sender: Sender = createSender({
    bot,
    config,
    logger,
    sessions: {
      isCurrent: (sessionId) => manager.isCurrentSession(sessionId),
      titleOf: (sessionId) => manager.sessionTitle(sessionId),
      canArchive: () => manager.workspaceRegistryAvailable(),
      isRunning: (sessionId) => manager.isRunningSession(sessionId),
    },
    outbox,
  });
  senderHolder.current = sender;

  // 热重载能力：hmr 是可选服务，profile 未启用时命令只提示、不做任何事
  const reloader = createReloader(ctx, logger, { notify: sender.text });
  // 插件安装能力：pluginManager 由宿主提供（web / desktop / CLI profile 都有）
  const installer = createPluginInstaller(ctx, logger, { notify: sender.text });

  // ── 中间件链 ──
  const commands = setupMiddlewares({
    bot,
    config,
    manager,
    logger,
    replyStore,
    reloader,
    installer,
    // 插件只做 C2C：SDK 的 ReplyTarget 里 group 分支不会走到这里
    sendText: (target, body) => sender.text(target as ReplyTarget, body),
  });

  // ── 入站：经过中间件链后的消息交给 dsh agent ──
  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    // 能收到消息就说明通道通了：先把上次没发出去的补发掉，再处理这一条
    void outbound.flushPending();
    await handleInbound(mCtx, manager, logger, sender.text);
  });

  // ── 出站：dsh session/event → QQ 消息 ──
  // tools 服务（工具结果结构化展示）
  const toolsRegistry = (ctx as unknown as { tools?: ToolsRegistryLike }).tools;

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
  // 非当前会话的来源头 + 尾部链接行由 sender.decorate 统一加，这里不再重复
  const deliverablesDeliverer = new DeliverablesDeliverer(sender, mediaSender, config, logger);

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
  // 不只当前会话（多会话输出都要回 QQ）。运行期 `cd`（working-directory/change）
  // 只动会话的运行目录，不改聊天工作区，这里不拦。
  (ctx as unknown as {
    on(event: string, handler: (...args: unknown[]) => void, options?: { global?: boolean }): void;
  }).on('session/event', ((session: SessionLike, event: RawSessionEvent) => {
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
  manager.retryChannel = new RetryChannel(sender, config, logger);

  // ── 会话确认通道（/clear、/new 在会话还在时先问一次） ──
  // 同样不 install：只被命令层发起、被 interaction 分发调用
  manager.sessionConfirmChannel = new SessionConfirmChannel(manager, sender, config, logger);

  // ── 按钮点击回调（interaction）：统一分发到问答/审批通道 ──
  bot.on('interaction', async (_iCtx: unknown, event: InteractionEvent) => {
    // 按钮只认绑定用户：非 owner 的点击不登记凭证、不分发、不回 ack
    if (!isOwner(config.access.owner, event.user_openid)) return;
    // 记录互动事件 id，作为后续被动回复候选（event_id，仅内存）
    replyStore.recordEvent('c2c', event.user_openid, event.id);

    const matched = dispatchInteraction(event, manager);
    await bot.acknowledgeInteraction(event.id, matched ? 0 : 3).catch(() => {});
  });

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${errorMessage(err)}`);
  });

  // 掉线可观测：willReconnect=false 表示不会再重连（随后 bot.start() 的 Promise 会失败）。
  bot.on('disconnected', (event: GatewayDisconnect) => {
    const detail = `code=${event.code}${event.reason ? ` reason=${event.reason}` : ''}`;
    if (event.willReconnect) {
      logger.warn(`Bot disconnected (${detail}), reconnecting...`);
    } else {
      logger.error(`Bot disconnected permanently (${detail}), giving up`);
      // 不会自动重连了：积压消息已经没有送达路径，先丢掉再释放全部持有。
      // 会话不 cancel、不 dispose，仍可在 Web 端继续；重新扫码后由用户手动接回。
      outbound.clearPending();
      manager.releaseAll('gateway');
    }
  });

  onGatewayConnected(bot, (event) => {
    console.log(`[qqterm] Bot ${event}! appId=${config.appId}`);

    // 通道恢复：补发断线期间积压的消息（按会话、按原顺序）
    void outbound.flushPending();

    // 启动恢复：把上次的会话接回来，避免「/status 说未建立、下一条消息又能接回」。
    // 失败时主动推一条带重试入口的消息——重启后没有入站消息，只能发给持久化的
    // 最后交互用户（/sessions resume 是幂等的，重试安全）。
    void manager.restoreCurrentSession()
      .then(async (outcome) => {
        if (outcome.kind !== 'failed') return;
        const reason = outcome.locked ? '另一个客户端正在使用' : '宿主报错';
        const text = [
          `⚠️ 上次的会话没能恢复（${reason}）`,
          commandLink(`/sessions resume #${shortSessionId(outcome.sessionId)}`, '重试恢复'),
        ].join('\n');
        await sender.text({ scope: 'c2c', targetId: outcome.targetId }, text);
      })
      .catch((err: unknown) => {
        logger.warn(`启动恢复会话失败: ${errorMessage(err)}`);
      });

    // 上一次 /plugins reload 的结果只能靠状态文件带到这个 fiber：连上后补发一条被动回复。
    // reconcile 可能还在 dispose 旧 fiber（实测约 10s）：结论没落盘时 announce 转后台轮询。
    void reloader.announce(bot).catch((err: unknown) => {
      logger.warn(`热重载结果播报失败: ${errorMessage(err)}`);
    });

    // 插件安装可能把 qqterm 自己换掉：新 fiber 连上后补发上一次安装 / 更新的结果
    void installer.announce(bot).catch((err: unknown) => {
      logger.warn(`插件操作结果播报失败: ${errorMessage(err)}`);
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
          logger.warn(`指令面板同步失败: ${errorMessage(err)}`);
        });
    }

    // 自定义菜单：单聊窗口底部的固定入口（四个按钮 + 权限 / 思考两个子菜单）
    if (config.menu.autoSync) {
      void syncCommandMenu(bot.api, logger)
        .then((result: MenuSyncResult) => {
          logger.info(`自定义菜单已同步: ${result.count} 项`);
        })
        .catch((err: unknown) => {
          logger.warn(`自定义菜单同步失败: ${errorMessage(err)}`);
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
        logger.error(`Bot start failed: ${errorMessage(err)}`);
        // 握手就失败（例如 appSecret 失效）：同样是整条渠道不可用
        outbound.clearPending();
        manager.releaseAll('start');
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
