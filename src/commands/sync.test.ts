/**
 * /bot-sync：一次推完指令面板与自定义菜单，失败按项报告
 */
import { describe, it, expect, vi } from 'vitest';
import type { QQBot, SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { CategorizedCommand } from './types.ts';
import { formatSyncReply, syncCommand } from './sync.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const commands = [
  { name: 'new', description: '开始新会话', scope: 'all', category: 'agent', handler: () => '' },
  { name: 'bot-help', description: '查看所有指令', scope: 'all', category: 'qqbot', handler: () => '' },
] as CategorizedCommand[];

function makeConfig(access: Partial<ImQQBotConfig['access']> = {}): ImQQBotConfig {
  return ConfigSchema({ appId: 'app', appSecret: 'secret', access } as ImQQBotConfig);
}

function makeCtx(senderId = 'user1'): SlashCommandHandlerContext {
  return { message: { senderId, kind: 'c2c' }, command: { raw: '' } } as unknown as SlashCommandHandlerContext;
}

const okApi = {
  get: async (path: string) => (path.startsWith('/v2/panels') ? { records: [] } : { version: 1 }),
  post: async () => ({ panel_id: 'p1' }),
  put: async () => ({ version: 2 }),
};

function run(api: Record<string, unknown> = okApi): Promise<string> {
  const command = syncCommand(
    { manager: {} as never, config: makeConfig(), logger, bot: { api } as unknown as QQBot },
    () => commands,
  );
  return Promise.resolve(command.handler(makeCtx())).then((r) => (typeof r === 'string' ? r : ''));
}

describe('/bot-sync', () => {
  it('面板与菜单都成功时两行结果', async () => {
    await expect(run()).resolves.toBe([
      '✅ 已同步 QQ 侧配置',
      '指令面板: 私聊 2 项',
      '自定义菜单: 6 项',
    ].join('\n'));
  });

  it('菜单失败时按项报错，面板结果保留', async () => {
    const api = {
      ...okApi,
      get: async (path: string) => {
        if (path === '/v2/menu') throw new Error('40030020 内容存在安全风险');
        return { records: [] };
      },
    };
    const text = await run(api);
    expect(text).toBe([
      '⚠️ QQ 侧配置部分同步失败',
      '✅ 指令面板: 私聊 2 项',
      '❌ 自定义菜单: 40030020 内容存在安全风险',
    ].join('\n'));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('两项都失败时只给原因', async () => {
    const api = {
      get: async () => {
        throw new Error('network down');
      },
      post: vi.fn(),
      put: vi.fn(),
    };
    await expect(run(api)).resolves.toBe([
      '❌ QQ 侧配置同步失败',
      '指令面板: network down',
      '自定义菜单: network down',
    ].join('\n'));
  });

  it('机器人未就绪时直接提示', async () => {
    const command = syncCommand({ manager: {} as never, config: makeConfig(), logger }, () => commands);
    await expect(command.handler(makeCtx())).resolves.toBe('⚠️ 同步失败: 机器人未就绪');
  });

  it('绑定用户：其他用户被拒', () => {
    const command = syncCommand(
      {
        manager: {} as never,
        config: makeConfig({ owner: 'user1' }),
        logger,
        bot: { api: okApi } as unknown as QQBot,
      },
      () => commands,
    );
    const authorized = command.authorized as (ctx: SlashCommandHandlerContext) => boolean | string;
    expect(authorized(makeCtx('user1'))).toBe(true);
    expect(authorized(makeCtx('stranger'))).toBe('⚠️ 无权限执行此命令');
  });
});

describe('formatSyncReply', () => {
  it('菜单未变化时原样给出计数', () => {
    expect(formatSyncReply([{ ok: true, text: '自定义菜单: 6 项（已是最新）' }])).toBe(
      '✅ 已同步 QQ 侧配置\n自定义菜单: 6 项（已是最新）',
    );
  });
});
