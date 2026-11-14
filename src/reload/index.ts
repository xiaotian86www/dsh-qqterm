/**
 * 插件热重载 — 把「应用 profile 磁盘变更」包装成一条命令能用的能力。
 *
 * 一次重载会 dispose 当前 fiber，因此这里有三条硬约束：
 *   1. `hmr` 只按可选服务探测（`ctx.get('hmr')`），不能进 inject：
 *      开发 profile 常把它关掉，headless 组合包也没有这个服务。
 *      探测必须是「每次用时再取」：宿主并发加载各 entry，hmr 可能在本插件
 *      apply 之后才注册；启动时取一次会把它永久判成不可用。
 *   2. 命令处理器跑在即将被销毁的 fiber 里，必须先写完状态、再回复，
 *      最后用脱离 fiber 的原生定时器调度重载。
 *   3. 重载失败不回滚（旧 fiber 已经没了），结果只能落盘，由新 fiber 读回。
 *
 * 结果通知有两条路：本插件被替换时没有「旧实例补发」的机会，由新 fiber 连上
 * （`ready` 或续传的 `resumed`）时读状态文件补上；本插件没被替换（磁盘上没变、
 * 或变的是别人）时不会有新的连接，只能由当前实例在重载结束后自己发。
 *
 * 新 fiber 连上时结论可能还没落盘（reconcile 还在跑），这里不等待：读不到结论就
 * 什么都不发，留给下一条 `/plugins reload` 开始前的补发。等待换来的只是「早几十毫秒
 * 送达」，代价是一整套超时判断。
 *
 * 「到底换没换」靠重载前后比各 entry 的 fiber uid：`reconcileProfile` 的返回值
 * 里没有这个信息，而用户最想知道的恰恰是「这次到底应用了什么」。
 *
 * 还有一处坑：本插件若是上一轮重载装进来的，它的 async 上下文继承了宿主的
 * `executing = true`，直接 `runExclusive` 会被判成嵌套事务 —— 所以提交前要先
 * `executing.exit()`（见 `outsideTransaction`）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  changedEntries,
  entryReplaced,
  entryUids,
  errorText,
  resolveProfileDir,
  type LoaderLike,
} from '../shared/index.ts';
import type { Logger } from '../types.ts';
import {
  describeReloadState,
  readReloadState,
  reloadStatePath,
  writeReloadState,
  type ReloadNotice,
  type ReloadState,
} from './state.ts';

/** 本插件在组合里的 entry id（bundle patch 与用户配置都按它定位，是兼容契约） */
const ENTRY_ID = 'qqterm';

/** 宿主 HMR 服务的最小接口（只用这两个方法） */
interface HmrLike {
  runExclusive<T>(operation: () => Promise<T> | T): Promise<T>;
  reconcileProfile(requiredIds?: string[]): Promise<{ restartReason?: string }>;
  /** `hmr` 内部的 AsyncLocalStorage（同一实例上，用来跳出上一轮的上下文） */
  executing?: ExecutingLike;
}

/** AsyncLocalStorage 的最小接口：只用 exit */
interface ExecutingLike {
  exit<T>(callback: () => T): T;
}

export interface Reloader {
  /** 当前 profile 是否可用热重载（未启用时为 false，命令据此提示） */
  readonly available: boolean;
  /** 写状态并调度一次重载；调用方负责先回复用户，并传入发结果用的 bot */
  run(notice?: ReloadNotice, bot?: QQBot): void;
  /** 上次重载的一句话描述（`/status` 用） */
  describe(): string | undefined;
  /** 新 fiber 连上、或下一条命令开始前：补发上一次重载留下的结果 */
  announce(bot: QQBot): Promise<void>;
}

/** 构造参数 */
export interface ReloaderOptions {
  /** 状态文件路径（单测注入临时目录，避免读写真实的 ~/.dsh-qqterm） */
  statePath?: string;
}

/** 回复之后再重载：给被动回复留出送达时间 */
const RELOAD_DELAY_MS = 200;
/** 超过这个时长的记录不再播报（避免下次正常重启时冒出陈旧通知） */
const STALE_MS = 600_000;

/**
 * 在「不在 HMR 事务里」的上下文执行。
 *
 * 本插件若是上一轮重载装进来的，它整个 async 上下文都继承了 `executing = true`
 * （fiber 是在事务里创建的），再调 `runExclusive` 就会被判成嵌套事务。
 * `exit()` 临时清掉这个继承值，新事务才开得起来。
 */
function outsideTransaction<T>(hmr: HmrLike, operation: () => Promise<T>): Promise<T> {
  const executing = hmr.executing;
  if (executing === undefined || typeof executing.exit !== 'function') return operation();
  return Promise.resolve(executing.exit(operation));
}

/** 提交一次重载；拿不到 executing 又撞上嵌套时，退化成直接调用（此时已在事务上下文里） */
async function reloadOnce(hmr: HmrLike): Promise<{ restartReason?: string }> {
  try {
    return await outsideTransaction(hmr, () => hmr.runExclusive(async () => hmr.reconcileProfile()));
  } catch (err) {
    if (err instanceof Error && err.message.includes('cannot be nested')) return await hmr.reconcileProfile();
    throw err;
  }
}

