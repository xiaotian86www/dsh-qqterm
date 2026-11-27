/**
 * /status 命令：会话状态的展示字段
 *
 * manager 用替身，只验证「状态 → 文案」这条链路；宿主交互由 session-admin.spec.ts
 * 覆盖，计费口径由 /cost 负责。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { SessionManager, SessionTurnProgress } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { sessionStatusCommand } from '../../src/commands/session-status.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../../src/shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as QQTermConfig);

const SESSION_ID = 'session-9d2c4410-1111-1111-1111-111111111111';

interface StubOptions {
  active?: boolean;
  /** 生成状态（默认空闲） */
  agentStatus?: 'idle' | 'running';
  /** 会话日志里的标题（默认没有，模拟宿主还没生成标题） */
  title?: string;
  context?: { used?: number; window?: number };
  workspace?: { title: string; path: string; missing: boolean; branch?: string } | undefined;
  /** 会话所在工作树（默认没有） */
  worktree?: { branch: string; baseCommit: string; path: string } | undefined;
  /** 会话团队模式（默认没有：投影缺失，该行不出现） */
  team?: boolean;
  /** 下一条消息的团队意图（默认没有） */
  pendingTeam?: boolean;
  /** 思考强度视图：默认支持 high、未显式设置 */
  effort?: { options?: Array<{ id: string; name: string }>; current?: { id: string; name: string }; defaulted: boolean };
  /** 生效 preset（没有会话时是部署默认值） */
  preset?: string;
  /** 生效权限预设（没有会话时是部署默认值） */
  permission?: string;
  /** 生成中的现场（默认没有进度事件） */
  progress?: SessionTurnProgress;
}

function makeManager(options: StubOptions = {}) {
  const active = options.active ?? true;
  const events = options.title === undefined
    ? []
    : [{ type: 'session/title', data: { title: options.title } }];
  const record = active
    ? {
      sessionId: SESSION_ID,
      agent: {
        status: options.agentStatus ?? 'idle',
        session: { snapshotEvents: () => events },
      },
    }
    : undefined;

  return {
    getStatus: vi.fn(() => ({
      active,
      sessionId: active ? SESSION_ID : undefined,
      provider: 'deepseek',
      model: 'deepseek-v4',
      preset: active ? 'default' : undefined,
    })),
    getSessionRecord: vi.fn(() => record),
    getContextUsage: vi.fn(() => options.context ?? {}),
    getTurnProgress: vi.fn(() => options.progress),
    getEffortView: vi.fn(async () => options.effort ?? {
      options: [{ id: 'high', name: 'High' }],
      current: { id: 'high', name: 'High' },
      defaulted: true,
    }),
    getEffectivePreset: vi.fn(() => options.preset ?? 'default'),
    getPermissionPreset: vi.fn(() => options.permission ?? 'workspace-write'),
    listPermissionPresets: vi.fn(() => [{ id: 'workspace-write', name: '工作区内修改' }]),
    chatWorkspaceInfo: vi.fn(async () => ('workspace' in options
      ? options.workspace
      : { title: 'repo', path: 'D:\\repo', missing: false, branch: 'main' })),
    worktreeOf: vi.fn(() => options.worktree),
    teamEnabled: vi.fn(() => options.team),
    pendingTeamEnabled: vi.fn(() => options.pendingTeam ?? false),
  } as unknown as SessionManager;
}

function makeCtx(): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw: '' },
  } as unknown as SlashCommandHandlerContext;
}

/** 跑一次命令，返回实际发送的 markdown 文本 */
async function run(
  manager: SessionManager,
  cfg: QQTermConfig = config,
): Promise<string> {
  state.sent.length = 0;
  const command = sessionStatusCommand({ manager, config: cfg, logger });
  const result = await command.handler(makeCtx());
  expect(result).toEqual({ kind: 'noop' });
  return state.sent.at(-1) ?? '';
}

beforeEach(() => {
  state.sent.length = 0;
});

describe('/status 命令声明', () => {
  it('私聊可用', () => {
    const command = sessionStatusCommand({ manager: makeManager(), config, logger });
    expect(command.name).toBe('status');
    expect(command.scope).toBe('all');
  });
});

