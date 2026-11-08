/**
 * 入站处理器：消息必须立刻交给目标会话，不能挂在「本轮结束」上
 *
 * 回归点：处理函数等 `whenIdle()` 会让 concurrencyGuard（以 QQ 用户为键）一直
 * 占着锁，正在生成的会话因此挡住另一个空闲会话，用户看到的是「发给空闲会话的
 * prompt 在排队」。会话内的先后由宿主 next-turn inbox 保证，这里只验证派发。
 */
import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { handleInbound } from './inbound.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { Logger } from '../types.ts';

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
    runMaintenance: vi.fn(),
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