export function createReloader(ctx: Context, logger: Logger, options?: ReloaderOptions): Reloader {
  const services = ctx as unknown as { get?: (name: string) => unknown };
  /**
   * 按需读服务：hmr 可能晚于本插件的 apply 才注册，启动时快照会误判成不可用。
   * 本插件被换掉之后旧 ctx 不可再访问，所以 run() 入口处取一次并持有到调度结束。
   */
  const service = <T>(name: string): T | undefined => services.get?.(name) as T | undefined;
  const statePath = options?.statePath ?? reloadStatePath(resolveProfileDir(ctx));

  /**
   * 结果投递串行化：新 fiber 的 ready 补发与「下次命令前补发」可能同时触发，
   * 两条都会把上一轮的结果发一遍。后到的那条直接让位，先到的负责送达。
   */
  let delivering = false;

  /** 发结果通知；成功才清 notify，失败留给下一个 ready 重试 */
  const deliver = async (bot: QQBot, state: ReloadState): Promise<void> => {
    if (delivering) return;
    const notice = state.notify;
    if (notice === undefined || notice.targetId === '') return;
    if (Date.now() - state.startedAt > STALE_MS) {
      writeReloadState(statePath, { ...state, notify: undefined }, logger);
      return;
    }
    const text = resultText(state);
    if (text === undefined) return;
    delivering = true;
    try {
      // 被动回复凭证由 ReplyStore 提供（msg_id 已落盘），这里只给投递目标
      await bot.sendMarkdown({ scope: 'c2c', targetId: notice.targetId }, text);
      // 只清这一轮的 notify：发送期间可能已有新一轮写下了自己的通知
      const latest = readReloadState(statePath, logger);
      if (latest !== undefined && latest.startedAt === state.startedAt) {
        writeReloadState(statePath, { ...latest, notify: undefined }, logger);
      }
    } catch (err) {
      logger.warn(`热重载结果通知失败: ${errorText(err)}`);
    } finally {
      delivering = false;
    }
  };

  return {
    get available(): boolean {
      return service<HmrLike>('hmr') !== undefined;
    },

    run(notice?: ReloadNotice, bot?: QQBot): void {
      const startedAt = Date.now();
      const hmr = service<HmrLike>('hmr');
      const loader = service<LoaderLike>('loader');
      const before = entryUids(loader);
      // 先只记「往哪回」：结论要等 reconcile 跑完才知道，写在这里的就是待补发记录
      writeReloadState(statePath, {
        startedAt,
        ...(notice === undefined ? {} : { notify: notice }),
      }, logger);
      if (hmr === undefined) return;

      // 脱离当前 fiber：命令处理器返回后这个 fiber 就会被 dispose
      const timer = setTimeout(() => {
        void reloadOnce(hmr)
          .then(async (result): Promise<void> => {
            const after = entryUids(loader);
            const replaced = changedEntries(before, after);
            const done: ReloadState = {
              phase: 'done',
              startedAt,
              ...(notice === undefined ? {} : { notify: notice }),
              ...(replaced === undefined ? {} : { replaced }),
              ...(result.restartReason === undefined ? {} : { restartReason: result.restartReason }),
            };
            writeReloadState(statePath, done, logger);
            // 自己没被换掉就没有新的 ready，只能由当前实例补发
            if (bot !== undefined && entryReplaced(before, after, ENTRY_ID) !== true) await deliver(bot, done);
          })
          .catch((err: unknown): void => {
            const after = entryUids(loader);
            const replaced = changedEntries(before, after);
            const failed: ReloadState = {
              phase: 'failed',
              startedAt,
              ...(notice === undefined ? {} : { notify: notice }),
              ...(replaced === undefined ? {} : { replaced }),
              error: errorText(err),
            };
            writeReloadState(statePath, failed, logger);
            logger.warn(`插件热重载失败: ${errorText(err)}`);
            if (bot !== undefined && entryReplaced(before, after, ENTRY_ID) !== true) void deliver(bot, failed);
          });
      }, RELOAD_DELAY_MS);
      timer.unref?.();
    },

    describe(): string | undefined {
      return describeReloadState(readReloadState(statePath, logger));
    },

    async announce(bot: QQBot): Promise<void> {
      const state = readReloadState(statePath, logger);
      // 还没跑完（没有 phase）：不猜等待，留给下一次命令前的补发
      if (state === undefined || state.phase === undefined) return;
      await deliver(bot, state);
    },
  };
}

/**
 * 结果文案：一行结论，必要时再补一行下一步。
 *
 * 三种结论分别对应「换掉了谁」「什么都没换」「判不出来」，别把它们合成一句话：
 * 用户要靠这个区分「命令跑了但白跑」和「真的有新代码生效」。
 */
function resultText(state: ReloadState): string | undefined {
  if (state.phase === 'failed') {
    return state.error === undefined
      ? '❌ 重载失败，重启 dsh 恢复'
      : `❌ 重载失败: ${state.error}\n重启 dsh 恢复。`;
  }
  if (state.phase !== 'done') return undefined;
  const applied = describeApplied(state.replaced);
  if (state.restartReason === undefined) return applied;
  return `${applied}\n⚠️ 部分改动需重启 dsh 才生效`;
}

/** 「应用了什么」：区分「有替换」与「没有任何变化」 */
function describeApplied(replaced: string[] | undefined): string {
  if (replaced === undefined) return '✅ 已应用变更';
  if (replaced.length === 0) return '✅ 没有需要应用的变更';
  const names = replaced.slice(0, 3).join(' · ');
  return replaced.length > 3
    ? `✅ 已应用变更: ${names} 等 ${replaced.length} 个`
    : `✅ 已应用变更: ${names}`;
}