describe('/status（有会话）', () => {
  it('给出会话标题、短 id、工作区、模型与 preset', async () => {
    const text = await run(makeManager({ title: '修登录' }));
    expect(text).toContain('### 📊 会话状态');
    expect(text).toContain('**会话**: 「修登录」 · `#9d2c4410`');
    expect(text).toContain('**状态**: 空闲');
    expect(text).toContain('**工作区**: repo · `D:\\repo` (`main`)');
    expect(text).toContain('**模型**: deepseek/deepseek-v4');
    expect(text).toContain('**思考强度**: 高');
    expect(text).toContain('**Preset**: default');
    expect(text).toContain('**权限**: 工作区内修改 (workspace-write)');
  });

  it('会话在工作树里时多给一行树路径与分支', async () => {
    const text = await run(makeManager({
      worktree: {
        branch: 'dsh-1a2b3c4d-9f0e',
        baseCommit: '6b1f02c0ffee',
        path: 'D:\\repo\\.agents\\worktrees\\dsh-1a2b3c4d-9f0e',
      },
    }));
    expect(text).toContain(
      '**工作树**: `D:\\repo\\.agents\\worktrees\\dsh-1a2b3c4d-9f0e` (`dsh-1a2b3c4d-9f0e`)',
    );
    // 树会话只显示树的分支：工作区行不再重复主仓库的分支
    expect(text).toContain('**工作区**: repo · `D:\\repo`');
    expect(text).not.toContain('`D:\\repo` (`main`)');
  });

  it('团队模式开着时给一行「开」', async () => {
    expect(await run(makeManager({ team: true }))).toContain('**团队**: 开');
  });

  it('团队模式关着时给一行「关」', async () => {
    expect(await run(makeManager({ team: false }))).toContain('**团队**: 关');
  });

  it('没有团队投影时不出现团队行', async () => {
    const text = await run(makeManager());
    expect(text).not.toContain('**团队**');
  });

  it('没有工作树的会话不出现这一行', async () => {
    const text = await run(makeManager());
    expect(text).not.toContain('**工作树**');
  });

  it('模型不支持思考时不显示思考强度行', async () => {
    const text = await run(makeManager({ effort: { defaulted: true } }));
    expect(text).not.toContain('**思考强度**:');
  });

  it('宿主还没生成标题时只给短 id，不写「未命名会话」', async () => {
    const text = await run(makeManager());
    expect(text).toContain('**会话**: `#9d2c4410`');
    expect(text).toContain('**状态**: 空闲');
    expect(text).not.toContain('未命名会话');
  });

  it('空标题按没有标题处理', async () => {
    const text = await run(makeManager({ title: '   ' }));
    expect(text).toContain('**会话**: `#9d2c4410`');
    expect(text).toContain('**状态**: 空闲');
  });

  it('标题过长时截断，不撑破一行', async () => {
    const text = await run(makeManager({ title: '标'.repeat(25) }));
    expect(text).toContain(`**会话**: 「${'标'.repeat(20)}…」`);
  });

  it('生成中与空闲都收在状态一行里', async () => {
    const running = await run(makeManager({ agentStatus: 'running' }));
    expect(running).toContain('**状态**: ⚡ 生成中');
    expect(running).not.toContain('**会话**: `#9d2c4410` · 生成中');
    const idle = await run(makeManager({ agentStatus: 'idle' }));
    expect(idle).toContain('**状态**: 空闲');
    expect(idle).not.toContain('**会话**: `#9d2c4410` · 空闲');
  });

  it('上下文给出占用 / 窗口 / 百分比 / 剩余', async () => {
    const text = await run(makeManager({ context: { used: 12_345, window: 200_000 } }));
    expect(text).toContain('**上下文**: 12,345 / 200,000（6.2%，剩 187,655）');
  });

  it('只有占用量时说明窗口未上报', async () => {
    const text = await run(makeManager({ context: { used: 12_345 } }));
    expect(text).toContain('**上下文**: 12,345（窗口未上报）');
  });

  it('只有窗口时说明还没有请求', async () => {
    const text = await run(makeManager({ context: { window: 200_000 } }));
    expect(text).toContain('**上下文**: 窗口 200,000（还没有请求）');
  });

  it('两个数都没有时不显示上下文行', async () => {
    expect(await run(makeManager({ context: {} }))).not.toContain('上下文');
  });

  it('目录已不存在时明确告警', async () => {
    const text = await run(makeManager({ workspace: { title: 'gone', path: 'D:\\gone', missing: true } }));
    expect(text).toContain('⚠️ 目录已不存在');
  });

  it('读不到工作区时不影响其它字段', async () => {
    const text = await run(makeManager({ workspace: undefined }));
    expect(text).not.toContain('**工作区**:');
    expect(text).toContain('**模型**: deepseek/deepseek-v4');
  });

  it('工作区没有名字时只显示路径，不重复末段目录名', async () => {
    const text = await run(makeManager({ workspace: { title: '', path: 'D:\\repo', missing: false } }));
    expect(text).toContain('**工作区**: `D:\\repo`');
    expect(text).not.toContain('repo ·');
  });

  it('工作区不是 Git 仓库时不显示分支', async () => {
    const text = await run(makeManager({ workspace: { title: 'repo', path: 'D:\\repo', missing: false } }));
    expect(text).toContain('**工作区**: repo · `D:\\repo`');
    expect(text).not.toContain('`D:\\repo` (`');
  });

  it('生成中依次给步数、总时长与正在执行的工具', async () => {
    const text = await run(makeManager({
      agentStatus: 'running',
      progress: {
        elapsedMs: 130_000,
        step: 3,
        waiting: 'tool',
        waitingSince: Date.now() - 12_000,
        toolName: 'read',
      },
    }));
    expect(text).toContain('**状态**: ⚡ 第 3 步 · 共 2m10s · 正在 `read`');
    expect(text).not.toContain('**本轮**');
    expect(text).not.toContain('**进度**');
  });

  it('等待模型响应时给重试退避', async () => {
    const text = await run(makeManager({
      agentStatus: 'running',
      progress: {
        elapsedMs: 45_000,
        waiting: 'model',
        waitingSince: Date.now() - 45_000,
        retry: { attempt: 2, delayMs: 10_000, since: Date.now() },
      },
    }));
    expect(text).toContain('**状态**: ⚡ 共 45s · 等待模型响应');
    expect(text).toContain('**重试**: 第 2 次 · ');
    expect(text).toContain('后重发');
  });

  it('空闲时不展示生成中的现场', async () => {
    const text = await run(makeManager({
      progress: { elapsedMs: 1000, step: 1, waiting: 'model', waitingSince: Date.now() },
    }));
    expect(text).toContain('**状态**: 空闲');
    expect(text).not.toContain('第 1 步');
    expect(text).not.toContain('等待模型响应');
  });

  it('生成中但没有进度事件时只写「⚡ 生成中」', async () => {
    const text = await run(makeManager({ agentStatus: 'running' }));
    expect(text).toContain('**状态**: ⚡ 生成中\n');
    expect(text).not.toContain('**本轮**');
    expect(text).not.toContain('**进度**');
  });

  it('生成中给可点击的 /stop 入口', async () => {
    const text = await run(makeManager({ agentStatus: 'running' }));
    expect(text).toContain('<qqbot-cmd-input text="/stop" show="停止生成"/>');
    expect(text.trimEnd().endsWith('/>')).toBe(true);
  });

  it('空闲与没有会话时不给 /stop 入口', async () => {
    expect(await run(makeManager({ agentStatus: 'idle' }))).not.toContain('/stop');
    expect(await run(makeManager({ active: false }))).not.toContain('/stop');
  });
});

