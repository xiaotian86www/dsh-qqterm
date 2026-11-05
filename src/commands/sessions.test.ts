/**
 * /sessions 命令：目标解析与各子命令的输出
 *
 * manager 用替身，只验证「解析 → 调用 → 文案」这条链路；宿主交互细节由
 * session-admin.test.ts 覆盖。输出统一走 sendMarkdownChunked（与 /model 一致），
 * 所以断言看捕获到的 markdown 文本，而不是 handler 返回值。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { SessionManager, WorkspaceSession } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { resolveSessionTarget, sessionAdminAuth, sessionsCommand } from './sessions.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as ImQQBotConfig);
const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function entry(over: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: 'session-11111111-1111-1111-1111-111111111111',
    title: '修复登录 bug',
    createdAt: Date.now() - 60_000,
    current: false,
    live: false,
    held: false,
    running: false,
    isSeeded: false,
    archived: false,
    ...over,
  };
}

type ManagerStub = Partial<Record<
  'listWorkspaceSessions' | 'listHeldSessions' | 'listWorkspaceGroups' | 'currentWorkspaceInfo'
  | 'currentSessionId' | 'switchSession' | 'archiveSession' | 'unarchiveSession' | 'directoryForAgent',
  unknown
>>;

function makeManager(over: ManagerStub = {}) {
  const list = (over.listWorkspaceSessions as (() => Promise<WorkspaceSession[]>) | undefined)
    ?? vi.fn(async () => [entry()]);
  const held = (over.listHeldSessions as (() => Promise<WorkspaceSession[]>) | undefined)
    ?? vi.fn(async () => (await list()).filter((item) => !item.archived));
  return {
    listWorkspaceSessions: list,
    listHeldSessions: held,
    // 分组视图默认与单工作区列表同源（测试里只关心命令层怎么用）
    listWorkspaceGroups: vi.fn(async () => [{
      id: 'ws-1',
      title: 'repo',
      path: '/repo',
      missing: false,
      // 真实 manager 会给每条补所属工作区标题，归档页靠它区分同名会话
      sessions: (await list()).map((item) => ({ ...item, workspace: 'repo' })),
    }]),
    currentWorkspaceInfo: vi.fn(async () => ({ title: 'repo', path: '/repo', missing: false })),
    currentSessionId: vi.fn(() => undefined),
    switchSession: vi.fn(async () => ({ ok: true })),
    archiveSession: vi.fn(async () => ({ ok: true })),
    unarchiveSession: vi.fn(async () => ({ ok: true })),
    directoryForAgent: vi.fn(() => undefined),
    ...over,
  } as unknown as SessionManager;
}

function makeCtx(raw: string): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

/** 跑一次命令，返回实际发送的 markdown 文本 */
async function run(manager: SessionManager, raw: string): Promise<string> {
  state.sent.length = 0;
  const command = sessionsCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  // 输出统一走 markdown 通道，handler 只回 noop
  expect(result).toEqual({ kind: 'noop' });
  return state.sent.at(-1) ?? '';
}

beforeEach(() => {
  state.sent.length = 0;
});

