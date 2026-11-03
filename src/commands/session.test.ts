/**
 * /new 命令：开新会话，可顺带指定工作区
 *
 * manager 用替身，只验证「参数 → 调用顺序 → 文案」。关键是顺序：**先解析目标
 * 再动会话**，路径写错不能把当前会话弄丢。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { newCommand } from './session.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { c2cAllow: ['user1'] },
} as ImQQBotConfig);

function makeManager() {
  return {
    remove: vi.fn(async () => {}),
    resolveWorkspace: vi.fn(() => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
    changeChatWorkspace: vi.fn(async () => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
  };
}

type ManagerStub = ReturnType<typeof makeManager>;

function makeCtx(raw: string, senderId = 'user1'): SlashCommandHandlerContext {
  return {
    message: { senderId, kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: ManagerStub, raw = '', senderId = 'user1'): Promise<string> {
  const command = newCommand({ manager: manager as unknown as SessionManager, config, logger });
  const result = await command.handler(makeCtx(raw, senderId));
  return typeof result === 'string' ? result : '';
}

describe('/new 命令声明', () => {
  it('三个别名都指向同一个命令，且不限作用域', () => {
    const command = newCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(command.name).toEqual(['new', 'reset', 'clear']);
    expect(command.scope).toBe('all');
  });
});

describe('/new（不带参数）', () => {
  it('留在当前工作区：只开新会话，不碰工作区', async () => {
    const manager = makeManager();
    expect(await run(manager)).toBe('已开启新会话 ✓');
    expect(manager.remove).toHaveBeenCalledWith('c2c', 'user1');
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
    expect(manager.resolveWorkspace).not.toHaveBeenCalled();
  });

  it('不带参数时不受白名单限制', async () => {
    const manager = makeManager();
    expect(await run(manager, '', 'stranger')).toBe('已开启新会话 ✓');
    expect(manager.remove).toHaveBeenCalled();
  });
});

describe('/new <工作区>', () => {
  it('先开新会话再换工作区，回复里带上工作区', async () => {
    const manager = makeManager();
    const text = await run(manager, 'repo');

    expect(manager.remove).toHaveBeenCalledWith('c2c', 'user1');
    expect(manager.changeChatWorkspace).toHaveBeenCalledWith('c2c', 'user1', 'repo');
    // 顺序：先 remove 再改目录（改目录只在会话没落盘时生效）
    const removeAt = manager.remove.mock.invocationCallOrder[0] ?? 0;
    const changeAt = manager.changeChatWorkspace.mock.invocationCallOrder[0] ?? 0;
    expect(removeAt).toBeLessThan(changeAt);
    expect(text).toContain('已开启新会话 ✓');
    expect(text).toContain('工作区：repo · D:\\repo');
  });

  it('目标解析失败时不动当前会话', async () => {
    const manager = {
      remove: vi.fn(async () => {}),
      resolveWorkspace: vi.fn(() => ({ ok: false as const, reason: 'missing' as const, path: 'D:\\nope' })),
      changeChatWorkspace: vi.fn(async () => ({ ok: true as const, title: 'x', path: 'x', isNew: false })),
    };

    const text = await run(manager, 'D:\\nope');

    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
    expect(text).toContain('目录不存在：`D:\\nope`');
  });

  it('换目录在 remove 之后仍失败时如实报告（不回「已开启」）', async () => {
    const manager = {
      remove: vi.fn(async () => {}),
      resolveWorkspace: vi.fn(() => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
      changeChatWorkspace: vi.fn(async () => ({ ok: false as const, reason: 'missing' as const, path: 'D:\\repo' })),
    };

    const text = await run(manager, 'repo');
    expect(text).toContain('目录不存在');
    expect(text).not.toContain('已开启新会话');
  });

  it('白名单外不能改工作区，且不动会话', async () => {
    const manager = makeManager();
    const text = await run(manager, 'repo', 'stranger');

    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
    expect(text).toContain('只在私聊 + 白名单');
  });

  it('群聊里不能改工作区（与 /workspace 一致），但直接 /new 仍然可以', async () => {
    const manager = makeManager();
    const command = newCommand({ manager: manager as unknown as SessionManager, config, logger });
    const groupCtx = {
      message: { senderId: 'user1', kind: 'group', groupOpenid: 'g1', messageId: 'm1' },
      command: { raw: 'repo' },
    } as unknown as SlashCommandHandlerContext;

    const text = await command.handler(groupCtx);
    expect(text).toContain('只在私聊 + 白名单');
    expect(manager.remove).not.toHaveBeenCalled();

    // 同一群里不带参数 = 普通开新会话
    const plain = { ...groupCtx, command: { raw: '' } } as unknown as SlashCommandHandlerContext;
    expect(await command.handler(plain)).toBe('已开启新会话 ✓');
    expect(manager.remove).toHaveBeenCalledWith('group', 'g1');
  });
});
