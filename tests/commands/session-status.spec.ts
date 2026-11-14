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
  messageCount?: number;
  usage?: { input: number; output: number };
  context?: { used?: number; window?: number };
  workspace?: { title: string; path: string; missing: boolean } | undefined;
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
      messageCount: options.messageCount ?? 12,
    })),
    getSessionRecord: vi.fn(() => record),
    getTokenUsage: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...options.usage })),
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
    currentWorkspaceInfo: vi.fn(async () => ('workspace' in options
      ? options.workspace
      : { title: 'repo', path: 'D:\\repo', missing: false })),
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
    expect(text).toContain('**会话**: 「修登录」 · `#9d2c4410` · 空闲');
    expect(text).toContain('**工作区**: repo · `D:\\repo`');
    expect(text).toContain('**模型**: deepseek/deepseek-v4');
    expect(text).toContain('**思考强度**: 高');
    expect(text).toContain('**Preset**: default');
    expect(text).toContain('**权限**: 工作区内修改 (workspace-write)');
  });

  it('模型不支持思考时不显示思考强度行', async () => {
    const text = await run(makeManager({ effort: { defaulted: true } }));
    expect(text).not.toContain('**思考强度**:');
  });

  it('宿主还没生成标题时只给短 id，不写「未命名会话」', async () => {
    const text = await run(makeManager());
    expect(text).toContain('**会话**: `#9d2c4410` · 空闲');
    expect(text).not.toContain('未命名会话');
  });

  it('空标题按没有标题处理', async () => {
    const text = await run(makeManager({ title: '   ' }));
    expect(text).toContain('**会话**: `#9d2c4410` · 空闲');
  });

  it('标题过长时截断，不撑破一行', async () => {
    const text = await run(makeManager({ title: '标'.repeat(25) }));
    expect(text).toContain(`**会话**: 「${'标'.repeat(20)}…」`);
  });

  it('生成中与空闲区分开', async () => {
    expect(await run(makeManager({ agentStatus: 'running' }))).toContain('生成中');
    expect(await run(makeManager({ agentStatus: 'idle' }))).toContain('空闲');
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

  it('累计 token 与消息数', async () => {
    const text = await run(makeManager({ usage: { input: 1234, output: 567 }, messageCount: 12 }));
    expect(text).toContain('**消息**: 12 条');
    expect(text).toContain('**Token**: 输入 1,234 · 输出 567（累计）');
  });

  it('没有 token 消耗时不显示 Token 行', async () => {
    expect(await run(makeManager({ usage: { input: 0, output: 0 } }))).not.toContain('**Token**:');
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

  it('生成中给出本轮耗时、步骤与正在执行的工具', async () => {
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
    expect(text).toContain('**本轮**: 2m10s · 第 3 步');
    expect(text).toContain('**进度**: 正在 `read`');
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
    expect(text).toContain('**进度**: 等待模型响应');
    expect(text).toContain('**重试**: 第 2 次 · ');
    expect(text).toContain('后重发');
  });

  it('空闲时不展示本轮现场', async () => {
    const text = await run(makeManager({
      progress: { elapsedMs: 1000, step: 1, waiting: 'model', waitingSince: Date.now() },
    }));
    expect(text).not.toContain('**本轮**:');
  });

  it('生成中但没有进度事件时不添加空行', async () => {
    const text = await run(makeManager({ agentStatus: 'running' }));
    expect(text).not.toContain('**本轮**:');
    expect(text).not.toContain('**进度**:');
  });

  it('生成中给可点击的 /stop 入口', async () => {
    const text = await run(makeManager({ agentStatus: 'running' }));
    expect(text).toContain('<qqbot-cmd-input text="/stop" show="⛔ 停止生成"/>');
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
    expect(text).toContain('**工作区**: repo · `D:\\repo`');
    expect(text).toContain('**模型**: deepseek/deepseek-v4');
    expect(text).toContain('**思考强度**: 高');
    expect(text).toContain('**Preset**: default');
    expect(text).toContain('**权限**: 工作区内修改 (workspace-write)');
    expect(text).not.toContain('默认');
  });

  it('不展示会话级字段', async () => {
    const text = await run(makeManager({ active: false }));
    expect(text).not.toContain('**消息**:');
    expect(text).not.toContain('**上下文**:');
    expect(text).not.toContain('**Token**:');
  });

  it('宿主读不出权限时保留该字段写 —，不整行消失', async () => {
    const manager = makeManager({ active: false });
    (manager.getPermissionPreset as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const text = await run(manager);
    expect(text).toContain('**权限**: —');
  });
});