describe('resolveSessionTarget', () => {
  const entries = [
    entry({ id: 'session-aaaaaaaa-1' }),
    entry({ id: 'session-bbbbbbbb-2' }),
    entry({ id: 'session-aaaaaaaa-3' }),
  ];

  it('按序号取（1 起）', () => {
    const result = resolveSessionTarget(entries, '2');
    expect(result.ok && result.entry.id).toBe('session-bbbbbbbb-2');
  });

  it('序号越界给出范围提示', () => {
    const result = resolveSessionTarget(entries, '9');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('超出范围');
  });

  it('唯一前缀命中', () => {
    const result = resolveSessionTarget(entries, 'session-bbb');
    expect(result.ok && result.entry.id).toBe('session-bbbbbbbb-2');
  });

  it('歧义前缀要求写长', () => {
    const result = resolveSessionTarget(entries, 'session-aaaa');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('匹配到 2 个');
  });

  it('过短 id 与空参数都拒绝', () => {
    expect(resolveSessionTarget(entries, 'ses').ok).toBe(false);
    expect(resolveSessionTarget(entries, '').ok).toBe(false);
  });

  it('没有匹配时给出提示', () => {
    const result = resolveSessionTarget(entries, 'session-zzz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('没有匹配');
  });

  it('列表里展示的 8 位短 id（带不带 # 都行）能命中', () => {
    const list = [entry({ id: 'session-3f2a9b1c-1111-2222-3333-444444444444' })];
    expect(resolveSessionTarget(list, '3f2a9b1c').ok).toBe(true);
    expect(resolveSessionTarget(list, '#3f2a9b1c').ok).toBe(true);
    // # 也能标在序号上
    const byIndex = resolveSessionTarget(entries, '#2');
    expect(byIndex.ok && byIndex.entry.id).toBe('session-bbbbbbbb-2');
  });

  it('全数字的短 id 不会被误判成序号', () => {
    const id = 'session-12345678-1111-2222-3333-444444444444';
    const result = resolveSessionTarget([entry({ id })], '12345678');
    expect(result.ok && result.entry.id).toBe(id);
  });
});

describe('/sessions 持有视图', () => {
  it('默认只列持有会话：状态、当前项与序号', async () => {
    const manager = makeManager({
      listHeldSessions: vi.fn(async () => [
        entry({ id: 'session-cccc1111', current: true, held: true, running: true, title: '当前会话' }),
        entry({
          id: 'session-dddd2222',
          held: true,
          title: '旧会话',
          createdAt: Date.now() - 3 * 86_400_000,
        }),
      ]),
      currentSessionId: vi.fn(() => 'session-cccc1111'),
    });

    const text = await run(manager, '');

    expect(text).toContain('### 🗂 持有会话（2 个）');
    expect(text).toContain('1. #cccc1111 · 当前会话 · 生成中');
    expect(text).toContain('2. #dddd2222 · 旧会话 · 空闲');
    expect(text).toMatch(/<qqbot-cmd-input text="\/sessions resume #cccc1111" show="1\. #cccc1111 · 当前会话 · 生成中 · [^"]* ✅"\/>/);
    expect(text).toContain('<qqbot-cmd-input text="/sessions resume #dddd2222" show="2. #dddd2222 · 旧会话');
    // 默认视图只列持有集合，不把工作区里的非持有会话混进来
    expect(text).not.toContain('修复登录 bug');
  });

  it('当前不在持有列表时单独补一行', async () => {
    const manager = makeManager({
      listHeldSessions: vi.fn(async () => [entry({ held: true, title: '后台会话' })]),
      currentSessionId: vi.fn(() => 'session-eeee3333'),
    });
    const text = await run(manager, '');

    expect(text).toContain('**当前**: #eeee3333 · 待恢复');
    expect(text).toContain('后台会话');
    expect(text).toContain('<qqbot-cmd-input text="/sessions resume #eeee3333" show="恢复当前"/>');
    // 不在列表里的当前项没有 ✅
    expect(text).not.toContain(' ✅');
  });

  it('跨工作区的持有项带工作区后缀', async () => {
    const manager = makeManager({
      listHeldSessions: vi.fn(async () => [
        entry({ held: true, title: '本区会话' }),
        entry({ held: true, title: '别的项目', workspace: 'docs' }),
      ]),
    });
    const text = await run(manager, '');

    expect(text).toContain('本区会话');
    expect(text).toContain('· docs');
  });

  it('当前项在别的页时只补当前行，不出现恢复入口', async () => {
    const many = Array.from({ length: 13 }, (_, i) => entry({
      id: `session-${String(i).padStart(8, '0')}`,
      held: true,
      current: i === 12,
    }));
    const manager = makeManager({
      listHeldSessions: vi.fn(async () => many),
      currentSessionId: vi.fn(() => many[12]!.id),
    });

    const page1 = await run(manager, '');
    expect(page1).toContain('**当前**: #00000012');
    expect(page1).not.toContain('show="恢复当前"');
  });

  it('持有列表分页，序号跨页连续且可被 resume 解析', async () => {
    const many = Array.from({ length: 13 }, (_, i) => entry({
      id: `session-${String(i).padStart(8, '0')}`,
      held: true,
      title: `第${i + 1}个`,
    }));
    const manager = makeManager({ listHeldSessions: vi.fn(async () => many) });

    const page1 = await run(manager, '');
    expect(page1).toContain('第 1/2 页 · <qqbot-cmd-input text="/sessions 2" show="下一页"/>');
    expect(page1).not.toContain('还有 3 个');

    const page2 = await run(manager, '2');
    expect(page2).toContain('第 2/2 页');
    expect(page2).toContain('11. #00000010 · 第11个');
    expect(page2).toContain('<qqbot-cmd-input text="/sessions 1" show="上一页"/> · 第 2/2 页');
    expect(page2).not.toContain('show="下一页"');

    await run(manager, 'resume 11');
    expect(manager.switchSession).toHaveBeenCalledWith(
      'c2c',
      'user1',
      'session-00000010',
      'user1',
      expect.objectContaining({ scope: 'c2c', targetId: 'user1', msgId: 'm1' }),
    );
  });

  it('没有持有会话时指向工作区视图', async () => {
    const manager = makeManager({ listHeldSessions: vi.fn(async () => []) });
    const text = await run(manager, '');
    expect(text).toContain('持有会话（0 个）');
    expect(text).toContain('还没有持有会话');
    expect(text).toContain('<qqbot-cmd-input text="/sessions workspace" show="工作区会话"/>');
    // 空列表只留页脚一个入口，不再重复「查看工作区」
    expect(text.split('/sessions workspace').length).toBe(2);
  });

  it('列举持有会话失败时回显原因而不是抛错', async () => {
    const manager = makeManager({
      listHeldSessions: vi.fn(async () => {
        throw new Error('sqlite malformed');
      }),
    });
    const text = await run(manager, '');
    expect(text).toContain('读取持有会话失败');
    expect(text).toContain('sqlite malformed');
  });
});

describe('/sessions workspace', () => {
  it('只标 📌，不标当前，也不展示状态', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-cccc1111', current: true, held: true, running: true, title: '当前会话' }),
        entry({ id: 'session-dddd2222', title: '旧会话' }),
      ]),
    });

    const text = await run(manager, 'workspace');

    expect(text).toContain('### 🗂 工作区会话（2 个未归档');
    expect(text).toContain('#cccc1111 · 当前会话 · 1m 前 · 📌');
    expect(text).toContain('#dddd2222 · 旧会话');
    expect(text).not.toContain(' ✅');
    expect(text).not.toContain('生成中');
    expect(text).not.toContain('空闲');
    expect(text).not.toContain('第 1/1 页');
    expect(text).not.toContain('下一页');
  });

  it('标题写明时间列是创建时间，页脚只留一行', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ id: 'session-cccc1111' })]),
    });
    const text = await run(manager, 'workspace');
    expect(text).toContain('按创建时间倒序');
    expect(text.split('\n').filter((line) => line.includes('/sessions all')).length).toBe(1);
  });

  it('页脚的归档与全部是可点击链接', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-cccc1111' }),
        entry({ id: 'session-dddd2222', archived: true }),
      ]),
    });
    const text = await run(manager, 'workspace');

    expect(text).toContain('<qqbot-cmd-input text="/sessions archive" show="归档"/>');
    expect(text).toContain('<qqbot-cmd-input text="/sessions all" show="查看全部"/>');
    expect(text).toContain('<qqbot-cmd-input text="/sessions archived" show="已归档 1"/>');
  });

  it('没有会话时给出引导', async () => {
    const manager = makeManager({ listWorkspaceSessions: vi.fn(async () => []) });
    expect(await run(manager, 'workspace')).toContain('这个工作区还没有会话');
  });

  it('工作区目录不存在时告警独占一行，不跟在路径后面', async () => {
    const manager = makeManager({
      currentWorkspaceInfo: vi.fn(async () => ({ title: 'repo', path: '/repo', missing: true })),
    });
    const text = await run(manager, 'workspace');

    expect(text).toContain('**repo** · `/repo`\n⚠️ 目录不存在');
    expect(text).not.toContain('`/repo` ⚠️');
  });

  it('本工作区为空但别处有会话时指向 /sessions all', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => []),
      listWorkspaceGroups: vi.fn(async () => [{
        id: 'ws-2',
        title: '别的项目',
        path: '/other',
        missing: false,
        sessions: [entry({ id: 'session-eeee3333', workspace: '别的项目' })],
      }]),
    });
    const text = await run(manager, 'workspace');
    expect(text).toContain('其它工作区还有 1 个会话');
    expect(text).toContain('/sessions all');
  });

  it('列举失败时回显原因而不是抛错', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => {
        throw new Error('sqlite malformed');
      }),
    });
    const text = await run(manager, 'workspace');
    expect(text).toContain('读取会话列表失败');
    expect(text).toContain('sqlite malformed');
  });

  it('超过展示上限时给出下一页链接，行内不编号', async () => {
    const many = Array.from({ length: 13 }, (_, i) => entry({ id: `session-${String(i).padStart(8, '0')}` }));
    const manager = makeManager({ listWorkspaceSessions: vi.fn(async () => many) });
    const text = await run(manager, 'workspace');
    expect(text).toContain('第 1/2 页 · <qqbot-cmd-input text="/sessions workspace 2" show="下一页"/>');
    expect(text).not.toContain('还有 3 个');
    expect(text).not.toMatch(/^\d+\. /m);
  });

  it('分页：第二页接续展示且仍不编号', async () => {
    const many = Array.from({ length: 13 }, (_, i) => entry({
      id: `session-${String(i).padStart(8, '0')}`,
      title: `第${i + 1}个`,
    }));
    const manager = makeManager({ listWorkspaceSessions: vi.fn(async () => many) });

    const page2 = await run(manager, 'workspace 2');
    expect(page2).toContain('第 2/2 页');
    expect(page2).toContain('#00000010 · 第11个');
    expect(page2).toContain('<qqbot-cmd-input text="/sessions workspace 1" show="上一页"/> · 第 2/2 页');
    expect(page2).not.toMatch(/^\d+\. /m);
  });

  it('页码越界时说明总页数', async () => {
    const manager = makeManager();
    expect(await run(manager, 'workspace 9')).toContain('共 1 页');
  });

  it('已归档的会话不占工作区列表，只在底部提示数量', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-cccc1111', title: '在用的' }),
        entry({ id: 'session-dddd2222', title: '归档的', archived: true }),
      ]),
    });

    const text = await run(manager, 'workspace');

    expect(text).toContain('工作区会话（1 个未归档');
    expect(text).toContain('在用的');
    expect(text).not.toContain('归档的');
    expect(text).toContain('已归档 1');
    expect(text).toContain('/sessions archived');
  });

  it('全部归档时工作区列表给出跳转提示', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ archived: true })]),
    });
    const text = await run(manager, 'workspace');
    expect(text).toContain('没有未归档的会话');
    expect(text).toContain('/sessions archived');
  });
});

