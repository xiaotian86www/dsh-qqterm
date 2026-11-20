import type {
  MiddlewareContext,
  SlashCommand,
  SlashCommandHandlerContext,
} from '@tencent-connect/qqbot-nodejs';
import { slashCommand } from '@tencent-connect/qqbot-nodejs';
import { describe, expect, it } from 'vitest';
import {
  NEWLINE_MARK,
  preserveMultilineCommands,
  restoreMultilineCommands,
} from '../../src/middleware/multiline-command.ts';

interface Harness {
  ctx: MiddlewareContext;
  /** 命令回复（经 SDK 的 sendText 发出去） */
  sent: string[];
  /** ctx.stop 的原因 */
  stops: string[];
  /** 下游中间件看到的正文 */
  seen: string[];
}

function harness(content: string): Harness {
  const sent: string[] = [];
  const stops: string[] = [];
  const seen: string[] = [];
  const ctx = {
    bot: { sendText: async (_target: unknown, text: string) => { sent.push(text); } },
    message: { content, kind: 'c2c', senderId: 'u1', timestamp: new Date().toISOString() },
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
    state: {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    stop(reason?: string) { stops.push(reason ?? ''); },
  } as unknown as MiddlewareContext;
  return { ctx, sent, stops, seen };
}

describe('preserveMultilineCommands', () => {
  it('单行指令不动正文', async () => {
    const h = harness('/to #abc 你好');
    await preserveMultilineCommands(['to'])(h.ctx, async () => {
      h.seen.push(h.ctx.message.content ?? '');
    });

    expect(h.seen).toEqual(['/to #abc 你好']);
    expect(h.ctx.message.content).toBe('/to #abc 你好');
  });

  it('多行指令先把换行换成占位符，出栈还原原文', async () => {
    const h = harness('/to #abc 第一行\n第二行');
    await preserveMultilineCommands(['to'])(h.ctx, async () => {
      h.seen.push(h.ctx.message.content ?? '');
    });

    expect(h.seen).toEqual([`/to #abc 第一行${NEWLINE_MARK}第二行`]);
    expect(h.ctx.message.content).toBe('/to #abc 第一行\n第二行');
  });

  it('CRLF 也按一个换行占位', async () => {
    const h = harness('/to #abc 第一行\r\n第二行');
    await preserveMultilineCommands(['to'])(h.ctx, async () => {
      h.seen.push(h.ctx.message.content ?? '');
    });

    expect(h.seen).toEqual([`/to #abc 第一行${NEWLINE_MARK}第二行`]);
  });

  it('不像指令的多行文本不动', async () => {
    for (const content of ['第一行\n第二行', '/usr/local\n/bin', '/nwe 第一行\n第二行']) {
      const h = harness(content);
      await preserveMultilineCommands(['to'])(h.ctx, async () => {
        h.seen.push(h.ctx.message.content ?? '');
      });
      expect(h.seen).toEqual([content]);
    }
  });
});

describe('restoreMultilineCommands', () => {
  it('handler 拿到还原成换行的 raw 与 args', async () => {
    let received: { raw: string; args: string[] } | undefined;
    const commands = restoreMultilineCommands([
      {
        name: 'to',
        handler: (ctx) => {
          received = { raw: ctx.command.raw, args: ctx.command.args };
          return 'ok';
        },
      },
    ]);
    const h = harness('');
    const ctx = {
      ...h.ctx,
      command: {
        name: 'to',
        raw: `#abc 第一行${NEWLINE_MARK}第二行`,
        args: ['#abc', `第一行${NEWLINE_MARK}第二行`],
      },
    } as unknown as SlashCommandHandlerContext;

    await (commands[0] as SlashCommand).handler(ctx);

    expect(received).toEqual({ raw: '#abc 第一行\n第二行', args: ['#abc', '第一行\n第二行'] });
  });

  it('正文里没有占位符时原样传给 handler', async () => {
    let raw: string | undefined;
    const commands = restoreMultilineCommands([
      {
        name: 'to',
        handler: (ctx) => {
          raw = ctx.command.raw;
          return 'ok';
        },
      },
    ]);
    const h = harness('');
    const ctx = {
      ...h.ctx,
      command: { name: 'to', raw: '#abc 你好', args: ['#abc', '你好'] },
    } as unknown as SlashCommandHandlerContext;

    await (commands[0] as SlashCommand).handler(ctx);

    expect(raw).toBe('#abc 你好');
  });
});

describe('多行指令走真实 slashCommand', () => {
  /** 按 middleware-setup 的顺序串起来：占位 → SDK 分发 */
  async function run(commands: SlashCommand[], content: string): Promise<{
    h: Harness;
    fellThrough: boolean;
  }> {
    const h = harness(content);
    const slash = slashCommand({ autoHelp: false, prefixes: ['/', '／'], commands });
    let fellThrough = false;
    const preserve = preserveMultilineCommands(commands.flatMap((cmd) => (
      Array.isArray(cmd.name) ? cmd.name : [cmd.name]
    )));
    await preserve(h.ctx, () => slash.middleware(h.ctx, async () => {
      fellThrough = true;
    }));
    return { h, fellThrough };
  }

  it('多行 /to 命中命令，不再漏成普通提问', async () => {
    let raw: string | undefined;
    const commands = restoreMultilineCommands([
      {
        name: 'to',
        scope: 'c2c' as const,
        handler: (ctx) => {
          raw = ctx.command.raw;
          return '✅ 已发送';
        },
      },
    ]);

    const { h, fellThrough } = await run(commands, '/to #abc 第一行\n第二行');

    expect(fellThrough).toBe(false);
    expect(raw).toBe('#abc 第一行\n第二行');
    expect(h.stops).toEqual(['command:matched:to']);
    expect(h.sent).toEqual(['✅ 已发送']);
    expect(h.ctx.message.content).toBe('/to #abc 第一行\n第二行');
  });

  it('没有这层兜底时，多行指令会漏到下游（回归背景）', async () => {
    const commands: SlashCommand[] = [{ name: 'to', handler: () => 'ok' }];
    const h = harness('/to #abc 第一行\n第二行');
    const slash = slashCommand({ autoHelp: false, prefixes: ['/'], commands });
    let fellThrough = false;

    await slash.middleware(h.ctx, async () => {
      fellThrough = true;
    });

    expect(fellThrough).toBe(true);
    expect(h.sent).toEqual([]);
  });
});
