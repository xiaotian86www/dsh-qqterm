/**
 * 插件安装 / 更新 — 把宿主的 `pluginManager` 包装成一条 QQ 命令能用的能力。
 *
 * 三条硬约束决定了这里的形状：
 *   1. `installBundle` / `updateBundle` 内部会 reconcile profile，可能把 qqterm
 *      自己 dispose 掉。命令处理器必须先回执、再把工作交给脱离当前 fiber 的定时器。
 *   2. 结论只有落盘才能活过 dispose：新 fiber 连上时读状态文件补发，读不到就等
 *      下一次 ready 或下一条命令前的补发。
 *   3. 宿主的 HMR 事务是 AsyncLocalStorage：本 fiber 若是在上一轮事务里创建的，
 *      直接提交会被判成嵌套事务，必须先 `exit()`（见 `outsideHmrTransaction`）。
 *
 * 与 `/plugins reload` 的一处刻意不同：重载失败读不到结论就不等，这里会轮询最长
 * 10 分钟。因为 `updateBundle` 的 reconcile 在它返回**之前**就跑完了，新 fiber 的
 * ready 往往早于结果落盘；不轮询就只能等用户下次发命令，等于「更新完了没反应」。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  entryReplaced,
  entryUids,
  errorText,
  outsideHmrTransaction,
  resolveProfileDir,
  type LoaderLike,
} from '../shared/index.ts';
import type { Logger } from '../types.ts';
import {
  describePluginOpState,
  pluginOpStatePath,
  pluginUpdateCachePath,
  readPluginOpState,
  readPluginUpdateCache,
  writePluginOpState,
  writePluginUpdateCache,
  type PluginAction,
  type PluginOpNotice,
  type PluginOpState,
  type PluginUpdateCache,
} from './state.ts';
import { pickLatestVersion, renderPluginResult } from './format.ts';
import type {
  BundleInfoLike,
  ChangeResultLike,
  PluginManagerLike,
  PluginUpdateResultLike,
} from './types.ts';

/** 本插件在组合里的 entry id（与 bundle patch 的 entry id 一致） */
const ENTRY_ID = 'qqterm';

/** 回执之后再开工：给被动回复留出送达时间 */
const OP_DELAY_MS = 200;
/** 超过这个时长的记录不再当作「进行中」（陈旧记录只播报一次失败） */
const STALE_MS = 600_000;
/** 结果轮询间隔（reconcile 通常在一秒内落盘） */
const POLL_MS = 2_000;

/** 一次安装 / 更新的请求 */
export interface PluginOpRequest {
  action: PluginAction;
  /** 展示与重试用的原始目标（install 是 spec，update 是包名） */
  target: string;
  /** install 实际提交的 spec（缺省用 target） */
  spec?: string;
  /** update 的目标版本；缺省由 registry 上最新的可用版本决定 */
  version?: string;
  /** 用户显式批准的构建脚本包名 */
  approvedBuilds?: string[];
  notify?: PluginOpNotice;
}

export interface PluginInstaller {
  /** 全部已安装 bundle（含官方；列表渲染只取第三方） */
  list(): Promise<BundleInfoLike[]>;
  find(name: string): Promise<BundleInfoLike | undefined>;
  /** 上一个操作还在跑时返回它的状态（命令据此拒绝新请求，避免覆盖结果） */
  pending(): PluginOpState | undefined;
  /** 写状态并调度一次操作；调用方负责先回执并传入发结果用的 bot */
  run(request: PluginOpRequest, bot?: QQBot): void;
  /** 新 fiber 连上、或下一条命令开始前：补发上一次操作的结果 */
  announce(bot: QQBot): Promise<void>;
  /** 上次操作的一句话描述（`/bot-status` 用） */
  describe(): string | undefined;
  /** 后台检查的结果（没有检查记录时 undefined）；列表据此标新版本 */
  updates(): PluginUpdateCache | undefined;
  /** 查一遍 registry，把可更新的版本写进缓存；失败按包跳过，不抛错 */
  checkUpdates(): Promise<void>;
}

export interface PluginInstallerOptions {
  /** 状态文件路径（单测注入临时目录，避免读写真实的 ~/.dsh-qqterm） */
  statePath?: string;
  /** 更新检查结果的路径（默认与状态文件同目录） */
  updatesPath?: string;
}

/** 带原因码的拒绝：宿主的 listVersions 用返回值表达，这里统一成异常便于收口 */
class PluginRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** 更新结果：要么「已是最新」，要么是宿主的一次真实更新 */
type UpdateOutcome =
  | { kind: 'up-to-date'; version: string }
  | { kind: 'result'; value: PluginUpdateResultLike };

/** 安装结果 → 状态字段 */
function installOutcome(result: ChangeResultLike): Partial<PluginOpState> {
  if (result.pendingBuilds !== undefined && result.pendingBuilds.length > 0) {
    return { phase: 'failed', code: 'pending-builds', pendingBuilds: [...result.pendingBuilds] };
  }
  if (result.application === 'failed') {
    return { phase: 'failed', code: result.error?.code, error: result.error?.diagnostic };
  }
  if (result.application === 'cancelled') return { phase: 'failed', code: 'cancelled' };
  return {
    phase: 'done',
    application: result.application,
    version: result.version,
    ...(result.bundle === undefined ? {} : { name: result.bundle }),
  };
}