describe('/sessions archived', () => {
  it('只列已归档会话：不显示序号，按钮带短 id，并标出所属工作区', async () => {
    const archivedId = 'session-22222222-2222-2222-2222-222222222222';
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-cccc1111' }),
        entry({ id: archivedId, title: '旧需求', archived: true }),
      ]),
    });

    const text = await run(manager, 'archived');

    expect(text.startsWith('### 🗄 已归档（共 1 个')).toBe(true);
    expect(text).toContain('旧需求');
    // 序号只对 /sessions 有效，归档页只用短 id；行尾补工作区
    expect(text).toContain(`<qqbot-cmd-input text="/sessions unarchive #22222222" show="#22222222 · 旧需求`);
    expect(text).toContain('· repo');
    expect(text).not.toMatch(/^1\. /m);
    // 默认列表里的会话不该出现在归档页
    expect(text).not.toContain('cccc1111');
    // 底部的返回入口也是链接
    expect(text).toContain('<qqbot-cmd-input text="/sessions" show="返回持有列表"/>');
  });

  it('归档超过一页时给出下一页链接', async () => {
    const many = Array.from({ length: 13 }, (_, i) => entry({
      id: `session-${String(i).padStart(8, '0')}`,
      archived: true,
    }));
    const manager = makeManager({ listWorkspaceSessions: vi.fn(async () => many) });
    const text = await run(manager, 'archived');
    expect(text).toContain('第 1/2 页 · <qqbot-cmd-input text="/sessions archived 2" show="下一页"/>');
    expect(text).not.toContain('还有 3 个');

    const page2 = await run(manager, 'archived 2');
    expect(page2).toContain('<qqbot-cmd-input text="/sessions archived 1" show="上一页"/> · 第 2/2 页');
    expect(page2).toContain('第 2/2 页\n\n<qqbot-cmd-input text="/sessions" show="返回持有列表"/>');
  });

  it('没有归档时说明用法', async () => {
    const manager = makeManager();
    const text = await run(manager, 'archived');
    expect(text).toContain('没有已归档的会话');
    expect(text).toContain('/sessions archive');
  });
});

