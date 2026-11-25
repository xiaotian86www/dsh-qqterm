/**
 * /steer：把仍在排队的 prompt 改成插话（下一步消费），不改指针、不中止生成。
 *
 * manager 用替身，只验证目标解析、队列状态分支与文案；updateQueue 的真实调用
 * 由 host/adapter.spec.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { SessionManager, SessionRecord } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { steerCommand } from '../../src/commands/misc.ts';
import { buildCommandList } from '../../src/commands/index.ts';

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

type SteerResult = Awaited<ReturnType<SessionManager['steerQueued']>>;

function makeManager(over: {
  current?: SessionRecord;
  acquired?: SessionRecord[];
  steer?: SteerResult;
} = {}) {
  return {
    getSessionRecord: vi.fn(() => over.current),
    listAcquiredSessions: vi.fn(() => over.acquired ?? []),
    steerQueued: vi.fn(async () => over.steer ?? { ok: true as const }),
    isCurrentSession: vi.fn((id: string) => over.current?.sessionId === id),
    canSteer: vi.fn(() => true),
  } as unknown as SessionManager;
}

function makeCtx(raw: string): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { name: 'steer', raw },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: SessionManager, raw = ''): Promise<string> {
  state.sent.length = 0;
  const command = steerCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : state.sent.at(-1) ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  state.sent.length = 0;
});

describe('/steer 命令声明', () => {
  it('可见、不限作用域，帮助里能查到', () => {
    const command = steerCommand({ manager: makeManager(), config, logger });
    expect(command.name).toBe('steer');
    expect(command.scope).toBe('all');
    expect(command.hidden).toBeUndefined();
    expect(command.usage).toContain('/steer <id> <消息id>');
  });

  it('部署没有 updateQueue 时不注册；有才出现', () => {
    const names = (canSteer: boolean): string[] => buildCommandList({
      manager: { canSteer: vi.fn(() => canSteer), presetsAvailable: vi.fn(() => true), worktreesAvailable: vi.fn(() => true) } as unknown as SessionManager,
      config,
      logger,
    }).flatMap((command) => (Array.isArray(command.name) ? command.name : [command.name]));
    expect(names(false)).not.toContain('steer');
    expect(names(true)).toContain('steer');
  });
});

describe('/steer 当前会话', () => {
  it('省略消息 id 时插话最近一条排队消息', async () => {
    const current = record(CURRENT, { nextTurn: ['m-1', 'm-2'] });
    const manager = makeManager({ current });

    expect(await run(manager)).toBe('✅ 已插话');
    expect(manager.steerQueued).toHaveBeenCalledWith(CURRENT, 'm-2');
    expect(current.agent.cancel).not.toHaveBeenCalled();
  });

  it('没有排队消息时只提示，不调用宿主', async () => {
    const current = record(CURRENT);
    const manager = makeManager({ current });

    expect(await run(manager)).toBe('⚠️ 没有排队消息 · #9d2c4410');
    expect(manager.steerQueued).not.toHaveBeenCalled();
  });

  it('当前会话不存在时给恢复入口', async () => {
    const manager = makeManager();

    expect(await run(manager)).toBe('⚠️ 当前没有会话 · 用 /sessions 恢复');
    expect(manager.steerQueued).not.toHaveBeenCalled();
  });

  it('回合已结束但消息还排着：如实说会继续发送，不调用宿主', async () => {
    const current = record(CURRENT, { status: 'idle', nextTurn: ['m-1'] });
    const manager = makeManager({ current });

    expect(await run(manager)).toBe('⚠️ 本轮已结束 · 排队消息会继续发送');
    expect(manager.steerQueued).not.toHaveBeenCalled();
  });
});

describe('/steer 指定会话与消息', () => {
  it('按短 id 插话别的已获取会话，回执带标题与 id', async () => {
    const current = record(CURRENT);
    const other = record(OTHER, { nextTurn: ['m-1'], title: '修登录' });
    const manager = makeManager({ current, acquired: [other] });

    expect(await run(manager, '04de1556')).toBe('✅ 已插话 · 「修登录」 · `#04de1556`');
    expect(manager.steerQueued).toHaveBeenCalledWith(OTHER, 'm-1');
    expect(manager.isCurrentSession).toHaveBeenCalledWith(OTHER);
  });

  it('给消息 id 时只插那一条，不取最近的', async () => {
    const other = record(OTHER, { nextTurn: ['m-1', 'm-2'] });
    const manager = makeManager({ acquired: [other] });

    expect(await run(manager, '#04de1556 m-1')).toBe('✅ 已插话 · `#04de1556`');
    expect(manager.steerQueued).toHaveBeenCalledWith(OTHER, 'm-1');
  });

  it('消息已经在下一步：回已经插话，不重复提交', async () => {
    const other = record(OTHER, { nextTurn: [], nextStep: ['m-1'] });
    const manager = makeManager({ acquired: [other] });

    expect(await run(manager, '#04de1556 m-1')).toBe('✅ 已经插话 · #04de1556');
    expect(manager.steerQueued).not.toHaveBeenCalled();
  });

  it('消息既不在 next-turn 也不在 next-step：回已不在队列', async () => {
    const other = record(OTHER, { nextTurn: [] });
    const manager = makeManager({ acquired: [other] });

    expect(await run(manager, '#04de1556 m-9')).toBe('⚠️ 这条消息已不在队列');
    expect(manager.steerQueued).not.toHaveBeenCalled();
  });

  it('找不到目标时给原因与下一步', async () => {
    const manager = makeManager({ acquired: [record(OTHER)] });

    expect(await run(manager, 'deadbeef'))
      .toBe('⚠️ 没有匹配的会话: deadbeef · 用 /sessions 查看会话');
    expect(manager.steerQueued).not.toHaveBeenCalled();
  });
});

describe('/steer 宿主结果', () => {
  it('消息已被消费：回已不在队列', async () => {
    const current = record(CURRENT, { nextTurn: ['m-1'] });
    const manager = makeManager({ current, steer: { ok: false, reason: 'not-found' } });

    expect(await run(manager)).toBe('⚠️ 这条消息已不在队列');
  });

  it('回合不再接受插话：回已结束并说明排队消息会继续发送', async () => {
    const current = record(CURRENT, { nextTurn: ['m-1'] });
    const manager = makeManager({ current, steer: { ok: false, reason: 'steer-unavailable' } });

    expect(await run(manager)).toBe('⚠️ 本轮已结束 · 排队消息会继续发送');
  });

  it('其它失败：给原因与下一步，不冒充成功', async () => {
    const current = record(CURRENT, { nextTurn: ['m-1'] });
    const manager = makeManager({ current, steer: { ok: false, reason: 'failed', message: 'boom' } });

    expect(await run(manager)).toBe('❌ 插话失败');
  });
});

describe('/steer 参数', () => {
  it('参数过多时给用法', async () => {
    const manager = makeManager({ current: record(CURRENT) });

    expect(await run(manager, 'a b c')).toBe('⚠️ 参数过多 · 用法: /help steer');
  });

  it('认不出的参数交给统一解析器，不静默忽略', async () => {
    const manager = makeManager({ current: record(CURRENT) });

    const text = await run(manager, '--now');
    expect(text).toContain('未知参数');
    expect(text).toContain('/help steer');
    expect(manager.steerQueued).not.toHaveBeenCalled();
  });
});
