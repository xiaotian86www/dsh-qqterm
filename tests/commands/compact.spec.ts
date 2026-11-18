/**
 * /compact：成败看命令 kind，宿主文本原样带出
 *
 * 宿主只返回 kind + text，插件不做文案映射：kind 决定图标与结论，text 跟在后面。
 * 压缩后的真实占用要等下一轮请求才更新，所以不估算占比。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { compactCommand } from '../../src/commands/session.ts';

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
  it('成功时原样带出宿主文本', async () => {
    await expect(run(makeManager({ ok: true, message: 'Compacted 2 history items (~300 tokens).' })))
      .resolves.toBe('✅ 压缩完成: Compacted 2 history items (~300 tokens).');
  });

  it('success 且文案说没有可压缩历史，也是成功', async () => {
    await expect(run(makeManager({ ok: true, message: 'No compactable history yet.' })))
      .resolves.toBe('✅ 压缩完成: No compactable history yet.');
  });

  it('失败时在结论后给宿主原文', async () => {
    await expect(run(makeManager({ ok: false, message: 'Compaction cancelled.' })))
      .resolves.toBe('❌ 压缩失败: Compaction cancelled.');
  });

  it('本地前置条件按原因给文案', async () => {
    await expect(run(makeManager({ ok: false, reason: 'busy' }))).resolves.toBe('⚠️ 正在生成中，无法压缩');
    await expect(run(makeManager({ ok: false, reason: 'no-session' }))).resolves.toBe('⚠️ 当前没有会话');
    await expect(run(makeManager({ ok: false, reason: 'no-compaction' }))).resolves.toBe('⚠️ 当前 preset 没有压缩能力');
  });

  it('宿主没给文本时只给结论', async () => {
    await expect(run(makeManager({ ok: true }))).resolves.toBe('✅ 压缩完成');
    await expect(run(makeManager({ ok: false }))).resolves.toBe('❌ 压缩失败');
  });
});