describe('/sessions all', () => {
  it('持有会话只标 📌，不标当前', async () => {
    const manager = makeManager({
      listWorkspaceGroups: vi.fn(async () => [{
        id: 'ws-1',
        title: 'repo',
        path: '/repo',
        missing: false,
        sessions: [
          entry({ id: 'session-held', current: true, held: true, title: '持有会话', workspace: 'repo' }),
          entry({ id: 'session-cold', title: '冷会话', workspace: 'repo' }),
        ],
      }]),
    });

    const text = await run(manager, 'all');

    expect(text).toContain('#held');
    expect(text).toContain('持有会话 · 1m 前 · 📌');
    expect(text).toContain('冷会话');
    expect(text).not.toContain(' ✅');
    expect(text).not.toContain('生成中');
    expect(text).not.toContain('空闲');
  });

  it('按工作区分组列出：组内不显示序号，只给短 id', async () => {
    const manager = makeManager({
      listWorkspaceGroups: vi.fn(async () => [
        {
          id: 'ws-1',
          title: 'dsh-qqbot',
          path: 'D:\\thirdparty\\dsh-qqbot',
          missing: false,
          sessions: [entry({ id: 'session-aaa11111', title: '仓库里的', workspace: 'dsh-qqbot' })],
        },
        {
          id: 'ws-2',
          title: 'default-workspace',
          path: 'C:\\Users\\me\\Documents\\deepseek-harness\\default-workspace',
          missing: true,
          sessions: [entry({ id: 'session-bbb22222', title: '默认项目里的', workspace: 'default-workspace' })],
        },
      ]),
    });

    const text = await run(manager, 'all');

    expect(text).toContain('全部工作区（2 个工作区 · 2 个未归档会话）');
    expect(text).toContain('**dsh-qqbot**');
    expect(text).toContain('**default-workspace**');
    expect(text).toContain('⚠️ 目录不存在');
    // 组内序号和命令解析顺序对不上，所以这里不编号
    expect(text).not.toMatch(/^\d+\. /m);
    expect(text).toContain('<qqbot-cmd-input text="/sessions resume #aaa11111"');
    expect(text).toContain('<qqbot-cmd-input text="/sessions resume #bbb22222"');
    expect(text).toContain('<qqbot-cmd-input text="/sessions" show="返回持有列表"/>');
  });

  it('超过一页时按会话分页，页首仍重复所属工作区', async () => {
    const many = Array.from({ length: 13 }, (_, i) => entry({
      id: `session-${String(i).padStart(8, '0')}`,
      title: `第${i + 1}个`,
      workspace: 'repo',
    }));
    const manager = makeManager({
      listWorkspaceGroups: vi.fn(async () => [{
        id: 'ws-1',
        title: 'repo',
        path: '/repo',
        missing: false,
        sessions: many,
      }]),
    });

    const page1 = await run(manager, 'all');
    expect(page1).toContain('第 1/2 页 · <qqbot-cmd-input text="/sessions all 2" show="下一页"/>');
    expect(page1).not.toContain('还有 3 个');

    const page2 = await run(manager, 'all 2');
    expect(page2).toContain('第 2/2 页');
    expect(page2).toContain('**repo**');
    expect(page2).toContain('#00000010 · 第11个');
    expect(page2).toContain('<qqbot-cmd-input text="/sessions all 1" show="上一页"/> · 第 2/2 页');
  });

  it('全部归档的工作区仍然列出，并指向归档页', async () => {
    const manager = makeManager({
      listWorkspaceGroups: vi.fn(async () => [{
        id: 'ws-1',
        title: '收工的项目',
        path: '/done',
        missing: false,
        sessions: [entry({ id: 'session-fff99999', archived: true, workspace: '收工的项目' })],
      }]),
    });
    const text = await run(manager, 'all');
    expect(text).toContain('**收工的项目**');
    expect(text).toContain('1 个会话全部已归档');
    expect(text).toContain('/sessions archived');
  });

  it('没有工作区会话时给出引导', async () => {
    const manager = makeManager({ listWorkspaceGroups: vi.fn(async () => []) });
    expect(await run(manager, 'all')).toContain('还没有任何工作区会话');
  });
});

