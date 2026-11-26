/**
 * /help 命令：索引与用法页
 *
 * 索引只列命令名与短语；`/help <命令>` 原样发出命令自带的 usage。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { CommandDeps, SlashCommand } from '../../src/commands/types.ts';
import { helpCommand } from '../../src/commands/help.ts';

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { owner: 'user1' },
} as QQTermConfig);

function fake(over: Partial<SlashCommand> & { name: string }): SlashCommand {
  return { scope: 'all', handler: async () => '', ...over } as unknown as SlashCommand;
}

const COMMANDS: SlashCommand[] = [
  fake({
    name: 'get',
    description: '发送本地文件',
    usage: '### 📖 /get 用法\n\n`/get <路径>` 发送文件',
  }),
  fake({
    name: ['reasoning', 'think'],
    description: '查看或切换思考强度',
    usage: '### 📖 /reasoning 用法\n\n`/reasoning <档位>` 切换思考强度',
  }),
  fake({ name: 'status', description: '查看会话状态' }),
  fake({ name: 'stop', description: '中止生成', hidden: true }),
];

/** 捕获 sendMarkdown 发出的内容 */
function makeCtx(raw: string, sent: string[]): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw },
    replyTarget: { scope: 'c2c', targetId: 'user1' },
    bot: {
      sendMarkdown: vi.fn(async (_target: unknown, content: string) => {
        sent.push(String(content));
      }),
    },
  } as unknown as SlashCommandHandlerContext;
}

async function run(raw: string, commands: readonly SlashCommand[] = COMMANDS): Promise<string> {
  const command = helpCommand({ config } as CommandDeps, () => commands);
  const sent: string[] = [];
  const result = await command.handler(makeCtx(raw, sent));
  return typeof result === 'string' ? result : sent.join('');
}

describe('/help 索引', () => {
  it('一行一条，点击填入用法命令，隐藏命令不出现', async () => {
    const text = await run('');

    expect(text.startsWith('### 🤖 QQ 超级终端指令')).toBe(true);
    expect(text).toContain('<qqbot-cmd-input text="/help get" show="/get"/> 发送本地文件');
    expect(text).not.toContain('/stop');
    expect(text).not.toContain('dsh-qqterm v');
  });
});

describe('/help <命令>', () => {
  it('原样渲染命令自带的用法页', async () => {
    const text = await run('get');

    expect(text).toBe('### 📖 /get 用法\n\n`/get <路径>` 发送文件');
  });

  it('别名与主名等价', async () => {
    expect(await run('think')).toContain('### 📖 /reasoning 用法');
  });

  it('不带参数的指令给一行签名', async () => {
    expect(await run('status')).toBe('### 📖 /status 用法\n\n`/status` 查看会话状态');
  });

  it('查不到时只给一句指引', async () => {
    expect(await run('nope')).toBe('⚠️ 没有这个指令 · 用法: /help');
  });

  it('能力不可用的命令既不列出也不能查到用法', async () => {
    const commands = [...COMMANDS, fake({
      name: 'steer',
      description: '插话排队消息',
      available: () => false,
    })];

    expect(await run('', commands)).not.toContain('/steer');
    expect(await run('steer', commands)).toBe('⚠️ 没有这个指令 · 用法: /help');
  });
});
