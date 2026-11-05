/**
 * /bot-status 命令：最小状态视图（会话 / 模型 / preset / 消息数）
 *
 * 只验证「状态 → 文案」：会话行要带标题，标题没有时退回短 id，
 * 与 /status 共用 `sessionTargetLabel`，不要在这里另拼一种写法。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { statusCommand } from './status.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const config = ConfigSchema({ appId: 'app', appSecret: 'secret' } as ImQQBotConfig);

const SESSION_ID = 'session-9d2c4410-1111-1111-1111-111111111111';

interface StubOptions {
  active?: boolean;
  title?: string;
}

function makeManager(options: StubOptions = {}) {
  const active = options.active ?? true;
  const events = options.title === undefined
    ? []
    : [{ type: 'session/title', data: { title: options.title } }];
  const record = active
    ? {
      sessionId: SESSION_ID,
      agent: { status: 'idle', session: { snapshotEvents: () => events } },
    }
    : undefined;

  return {
    getStatus: vi.fn(() => ({
      active,
      sessionId: active ? SESSION_ID : undefined,
      provider: 'deepseek',
      model: 'deepseek-v4',
      preset: active ? 'default' : undefined,
      messageCount: 3,
    })),
    getSessionRecord: vi.fn(() => record),
    getEffortView: vi.fn(async () => ({
      options: [{ id: 'high', name: 'High' }],
      current: { id: 'high', name: 'High' },
      defaulted: true,
    })),
  } as unknown as SessionManager;
}

function makeCtx(): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw: '' },
  } as unknown as SlashCommandHandlerContext;
}

async function run(manager: SessionManager): Promise<string> {
  const command = statusCommand({ manager, config, logger });
  return String(await command.handler(makeCtx()));
}

describe('/bot-status 命令声明', () => {
  it('是插件特有命令，私聊可用', () => {
    const command = statusCommand({ manager: makeManager(), config, logger });
    expect(command.name).toBe('bot-status');
    expect(command.category).toBe('qqbot');
    expect(command.scope).toBe('all');
  });
});

describe('/bot-status', () => {
  it('会话行给出标题与短 id', async () => {
    const text = await run(makeManager({ title: '修登录' }));
    expect(text).toContain('📊 会话状态');
    expect(text).toContain('会话: 「修登录」 · `#9d2c4410`');
    expect(text).toContain('模型: deepseek/deepseek-v4');
    expect(text).toContain('思考强度: 高');
    expect(text).toContain('Preset: default');
    expect(text).toContain('消息数: 3');
  });

  it('还没有标题时退回短 id', async () => {
    const text = await run(makeManager());
    expect(text).toContain('会话: `#9d2c4410`');
  });

  it('没有活跃会话时提示', async () => {
    expect(await run(makeManager({ active: false }))).toBe('⚠️ 当前无活跃会话');
  });
});