describe('/sessions resume', () => {
  it('序号按持有列表解析，而不是工作区列表', async () => {
    const heldId = 'session-held01';
    const workspaceId = 'session-work01';
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ id: workspaceId, title: '工作区里的' })]),
      listHeldSessions: vi.fn(async () => [entry({ id: heldId, held: true, title: '持有里的' })]),
    });

    const text = await run(manager, 'resume 1');

    expect(manager.switchSession).toHaveBeenCalledWith(
      'c2c',
      'user1',
      heldId,
      'user1',
      expect.objectContaining({ scope: 'c2c', targetId: 'user1', msgId: 'm1' }),
    );
    expect(text).toContain('#held01');
    expect(text).not.toContain('#work01');
  });

  it('持有会话不在全量清单里也能按 id 恢复', async () => {
    const manager = makeManager({
      listHeldSessions: vi.fn(async () => [entry({ id: 'session-held01', held: true })]),
      listWorkspaceGroups: vi.fn(async () => []),
    });

    const text = await run(manager, 'resume #held01');

    expect(manager.switchSession).toHaveBeenCalledWith(
      'c2c',
      'user1',
      'session-held01',
      'user1',
      expect.objectContaining({ scope: 'c2c', targetId: 'user1', msgId: 'm1' }),
    );
    expect(text).toContain('已恢复会话');
  });

  it('按序号恢复并带上回复目标', async () => {
    const manager = makeManager();
    const text = await run(manager, 'resume 1');

    expect(manager.switchSession).toHaveBeenCalledWith(
      'c2c',
      'user1',
      entry().id,
      'user1',
      expect.objectContaining({ scope: 'c2c', targetId: 'user1', msgId: 'm1' }),
    );
    expect(text).toContain('已恢复会话');
    expect(text).toContain('`#11111111`');
    expect(text).not.toContain('`session-`');
    // 只回一行：告诉切到了哪个会话，不追加历史/工作区说明
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toContain('工作区');
  });

  it('恢复已归档会话也只回一行', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ archived: true })]),
      switchSession: vi.fn(async () => ({ ok: true, unarchived: true })),
    });
    const text = await run(manager, `resume ${entry().id}`);
    expect(text).toBe('✅ 已恢复会话「修复登录 bug」 · `#11111111`（已取消归档）');
  });

  it('已是当前会话时直接提示', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ current: true })]),
    });
    expect(await run(manager, 'resume 1')).toBe('✅ 已是当前会话');
    expect(manager.switchSession).not.toHaveBeenCalled();
  });

  it('会话不存在 / 被别的端占用 / 恢复失败各有明确文案', async () => {
    const missing = makeManager({ switchSession: vi.fn(async () => ({ ok: false, reason: 'not-found' })) });
    expect(await run(missing, 'resume 1')).toContain('这个会话已不存在');

    const locked = makeManager({ switchSession: vi.fn(async () => ({ ok: false, reason: 'locked' })) });
    expect(await run(locked, 'resume 1')).toContain('正在别的客户端运行');

    const failed = makeManager({
      switchSession: vi.fn(async () => ({ ok: false, reason: 'failed', message: 'ownership taken' })),
    });
    expect(await run(failed, 'resume 1')).toContain('ownership taken');
  });

  it('目标解析失败时首行带 ⚠️，并给返回列表的链接', async () => {
    const text = await run(makeManager(), 'resume 99');

    expect(text.startsWith('⚠️ 序号 99 超出范围')).toBe(true);
    expect(text).toContain('<qqbot-cmd-input text="/sessions" show="查看会话"/>');
    expect(text.split('\n')).toHaveLength(1);
  });
});

