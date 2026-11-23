/**
 * /rename：改当前会话名
 *
 * manager 用替身，只验证「参数 → 调用 → 文案」。真正的标题写入在
 * session-manager / host adapter 的测试里钉住。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { SessionManager } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import type { CommandDeps } from '../../src/commands/types.ts';
import { renameCommand } from '../../src/commands/rename.ts';
import { buildCommandList } from '../../src/commands/index.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { owner: 'user1' },
} as QQTermConfig);

const CURRENT = 'session-3f2a9b1c-1111-2222-3333-444455556666';

function makeManager(overrides: Record<string, unknown> = {}) {
  return {
    currentSessionId: vi.fn(() => CURRENT as string | undefined),
    hasCurrentSession: vi.fn(() => true),
    sessionTitle: vi.fn(() => '修登录' as string | undefined),
    renameCurrentSession: vi.fn(() => ({ ok: true as const, title: '新名字' })),
    presetsAvailable: vi.fn(() => true),
    worktreesAvailable: vi.fn(() => true),
    canSteer: vi.fn(() => false),
    ...overrides,
  };
}

type ManagerStub = ReturnType<typeof makeManager>;

function makeCtx(raw: string): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { name: 'rename', raw },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: ManagerStub, raw = ''): Promise<string> {
  const command = renameCommand({ manager: manager as unknown as SessionManager, config, logger });
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : '';
}

describe('/rename 命令声明', () => {
  it('不限作用域', () => {
    const command = renameCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(command.name).toBe('rename');
    expect(command.scope).toBe('all');
    expect(command.description).toContain('会话');
  });

  it('注册进命令列表', () => {
    const names = buildCommandList({
      manager: makeManager() as unknown as SessionManager,
      config,
      logger,
    }).flatMap((command) => (Array.isArray(command.name) ? command.name : [command.name]));
    expect(names).toContain('rename');
  });
});

describe('/rename（不带参数）', () => {
  it('显示当前会话名与下一步', async () => {
    const manager = makeManager();

    expect(await run(manager)).toBe('🗂 当前会话名: 「修登录」\n改名用 /rename <新标题>');
    expect(manager.renameCurrentSession).not.toHaveBeenCalled();
  });

  it('当前没有会话时只说明状态', async () => {
    const manager = makeManager({
      currentSessionId: vi.fn(() => undefined),
      hasCurrentSession: vi.fn(() => false),
    });

    const text = await run(manager);
    expect(text).toBe('⚠️ 当前没有会话');
    expect(manager.renameCurrentSession).not.toHaveBeenCalled();
  });

  it('指针还在但会话没打开时同样只说明状态', async () => {
    const manager = makeManager({ hasCurrentSession: vi.fn(() => false) });

    expect(await run(manager)).toContain('当前没有会话');
  });

  it('只有空白字符时按不带参数处理（不会把空标题写进日志）', async () => {
    const manager = makeManager();

    expect(await run(manager, '   ')).toContain('当前会话名');
    expect(manager.renameCurrentSession).not.toHaveBeenCalled();
  });

  it('会话还没有标题时显示兜底名', async () => {
    const manager = makeManager({ sessionTitle: vi.fn(() => undefined) });

    expect(await run(manager)).toContain('「未命名会话」');
  });
});

describe('/rename <新标题>', () => {
  it('把原始标题交给 manager，并回报宿主接受的标题', async () => {
    const manager = makeManager({
      renameCurrentSession: vi.fn(() => ({ ok: true as const, title: '修登录 2' })),
    });

    expect(await run(manager, ' 修登录 2 ')).toBe('✅ 会话名已改为「修登录 2」');
    expect(manager.renameCurrentSession).toHaveBeenCalledWith('修登录 2');
  });

  it('当前没有会话时只说明状态', async () => {
    const manager = makeManager({
      renameCurrentSession: vi.fn(() => ({ ok: false as const, reason: 'no-session' as const })),
    });

    expect(await run(manager, '新名字')).toBe('⚠️ 当前没有会话');
  });

  it('标题为空时明确拒绝', async () => {
    const manager = makeManager({
      renameCurrentSession: vi.fn(() => ({ ok: false as const, reason: 'invalid' as const })),
    });

    expect(await run(manager, 'x')).toBe('⚠️ 新标题不能为空');
  });

  it('会话已关闭时如实说明', async () => {
    const manager = makeManager({
      renameCurrentSession: vi.fn(() => ({ ok: false as const, reason: 'not-live' as const })),
    });

    expect(await run(manager, '新名字')).toBe('⚠️ 会话已关闭');
  });

  it('其它失败用 ❌ 并带上原因', async () => {
    const manager = makeManager({
      renameCurrentSession: vi.fn(() => ({
        ok: false as const,
        reason: 'failed' as const,
        message: '日志写入失败',
      })),
    });

    expect(await run(manager, '新名字')).toBe('❌ 改名失败: 日志写入失败');
  });

  it('展示时去掉 markdown 字符并压成一行', async () => {
    const manager = makeManager({
      renameCurrentSession: vi.fn(() => ({ ok: true as const, title: '`a*b`\nc' })),
    });

    expect(await run(manager, 'x')).toBe('✅ 会话名已改为「ab c」');
  });

  it('超长标题在回复里截断，但不改写提交给宿主的标题', async () => {
    const long = '很长的会话标题'.repeat(10);
    const manager = makeManager({
      renameCurrentSession: vi.fn(() => ({ ok: true as const, title: long })),
    });

    const text = await run(manager, long);
    expect(text).toContain('…');
    expect(manager.renameCurrentSession).toHaveBeenCalledWith(long);
  });
});