/** 更新结果 → 状态字段 */
function updateOutcome(outcome: UpdateOutcome): Partial<PluginOpState> {
  if (outcome.kind === 'up-to-date') {
    return { phase: 'done', upToDate: true, version: outcome.version };
  }
  const { from, to, result, restore } = outcome.value;
  const rolledBack = restore?.application === 'applied';
  if (result.application === 'failed') {
    return { phase: 'failed', from, to, code: result.error?.code, error: result.error?.diagnostic, rolledBack };
  }
  if (result.application === 'cancelled') {
    return { phase: 'failed', from, to, code: 'cancelled', rolledBack };
  }
  return { phase: 'done', from, to, application: result.application, version: to };
}

export function createPluginInstaller(
  ctx: Context,
  logger: Logger,
  options?: PluginInstallerOptions,
): PluginInstaller {
  const services = ctx as unknown as { get?: (name: string) => unknown };
  const manager = services.get?.('pluginManager') as PluginManagerLike | undefined;
  // 提前抓 loader：本插件被换掉之后旧 ctx 就不可再访问，而 loader 属于宿主
  const loader = services.get?.('loader') as LoaderLike | undefined;
  const statePath = options?.statePath ?? pluginOpStatePath(resolveProfileDir(ctx));
  const updatesPath = options?.updatesPath ?? pluginUpdateCachePath(resolveProfileDir(ctx));

  /** 结果投递串行化：新 fiber 的 ready 与「下一条命令前补发」可能同时触发 */
  let delivering = false;
  /** 结果轮询只能有一份：多次 ready / announce 不能各起一条轮询链 */
  let watching = false;

  /** 发结果通知；成功才清 notify，失败留给下一次 ready 重试 */
  const deliver = async (bot: QQBot, state: PluginOpState): Promise<void> => {
    if (delivering) return;
    const notice = state.notify;
    if (notice === undefined || notice.targetId === '') return;
    const text = renderPluginResult(state);
    if (text === undefined) return;
    delivering = true;
    try {
      // 被动回复凭证由 ReplyStore 提供（msg_id 已落盘），这里只给投递目标
      await bot.sendMarkdown({ scope: 'c2c', targetId: notice.targetId }, text);
      // 只清这一轮的 notify：发送期间可能已有新一轮写下了自己的通知
      const latest = readPluginOpState(statePath, logger);
      if (latest !== undefined && latest.startedAt === state.startedAt) {
        writePluginOpState(statePath, { ...latest, notify: undefined }, logger);
      }
    } catch (err) {
      logger.warn(`插件操作结果通知失败: ${errorText(err)}`);
    } finally {
      delivering = false;
    }
  };

  /**
   * 后台等结果：reconcile 在 install 返回前完成，新 fiber 的 ready 常早于落盘，
   * 所以看到「还在跑」不能直接放弃。只等自己这一轮（startedAt 变了就让位）。
   */
  const watch = (bot: QQBot, startedAt: number): void => {
    if (watching) return;
    watching = true;
    const deadline = Date.now() + STALE_MS;

    const tick = async (): Promise<void> => {
      const latest = readPluginOpState(statePath, logger);
      if (latest === undefined || latest.startedAt !== startedAt) {
        watching = false;
        return;
      }
      if (latest.phase !== undefined) {
        watching = false;
        await deliver(bot, latest);
        return;
      }
      if (Date.now() >= deadline) {
        const failed: PluginOpState = { ...latest, phase: 'failed', code: 'timeout' };
        writePluginOpState(statePath, failed, logger);
        watching = false;
        await deliver(bot, failed);
        return;
      }
      setTimeout(() => void tick(), POLL_MS).unref?.();
    };

    setTimeout(() => void tick(), POLL_MS).unref?.();
  };

  /** 解析更新目标：没给版本时问 registry，选一个可升级的版本 */
  const resolveUpdate = async (request: PluginOpRequest): Promise<UpdateOutcome> => {
    if (manager === undefined) throw new PluginRefusal('operation-error', '当前 profile 没有插件管理能力');
    let version = request.version;
    if (version === undefined) {
      const list = await manager.listVersions(request.target);
      if (list.status === 'refused') throw new PluginRefusal(list.problem, list.reason);
      const picked = pickLatestVersion(list.versions);
      if (picked === undefined) return { kind: 'up-to-date', version: list.installed };
      version = picked.version;
    }
    return { kind: 'result', value: await manager.updateBundle(request.target, version) };
  };

  /** 装到新版本后把该包从「可更新」缓存里划掉，等下一轮检查重新判断 */
  const forgetUpdate = (name: string): void => {
    const cache = readPluginUpdateCache(updatesPath, logger);
    if (cache === undefined || cache.versions[name] === undefined) return;
    const versions = { ...cache.versions };
    delete versions[name];
    writePluginUpdateCache(updatesPath, { checkedAt: cache.checkedAt, versions }, logger);
  };

  /** 真正干活：先落状态，再决定由谁补发结果 */
  const execute = async (
    request: PluginOpRequest,
    startedAt: number,
    before: ReturnType<typeof entryUids> | undefined,
    bot: QQBot | undefined,
  ): Promise<void> => {
    if (manager === undefined) {
      const failed: PluginOpState = {
        startedAt,
        action: request.action,
        target: request.target,
        phase: 'failed',
        code: 'operation-error',
        error: '当前 profile 没有插件管理能力',
      };
      writePluginOpState(statePath, failed, logger);
      if (bot !== undefined) await deliver(bot, failed);
      return;
    }

    let extra: Partial<PluginOpState>;
    try {
      extra = request.action === 'install'
        ? installOutcome(await outsideHmrTransaction(ctx, () =>
          manager.installBundle(request.spec ?? request.target, {
            ...(request.approvedBuilds === undefined || request.approvedBuilds.length === 0
              ? {}
              : { approvedBuilds: request.approvedBuilds }),
          })))
        : updateOutcome(await outsideHmrTransaction(ctx, () => resolveUpdate(request)));
    } catch (err) {
      extra = err instanceof PluginRefusal
        ? { phase: 'failed', code: err.code, error: err.message }
        : { phase: 'failed', code: 'operation-error', error: errorText(err) };
    }

    const state: PluginOpState = {
      startedAt,
      action: request.action,
      target: request.target,
      ...(request.notify === undefined ? {} : { notify: request.notify }),
      ...extra,
    };
    writePluginOpState(statePath, state, logger);
    if (state.phase === 'done') forgetUpdate(state.name ?? request.target);

    const after = entryUids(loader);
    if (bot !== undefined && entryReplaced(before, after, ENTRY_ID) !== true) {
      await deliver(bot, state);
    }
  };

  return {
    async list(): Promise<BundleInfoLike[]> {
      if (manager === undefined) throw new Error('当前 profile 没有插件管理能力');
      return await manager.listBundles();
    },

    async find(name: string): Promise<BundleInfoLike | undefined> {
      if (manager === undefined) return undefined;
      const bundles = await manager.listBundles();
      return bundles.find((bundle) => bundle.name === name);
    },

    pending(): PluginOpState | undefined {
      const state = readPluginOpState(statePath, logger);
      if (state === undefined || state.phase !== undefined) return undefined;
      if (Date.now() - state.startedAt > STALE_MS) return undefined;
      return state;
    },

    run(request: PluginOpRequest, bot?: QQBot): void {
      const startedAt = Date.now();
      const before = entryUids(loader);
      // 先只记「在装什么、往哪回」：结论要等宿主返回才知道，写在这里的是待补发记录
      writePluginOpState(statePath, {
        startedAt,
        action: request.action,
        target: request.target,
        ...(request.notify === undefined ? {} : { notify: request.notify }),
      }, logger);

      // 脱离当前 fiber：命令处理器返回后这个 fiber 可能被 reconcile 掉
      const timer = setTimeout(() => {
        void execute(request, startedAt, before, bot).catch((err: unknown): void => {
          logger.warn(`插件操作执行失败: ${errorText(err)}`);
        });
      }, OP_DELAY_MS);
      timer.unref?.();
    },

    describe(): string | undefined {
      return describePluginOpState(readPluginOpState(statePath, logger));
    },

    updates(): PluginUpdateCache | undefined {
      return readPluginUpdateCache(updatesPath, logger);
    },

    async checkUpdates(): Promise<void> {
      if (manager === undefined) return;
      const bundles = await manager.listBundles();
      // 旧结果只用来兜单个包的查询失败，不能整体沿用：退装的包要消失
      const previous = readPluginUpdateCache(updatesPath, logger)?.versions ?? {};
      const versions: Record<string, string> = {};

      for (const bundle of bundles) {
        if (!bundle.installed || bundle.official || !bundle.updatable) continue;
        try {
          const list = await manager.listVersions(bundle.name);
          if (list.status !== 'listed') continue;
          const picked = pickLatestVersion(list.versions);
          if (picked !== undefined) versions[bundle.name] = picked.version;
        } catch (err) {
          const kept = previous[bundle.name];
          if (kept !== undefined) versions[bundle.name] = kept;
          logger.debug(`检查插件更新失败 (${bundle.name}): ${errorText(err)}`);
        }
      }

      writePluginUpdateCache(updatesPath, { checkedAt: Date.now(), versions }, logger);
    },

    async announce(bot: QQBot): Promise<void> {
      const state = readPluginOpState(statePath, logger);
      if (state === undefined || state.notify === undefined) return;

      if (state.phase === undefined) {
        if (Date.now() - state.startedAt > STALE_MS) {
          const failed: PluginOpState = { ...state, phase: 'failed', code: 'timeout' };
          writePluginOpState(statePath, failed, logger);
          await deliver(bot, failed);
          return;
        }
        // 结论还没落盘：后台轮询，不阻塞命令处理
        watch(bot, state.startedAt);
        return;
      }

      await deliver(bot, state);
    },
  };
}