describe('/sessions archive', () => {
  it('序号按持有列表解析，归档的是持有会话', async () => {
    const heldId = 'session-held01';
    const workspaceId = 'session-work01';
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ id: workspaceId, title: '工作区里的' })]),
      listHeldSessions: vi.fn(async () => [entry({ id: heldId, held: true, title: '持有里的' })]),
    });

    const text = await run(manager, 'archive 1');

    expect(manager.archiveSession).toHaveBeenCalledWith(heldId);
    expect(text).toContain('持有里的');
  });

  it('持有会话不在全量清单里也能按 id 归档', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => []),
      listWorkspaceGroups: vi.fn(async () => []),
      listHeldSessions: vi.fn(async () => [entry({ id: 'session-held01', held: true })]),
    });

    const text = await run(manager, 'archive #held01');

    expect(manager.archiveSession).toHaveBeenCalledWith('session-held01');
    expect(text).toContain('已归档');
  });

  it('不带目标时给出可点击的归档候选', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-aaaa0001', title: '甲', held: true }),
        entry({ id: 'session-bbbb0002', title: '乙' }),
      ]),
    });

    const text = await run(manager, 'archive');

    expect(text.startsWith('### 🗄 归档候选（2 个）')).toBe(true);
    expect(text).toContain('<qqbot-cmd-input text="/sessions archive #aaaa0001" show="#aaaa0001 · 甲');
    expect(text).toContain('<qqbot-cmd-input text="/sessions archive #bbbb0002" show="#bbbb0002 · 乙');
    expect(text).toContain('· 📌');
    expect(text).not.toMatch(/^\d+\. /m);
    expect(text).not.toContain(' ✅');
    // 只是候选，不能点开就真的归档
    expect(manager.archiveSession).not.toHaveBeenCalled();
  });

  it('候选跨工作区时补工作区标题，并保留返回入口', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ id: 'session-cccc1111', title: '本区' })]),
      listHeldSessions: vi.fn(async () => [
        entry({ id: 'session-dddd2222', title: '别处', held: true, workspace: 'docs' }),
      ]),
    });

    const text = await run(manager, 'archive');

    expect(text).toContain('#dddd2222 · 别处');
    expect(text).toContain('· docs');
    // 本工作区候选排在其它工作区的持有会话前面
    expect(text.indexOf('#cccc1111')).toBeLessThan(text.indexOf('#dddd2222'));
    // 工作区后缀在前，📌 仍是行尾
    expect(text).toMatch(/#dddd2222 · 别处 · [^"]* · docs · 📌"/);
    expect(text).toContain('<qqbot-cmd-input text="/sessions" show="返回持有列表"/>');
  });

  it('候选超过一页时用 page 翻页，第二页仍是同一份候选', async () => {
    const many = Array.from({ length: 13 }, (_, i) => entry({
      id: `session-${String(i).padStart(8, '0')}`,
      title: `第${i + 1}个`,
    }));
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => many),
      listHeldSessions: vi.fn(async () => []),
    });

    const page1 = await run(manager, 'archive');
    expect(page1).toContain('归档候选（13 个）');
    expect(page1).toContain('第 1/2 页 · <qqbot-cmd-input text="/sessions archive page 2" show="下一页"/>');
    expect(page1).not.toContain('还有 3 个');
    // 不再把「还有 N 个」错误地指向全部工作区
    expect(page1).not.toContain('查看全部');

    const page2 = await run(manager, 'archive page 2');
    expect(page2).toContain('第 2/2 页');
    expect(page2).toContain('#00000010 · 第11个');
    expect(page2).toContain('<qqbot-cmd-input text="/sessions archive page 1" show="上一页"/> · 第 2/2 页');
  });

  it('归档成功后给出可恢复提示', async () => {
    const manager = makeManager();
    const text = await run(manager, 'archive 1');

    expect(manager.archiveSession).toHaveBeenCalledWith(entry().id);
    expect(text).toContain('已归档「修复登录 bug」');
    expect(text).toContain('`#11111111`');
    expect(text).toContain('<qqbot-cmd-input text="/sessions unarchive #11111111" show="取消归档"/>');
  });

  it('归档当前会话时提示已切到新会话', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ current: true })]),
      archiveSession: vi.fn(async () => ({ ok: true, remapped: 1 })),
    });
    expect(await run(manager, 'archive 1')).toContain('当前聊天已切到新会话');
  });

  it('已经归档的会话不再重复写，并提示跳过', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-active' }),
        entry({ id: 'session-old', archived: true }),
      ]),
    });
    const text = await run(manager, 'archive session-old');
    expect(text.startsWith('⚠️ 没有可归档的会话')).toBe(true);
    expect(text).toContain('本来就在归档里');
    expect(manager.archiveSession).not.toHaveBeenCalled();
  });

  it('宿主没有归档接口时明确说明（不静默失败）', async () => {
    const manager = makeManager({
      archiveSession: vi.fn(async () => ({
        ok: false,
        reason: 'unavailable',
        message: '当前 profile 没装会话归档接口（web / desktop 自带）',
      })),
    });
    const text = await run(manager, 'archive 1');
    expect(text).toContain('归档失败');
    expect(text).toContain('归档接口');
  });

  it('会话仍在运行时如实报告', async () => {
    const manager = makeManager({
      archiveSession: vi.fn(async () => ({ ok: false, reason: 'busy', message: '会话仍在运行: generating' })),
    });
    const text = await run(manager, 'archive 1');
    // 忙碌是自解释的：只给一句原因，不把宿主原文贴给用户
    expect(text).toContain('⚠️ 归档失败: 该会话还有工作在运行，稍后再试');
    expect(text).toContain('<qqbot-cmd-input text="/sessions" show="查看会话"/>');
  });

  it('全部归档时提示没有可归档对象', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ archived: true })]),
    });
    expect(await run(manager, 'archive')).toContain('没有未归档的会话');
  });

  it('英文逗号分隔批量归档，逐个执行并汇总', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-one', title: '一' }),
        entry({ id: 'session-two', title: '二' }),
        entry({ id: 'session-three', title: '三' }),
      ]),
    });

    const text = await run(manager, 'archive 1,2');

    expect(manager.archiveSession).toHaveBeenCalledTimes(2);
    expect(manager.archiveSession).toHaveBeenNthCalledWith(1, 'session-one');
    expect(manager.archiveSession).toHaveBeenNthCalledWith(2, 'session-two');
    expect(text).toContain('已归档 2 个会话');
    expect(text).toContain('✅ 1. 一');
    expect(text).toContain('✅ 2. 二');
    expect(text).toContain('<qqbot-cmd-input text="/sessions archived" show="查看已归档"/>');
    expect(manager.archiveSession).not.toHaveBeenCalledWith('session-three');
  });

  it('全角逗号与 id 混用也能识别，重复目标只执行一次', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-one', title: '一' }),
        entry({ id: 'session-two', title: '二' }),
      ]),
    });

    const text = await run(manager, 'archive 1，session-one,session-two');

    expect(manager.archiveSession).toHaveBeenCalledTimes(2);
    expect(text).toContain('已归档 2 个会话');
  });

  it('批量里单个失败不影响其它，并在清单里标出原因', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-ok', title: '好的' }),
        entry({ id: 'session-busy', title: '忙的' }),
      ]),
      archiveSession: vi.fn(async (id: string) => (id === 'session-busy'
        ? { ok: false, reason: 'busy', message: '会话仍在运行：generating' }
        : { ok: true })),
    });

    const text = await run(manager, 'archive 1,2');

    expect(text).toContain('已归档 1 个会话，1 个失败');
    expect(text).toContain('✅ 1. 好的');
    expect(text).toContain('⚠️ 2. 忙的');
    expect(text).toContain('还有工作在运行');
  });

  it('批量全部失败时首行用警告，不写成「已归档 0 个」', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-one', title: '一' }),
        entry({ id: 'session-two', title: '二' }),
      ]),
      archiveSession: vi.fn(async () => ({ ok: false, reason: 'busy', message: '会话仍在运行' })),
    });

    const text = await run(manager, 'archive 1,2');
    expect(text.startsWith('⚠️ 2 个会话归档失败')).toBe(true);
    expect(text).not.toContain('已归档 0 个');
    expect(text).toContain('<qqbot-cmd-input text="/sessions" show="返回持有列表"/>');
  });

  it('部分序号越界时报告该条，其余照常执行', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ id: 'session-one' })]),
    });

    const text = await run(manager, 'archive 1,9');

    expect(manager.archiveSession).toHaveBeenCalledTimes(1);
    expect(text).toContain('序号 9 超出范围');
    expect(text).toContain('已归档 1 个会话');
  });

  it('一次超过 10 个目标时直接拒绝', async () => {
    const manager = makeManager();
    const many = Array.from({ length: 11 }, (_, i) => String(i + 1)).join(',');
    const text = await run(manager, `archive ${many}`);
    expect(text).toContain('最多处理 10 个');
    expect(manager.archiveSession).not.toHaveBeenCalled();
  });
});