describe('/status（没有会话）', () => {
  it('展示模型 / 思考强度 / preset / 权限的默认值，不标「默认」', async () => {
    const text = await run(makeManager({ active: false }));
    expect(text).toContain('**会话**: 未建立');
    expect(text).toContain('**工作区**: repo · `D:\\repo` (`main`)');
    expect(text).toContain('**模型**: deepseek/deepseek-v4');
    expect(text).toContain('**思考强度**: 高');
    expect(text).toContain('**Preset**: default');
    expect(text).toContain('**权限**: 工作区内修改 (workspace-write)');
    expect(text).not.toContain('默认');
  });

  it('没有会话但留了团队意图时写在下一条消息上', async () => {
    expect(await run(makeManager({ active: false, pendingTeam: true }))).toContain('**下一条消息**: 团队模式');
  });

  it('没有团队意图时不出现下一条消息行', async () => {
    expect(await run(makeManager({ active: false }))).not.toContain('**下一条消息**');
  });

  it('没有会话时不展示上下文', async () => {
    expect(await run(makeManager({ active: false }))).not.toContain('**上下文**:');
  });

  it('宿主读不出权限时保留该字段写 —，不整行消失', async () => {
    const manager = makeManager({ active: false });
    (manager.getPermissionPreset as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const text = await run(manager);
    expect(text).toContain('**权限**: —');
  });
});
