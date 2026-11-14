/**
 * `/stop` 命令：只中止 current；`/stop all` 交给 manager 批量中止已获取会话。
 *
 * manager 用替身，只验证命令层的参数解析与文案；批量中止的筛选与 pending
 * 清理由 session-admin.spec.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../../src/session/index.ts';
import type { SessionRecord } from '../../src/session/types.ts';
import type { CommandDeps } from '../../src/commands/types.ts';
import { stopCommand } from '../../src/commands/misc.ts';

const PEER = 'user1';
const CURRENT = 'session-9d2c4410-2222-2222-2222-222222222222';

function record(status: 'idle' | 'running') {
  const cancel = vi.fn();
  const value = {
    sessionId: CURRENT,
    agent: { status, cancel },
  } as unknown as SessionRecord;
  return { value, cancel };
}

function makeManager(over: {
  current?: SessionRecord;
  cancelled?: string[];
} = {}) {
  return {
    getSessionRecord: vi.fn(() => over.current),
    cancelAllRunning: vi.fn(() => over.cancelled ?? []),
  } as unknown as SessionManager;
}

function makeCtx(raw: string): SlashCommandHandlerContext {
  return {
    message: { senderId: PEER, kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: SessionManager, raw: string): Promise<string> {
  const command = stopCommand({ manager } as CommandDeps);
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : '';
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/stop', () => {
  it('当前会话在生成时 cancel，并回已中止', async () => {
    const { value, cancel } = record('running');
    const manager = makeManager({ current: value });

    expect(await run(manager, '')).toBe('⛔ 已中止');
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(manager.cancelAllRunning).not.toHaveBeenCalled();
  });

  it('当前会话空闲时只提示，不 cancel', async () => {
    const { value, cancel } = record('idle');
    const manager = makeManager({ current: value });

    expect(await run(manager, '')).toBe('⚠️ 当前没有进行中的生成');
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('/stop all', () => {
  it('批量中止，并用数量回执', async () => {
    const manager = makeManager({ cancelled: ['session-a', 'session-b'] });

    expect(await run(manager, 'all')).toBe('⛔ 已中止 2 个会话');
    expect(manager.cancelAllRunning).toHaveBeenCalledWith();
    expect(manager.getSessionRecord).not.toHaveBeenCalled();
  });

  it('没有正在生成的会话时提示，不冒充成功', async () => {
    const manager = makeManager();

    expect(await run(manager, 'all')).toBe('⚠️ 当前没有进行中的生成');
    expect(manager.cancelAllRunning).toHaveBeenCalledWith();
  });

  it('其它子命令只回用法，不做任何中止', async () => {
    const manager = makeManager();

    expect(await run(manager, 'now')).toBe('⚠️ 用法: /stop 或 /stop all');
    expect(manager.cancelAllRunning).not.toHaveBeenCalled();
    expect(manager.getSessionRecord).not.toHaveBeenCalled();
  });
});
