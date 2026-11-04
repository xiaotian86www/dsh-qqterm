/**
 * /workspace 命令：当前工作区视图 + 切换结果文案
 *
 * manager 用替身，只验证「参数 → 调用 → 文案」这条链路；宿主交互与「什么时候
 * 能改」的判定由 session-admin.test.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { ChangeWorkspaceOutcome, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { workspaceCommand } from './workspace.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as ImQQBotConfig);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const SESSION_ID = 'session-9d2c4410-1111-1111-1111-111111111111';

interface StubOptions {
  /** 当前工作区视图 */
  current?: { title: string; path: string; missing: boolean };
  /** 还能不能改（false = 已有会话） */
  canChoose?: boolean;
  /** 挡住修改的会话 id */
  sessionId?: string;
  /** 切换结果 */
  change?: ChangeWorkspaceOutcome;
}

function makeManager(options: StubOptions = {}) {
  return {
    currentWorkspaceInfo: vi.fn(async () => options.current
      ?? { title: 'repo', path: 'D:\\repo', missing: false }),
    canChooseWorkspace: vi.fn(async () => (options.canChoose === false
      ? { canChoose: false, sessionId: options.sessionId ?? SESSION_ID }
      : { canChoose: true })),
    changeChatWorkspace: vi.fn(async () => options.change
      ?? { ok: true, title: 'other', path: 'D:\\other', isNew: false }),
  } as unknown as SessionManager;
}

function makeCtx(raw: string): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

/** 跑一次命令，返回实际发送的 markdown 文本 */
async function run(manager: SessionManager, raw = ''): Promise<string> {
  state.sent.length = 0;
  const command = workspaceCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  expect(result).toEqual({ kind: 'noop' });
  return state.sent.at(-1) ?? '';
}

beforeEach(() => {
  state.sent.length = 0;
});

describe('/workspace 命令声明', () => {
  it('只允许私聊（换工作区等于换 agent 能碰的目录）', () => {
    const command = workspaceCommand({ manager: makeManager(), config, logger });
    expect(command.name).toBe('workspace');
    expect(command.scope).toBe('c2c');
    expect(command.authorized).toBeTypeOf('function');
  });

  it('白名单外的用户被拒绝', () => {
    const command = workspaceCommand({ manager: makeManager(), config, logger });
    const allowed = command.authorized as (ctx: { message: { senderId?: string } }) => boolean | string;
    expect(allowed({ message: { senderId: 'stranger' } })).toBeTypeOf('string');
  });
});

describe('/workspace（查看）', () => {
  it('显示当前工作区，并提示可以换', async () => {
    const text = await run(makeManager());
    expect(text).toContain('### 🗂 工作区');
    expect(text).toContain('**repo** · `D:\\repo`');
    expect(text).toContain('下一条消息会在这里开新会话');
    expect(text).toContain('/workspace <名字|路径>');
  });

  it('已有会话时说明改不了，并给出先 /new 的路径', async () => {
    const text = await run(makeManager({ canChoose: false }));
    expect(text).toContain('#9d2c4410');
    expect(text).toContain('改不了');
    expect(text).toContain('`/new <名字|路径>`');
    expect(text).not.toContain('下一条消息会在这里开新会话');
  });

  it('目录已不存在时明确告警', async () => {
    const text = await run(makeManager({
      current: { title: 'gone', path: 'D:\\gone', missing: true },
    }));
    expect(text).toContain('目录已不存在');
  });

  it('读不到工作区信息时不崩', async () => {
    const manager = {
      currentWorkspaceInfo: vi.fn(async () => undefined),
      canChooseWorkspace: vi.fn(async () => ({ canChoose: true })),
      changeChatWorkspace: vi.fn(),
    } as unknown as SessionManager;
    expect(await run(manager)).toContain('读不到当前工作区');
  });
});

describe('/workspace <名字|路径>（切换）', () => {
  it('切换成功：给出标题、路径和下一步', async () => {
    const manager = makeManager();
    const text = await run(manager, 'other');
    expect(manager.changeChatWorkspace).toHaveBeenCalledWith('c2c', 'user1', 'other');
    expect(text).toContain('✅ 工作区已切到 **other** · `D:\\other`');
    expect(text).toContain('下一条消息会在这里开新会话');
  });

  it('宿主还不认识的新目录会说明会在第一条消息时创建', async () => {
    const text = await run(
      makeManager({ change: { ok: true, title: 'brand-new', path: 'D:\\brand-new', isNew: true } }),
      'D:\\brand-new',
    );
    expect(text).toContain('还是新的');
  });

  it('已有会话时拒绝，并带上挡路的会话短 id', async () => {
    const text = await run(
      makeManager({ change: { ok: false, reason: 'has-session', sessionId: SESSION_ID } }),
      'other',
    );
    expect(text).toContain('已经有会话（`#9d2c4410`）');
    expect(text).toContain('`/new <名字|路径>`');
  });

  it('目录不存在', async () => {
    const text = await run(
      makeManager({ change: { ok: false, reason: 'missing', path: 'D:\\nope' } }),
      'D:\\nope',
    );
    expect(text).toContain('目录不存在: `D:\\nope`');
  });

  it('标题有歧义时列出候选并要求绝对路径', async () => {
    const text = await run(
      makeManager({ change: { ok: false, reason: 'ambiguous', matches: ['repo', 'repo-old'] } }),
      'repo',
    );
    expect(text).toContain('2 个工作区匹配: repo、repo-old');
    expect(text).toContain('绝对路径');
  });

  it('没有同名工作区时指向 /sessions all', async () => {
    const text = await run(
      makeManager({ change: { ok: false, reason: 'not-found', arg: 'nope' } }),
      'nope',
    );
    expect(text).toContain('没有叫 `nope` 的工作区');
    expect(text).toContain('/sessions all');
  });

  it('manager 抛错时给出告警而不是把异常抛给宿主', async () => {
    const manager = {
      currentWorkspaceInfo: vi.fn(),
      canChooseWorkspace: vi.fn(),
      changeChatWorkspace: vi.fn(async () => { throw new Error('boom'); }),
    } as unknown as SessionManager;
    expect(await run(manager, 'other')).toContain('工作区操作失败: boom');
  });
});
