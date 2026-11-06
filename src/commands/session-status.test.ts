/**
 * /status 命令：会话状态的展示字段
 *
 * manager 用替身，只验证「状态 → 文案」这条链路；宿主交互由 session-admin.test.ts
 * 覆盖，计费口径由 /cost 负责。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { sessionStatusCommand } from './session-status.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as ImQQBotConfig);

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
    getEffortView: vi.fn(async () => options.effort ?? {
      options: [{ id: 'high', name: 'High' }],
      current: { id: 'high', name: 'High' },
      defaulted: true,
    }),
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
  cfg: ImQQBotConfig = config,
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
  it('是通用能力命令，私聊可用', () => {
    const command = sessionStatusCommand({ manager: makeManager(), config, logger });
    expect(command.name).toBe('status');
    expect(command.category).toBe('agent');
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
});

describe('/status（没有会话）', () => {
  it('只说明未建立与工作区，不展示会话级字段', async () => {
    const text = await run(makeManager({ active: false }));
    expect(text).toContain('**会话**: 未建立');
    expect(text).toContain('**工作区**: repo · `D:\\repo`');
    expect(text).not.toContain('**模型**:');
    expect(text).not.toContain('**思考强度**:');
    expect(text).not.toContain('**Preset**:');
    expect(text).not.toContain('**消息**:');
  });
});