describe('/sessions unarchive', () => {
  it('按短 id 取消归档', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-cccc1111' }),
        entry({ id: 'session-22222222', title: '旧活儿', archived: true }),
      ]),
    });
    const text = await run(manager, 'unarchive #22222222');

    expect(manager.unarchiveSession).toHaveBeenCalledWith('session-22222222');
    expect(text).toContain('已取消归档');
    expect(text).toContain('<qqbot-cmd-input text="/sessions resume #22222222" show="继续会话"/>');
  });

  it('序号只对应 /sessions 列表，归档页用序号会被明确拒绝', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-cccc1111' }),
        entry({ id: 'session-22222222', archived: true }),
      ]),
    });
    const text = await run(manager, 'unarchive 1');
    expect(manager.unarchiveSession).not.toHaveBeenCalled();
    expect(text).toContain('序号只对应');
  });

  it('没有归档时说明用法', async () => {
    const manager = makeManager();
    expect(await run(manager, 'unarchive 22222222')).toContain('没有已归档的会话');
  });

  it('目标没有归档时不重复操作', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-cccc1111' }),
        entry({ id: 'session-22222222', archived: true }),
      ]),
    });
    const text = await run(manager, 'unarchive #cccc1111');
    expect(manager.unarchiveSession).not.toHaveBeenCalled();
    expect(text).toContain('没有归档');
  });

  it('取消归档失败时如实报告', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ id: 'session-22222222', archived: true })]),
      unarchiveSession: vi.fn(async () => ({ ok: false, reason: 'failed', message: 'EIO' })),
    });
    const text = await run(manager, 'unarchive #22222222');
    expect(text).toContain('取消归档失败');
    expect(text).toContain('EIO');
  });

  it('英文逗号分隔批量恢复', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-aaaa0001', title: '甲', archived: true }),
        entry({ id: 'session-bbbb0002', title: '乙', archived: true }),
        entry({ id: 'session-cccc0003', title: '当前' }),
      ]),
    });

    const text = await run(manager, 'unarchive #aaaa0001,#bbbb0002');

    expect(manager.unarchiveSession).toHaveBeenCalledTimes(2);
    expect(manager.unarchiveSession).toHaveBeenNthCalledWith(1, 'session-aaaa0001');
    expect(manager.unarchiveSession).toHaveBeenNthCalledWith(2, 'session-bbbb0002');
    expect(text).toContain('已取消归档 2 个会话');
    expect(text).toContain('<qqbot-cmd-input text="/sessions" show="返回持有列表"/>');
  });
});

