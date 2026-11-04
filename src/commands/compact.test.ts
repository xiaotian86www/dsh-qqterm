/**
 * /compact：只报压缩结果，不估算压缩后的上下文占比
 *
 * 压缩后的真实占用要等下一轮请求才更新，估算值会和菜单里的实际值打架，
 * 所以回复里只给「压缩了多少条 / 多少 token」。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { compactCommand } from './session.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeCtx(): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw: '' },
  } as unknown as SlashCommandHandlerContext;
}

function makeManager(compactResult: Record<string, unknown>) {
  return {
    compact: vi.fn(async () => compactResult),
  };
}

async function run(manager: ReturnType<typeof makeManager>): Promise<string> {
  const command = compactCommand({ manager: manager as unknown as SessionManager, logger } as never);
  const result = await command.handler(makeCtx());
  return typeof result === 'string' ? result : '';
}

describe('/compact', () => {
  it('压出历史时只报条数与 token', async () => {
    await expect(run(makeManager({ ok: true, shadowed: 12, tokens: 8432 })))
      .resolves.toBe('✅ 已压缩 12 条历史记录（约 8,432 tokens）');
  });

  it('没有可压缩的历史', async () => {
    await expect(run(makeManager({ ok: true, shadowed: 0, tokens: 0 }))).resolves.toBe('没有可压缩的历史');
  });

  it('失败时按原因给文案', async () => {
    await expect(run(makeManager({ ok: false, reason: 'busy' }))).resolves.toBe('正在生成中，无法压缩');
    await expect(run(makeManager({ ok: false, reason: 'no-session' }))).resolves.toBe('当前无活跃会话');
  });
});
