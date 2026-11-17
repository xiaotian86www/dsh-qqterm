/**
 * 状态文件轮询 — 操作结论由「另一条 fiber」落盘时，连上的一方要能等到它。
 *
 * 装 / 卸 / 更新插件和热重载都会把 qqterm 自己换掉：旧 fiber 发不出消息，只能由新
 * fiber 在 `ready` 时读状态文件补发。但 reconcile 要先 dispose 旧 fiber 再重连，可能
 * 比 ready 晚几秒到几十秒（实测热重载约 10s），所以看到「有通知、没结论」不能读一次
 * 就放弃，要后台继续等；等不到就让调用方先回复用户，结论落盘后自己补发。
 *
 * 三条规则：
 *   1. 只等自己这一轮：`startedAt` 变了就让位（用户又发起了一次操作）。
 *   2. 同时只有一条轮询链：多次 ready / 补发不能各起一条。
 *   3. 定时器 unref：不拖住进程退出。
 */
import type { Logger } from '../types.ts';
import { errorText } from './utils.ts';

/** 轮询等待的最小状态形状 */
export interface SettledState {
  /** 本轮操作的起始时间，用来确认等的是同一次操作 */
  startedAt: number;
  /** 结论；undefined 表示还在跑 */
  phase?: string;
}

/** 一次轮询的取数、写回与收尾 */
export interface SettledWatchOptions<T extends SettledState> {
  /** 轮询间隔 */
  pollMs: number;
  /** 超过这个时长仍未落盘，按失败收尾 */
  staleMs: number;
  read(): T | undefined;
  write(state: T): void;
  /** 超时：把记录改成终态（返回值会被播报） */
  expire(state: T): T;
  logger: Logger;
}

/** 起一条后台轮询；已有轮询在跑时直接返回 */
export type SettledWatch<T extends SettledState> = (
  startedAt: number,
  deliver: (state: T) => Promise<void>,
) => void;

export function createSettledWatch<T extends SettledState>(
  options: SettledWatchOptions<T>,
): SettledWatch<T> {
  const { pollMs, staleMs, read, write, expire, logger } = options;
  let watching = false;

  return (startedAt, deliver) => {
    if (watching) return;
    watching = true;
    const deadline = Date.now() + staleMs;

    const tick = async (): Promise<void> => {
      try {
        const latest = read();
        // 又发起了一轮新操作：让位，等那一轮自己的 ready
        if (latest === undefined || latest.startedAt !== startedAt) {
          watching = false;
          return;
        }
        if (latest.phase !== undefined) {
          watching = false;
          await deliver(latest);
          return;
        }
        if (Date.now() >= deadline) {
          const expired = expire(latest);
          write(expired);
          watching = false;
          await deliver(expired);
          return;
        }
        setTimeout(() => void tick(), pollMs).unref?.();
      } catch (err) {
        watching = false;
        logger.warn(`状态文件轮询失败: ${errorText(err)}`);
      }
    };

    setTimeout(() => void tick(), pollMs).unref?.();
  };
}