describe('sessionAdminAuth', () => {
  const withAllow = ConfigSchema({
    appId: 'app',
    appSecret: 'secret',
    access: { c2cMode: 'open', c2cAllow: ['user1'] },
  } as ImQQBotConfig);

  it('名单内用户放行（open 模式也一样）', () => {
    expect(sessionAdminAuth(withAllow)({ message: { senderId: 'user1' } })).toBe(true);
  });

  it('名单外用户拒绝', () => {
    expect(sessionAdminAuth(withAllow)({ message: { senderId: 'stranger' } })).not.toBe(true);
  });

  it('未配置名单时 fail-closed，并提示用 /bot-me 查 openid', () => {
    const denied = sessionAdminAuth(config)({ message: { senderId: 'user1' } });
    expect(denied).not.toBe(true);
    expect(String(denied)).toContain('/bot-me');
  });
});

describe('其它入口', () => {
  it('help 用统一的视图标题，并保留全部子命令入口', async () => {
    const text = await run(makeManager(), 'help');

    expect(text.startsWith('### 🗂 会话管理')).toBe(true);
    expect(text).toContain('/sessions resume');
    expect(text).toContain('/sessions archive');
    expect(text).toContain('/sessions unarchive');
  });

  it('不再保留 held 子命令', async () => {
    const text = await run(makeManager(), 'held');
    expect(text).toContain('未知子命令');
  });

  it('未知子命令只回一行指引，不刷整屏用法', async () => {
    const text = await run(makeManager(), 'whatever');
    expect(text).toContain('未知子命令');
    expect(text).toContain('/sessions help');
    expect(text.split('\n').length).toBe(1);
    // 物理删除已下线，用法里不应再出现 delete
    expect(text).not.toContain('/sessions delete');
  });

  it('缺少目标时给可点击的入口', async () => {
    const text = await run(makeManager(), 'resume');
    expect(text).toContain('缺少目标');
    expect(text).toContain('<qqbot-cmd-input text="/sessions" show="选择会话"/>');
    expect(text.split('\n').length).toBe(1);
  });
});
