/**
 * dsh-qqterm — QQ Bot IM channel plugin for deepseek-harness
 *
 * Cordis 插件入口。将 QQ 消息平台作为 dsh 的前端协议驱动。
 * 网关组装（中间件编排 + 事件 + 出站 + 生命周期）见 src/gateway/；
 * 凭据绑定编排（扫码状态机 + 端内绑定页路由）见 src/setup/。
 */
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, type QQTermConfig } from './config.ts';
import { bootstrapGateway } from './gateway/index.ts';
import type { DshAgentRegistry } from './session/index.ts';
import { getProfileDir, outsideHmrTransaction, resolveEnv } from './shared/index.ts';
import { ensureCredentials, persistCredentialsToProfile, registerBoundCredentialRoutes } from './setup/index.ts';
import type { Logger } from './types.ts';

// ── Cordis 插件元数据 ──
export const name = 'qqterm';
// 四个 web 专属服务不入 inject，按部署可选：
// - agentPresets：缺它时 /preset 整条不注册、建会话不挂 preset；
// - sessionController：能力不依赖它，/model、/reasoning 直接写 dsh-agent 的
//   agent.model.select，只有 adapter 软读一次 list() 取 /sessions 的排序时间；
// - webServer：只有 web / Desktop 有 dsh-host-webserver，端内绑定页经 ctx.inject
//   可选挂载，缺服务时扫码只走终端 / 浏览器降级通道；
// - workspaceRegistry：缺它时 /sessions 仍按目录分组，只有路径、没有归档，
//   归档子命令按未知子命令处理。
export const inject = [
  'agents',
  'llm',
  'agentDefaultModel',
  'sessionProjections',
  'sessionPersistence',
  'sessionQuery',
  'sessionTitle',
  'permissionPresets',
  'settings',
  // 宿主斜杠命令登记簿（dsh-base 的 dsh-commands）：/compact 的判定与执行都走它
  // 能力是否存在，不经过 web 的 preset 服务。
  'commands',
  'tools',
  'attachments',
  // 会话目录（defaultDirectory / get）由 dsh-base 的 working-directory 提供：
  // 若按可选服务软读，Cordis 代理会在属性未注入时直接抛错，可选链兜不住。
  'workingDirectory',
  // 插件安装 / 更新（/plugins）：web / desktop / CLI profile 由 dsh-base 提供；
  // 服务缺失时插件保持 inactive，不写「能力不可用」的降级分支。
  'pluginManager',
];
export const Config = ConfigSchema;

export type { QQTermConfig } from './config.ts';

/** 扫码成功后等待宿主热重载的宽限时间；超时则本 fiber 直接启动网关 */
const HMR_GRACE_MS = 2000;

// ── 插件主体 ──
export async function apply(ctx: Context, config: QQTermConfig): Promise<void> {
  const agents = (ctx as unknown as Record<string, unknown>).agents as DshAgentRegistry;
  const logger: Logger = ((ctx as unknown as Record<string, unknown>).logger as Logger) ?? console;

  let appId = resolveEnv(config.appId, 'QQBOT_APPID');
  let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');

  // 本 fiber 内已启动网关时回填：扫码成功不再等待 HMR 重载，
  // 状态接口据此从 saving 收敛到 bound
  let boundAppId: string | null = null;

  // ── 凭据缺失时唤起扫码绑定 ──
  if (!appId || !appSecret) {
    logger.info('凭据未配置，启动扫码绑定...');

    // 关键：不 await 扫码结果。boot 会等 Loader 树稳定（loader.await()），
    // 无限期等待用户扫码会阻塞 Host ready——Desktop 界面无法进入、
    // Web 的 URL 延迟输出。绑定编排（路由/呈现/生命周期）在
    // ensureCredentials 的同步阶段即完成，凭据就绪后由异步链接管。
    void ensureCredentials(ctx, {
      logger,
      config: { ...config },
      boundAppId: () => boundAppId,
    })
      .then((credentials): void => {
        if (!credentials) {
          // null 包括：扫码取消、手动提交（已另行持久化）、流程失败
          logger.info('扫码绑定流程结束（未获取凭据或已手动配置）');
          return;
        }

        // 持久化到 profile 供下次启动使用。是否写盘成功都要在本 fiber 内直接
        // 启动网关：写入 patch 只是「下次重启不用再扫」，HMR 不在时也能立即生效。
        // 注意：不写入 process.env——resolveEnv 的 env 回退属于用户显式
        // export 的配置语义，运行时写入会与解绑清理不对齐（解绑后 HMR
        // 重载的新 fiber 仍从 env 读到旧凭据，状态停留 bound）
        const persisted = persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);
        if (!persisted) {
          logger.warn('凭据未能持久化，本次进程将使用扫码凭据启动（重启后需重新绑定）');
        }

        const startGateway = (): void => {
          boundAppId = credentials.appId;
          // 网关必须建在 HMR 事务之外：否则它派生的每条入站消息都带着
          // 「正在应用变更」标记，之后写配置会被宿主当成嵌套事务拒绝
          void outsideHmrTransaction(ctx, () => bootstrapGateway(ctx, agents, {
            ...config,
            appId: credentials.appId,
            appSecret: credentials.appSecret,
          }, logger)).catch((err: unknown) => {
            boundAppId = null;
            logger.error(`网关启动失败: ${err instanceof Error ? err.message : String(err)}`);
          });
        };

        if (!persisted) {
          startGateway();
          return;
        }

        // 写入 patch 后先给热重载一个窗口：重载成功时本 fiber 会被销毁，
        // 随 fiber 注销的定时器不再触发，避免两个网关同时连 QQ。
        // 宿主没有可用 HMR（或配置变更未触发重载）时，窗口结束就在本 fiber 启动。
        const timer = setTimeout(startGateway, HMR_GRACE_MS);
        timer.unref?.();
        (ctx as unknown as { effect(fn: () => () => void, name?: string): void })
          .effect(() => () => clearTimeout(timer), 'qqterm.deferred-gateway');
      })
      .catch((err: unknown) => {
        // 全兜：unhandled rejection 会被宿主 fail-loud 判致命
        logger.error(`扫码绑定流程异常: ${err instanceof Error ? err.message : String(err)}`);
      });

    // apply 立即完成，插件 fiber 进入 ACTIVE，Host ready 不再被阻塞
    return;
  }

  // 已绑定：注册常驻路由（状态回显 + 手动编辑/更换凭据 + 配置编辑）
  registerBoundCredentialRoutes(ctx, logger, appId, { ...config });

  const resolvedConfig: QQTermConfig = { ...config, appId, appSecret };

  await outsideHmrTransaction(ctx, () => bootstrapGateway(ctx, agents, resolvedConfig, logger));
}
