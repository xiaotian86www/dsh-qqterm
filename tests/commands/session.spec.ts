/**
 * /new 与 /reset：开新会话；/new 可顺带指定工作区，/reset 会先停掉当前会话
 *
 * manager 用替身，只验证「参数 → 调用顺序 → 文案」。关键是顺序：**先解析目标
 * 再动会话**，路径写错不能把当前会话弄丢。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import { WorktreeError, type SessionManager } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import type { CommandDeps } from '../../src/commands/types.ts';
import { compactCommand, newCommand, parseNewArgs, resetCommand } from '../../src/commands/session.ts';
import type { SessionConfirmRequest } from '../../src/features/session-confirm.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { owner: 'user1' },
} as QQTermConfig);

function makeManager() {
  return {
    remove: vi.fn(async () => {}),
    promptNewSession: vi.fn(async () => ({ sessionId: 's1' })),
    startBackgroundSession: vi.fn(async () => ({ sessionId: 'session-abcdef123' })),
    chatWorkspaceInfo: vi.fn(async () => ({ title: 'repo', path: 'D:\\repo', missing: false })),
    workspaceRegistryAvailable: vi.fn(() => true),
    worktreesAvailable: vi.fn(() => true),
    readOnlySandbox: vi.fn(() => false),
    armWorktree: vi.fn(),
    resolveWorkspace: vi.fn(() => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
    changeChatWorkspace: vi.fn(async () => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
    // 默认没有当前会话：既有用例不该被确认门禁挡住
    currentSessionId: vi.fn(() => undefined as string | undefined),
    size: 0,
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
    currentSessionId: vi.fn(() => undefined as string | undefined),
    size: 0,
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

    expect(text).toBe('⚠️ /clear 不支持指定工作区\n换工作区用 /new --dir <工作区|路径>。');
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

  it('--worktree：交出意图，回执交代下一条消息开树', async () => {
    const manager = makeManager();
    expect(await run(manager, '--worktree')).toBe('✅ 已开启新会话\n🌿 下一条消息开新工作树');
    expect(manager.remove).toHaveBeenCalledWith();
    expect(manager.armWorktree).toHaveBeenCalledTimes(1);
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
  });

  it('-w 是 --worktree 的别名', async () => {
    const manager = makeManager();
    expect(await run(manager, '-w')).toContain('🌿 下一条消息开新工作树');
    expect(manager.armWorktree).toHaveBeenCalledTimes(1);
  });

  it('没有 worktrees 服务：按未知参数处理，不动会话', async () => {
    const manager = { ...makeManager(), worktreesAvailable: vi.fn(() => false) };

    const text = await run(manager, '--worktree');

    expect(text).toBe('⚠️ 未知参数: --worktree · 用法: /help new');
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.armWorktree).not.toHaveBeenCalled();
  });

  it('只读沙箱：拒绝开树，不动会话', async () => {
    const manager = { ...makeManager(), readOnlySandbox: vi.fn(() => true) };

    const text = await run(manager, '--worktree');

    expect(text).toContain('只读沙箱开不了工作树');
    expect(text).toContain('/permission');
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.armWorktree).not.toHaveBeenCalled();
  });
});

describe('parseNewArgs', () => {
  it('裸文字是提示词，不再当工作区', () => {
    expect(parseNewArgs('修一下')).toEqual({ arg: '', worktree: false, background: false, prompt: '修一下', error: undefined });
    expect(parseNewArgs('看下这个 bug')).toEqual({ arg: '', worktree: false, background: false, prompt: '看下这个 bug', error: undefined });
    expect(parseNewArgs('')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: undefined });
  });

  it('--dir 与 -d 取后一个 token 作工作区，其余是提示词', () => {
    expect(parseNewArgs('--dir repo')).toEqual({ arg: 'repo', worktree: false, background: false, prompt: undefined, error: undefined });
    expect(parseNewArgs('-d repo 修一下')).toEqual({ arg: 'repo', worktree: false, background: false, prompt: '修一下', error: undefined });
    expect(parseNewArgs('-w --dir repo 修一下')).toEqual({ arg: 'repo', worktree: true, background: false, prompt: '修一下', error: undefined });
    expect(parseNewArgs('--worktree')).toEqual({ arg: '', worktree: true, background: false, prompt: undefined, error: undefined });
  });

  it('成对引号里的空格算同一个 token', () => {
    expect(parseNewArgs('--dir "D:\\My Repo"')).toEqual({ arg: 'D:\\My Repo', worktree: false, background: false, prompt: undefined, error: undefined });
    expect(parseNewArgs("-d 'D:\\My Repo' -w")).toEqual({ arg: 'D:\\My Repo', worktree: true, background: false, prompt: undefined, error: undefined });
  });

  it('参数写在提示词前后都生效，其余词按顺序连成提示词', () => {
    expect(parseNewArgs('修一下 --dir repo 再跑测试')).toEqual({ arg: 'repo', worktree: false, background: false, prompt: '修一下 再跑测试', error: undefined });
    expect(parseNewArgs('修一下 -w')).toEqual({ arg: '', worktree: true, background: false, prompt: '修一下', error: undefined });
  });

  it('引号包着的词是提示词或值，不当参数', () => {
    expect(parseNewArgs('看下 "-w" 这个参数')).toEqual({ arg: '', worktree: false, background: false, prompt: '看下 -w 这个参数', error: undefined });
    expect(parseNewArgs('-d "-w"')).toEqual({ arg: '-w', worktree: false, background: false, prompt: undefined, error: undefined });
  });

  it('--dir=值 与 --dir 值等价', () => {
    expect(parseNewArgs('--dir=repo 修一下')).toEqual({ arg: 'repo', worktree: false, background: false, prompt: '修一下', error: undefined });
    expect(parseNewArgs('--dir="D:\\My Repo"')).toEqual({ arg: 'D:\\My Repo', worktree: false, background: false, prompt: undefined, error: undefined });
    expect(parseNewArgs('--dir=')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ --dir 后要跟工作区 · 用法: /help new' });
  });

  it('-- 之后一律当提示词', () => {
    expect(parseNewArgs('--dir repo -- 看下 --prompt 这个参数')).toEqual({ arg: 'repo', worktree: false, background: false, prompt: '看下 --prompt 这个参数', error: undefined });
  });

  it('不认识的参数与已删除的 --prompt 都回未知参数', () => {
    expect(parseNewArgs('--prompt 修一下')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ 未知参数: --prompt · 用法: /help new' });
    expect(parseNewArgs('-p 修一下')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ 未知参数: -p · 用法: /help new' });
    expect(parseNewArgs('--nope 修一下')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ 未知参数: --nope · 用法: /help new' });
  });

  it('引号没闭合只回错误', () => {
    expect(parseNewArgs('--dir "D:\\My Repo')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ 引号没有闭合 · 用法: /help new' });
  });

  it('--dir 缺值时只回参数错', () => {
    expect(parseNewArgs('--dir')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ --dir 后要跟工作区 · 用法: /help new' });
    expect(parseNewArgs('-w -d')).toEqual({ arg: '', worktree: true, background: false, prompt: undefined, error: '⚠️ --dir 后要跟工作区 · 用法: /help new' });
    expect(parseNewArgs('--dir -w')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ --dir 后要跟工作区 · 用法: /help new' });
    expect(parseNewArgs('--dir ""')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ --dir 后要跟工作区 · 用法: /help new' });
  });

  it('--background / -b 是后台开关，不参与提示词', () => {
    expect(parseNewArgs('-b 修一下')).toEqual({ arg: '', worktree: false, background: true, prompt: '修一下', error: undefined });
    expect(parseNewArgs('--background --dir repo 修一下')).toEqual({ arg: 'repo', worktree: false, background: true, prompt: '修一下', error: undefined });
    expect(parseNewArgs('-b -w')).toEqual({ arg: '', worktree: true, background: true, prompt: undefined, error: undefined });
  });

  it('--prompt / -p 按未知参数回绝', () => {
    expect(parseNewArgs('--prompt 修一下')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ 未知参数: --prompt · 用法: /help new' });
    expect(parseNewArgs('-p 修一下')).toEqual({ arg: '', worktree: false, background: false, prompt: undefined, error: '⚠️ 未知参数: -p · 用法: /help new' });
  });
});

describe('/new --dir', () => {
  it('先开新会话再换工作区，回复里带上工作区', async () => {
    const manager = makeManager();
    const text = await run(manager, '--dir repo');

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

    const text = await run(manager, '--dir D:\\nope');

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

    const text = await run(manager, '--dir repo');

    expect(text).toContain('只支持绝对路径');
    expect(text).toContain('/new --dir D:\\项目\\目录');
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it('换目录在 remove 之后仍失败时如实报告（不回「已开启」）', async () => {
    const manager = {
      remove: vi.fn(async () => {}),
      workspaceRegistryAvailable: vi.fn(() => true),
      resolveWorkspace: vi.fn(() => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: false })),
      changeChatWorkspace: vi.fn(async () => ({ ok: false as const, reason: 'missing' as const, path: 'D:\\repo' })),
      currentSessionId: vi.fn(() => undefined as string | undefined),
      size: 0,
    };

    const text = await run(manager, '--dir repo');
    expect(text).toContain('目录不存在');
    expect(text).not.toContain('已开启新会话');
  });

  it('没有 registry 时用法页只列路径写法', () => {
    const named = newCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(named.usage).toContain('`/new --dir <工作区>`');
    expect(named.usage).toContain('工作区认标题、目录名或绝对路径');

    const pathOnly = newCommand({
      manager: { ...makeManager(), workspaceRegistryAvailable: vi.fn(() => false) } as unknown as SessionManager,
      config,
      logger,
    });
    expect(pathOnly.usage).toContain('`/new --dir <路径>`');
    expect(pathOnly.usage).not.toContain('工作区认标题');
  });

  it('没有 registry 时回执只显示路径，不重复末段目录名', async () => {
    const manager = {
      remove: vi.fn(async () => {}),
      workspaceRegistryAvailable: vi.fn(() => false),
      resolveWorkspace: vi.fn(() => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: true })),
      changeChatWorkspace: vi.fn(async () => ({ ok: true as const, title: 'repo', path: 'D:\\repo', isNew: true })),
      currentSessionId: vi.fn(() => undefined as string | undefined),
      size: 0,
    };

    const text = await run(manager, '--dir D:\\repo');

    expect(text).toBe('✅ 已开启新会话\n工作区: D:\\repo');
  });

  it('非绑定用户不能改工作区，且不动会话', async () => {
    const manager = makeManager();
    const text = await run(manager, '--dir repo', 'stranger');

    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
    expect(text).toContain('仅限绑定用户可用');
  });

  it('--worktree 与路径同时给：换完工作区再交出意图，回执三行', async () => {
    const manager = makeManager();

    const text = await run(manager, '-w --dir "D:\\My Repo"');

    expect(manager.resolveWorkspace).toHaveBeenCalledWith('D:\\My Repo');
    expect(manager.changeChatWorkspace).toHaveBeenCalledWith('c2c', 'user1', 'D:\\My Repo');
    expect(manager.armWorktree).toHaveBeenCalledTimes(1);
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('🌿 下一条消息开新工作树');
  });

  it('只读沙箱带路径也拒绝，不动会话', async () => {
    const manager = { ...makeManager(), readOnlySandbox: vi.fn(() => true) };

    const text = await run(manager, '--worktree repo');

    expect(text).toContain('只读沙箱');
    expect(manager.resolveWorkspace).not.toHaveBeenCalled();
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it('用法页只在有 worktrees 服务时列 --worktree', () => {
    const withService = newCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(withService.usage).toContain('`/new --worktree`');

    const noService = newCommand({
      manager: { ...makeManager(), worktreesAvailable: vi.fn(() => false) } as unknown as SessionManager,
      config,
      logger,
    });
    expect(noService.usage).not.toContain('--worktree');
  });
});

describe('/new <提示词>', () => {
  it('立刻开会话并把提示词发出去，先清指针再发', async () => {
    const manager = makeManager();

    expect(await run(manager, '修复登录页闪退')).toBe('✅ 已开启新会话，提示词已发出');
    expect(manager.promptNewSession).toHaveBeenCalledWith('c2c', 'user1', 'user1', '修复登录页闪退', { scope: 'c2c', targetId: 'user1' });
    const removeAt = manager.remove.mock.invocationCallOrder[0] ?? 0;
    const promptAt = manager.promptNewSession.mock.invocationCallOrder[0] ?? 0;
    expect(removeAt).toBeLessThan(promptAt);
  });

  it('--worktree 写在提示词后面也生效', async () => {
    const manager = makeManager();

    expect(await run(manager, '看下这个参数 -w')).toBe('✅ 已开启新会话，提示词已发出');
    expect(manager.armWorktree).toHaveBeenCalledTimes(1);
    expect(manager.promptNewSession).toHaveBeenCalledWith('c2c', 'user1', 'user1', '看下这个参数', { scope: 'c2c', targetId: 'user1' });
  });

  it('带 --dir 时先换目录再发提示词，回执带上工作区', async () => {
    const manager = makeManager();

    const text = await run(manager, '--dir repo 修一下');

    expect(manager.changeChatWorkspace).toHaveBeenCalledWith('c2c', 'user1', 'repo');
    expect(manager.promptNewSession).toHaveBeenCalledWith('c2c', 'user1', 'user1', '修一下', { scope: 'c2c', targetId: 'user1' });
    expect(text).toBe('✅ 已开启新会话，提示词已发出\n工作区: repo · D:\\repo');
  });

  it('--worktree 与提示词同时给：建树回执代替「已开启」首行', async () => {
    const manager = {
      ...makeManager(),
      promptNewSession: vi.fn(async () => ({ sessionId: 's2', worktreeNotice: '✅ 已在新工作树 `feat` 里开启会话 · 从 `main` 拉出\n路径: `D:\\wt\\feat`' })),
    };

    const text = await run(manager, '--worktree 查一下为什么启动慢');

    expect(manager.armWorktree).toHaveBeenCalledTimes(1);
    expect(text.startsWith('✅ 已在新工作树')).toBe(true);
    expect(text).toContain('路径:');
    expect(text).not.toContain('已开启新会话');
  });

  it('--prompt 按未知参数回绝，不动会话', async () => {
    const manager = makeManager();

    expect(await run(manager, '--prompt 修一下')).toBe('⚠️ 未知参数: --prompt · 用法: /help new');
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.promptNewSession).not.toHaveBeenCalled();
  });

  it('带工作区时仍只允许绑定用户', async () => {
    const manager = makeManager();

    const text = await run(manager, '--dir repo 修一下', 'stranger');

    expect(text).toContain('仅限绑定用户可用');
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.promptNewSession).not.toHaveBeenCalled();
  });

  it('工作树建不出来时用同一份失败文案', async () => {
    const manager = {
      ...makeManager(),
      promptNewSession: vi.fn(async () => {
        throw new WorktreeError('create', 'fatal: not a git repository', undefined, 'main');
      }),
    };

    const text = await run(manager, '--worktree 修一下');

    expect(text).toContain('没能从 `main` 建工作树');
    expect(text).toContain('本次会话没有创建');
  });

  it('用法页列出提示词写法', () => {
    const command = newCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(command.usage).toContain('`/new <提示词>`');
    expect(command.usage).toContain('参数位置随意');
  });
});

describe('/new --dir 参数', () => {
  it('-d 指定工作区，回执照旧', async () => {
    const manager = makeManager();

    const text = await run(manager, '-d repo');

    expect(manager.changeChatWorkspace).toHaveBeenCalledWith('c2c', 'user1', 'repo');
    expect(manager.promptNewSession).not.toHaveBeenCalled();
    expect(text).toContain('✅ 已开启新会话');
    expect(text).toContain('工作区: repo · D:\\repo');
  });

  it('--dir 缺值：报参数错，不动会话', async () => {
    const manager = makeManager();

    expect(await run(manager, '--dir')).toBe('⚠️ --dir 后要跟工作区 · 用法: /help new');
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
  });

  it('用法页列出 --dir 写法', () => {
    const command = newCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(command.usage).toContain('`/new --dir <工作区>`');
    expect(command.usage).toContain('`-d` 是 `--dir` 的简写');
  });
});

describe('有会话时的二次确认', () => {
  function makeChannel(offered = true) {
    const list: SessionConfirmRequest[] = [];
    return {
      list,
      offer: vi.fn(async (req: SessionConfirmRequest) => {
        list.push(req);
        return offered;
      }),
      handleInteraction: vi.fn(() => true),
      cancelPending: vi.fn(),
    };
  }

  async function runNew(manager: Record<string, unknown>, raw = ''): Promise<unknown> {
    const command = newCommand({ manager: manager as unknown as SessionManager, config, logger });
    return command.handler(makeCtx(raw, 'user1', 'new'));
  }

  async function runResetCmd(manager: Record<string, unknown>, raw = ''): Promise<unknown> {
    const command = resetCommand({ manager } as unknown as CommandDeps);
    return command.handler(makeCtx(raw, 'user1', 'clear'));
  }

  it('/new 有当前会话时直接开新会话，不发卡片', async () => {
    const channel = makeChannel();
    const manager = { ...makeManager(), currentSessionId: vi.fn(() => 'sess-1'), sessionConfirmChannel: channel };

    expect(await runNew(manager)).toBe('✅ 已开启新会话');
    expect(manager.remove).toHaveBeenCalledWith();
    expect(channel.offer).not.toHaveBeenCalled();
  });

  it('/new --dir <路径> 直接换工作区，不发卡片', async () => {
    const channel = makeChannel();
    const manager = { ...makeManager(), currentSessionId: vi.fn(() => 'sess-1'), sessionConfirmChannel: channel };

    expect(await runNew(manager, '--dir D:\\repo')).toBe('✅ 已开启新会话\n工作区: repo · D:\\repo');
    expect(manager.remove).toHaveBeenCalledWith();
    expect(manager.changeChatWorkspace).toHaveBeenCalledWith('c2c', 'user1', 'D:\\repo');
    expect(channel.offer).not.toHaveBeenCalled();
  });

  it('/clear 有当前会话时先发卡片，不直接停会话', async () => {
    const channel = makeChannel();
    const manager = { ...makeResetManager(true), currentSessionId: vi.fn(() => 'sess-1'), sessionConfirmChannel: channel };

    expect(await runResetCmd(manager)).toEqual({ kind: 'noop' });
    expect(manager.resetCurrentSession).not.toHaveBeenCalled();
    expect(channel.list[0]!.action).toBe('reset');

    await expect(channel.list[0]!.run()).resolves.toBe('✅ 已停止当前会话，并开启新会话');
    expect(manager.resetCurrentSession).toHaveBeenCalledWith();
  });

  it('/clear all 没有当前会话但有已获取会话时也要确认', async () => {
    const channel = makeChannel();
    const manager = { ...makeResetManager(true, 2), size: 2, sessionConfirmChannel: channel };

    expect(await runResetCmd(manager, 'all')).toEqual({ kind: 'noop' });
    expect(manager.resetAllSessions).not.toHaveBeenCalled();
    expect(channel.list[0]!.action).toBe('reset-all');
    expect(channel.list[0]!.currentId).toBeUndefined();
  });

  it('/clear all 一个会话都没有时直接执行', async () => {
    const channel = makeChannel();
    const manager = { ...makeResetManager(true, 0), size: 0, sessionConfirmChannel: channel };

    expect(await runResetCmd(manager, 'all')).toBe('✅ 已开启新会话');
    expect(channel.offer).not.toHaveBeenCalled();
    expect(manager.resetAllSessions).toHaveBeenCalledWith();
  });

  it('卡片发不出去时放弃动作，不退回直接执行', async () => {
    const channel = makeChannel(false);
    const manager = { ...makeResetManager(true), currentSessionId: vi.fn(() => 'sess-1'), sessionConfirmChannel: channel };

    expect(await runResetCmd(manager)).toBe('⚠️ 确认卡片没能发出，稍后再试一次');
    expect(manager.resetCurrentSession).not.toHaveBeenCalled();
  });

  it('/new --dir <路径> 解析失败时不动会话', async () => {
    const channel = makeChannel();
    const manager = {
      ...makeManager(),
      currentSessionId: vi.fn(() => 'sess-1'),
      resolveWorkspace: vi.fn(() => ({ ok: false as const, reason: 'missing' as const, path: 'D:\\nope' })),
      sessionConfirmChannel: channel,
    };

    const text = await runNew(manager, '--dir D:\\nope');

    expect(String(text)).toContain('目录不存在');
    expect(channel.offer).not.toHaveBeenCalled();
    expect(manager.remove).not.toHaveBeenCalled();
  });
});

describe('/compact 缺少 preset 压缩能力', () => {
  it('只回一行，不点名具体 preset', async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({ agent: { id: 's1' } })),
      runHostCommand: vi.fn(async () => ({ kind: 'unsupported' as const })),
    };
    const command = compactCommand({ manager } as unknown as CommandDeps);
    const result = await command.handler(makeCtx('', 'user1', 'compact'));

    expect(result).toBe('⚠️ 当前 preset 没有压缩能力');
  });
});

describe('/new --background', () => {
  it('另开一条会话发提示词，不切走当前会话', async () => {
    const manager = makeManager();

    const text = await run(manager, '-b 修一下');

    expect(manager.startBackgroundSession).toHaveBeenCalledWith({
      directory: 'D:\\repo',
      worktree: false,
      prompt: '修一下',
      scope: 'c2c',
      peerId: 'user1',
      senderId: 'user1',
      replyTarget: { scope: 'c2c', targetId: 'user1' },
    });
    // 当前会话与它的工作区都不动
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.changeChatWorkspace).not.toHaveBeenCalled();
    expect(manager.armWorktree).not.toHaveBeenCalled();
    expect(manager.promptNewSession).not.toHaveBeenCalled();
    expect(text.split('\n')[0]).toBe('✅ 已在后台开启会话 `#abcdef12`');
    expect(text).toContain('/sessions resume #abcdef12');
  });

  it('--dir 指定目录时在那一处开会话，回执带工作区', async () => {
    const manager = makeManager();

    const text = await run(manager, '-b --dir repo 修一下');

    expect(manager.startBackgroundSession).toHaveBeenCalledWith(expect.objectContaining({ directory: 'D:\\repo', prompt: '修一下' }));
    expect(text).toBe('✅ 已在后台开启会话 `#abcdef12`\n工作区: repo · D:\\repo\n> 💡 /sessions resume #abcdef12 切过去');
  });

  it('--worktree 的建树回执代替首行', async () => {
    const manager = {
      ...makeManager(),
      startBackgroundSession: vi.fn(async () => ({
        sessionId: 'session-abcdef123',
        worktreeNotice: '✅ 已在新工作树 `feat` 里开启会话 · 从 `main` 拉出\n路径: `D:/wt/feat`',
      })),
    };

    const text = await run(manager, '-b -w 修一下');

    expect(manager.startBackgroundSession).toHaveBeenCalledWith(expect.objectContaining({ worktree: true }));
    expect(text.startsWith('✅ 已在新工作树')).toBe(true);
    expect(text).not.toContain('已在后台开启会话');
    expect(text).toContain('resume #abcdef12');
  });

  it('没给提示词就回绝，不动会话', async () => {
    const manager = makeManager();

    expect(await run(manager, '-b')).toBe('⚠️ --background 需要提示词 · 用法: /help new');
    expect(manager.startBackgroundSession).not.toHaveBeenCalled();
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it('带 --dir 仍只允许绑定用户', async () => {
    const manager = makeManager();

    const text = await run(manager, '-b --dir repo 修一下', 'stranger');

    expect(text).toContain('仅限绑定用户可用');
    expect(manager.startBackgroundSession).not.toHaveBeenCalled();
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it('拿不到当前工作区时提示用 --dir', async () => {
    const manager = { ...makeManager(), chatWorkspaceInfo: vi.fn(async () => undefined) };

    expect(await run(manager, '-b 修一下')).toBe('⚠️ 拿不到当前工作区 · 用 `--dir` 指定一个');
    expect(manager.startBackgroundSession).not.toHaveBeenCalled();
  });

  it('工作树建不出来时用同一份失败文案', async () => {
    const manager = {
      ...makeManager(),
      startBackgroundSession: vi.fn(async () => {
        throw new WorktreeError('create', 'fatal: not a git repository', undefined, 'main');
      }),
    };

    const text = await run(manager, '-b -w 修一下');

    expect(text).toContain('没能从 `main` 建工作树');
    expect(text).toContain('本次会话没有创建');
  });

  it('用法页列出 --background', () => {
    const command = newCommand({ manager: makeManager() as unknown as SessionManager, config, logger });
    expect(command.usage).toContain('`/new --background <提示词>`');
    expect(command.usage).toContain('`--background` 必须带提示词');
  });
});
