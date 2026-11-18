/**
 * 入站处理器：消息必须立刻交给目标会话，不能挂在「本轮结束」上
 *
 * 回归点：处理函数等 `whenIdle()` 会让 concurrencyGuard（以 QQ 用户为键）一直
 * 占着锁，正在生成的会话因此挡住另一个空闲会话，用户看到的是「发给空闲会话的
 * prompt 在排队」。会话内的先后由宿主 next-turn inbox 保证，这里只验证派发。
 */
import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { handleInbound } from '../../src/transport/inbound.ts';
import { WorktreeError } from '../../src/session/worktree.ts';
import type { SessionManager, SessionRecord } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeCtx(content = 'hi', messageId = 'm1'): MiddlewareContext {
  return {
    bot: { sendMarkdown: vi.fn(async () => ({ id: 'm2' })) },
    message: { content, senderId: 'u1', kind: 'c2c', messageId },
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: messageId },
    state: {},
    log: logger,
    stop: vi.fn(),
    receivedAt: Date.now(),
  } as unknown as MiddlewareContext;
}

/**
 * 造一条「生成中」的会话记录。
 * `whenIdle` 永远不 resolve：旧实现会在这里挂住，测试因此超时失败。
 */
function makeRecord(sessionId: string, status: 'idle' | 'running' = 'running'): {
  record: SessionRecord;
  followup: ReturnType<typeof vi.fn>;
  whenIdle: ReturnType<typeof vi.fn>;
} {
  const followup = vi.fn();
  const whenIdle = vi.fn(() => new Promise<void>(() => {}));
  const agent = {
    id: sessionId,
    ctx: {} as never,
    status,
    session: { id: sessionId, snapshotEvents: () => [] },
    cancel: vi.fn(),
    followup,
    whenIdle,
  };
  const record: SessionRecord = {
    sessionKey: 'qqterm:app:chat',
    sessionId,
    agent: agent as unknown as SessionRecord['agent'],
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
    scope: 'c2c',
    peerId: 'u1',
    senderId: 'u1',
    acquiredAt: Date.now(),
  };
  return { record, followup, whenIdle };
}

function managerOf(records: SessionRecord[]): SessionManager {
  let index = 0;
  return {
    getOrCreate: vi.fn(async () => records[Math.min(index++, records.length - 1)]),
  } as unknown as SessionManager;
}

/** followup 收到的 UserMessage 正文 */
function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map(block => block.text ?? '').join('');
}

describe('handleInbound：派发不等待本轮 turn', () => {
  it('会话生成中也立即返回，不等 whenIdle', async () => {
    const { record, followup, whenIdle } = makeRecord('session-a');
    const manager = managerOf([record]);

    await handleInbound(makeCtx('继续'), manager, logger);

    expect(followup).toHaveBeenCalledTimes(1);
    expect(textOf(followup.mock.calls[0]?.[0])).toBe('继续');
    expect(whenIdle).not.toHaveBeenCalled();
  });

  it('空闲会话的消息马上进 followup，不被另一个生成中的会话挡住', async () => {
    const busy = makeRecord('session-busy');
    const idle = makeRecord('session-idle', 'idle');
    const manager = managerOf([busy.record, idle.record]);

    // 第一条把「当前会话」推进生成中；第二条目标已是空闲会话
    await handleInbound(makeCtx('第一条'), manager, logger);
    await handleInbound(makeCtx('第二条'), manager, logger);

    expect(busy.followup).toHaveBeenCalledTimes(1);
    expect(idle.followup).toHaveBeenCalledTimes(1);
    expect(textOf(idle.followup.mock.calls[0]?.[0])).toBe('第二条');
  });

  it('同一会话连发两条：两条都交给宿主排队，按顺序', async () => {
    const { record, followup } = makeRecord('session-a');
    const manager = managerOf([record]);

    await handleInbound(makeCtx('一'), manager, logger);
    await handleInbound(makeCtx('二'), manager, logger);

    expect(followup).toHaveBeenCalledTimes(2);
    expect(followup.mock.calls.map(call => textOf(call[0]))).toEqual(['一', '二']);
  });
});

describe('handleInbound：工作树', () => {
  /** 取出 bot.sendMarkdown 的调用参数 */
  function sent(ctx: ReturnType<typeof makeCtx>): Array<[unknown, string]> {
    return (ctx.bot.sendMarkdown as unknown as { mock: { calls: Array<[unknown, string]> } }).mock.calls;
  }

  function failingManager(error: unknown): SessionManager {
    return { getOrCreate: vi.fn(async () => { throw error; }) } as unknown as SessionManager;
  }

  it('建树失败：说清会话没创建，重发会重新尝试', async () => {
    const ctx = makeCtx('hi');

    await handleInbound(ctx, failingManager(new WorktreeError('create', 'fatal: cannot lock ref')), logger);

    expect(sent(ctx).at(-1)?.[1]).toBe(
      '❌ 工作树没建成: fatal: cannot lock ref\n本次会话没有创建，重发一次会重新尝试。',
    );
  });

  it('工作树重建失败：给下一步，不谎称会话没了', async () => {
    const ctx = makeCtx('hi');

    await handleInbound(ctx, failingManager(new WorktreeError('restore', 'fatal: path exists')), logger);

    expect(sent(ctx).at(-1)?.[1]).toBe(
      '❌ 工作树重建失败: fatal: path exists · 用 /new 重新开会话',
    );
  });

  it('非工作树错误仍然走通用兜底', async () => {
    const ctx = makeCtx('hi');

    await handleInbound(ctx, failingManager(new Error('EIO')), logger);

    expect(sent(ctx).at(-1)?.[1]).toBe('⚠️ 处理消息时出现异常，请稍后重试。');
  });

  it('新会话建了树：回执只发一次，之后不再重复', async () => {
    const { record } = makeRecord('session-a');
    record.worktreeNotice = '✅ 已在新工作树 `dsh-x` 里开启会话\n路径: `D:\\repo\\.agents\\worktrees\\dsh-x`';
    const manager = managerOf([record]);
    const first = makeCtx('一');

    await handleInbound(first, manager, logger);

    expect(sent(first).some(([, text]) => text === '✅ 已在新工作树 `dsh-x` 里开启会话\n路径: `D:\\repo\\.agents\\worktrees\\dsh-x`')).toBe(true);
    expect(record.worktreeNotice).toBeUndefined();

    const second = makeCtx('二');
    await handleInbound(second, manager, logger);
    expect(sent(second)).toHaveLength(0);
  });
});
