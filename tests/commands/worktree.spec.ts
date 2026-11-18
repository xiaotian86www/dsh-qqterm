/**
 * /worktree：查看 / 切换「之后新建的会话是否开工作树」
 *
 * manager 用替身，只验证「参数 → 调用 → 文案」与命令注册；建树本身的行为
 * 由 session-manager.spec.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { SessionManager } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { buildCommandList } from '../../src/commands/index.ts';
import { worktreeCommand } from '../../src/commands/worktree.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../../src/shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { owner: 'owner' },
} as QQTermConfig);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

interface StubOptions {
  enabled?: boolean;
  available?: boolean;
}

function makeManager(options: StubOptions = {}) {
  return {
    worktreesAvailable: vi.fn(() => options.available ?? true),
    worktreeEnabled: vi.fn(() => options.enabled ?? true),
    setWorktreeEnabled: vi.fn(),
    presetsAvailable: vi.fn(() => true),
  } as unknown as SessionManager;
}

function makeCtx(raw = '', senderId = 'owner'): SlashCommandHandlerContext {
  return {
    message: { senderId, kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

/** 跑一次命令：查看类走 sendMarkdownChunked，切换类直接返回文本 */
async function run(manager: SessionManager, raw = ''): Promise<string> {
  state.sent.length = 0;
  const command = worktreeCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : state.sent.at(-1) ?? '';
}

beforeEach(() => {
  state.sent.length = 0;
});

describe('/worktree 命令声明', () => {
  it('不限作用域，但要绑定用户', () => {
    const command = worktreeCommand({ manager: makeManager(), config, logger });
    expect(command.name).toBe('worktree');
    expect(command.scope).toBe('all');
    expect(command.description).toContain('工作树');
  });

  it('非绑定用户被拒绝', () => {
    const command = worktreeCommand({ manager: makeManager(), config, logger });
    expect(command.authorized?.(makeCtx('开', 'stranger'))).toBe('⚠️ 无权限执行此命令');
    expect(command.authorized?.(makeCtx('开'))).toBe(true);
  });
});

describe('/worktree 注册', () => {
  const namesOf = (available: boolean): string[] => buildCommandList({
    manager: makeManager({ available }),
    config,
    logger,
  }).flatMap((command) => (Array.isArray(command.name) ? command.name : [command.name]));

  it('有 worktrees 服务时注册', () => {
    expect(namesOf(true)).toContain('worktree');
  });

  it('没有 worktrees 服务时整条命令不出现', () => {
    expect(namesOf(false)).not.toContain('worktree');
  });
});

describe('/worktree 查看', () => {
  it('开：当前值与两个取值，当前项标 ✅', async () => {
    const text = await run(makeManager());
    expect(text).toContain('### 🌿 工作树');
    expect(text).toContain('当前: 开');
    expect(text).toContain('show="/worktree 开 ✅"');
    expect(text).toContain('show="/worktree 关"');
    expect(text).not.toContain('默认');
  });

  it('关：当前值跟着变，✅ 落到关上', async () => {
    const text = await run(makeManager({ enabled: false }));
    expect(text).toContain('当前: 关');
    expect(text).toContain('show="/worktree 开"');
    expect(text).toContain('show="/worktree 关 ✅"');
  });
});

describe('/worktree 切换', () => {
  it('关：落盘并回执「之后新建的会话在主检出里跑」', async () => {
    const manager = makeManager();
    const text = await run(manager, '关');
    expect(manager.setWorktreeEnabled).toHaveBeenCalledWith(false);
    expect(text).toBe('✅ 之后新建的会话直接在主检出里跑 · 已有会话不受影响');
  });

  it('开：落盘并回执「之后新建的会话开在工作树里」', async () => {
    const manager = makeManager({ enabled: false });
    const text = await run(manager, '开');
    expect(manager.setWorktreeEnabled).toHaveBeenCalledWith(true);
    expect(text).toBe('✅ 之后新建的会话开在工作树里 · 已有会话不受影响');
  });

  it('on / off 是别名', async () => {
    const manager = makeManager();
    expect(await run(manager, 'OFF')).toContain('主检出');
    expect(manager.setWorktreeEnabled).toHaveBeenCalledWith(false);
    expect(await run(manager, 'On')).toContain('开在工作树里');
    expect(manager.setWorktreeEnabled).toHaveBeenLastCalledWith(true);
  });

  it('未知子命令：不回退成切换', async () => {
    const manager = makeManager();
    const text = await run(manager, 'maybe');
    expect(text).toBe('⚠️ 未知子命令: maybe · 用法: /help worktree');
    expect(manager.setWorktreeEnabled).not.toHaveBeenCalled();
  });
});
