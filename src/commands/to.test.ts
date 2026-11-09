/**
 * `/to` 命令：目标解析、四条结果分支与「不改 current」的调用约定。
 *
 * manager 用替身，只验证命令层拼装；会话获取与答案通道的细节由
 * session-admin.test.ts / question-channel.test.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../config.ts';
import type { SessionManager, SessionRecord, WorkspaceGroup, WorkspaceSession } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { toCommand } from './to.ts';

const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as QQTermConfig);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const TARGET = 'session-3f2a9b1c-1111-1111-1111-111111111111';
const CURRENT = 'session-9d2c4410-2222-2222-2222-222222222222';

function entry(over: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: TARGET,
    title: '目标会话',
    createdAt: 1,
    updatedAt: 1,
    current: false,
    live: true,
    held: false,
    running: false,
    isSeeded: false,
    archived: false,
    ...over,
  };
}

function groups(sessions: WorkspaceSession[] = [entry()]): WorkspaceGroup[] {
  return [{ id: 'ws', title: 'repo', path: '/repo', missing: false, sessions }];
}

type SendToResult = Awaited<ReturnType<SessionManager['sendTo']>>;

function makeManager(over: {
  groups?: WorkspaceGroup[];
  sendTo?: SendToResult;
  live?: boolean;
  record?: SessionRecord;
} = {}) {
  return {
    listWorkspaceGroups: vi.fn(async () => over.groups ?? groups()),
    fillSessionTitles: vi.fn(async () => {}),
    hasLiveSession: vi.fn(() => over.live ?? true),
    findBySessionId: vi.fn(() => over.record),
    sendTo: vi.fn(async () => over.sendTo ?? { ok: true, kind: 'sent', sessionId: TARGET }),
  } as unknown as SessionManager;
}

function makeCtx(raw: string): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: SessionManager, raw: string): Promise<string> {
  const command = toCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : '';
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/to', () => {
  it('按短 id 找到目标，文本原样交给 sendTo，且不改 current', async () => {
    const manager = makeManager();

    const text = await run(manager, '#3f2a9b1c 继续修登录');

    expect(text).toBe('✅ 已发送到「目标会话」 · `#3f2a9b1c`');
    expect(manager.sendTo).toHaveBeenCalledWith(
      'c2c',
      'user1',
      'user1',
      TARGET,
      '继续修登录',
      { scope: 'c2c', targetId: 'user1' },
    );
  });

  it('目标在等答案时回「已回答」，不冒充新 prompt', async () => {
    const manager = makeManager({ sendTo: { ok: true, kind: 'answered', sessionId: TARGET } });
    expect(await run(manager, `#3f2a9b1c 2`)).toBe('✅ 已回答「目标会话」 · `#3f2a9b1c`');
  });

  it('空文本 + 有待答问题时进入回答模式', async () => {
    const manager = makeManager({ sendTo: { ok: true, kind: 'answer-mode', sessionId: TARGET } });
    expect(await run(manager, '#3f2a9b1c')).toBe('💡 请发送回答: 「目标会话」 · `#3f2a9b1c`');
    expect(manager.sendTo).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), TARGET, '',
      expect.anything(),
    );
  });

  it('目标不 live 时拒绝，并提示先 resume', async () => {
    const manager = makeManager({ sendTo: { ok: false, reason: 'not-running', sessionId: TARGET } });
    const text = await run(manager, `#3f2a9b1c hi`);
    expect(text).toContain('会话未运行');
    expect(text).toContain('「目标会话」 · `#3f2a9b1c`');
    expect(text).toContain('/sessions resume #3f2a9b1c');
  });

  it('列表里没有、但有 live 会话时，名字从会话日志的标题取', async () => {
    const manager = makeManager({
      groups: groups([entry({ id: CURRENT })]),
      record: {
        sessionId: TARGET,
        agent: { session: { snapshotEvents: () => [{ type: 'session/title', data: { title: '日志标题' } }] } },
      } as unknown as SessionRecord,
    });
    const text = await run(manager, `${TARGET} hi`);
    expect(text).toBe('✅ 已发送到「日志标题」 · `#3f2a9b1c`');
  });

  it('空文本且没有待答问题时提示用法', async () => {
    const manager = makeManager({ sendTo: { ok: false, reason: 'empty', sessionId: TARGET } });
    expect(await run(manager, '#3f2a9b1c')).toContain('缺少文本');
  });

  it('已归档的目标拒绝，并给取消归档入口', async () => {
    const manager = makeManager({ groups: groups([entry({ archived: true })]) });
    const text = await run(manager, '#3f2a9b1c hi');
    expect(text).toContain('已归档');
    expect(text).toContain('/sessions unarchive #3f2a9b1c');
    expect(manager.sendTo).not.toHaveBeenCalled();
  });

  it('列表里没有、也没有 live agent 时给短 id 提示', async () => {
    const manager = makeManager({ groups: groups([entry({ id: CURRENT })]), live: false });
    const text = await run(manager, '#3f2a9b1c hi');
    expect(text).toContain('没有匹配的会话');
  });

  it('缺少会话参数时给用法', async () => {
    const manager = makeManager();
    expect(await run(manager, '')).toContain('缺少会话');
    expect(manager.sendTo).not.toHaveBeenCalled();
  });
});
