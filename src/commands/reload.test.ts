/**
 * /bot-reload 命令：先补发上一轮结果，再回执，最后调度新一轮
 *
 * 补发这一步不能省：重载会 dispose 当前 fiber，第一轮的结果只能落盘等新 fiber 的
 * ready 补发；第二条命令若先跑到 run()，状态会被改写成 running，那一轮「应用了
 * 什么」就永久读不到了。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { Reloader } from '../reload/index.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { reloadCommand } from './reload.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as ImQQBotConfig);

interface Harness {
  command: ReturnType<typeof reloadCommand>;
  announce: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  order: string[];
  bot: { sendMarkdown: ReturnType<typeof vi.fn> };
}

function harness(): Harness {
  const order: string[] = [];
  const announce = vi.fn(async () => {
    order.push('announce');
  });
  const run = vi.fn(() => {
    order.push('run');
  });
  const bot = {
    sendMarkdown: vi.fn(async () => {
      order.push('ack');
      return {};
    }),
  };
  const reloader = {
    available: true,
    announce,
    run,
    describe: vi.fn(),
  } as unknown as Reloader;
  return {
    command: reloadCommand({ manager: {} as SessionManager, config, logger, reloader }),
    announce,
    run,
    order,
    bot,
  };
}

function makeCtx(bot?: unknown): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw: '' },
    replyTarget: { targetId: 'u1' },
    ...(bot === undefined ? {} : { bot }),
  } as unknown as SlashCommandHandlerContext;
}

describe('/bot-reload 命令声明', () => {
  it('是插件特有命令，私聊可用', () => {
    const command = reloadCommand({
      manager: {} as SessionManager,
      config,
      logger,
      reloader: { available: true } as unknown as Reloader,
    });
    expect(command.name).toBe('bot-reload');
    expect(command.category).toBe('qqbot');
    expect(command.scope).toBe('all');
  });
});

describe('/bot-reload', () => {
  it('先补发上一轮结果，再回执，最后调度新一轮', async () => {
    const h = harness();
    await h.command.handler(makeCtx(h.bot));

    expect(h.order).toEqual(['announce', 'ack', 'run']);
    expect(h.announce).toHaveBeenCalledWith(h.bot);
    expect(h.run).toHaveBeenCalledWith({ targetId: 'u1' }, h.bot);
  });

  it('profile 未启用热重载时只提示，不补发也不调度', async () => {
    const announce = vi.fn();
    const run = vi.fn();
    const command = reloadCommand({
      manager: {} as SessionManager,
      config,
      logger,
      reloader: { available: false, announce, run } as unknown as Reloader,
    });

    const result = await command.handler(makeCtx(harness().bot));
    expect(result).toBe('⚠️ 当前 profile 未启用热重载');
    expect(announce).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
