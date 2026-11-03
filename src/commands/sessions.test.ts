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
import { formatBytes, resolveSessionTarget, sessionAdminAuth, sessionsCommand } from './sessions.ts';

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
    isSeeded: false,
    ...over,
  };
}

function makeManager(over: Partial<Record<'listWorkspaceSessions' | 'switchSession' | 'deleteSessions', unknown>> = {}) {
  return {
    listWorkspaceSessions: vi.fn(async () => [entry()]),
    switchSession: vi.fn(async () => ({ ok: true })),
    deleteSessions: vi.fn(async () => ({
      ok: true,
      removed: [{ id: entry().id, path: '/tmp/x', bytes: 2048 }],
      failed: [],
      missing: [],
      cascaded: 0,
      remapped: 0,
    })),
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
});

describe('/sessions list', () => {
  it('统一 markdown 格式：当前会话是状态行，其余渲染成可点击命令', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [
        entry({ id: 'session-current', current: true, title: '当前会话' }),
        entry({ id: 'session-older', title: '旧会话', createdAt: Date.now() - 3 * 86_400_000 }),
      ]),
    });

    const text = await run(manager, '');

    expect(text).toContain('🗂 会话（共 2 个');
    expect(text).toContain('✅ **当前**');
    expect(text).toContain('旧会话');
    // 点击后输入框出现对应操作
    expect(text).toContain('<qqbot-cmd-input text="/sessions resume 2" show="2. 旧会话');
    // 当前会话不该出现恢复入口
    expect(text).not.toContain('/sessions resume 1');
    // 标题层级与 /model 一致，且不出现堆叠的 ####
    expect(text.startsWith('### 🗂')).toBe(true);
    expect(text).not.toContain('####');
  });

  it('被其它聊天占用的会话在标签里标注使用中', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ live: true })]),
    });
    expect(await run(manager, 'list')).toContain('使用中');
  });

  it('没有会话时给出引导', async () => {
    const manager = makeManager({ listWorkspaceSessions: vi.fn(async () => []) });
    expect(await run(manager, 'list')).toContain('还没有会话');
  });

  it('列举失败时回显原因而不是抛错', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => {
        throw new Error('sqlite malformed');
      }),
    });
    const text = await run(manager, 'list');
    expect(text).toContain('读取会话列表失败');
    expect(text).toContain('sqlite malformed');
  });

  it('超过展示上限时提示还有更早的会话', async () => {
    const many = Array.from({ length: 13 }, (_, i) => entry({ id: `session-${String(i).padStart(4, '0')}` }));
    const manager = makeManager({ listWorkspaceSessions: vi.fn(async () => many) });
    expect(await run(manager, 'list')).toContain('还有 3 个更早的会话');
  });
});

describe('/sessions resume', () => {
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
    // 短 id 去掉 session- 前缀，避免只显示出一个 "session-"
    expect(text).toContain('`11111111`');
    expect(text).not.toContain('`session-`');
  });

  it('已是当前会话时直接提示', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ current: true })]),
    });
    expect(await run(manager, 'resume 1')).toContain('已经是当前会话');
    expect(manager.switchSession).not.toHaveBeenCalled();
  });

  it('会话不存在 / 被其它聊天占用 / 恢复失败各有明确文案', async () => {
    const missing = makeManager({ switchSession: vi.fn(async () => ({ ok: false, reason: 'not-found' })) });
    expect(await run(missing, 'resume 1')).toContain('磁盘上没有这个会话');

    const inUse = makeManager({ switchSession: vi.fn(async () => ({ ok: false, reason: 'in-use' })) });
    expect(await run(inUse, 'resume 1')).toContain('另一个聊天中使用');

    const failed = makeManager({
      switchSession: vi.fn(async () => ({ ok: false, reason: 'failed', message: 'ownership taken' })),
    });
    expect(await run(failed, 'resume 1')).toContain('ownership taken');
  });
});

describe('/sessions delete', () => {
  it('删除成功后报告释放空间', async () => {
    const manager = makeManager();
    const text = await run(manager, 'delete 1');

    expect(manager.deleteSessions).toHaveBeenCalledWith([entry().id]);
    expect(text).toContain('已删除会话');
    expect(text).toContain('2.0 KB');
  });

  it('删除当前会话后提示已切到新会话', async () => {
    const manager = makeManager({
      listWorkspaceSessions: vi.fn(async () => [entry({ current: true })]),
    });
    expect(await run(manager, 'delete 1')).toContain('已自动切换到一个新会话');
  });

  it('删盘失败时如实报告（多为被 Web 端占用）', async () => {
    const manager = makeManager({
      deleteSessions: vi.fn(async () => ({
        ok: false,
        reason: 'failed',
        removed: [],
        failed: [{ id: entry().id, message: 'EBUSY: resource busy' }],
        missing: [],
        cascaded: 0,
        remapped: 0,
      })),
    });
    const text = await run(manager, 'delete 1');
    expect(text).toContain('EBUSY');
  });

  it('宿主未暴露存储根目录时明确拒绝', async () => {
    const manager = makeManager({
      deleteSessions: vi.fn(async () => ({
        ok: false,
        reason: 'no-root',
        message: '宿主未暴露会话存储根目录',
        removed: [],
        failed: [],
        missing: [],
        cascaded: 0,
        remapped: 0,
      })),
    });
    expect(await run(manager, 'delete 1')).toContain('无法删除');
  });
});

describe('sessionAdminAuth', () => {
  const withAllow = ConfigSchema({
    appId: 'app',
    appSecret: 'secret',
    access: { c2cMode: 'open', c2cAllow: ['user1'], groupMode: 'open', groupAllow: [] },
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
  it('未知子命令返回用法', async () => {
    const text = await run(makeManager(), 'whatever');
    expect(text).toContain('未知子命令');
    expect(text).toContain('/sessions resume');
  });

  it('formatBytes 分级', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
