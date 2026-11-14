/**
 * /plugins 命令单测：列表 / 安装 / 更新 / 热重载 / 用法与占用保护
 */
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { PluginInstaller } from '../../src/plugins/index.ts';
import type { PluginOpState } from '../../src/plugins/state.ts';
import type { BundleInfoLike } from '../../src/plugins/types.ts';
import type { Reloader } from '../../src/reload/index.ts';
import type { SessionManager } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { pluginsCommand } from '../../src/commands/plugins.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as QQTermConfig);

function bundle(over: Partial<BundleInfoLike> & { name: string }): BundleInfoLike {
  return { official: false, installed: true, enabled: true, updatable: true, removable: true, ...over };
}

function makeCtx(raw: string, bot?: unknown): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw },
    replyTarget: { targetId: 'u1' },
    ...(bot === undefined ? {} : { bot }),
  } as unknown as SlashCommandHandlerContext;
}

interface Harness {
  command: ReturnType<typeof pluginsCommand>;
  announce: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
  reloadAnnounce: ReturnType<typeof vi.fn>;
  reloadRun: ReturnType<typeof vi.fn>;
  order: string[];
  bot: { sendMarkdown: ReturnType<typeof vi.fn> };
}

function harness(options?: {
  running?: PluginOpState;
  bundles?: BundleInfoLike[];
  info?: BundleInfoLike;
  noInstaller?: boolean;
  reloadAvailable?: boolean;
}): Harness {
  const order: string[] = [];
  const announce = vi.fn(async () => {
    order.push('announce');
  });
  const run = vi.fn(() => {
    order.push('run');
  });
  const reloadAnnounce = vi.fn(async () => {
    order.push('reload-announce');
  });
  const reloadRun = vi.fn(() => {
    order.push('reload-run');
  });
  const list = vi.fn(async () => options?.bundles ?? [bundle({ name: 'dsh-x', version: '1.0.0' })]);
  const find = vi.fn(async () => options?.info ?? bundle({ name: 'dsh-x', version: '1.0.0' }));
  const pending = vi.fn(() => options?.running);
  const bot = {
    sendMarkdown: vi.fn(async () => {
      order.push('ack');
      return {};
    }),
  };
  const installer = options?.noInstaller === true
    ? undefined
    : {
      list,
      find,
      pending,
      run,
      announce,
      describe: vi.fn(),
      // 列表直接读后台检查的缓存：这里给空结果，渲染不出现版本箭头
      updates: vi.fn(() => undefined),
      checkUpdates: vi.fn(),
    } as unknown as PluginInstaller;
  const reloader = {
    available: options?.reloadAvailable ?? true,
    announce: reloadAnnounce,
    run: reloadRun,
    describe: vi.fn(),
  } as unknown as Reloader;
  return {
    command: pluginsCommand({ manager: {} as SessionManager, config, logger, installer, reloader }),
    announce,
    run,
    list,
    find,
    reloadAnnounce,
    reloadRun,
    order,
    bot,
  };
}

describe('/plugins 命令声明', () => {
  it('是插件特有命令，私聊可用', () => {
    const h = harness();
    expect(h.command.name).toBe('plugins');
    expect(h.command.scope).toBe('all');
  });

  it('宿主没有 pluginManager 时明确提示', async () => {
    const h = harness({ noInstaller: true });
    expect(await h.command.handler(makeCtx(''))).toBe('⚠️ 当前 profile 没有插件管理能力');
  });
});

describe('/plugins 列表', () => {
  it('无参时列出第一页', async () => {
    const h = harness();
    const result = await h.command.handler(makeCtx('', h.bot));

    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.bot.sendMarkdown).toHaveBeenCalledTimes(1);
    const text = h.bot.sendMarkdown.mock.calls[0]?.[1] as string;
    expect(text).toContain('已安装插件（1 个）');
    expect(result).toEqual({ kind: 'noop' });
  });

  it('list 也可以带页码', async () => {
    const h = harness();
    await h.command.handler(makeCtx('list 2', h.bot));
    expect(h.bot.sendMarkdown).toHaveBeenCalledTimes(1);
  });

  it('数字参数当作页码', async () => {
    const h = harness();
    await h.command.handler(makeCtx('3', h.bot));
    expect(h.bot.sendMarkdown).toHaveBeenCalledTimes(1);
  });

  it('读取失败时给出原因，不静默', async () => {
    const h = harness();
    h.list.mockRejectedValueOnce(new Error('boom'));
    expect(await h.command.handler(makeCtx(''))).toBe('❌ 插件操作启动失败: boom');
  });
});

