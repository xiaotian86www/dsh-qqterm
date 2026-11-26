/**
 * /unqueue：取消一条仍在排队的 prompt，不中止生成、不改指针。
 *
 * manager 用替身，只验证目标解析、队列状态分支与文案；updateQueue 的真实调用
 * 由 host/adapter.spec.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { SessionManager, SessionRecord } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { unqueueCommand } from '../../src/commands/misc.ts';
import { buildCommandList } from '../../src/commands/index.ts';
import { visibleCommands } from '../../src/commands/availability.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../../src/shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as QQTermConfig);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const CURRENT = 'session-9d2c4410-2222-2222-2222-222222222222';
const OTHER = 'session-04de1556-8c54-4b78-93e1-5714e079fca6';

interface RecordOptions {
  status?: 'idle' | 'running';
  nextTurn?: string[];
  nextStep?: string[];
  title?: string;
}

function record(sessionId: string, options: RecordOptions = {}) {
  const events = options.title === undefined
    ? []
    : [{ type: 'session/title', data: { title: options.title } }];
  return {
    sessionId,
    agent: {
      status: options.status ?? 'running',
      cancel: vi.fn(),
      session: { id: sessionId, snapshotEvents: () => events },
      inbox: {
        nextTurn: (options.nextTurn ?? []).map((id) => ({ id })),
        nextStep: (options.nextStep ?? []).map((id) => ({ id })),
      },
    },
  } as unknown as SessionRecord;
}

type RemoveResult = Awaited<ReturnType<SessionManager['removeQueued']>>;

function makeManager(over: {
  current?: SessionRecord;
  acquired?: SessionRecord[];
  remove?: RemoveResult;
} = {}) {
  return {
    getSessionRecord: vi.fn(() => over.current),
    listAcquiredSessions: vi.fn(() => over.acquired ?? []),
    removeQueued: vi.fn(async () => over.remove ?? { ok: true as const }),
    isCurrentSession: vi.fn((id: string) => over.current?.sessionId === id),
    canMutateQueue: vi.fn(() => true),
  } as unknown as SessionManager;
}

function makeCtx(raw: string): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { name: 'unqueue', raw },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: SessionManager, raw = ''): Promise<string> {
  state.sent.length = 0;
  const command = unqueueCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : state.sent.at(-1) ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  state.sent.length = 0;
});

describe('/unqueue 命令声明', () => {
  it('可见、不限作用域，帮助里能查到', () => {
    const command = unqueueCommand({ manager: makeManager(), config, logger });
    expect(command.name).toBe('unqueue');
    expect(command.scope).toBe('all');
    expect(command.hidden).toBeUndefined();
    expect(command.usage).toContain('/unqueue <id> <消息id>');
  });

  it('始终注册，可见性随能力翻转现查（不固化构造期的缺失）', () => {
    let canMutateQueue = false;
    const manager = {
      canMutateQueue: vi.fn(() => canMutateQueue),
      presetsAvailable: vi.fn(() => true),
      worktreesAvailable: vi.fn(() => true),
    } as unknown as SessionManager;
    const commands = buildCommandList({ manager, config, logger });
    const namesOf = (list: typeof commands): string[] =>
      list.flatMap((command) => (Array.isArray(command.name) ? command.name : [command.name]));

    expect(namesOf(commands)).toContain('unqueue');
    expect(namesOf(visibleCommands(commands))).not.toContain('unqueue');
    canMutateQueue = true;
    expect(namesOf(visibleCommands(commands))).toContain('unqueue');
  });

  it('能力翻转为不可用后按未知指令回绝，不调用宿主', async () => {
    const manager = makeManager({ current: record(CURRENT, { nextTurn: ['m-1'] }) });
    (manager.canMutateQueue as ReturnType<typeof vi.fn>).mockReturnValue(false);

    expect(await run(manager)).toBe(
      '⚠️ 没有 `/unqueue` 这个指令。\n如果只是普通文本，去掉开头的 `/` 再发；全部指令见 `/help`。',
    );
    expect(manager.removeQueued).not.toHaveBeenCalled();
  });
});

describe('/unqueue 当前会话', () => {
  it('省略消息 id 时取消最近一条排队消息', async () => {
    const current = record(CURRENT, { nextTurn: ['m-1', 'm-2'] });
    const manager = makeManager({ current });

    expect(await run(manager)).toBe('✅ 已取消排队');
    expect(manager.removeQueued).toHaveBeenCalledWith(CURRENT, 'm-2');
    expect(current.agent.cancel).not.toHaveBeenCalled();
  });

  it('本轮已结束也照常删队列项，不要求正在生成', async () => {
    const current = record(CURRENT, { status: 'idle', nextTurn: ['m-1'] });
    const manager = makeManager({ current });

    expect(await run(manager)).toBe('✅ 已取消排队');
    expect(manager.removeQueued).toHaveBeenCalledWith(CURRENT, 'm-1');
  });

  it('没有排队消息时只提示，不调用宿主', async () => {
    const manager = makeManager({ current: record(CURRENT) });

    expect(await run(manager)).toBe('⚠️ 没有排队消息 · #9d2c4410');
    expect(manager.removeQueued).not.toHaveBeenCalled();
  });

  it('当前会话不存在时给恢复入口', async () => {
    const manager = makeManager();

    expect(await run(manager)).toBe('⚠️ 当前没有会话 · 用 /sessions 恢复');
    expect(manager.removeQueued).not.toHaveBeenCalled();
  });
});

describe('/unqueue 指定会话与消息', () => {
  it('按短 id 取消别的已获取会话，回执带标题与 id', async () => {
    const other = record(OTHER, { nextTurn: ['m-1'], title: '修登录' });
    const manager = makeManager({ current: record(CURRENT), acquired: [other] });

    expect(await run(manager, '04de1556')).toBe('✅ 已取消排队 · 「修登录」 · `#04de1556`');
    expect(manager.removeQueued).toHaveBeenCalledWith(OTHER, 'm-1');
  });

  it('给消息 id 时只删那一条，不取最近的', async () => {
    const other = record(OTHER, { nextTurn: ['m-1', 'm-2'] });
    const manager = makeManager({ acquired: [other] });

    expect(await run(manager, '#04de1556 m-1')).toBe('✅ 已取消排队 · `#04de1556`');
    expect(manager.removeQueued).toHaveBeenCalledWith(OTHER, 'm-1');
  });

  it('消息已经插话：拒绝取消并说明原因', async () => {
    const other = record(OTHER, { nextTurn: [], nextStep: ['m-1'] });
    const manager = makeManager({ acquired: [other] });

    expect(await run(manager, '#04de1556 m-1')).toBe('⚠️ 这条消息已插话 · 不能取消');
    expect(manager.removeQueued).not.toHaveBeenCalled();
  });

  it('消息既不在 next-turn 也不在 next-step：回已不在队列', async () => {
    const manager = makeManager({ acquired: [record(OTHER)] });

    expect(await run(manager, '#04de1556 m-9')).toBe('⚠️ 这条消息已不在队列');
    expect(manager.removeQueued).not.toHaveBeenCalled();
  });

  it('找不到目标时给原因与下一步', async () => {
    const manager = makeManager({ acquired: [record(OTHER)] });

    expect(await run(manager, 'deadbeef'))
      .toBe('⚠️ 没有匹配的会话: deadbeef · 用 /sessions 查看会话');
    expect(manager.removeQueued).not.toHaveBeenCalled();
  });
});

describe('/unqueue 宿主结果', () => {
  it('消息已被消费：回已不在队列', async () => {
    const manager = makeManager({
      current: record(CURRENT, { nextTurn: ['m-1'] }),
      remove: { ok: false, reason: 'not-found' },
    });

    expect(await run(manager)).toBe('⚠️ 这条消息已不在队列');
  });

  it('其它失败：如实说取消失败，不冒充成功', async () => {
    const manager = makeManager({
      current: record(CURRENT, { nextTurn: ['m-1'] }),
      remove: { ok: false, reason: 'failed', message: 'boom' },
    });

    expect(await run(manager)).toBe('❌ 取消失败');
  });
});

describe('/unqueue 参数', () => {
  it('参数过多时给用法', async () => {
    const manager = makeManager({ current: record(CURRENT) });

    expect(await run(manager, 'a b c')).toBe('⚠️ 参数过多 · 用法: /help unqueue');
  });

  it('认不出的参数交给统一解析器，不静默忽略', async () => {
    const manager = makeManager({ current: record(CURRENT, { nextTurn: ['m-1'] }) });

    const text = await run(manager, '--now');
    expect(text).toContain('未知参数');
    expect(text).toContain('/help unqueue');
    expect(manager.removeQueued).not.toHaveBeenCalled();
  });
});
