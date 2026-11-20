/**
 * `/stop` 命令：裸命令停当前、`<id>` 停指定已获取会话、`all` 批量中止。
 *
 * manager 用替身，只验证命令层的目标解析与文案；批量中止的筛选与 pending
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
const OTHER = 'session-04de1556-8c54-4b78-93e1-5714e079fca6';

function record(
  status: 'idle' | 'running',
  opts: { sessionId?: string; title?: string } = {},
) {
  const cancel = vi.fn();
  const sessionId = opts.sessionId ?? CURRENT;
  const events = opts.title === undefined
    ? []
    : [{ type: 'session/title', data: { title: opts.title } }];
  const value = {
    sessionId,
    agent: { status, cancel, session: { id: sessionId, snapshotEvents: () => events } },
  } as unknown as SessionRecord;
  return { value, cancel };
}

function makeManager(over: {
  current?: SessionRecord;
  cancelled?: string[];
  acquired?: SessionRecord[];
} = {}) {
  return {
    getSessionRecord: vi.fn(() => over.current),
    cancelAllRunning: vi.fn(() => over.cancelled ?? []),
    listAcquiredSessions: vi.fn(() => over.acquired ?? []),
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

describe('/stop <id>', () => {
  it('按 8 位短 id 中止指定会话，回执带标题与 id', async () => {
    const { value, cancel } = record('running', { sessionId: OTHER, title: '修登录' });
    const manager = makeManager({ acquired: [value] });

    expect(await run(manager, '04de1556')).toBe('⛔ 已中止「修登录」 · #04de1556');
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' });
    // 目标命令不碰当前会话，也不批量中止
    expect(manager.getSessionRecord).not.toHaveBeenCalled();
    expect(manager.cancelAllRunning).not.toHaveBeenCalled();
  });

  it('带 # 的完整 id 同样能选中，没有标题时只回 id', async () => {
    const { value, cancel } = record('running', { sessionId: OTHER });
    const manager = makeManager({ acquired: [value] });

    expect(await run(manager, '#' + OTHER)).toBe('⛔ 已中止 #04de1556');
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' });
  });

  it('目标会话空闲时只提示，不 cancel', async () => {
    const { value, cancel } = record('idle', { sessionId: OTHER });
    const manager = makeManager({ acquired: [value] });

    expect(await run(manager, '04de1556')).toBe('⚠️ 没有进行中的生成 · #04de1556');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('找不到目标时给原因与下一步，不 cancel 任何会话', async () => {
    const { value, cancel } = record('running', { sessionId: OTHER });
    const manager = makeManager({ acquired: [value] });

    expect(await run(manager, 'deadbeef'))
      .toBe('⚠️ 没有匹配的会话: deadbeef · 用 /sessions 查看会话');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('太短的参数按 id 报错，不再回旧的用法行', async () => {
    const manager = makeManager({ acquired: [] });

    expect(await run(manager, 'now'))
      .toBe('⚠️ id 至少 4 位，列表里的 8 位短 id 直接可用 · 用 /sessions 查看会话');
    expect(manager.listAcquiredSessions).toHaveBeenCalledWith();
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
});
