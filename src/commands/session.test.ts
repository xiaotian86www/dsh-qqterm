/**
 * /new 与 /reset：开新会话；/new 可顺带指定工作区，/reset 会先停掉当前会话
 *
 * manager 用替身，只验证「参数 → 调用顺序 → 文案」。关键是顺序：**先解析目标
 * 再动会话**，路径写错不能把当前会话弄丢。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import type { CommandDeps } from './types.ts';
import { compactCommand, newCommand, resetCommand } from './session.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { owner: 'user1' },
} as QQTermConfig);

function makeManager() {
  return {
    remove: vi.fn(async () => {}),
    workspaceRegistryAvailable: vi.fn(() => true),
    resolveWorkspace: vi.fn(() => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
    changeChatWorkspace: vi.fn(async () => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
  };
}

type ManagerStub = ReturnType<typeof makeManager>;

function makeCtx(raw: string, senderId = 'user1', name = 'new'): SlashCommandHandlerContext {
  return {
    message: { senderId, kind: 'c2c', messageId: 'm1' },
    command: { name, raw },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: ManagerStub, raw = '', senderId = 'user1'): Promise<string> {
  const command = newCommand({ manager: manager as unknown as SessionManager, config, logger });
  const result = await command.handler(makeCtx(raw, senderId));
  return typeof result === 'string' ? result : '';
}

function makeResetManager(stopped = true, allStopped = 0) {
  return {
    resetCurrentSession: vi.fn(async () => stopped),
    resetAllSessions: vi.fn(async () => allStopped),
  };
}

type ResetManagerStub = ReturnType<typeof makeResetManager>;

async function runReset(manager: ResetManagerStub, raw = '', name = 'reset'): Promise<string> {
  const command = resetCommand({ manager } as unknown as CommandDeps);
  const result = await command.handler(makeCtx(raw, 'user1', name));
  return typeof result === 'string' ? result : '';
}

describe('/new 命令声明', () => {
  it('只有 new 一个名字，且不限作用域', () => {
    const command = newCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(command.name).toBe('new');
    expect(command.scope).toBe('all');
  });
});

describe('/reset /clear 命令声明', () => {
  it('clear 是主名，reset 是别名，且不限作用域', () => {
    const command = resetCommand({ manager: makeResetManager() as unknown as SessionManager });
    expect(command.name).toEqual(['clear', 'reset']);
    expect(command.scope).toBe('all');
  });
});

describe('/reset /clear', () => {
  it('停掉当前会话并开启新会话', async () => {
    const manager = makeResetManager(true);

    expect(await runReset(manager)).toBe('✅ 已停止当前会话，并开启新会话');
    expect(manager.resetCurrentSession).toHaveBeenCalledWith();
  });

  it('没有当前会话时只报已开启', async () => {
    const manager = makeResetManager(false);

    expect(await runReset(manager, '', 'clear')).toBe('✅ 已开启新会话');
    expect(manager.resetCurrentSession).toHaveBeenCalledWith();
  });

  it('带工作区参数时拒绝，并提示改用 /new', async () => {
    const manager = makeResetManager();

    const text = await runReset(manager, 'repo', 'clear');

    expect(text).toBe('⚠️ /clear 不支持指定工作区\n换工作区用 /new <工作区|路径>。');
    expect(manager.resetCurrentSession).not.toHaveBeenCalled();
    expect(manager.resetAllSessions).not.toHaveBeenCalled();
  });

  it('/reset all 停掉所有会话，并用数量回执', async () => {
    const manager = makeResetManager(true, 3);

    expect(await runReset(manager, 'all')).toBe('✅ 已停止 3 个会话，并开启新会话');
    expect(manager.resetAllSessions).toHaveBeenCalledWith();
    expect(manager.resetCurrentSession).not.toHaveBeenCalled();
  });

  it('/clear all 没有可停的会话时只报已开启', async () => {
    const manager = makeResetManager(true, 0);

    expect(await runReset(manager, 'all', 'clear')).toBe('✅ 已开启新会话');
    expect(manager.resetAllSessions).toHaveBeenCalledWith();
    expect(manager.resetCurrentSession).not.toHaveBeenCalled();
  });
});

describe('/new（不带参数）', () => {
  it('留在当前工作区：只开新会话，不碰工作区', async () => {
    const manager = makeManager();
    expect(await run(manager)).toBe('✅ 已开启新会话');
    expect(manager.remove).toHaveBeenCalledWith();
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
    expect(manager.resolveWorkspace).not.toHaveBeenCalled();
  });

  it('不带参数时不受白名单限制', async () => {
    const manager = makeManager();
    expect(await run(manager, '', 'stranger')).toBe('✅ 已开启新会话');
    expect(manager.remove).toHaveBeenCalled();
  });
});

describe('/new <工作区>', () => {
  it('先开新会话再换工作区，回复里带上工作区', async () => {
    const manager = makeManager();
    const text = await run(manager, 'repo');

    expect(manager.remove).toHaveBeenCalledWith();
    expect(manager.changeChatWorkspace).toHaveBeenCalledWith('c2c', 'user1', 'repo');
    // 顺序：先 remove 再改目录（改目录只在会话没落盘时生效）
    const removeAt = manager.remove.mock.invocationCallOrder[0] ?? 0;
    const changeAt = manager.changeChatWorkspace.mock.invocationCallOrder[0] ?? 0;
    expect(removeAt).toBeLessThan(changeAt);
    expect(text).toContain('✅ 已开启新会话');
    expect(text).toContain('工作区: repo · D:\\repo');
  });

  it('目标解析失败时不动当前会话', async () => {
    const manager = {
      remove: vi.fn(async () => {}),
      workspaceRegistryAvailable: vi.fn(() => true),
      resolveWorkspace: vi.fn(() => ({ ok: false as const, reason: 'missing' as const, path: 'D:\\nope' })),
      changeChatWorkspace: vi.fn(async () => ({ ok: true as const, title: 'x', path: 'x', isNew: false })),
    };

    const text = await run(manager, 'D:\\nope');

    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
    expect(text).toContain('目录不存在: `D:\\nope`');
  });

  it('没有 registry 的部署不能按名字新建，提示用绝对路径', async () => {
    const manager = {
      remove: vi.fn(async () => {}),
      workspaceRegistryAvailable: vi.fn(() => false),
      resolveWorkspace: vi.fn(() => ({ ok: false as const, reason: 'unavailable' as const, arg: 'repo' })),
      changeChatWorkspace: vi.fn(async () => ({ ok: true as const, title: 'x', path: 'x', isNew: false })),
    };

    const text = await run(manager, 'repo');

    expect(text).toContain('只支持绝对路径');
    expect(text).toContain('/new D:\\项目\\目录');
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it('换目录在 remove 之后仍失败时如实报告（不回「已开启」）', async () => {
    const manager = {
      remove: vi.fn(async () => {}),
      workspaceRegistryAvailable: vi.fn(() => true),
      resolveWorkspace: vi.fn(() => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
      changeChatWorkspace: vi.fn(async () => ({ ok: false as const, reason: 'missing' as const, path: 'D:\\repo' })),
    };

    const text = await run(manager, 'repo');
    expect(text).toContain('目录不存在');
    expect(text).not.toContain('已开启新会话');
  });

  it('没有 registry 时用法页只列路径写法', () => {
    const named = newCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(named.usage).toContain('`/new <工作区>`');
    expect(named.usage).toContain('工作区认标题、目录名或绝对路径');

    const pathOnly = newCommand({
      manager: { ...makeManager(), workspaceRegistryAvailable: vi.fn(() => false) } as unknown as SessionManager,
      config,
      logger,
    });
    expect(pathOnly.usage).toContain('`/new <路径>`');
    expect(pathOnly.usage).not.toContain('工作区认标题');
  });

  it('没有 registry 时回执只显示路径，不重复末段目录名', async () => {
    const manager = {
      remove: vi.fn(async () => {}),
      workspaceRegistryAvailable: vi.fn(() => false),
      resolveWorkspace: vi.fn(() => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: true })),
      changeChatWorkspace: vi.fn(async () => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: true })),
    };

    const text = await run(manager, 'D:\\repo');

    expect(text).toBe('✅ 已开启新会话\n工作区: D:\\repo');
  });

  it('非绑定用户不能改工作区，且不动会话', async () => {
    const manager = makeManager();
    const text = await run(manager, 'repo', 'stranger');

    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
    expect(text).toContain('仅限绑定用户可用');
  });
});

describe('/compact 缺少 preset 压缩能力', () => {
  it('只回一行，不点名具体 preset', async () => {
    const manager = { compact: vi.fn(async () => ({ ok: false, reason: 'no-compaction' })) };
    const command = compactCommand({ manager } as unknown as CommandDeps);
    const result = await command.handler(makeCtx('', 'user1', 'compact'));

    expect(result).toBe('⚠️ 当前 preset 没有压缩能力');
  });
});