describe('/plugins install', () => {
  it('先补发上一轮，再回执，最后调度安装', async () => {
    const h = harness();
    await h.command.handler(makeCtx('install dsh-x@1.2.0', h.bot));

    expect(h.order).toEqual(['announce', 'ack', 'run']);
    expect(h.announce).toHaveBeenCalledWith(h.bot);
    expect(h.run).toHaveBeenCalledWith({
      action: 'install',
      target: 'dsh-x@1.2.0',
      spec: 'dsh-x@1.2.0',
      notify: { targetId: 'u1' },
    }, h.bot);
    expect(h.bot.sendMarkdown.mock.calls[0]?.[1]).toBe('🔄 正在安装 dsh-x@1.2.0…');
  });

  it('--allow-builds 解析成包名数组', async () => {
    const h = harness();
    await h.command.handler(makeCtx('install dsh-x --allow-builds=esbuild,swc', h.bot));

    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({
      approvedBuilds: ['esbuild', 'swc'],
    }), h.bot);
  });

  it('缺包名时只给用法，不调度', async () => {
    const h = harness();
    const result = await h.command.handler(makeCtx('install', h.bot));

    expect(String(result)).toContain('缺少包名');
    expect(h.run).not.toHaveBeenCalled();
  });

  it('上一个操作还没结束时拒绝新请求，避免覆盖它的结果', async () => {
    const h = harness({
      running: { startedAt: Date.now(), action: 'install', target: 'dsh-old' },
    });
    const result = await h.command.handler(makeCtx('install dsh-x', h.bot));

    expect(result).toBe('⚠️ 上一个插件操作还没结束: dsh-old');
    expect(h.run).not.toHaveBeenCalled();
    expect(h.bot.sendMarkdown).not.toHaveBeenCalled();
  });
});

describe('/plugins update', () => {
  it('本地安装的包不发请求', async () => {
    const h = harness({ info: bundle({ name: 'dsh-x', updatable: false }) });
    expect(await h.command.handler(makeCtx('update dsh-x', h.bot))).toBe('⚠️ 本地安装，不能自动更新');
    expect(h.run).not.toHaveBeenCalled();
  });

  it('没装过时提示找不到', async () => {
    const h = harness({ info: bundle({ name: 'dsh-x', installed: false }) });
    expect(await h.command.handler(makeCtx('update dsh-nope', h.bot))).toBe('⚠️ 没有这个插件: dsh-nope');
  });

  it('带版本时回执写清目标版本', async () => {
    const h = harness();
    await h.command.handler(makeCtx('update dsh-x 1.1.0', h.bot));

    expect(h.bot.sendMarkdown.mock.calls[0]?.[1]).toBe('🔄 正在更新 dsh-x → 1.1.0…');
    expect(h.run).toHaveBeenCalledWith({
      action: 'update',
      target: 'dsh-x',
      version: '1.1.0',
      notify: { targetId: 'u1' },
    }, h.bot);
  });

  it('不带版本时由 registry 决定', async () => {
    const h = harness();
    await h.command.handler(makeCtx('update dsh-x', h.bot));

    expect(h.bot.sendMarkdown.mock.calls[0]?.[1]).toBe('🔄 正在更新 dsh-x…');
  });
});

describe('/plugins reload', () => {
  it('先补发上一轮，再回执，最后调度重载', async () => {
    const h = harness();
    const result = await h.command.handler(makeCtx('reload', h.bot));

    expect(h.order).toEqual(['reload-announce', 'ack', 'reload-run']);
    expect(h.reloadAnnounce).toHaveBeenCalledWith(h.bot);
    expect(h.reloadRun).toHaveBeenCalledWith({ targetId: 'u1' }, h.bot);
    expect(h.bot.sendMarkdown.mock.calls[0]?.[1]).toBe('🔄 正在应用插件变更…');
    expect(result).toEqual({ kind: 'noop' });
  });

  it('没有 replyTarget 时不带投递目标', async () => {
    const h = harness();
    const ctx = { ...makeCtx('reload', h.bot), replyTarget: undefined } as unknown as SlashCommandHandlerContext;
    await h.command.handler(ctx);
    expect(h.reloadRun).toHaveBeenCalledWith(undefined, h.bot);
  });

  it('profile 未启用热重载时按未知子命令处理，不补发也不调度', async () => {
    const h = harness({ reloadAvailable: false });
    const result = await h.command.handler(makeCtx('reload', h.bot));

    expect(result).toBe('⚠️ 不支持的子命令: `reload` · 用法: /help plugins');
    expect(h.reloadAnnounce).not.toHaveBeenCalled();
    expect(h.reloadRun).not.toHaveBeenCalled();
  });

  it('没有 pluginManager 也能重载', async () => {
    const h = harness({ noInstaller: true });
    await h.command.handler(makeCtx('reload', h.bot));
    expect(h.reloadRun).toHaveBeenCalledTimes(1);
  });
});

describe('/plugins 用法', () => {
  it('不认识的子命令给出用法', async () => {
    const h = harness();
    const result = await h.command.handler(makeCtx('remove dsh-x', h.bot));
    expect(result).toBe('⚠️ 不支持的子命令: `remove` · 用法: /help plugins');
  });

  it('用法页只在有 hmr 时列 reload', () => {
    expect(harness().command.usage).toContain('/plugins reload');
    expect(harness({ reloadAvailable: false }).command.usage).not.toContain('/plugins reload');
  });
});
