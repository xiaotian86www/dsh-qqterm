/**
 * /compact：成败看宿主命令 kind，宿主文本原样带出
 *
 * 宿主只返回 kind + text，插件不做文案映射：kind 决定图标与结论，text 跟在后面。
 * 命令自己拉起会话（没有活跃会话时从磁盘恢复），执行与判定都交给 runHostCommand。
 * 压缩后的真实占用要等下一轮请求才更新，所以不估算占比。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../../src/session/index.ts';
import type { HostCommandRun } from '../../src/session/types.ts';
import type { Logger } from '../../src/types.ts';
import { compactCommand } from '../../src/commands/session.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const AGENT = { id: 's1' };

function makeCtx(): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw: '' },
  } as unknown as SlashCommandHandlerContext;
}

function makeManager(run: HostCommandRun) {
  return {
    getOrCreate: vi.fn(async () => ({ agent: AGENT })),
    runHostCommand: vi.fn(async () => run),
  };
}

async function run(manager: ReturnType<typeof makeManager>): Promise<string> {
  const command = compactCommand({ manager: manager as unknown as SessionManager, logger } as never);
  const result = await command.handler(makeCtx());
  return typeof result === 'string' ? result : '';
}

describe('/compact', () => {
  it('成功时原样带出宿主文本', async () => {
    const manager = makeManager({ kind: 'success', text: 'Compacted 2 history items (~300 tokens).' });

    await expect(run(manager)).resolves.toBe('✅ 压缩完成: Compacted 2 history items (~300 tokens).');
    expect(manager.runHostCommand).toHaveBeenCalledWith(AGENT, 'compact');
  });

  it('success 且文案说没有可压缩历史，也是成功', async () => {
    await expect(run(makeManager({ kind: 'success', text: 'No compactable history yet.' })))
      .resolves.toBe('✅ 压缩完成: No compactable history yet.');
  });

  it('失败时在结论后给宿主原文', async () => {
    await expect(run(makeManager({ kind: 'error', text: 'Compaction cancelled.' })))
      .resolves.toBe('❌ 压缩失败: Compaction cancelled.');
  });

  it('宿主抛错时带出 message', async () => {
    await expect(run(makeManager({ kind: 'threw', message: 'EPERM: lock busy' })))
      .resolves.toBe('❌ 压缩失败: EPERM: lock busy');
  });

  it('宿主没给文本时只给结论', async () => {
    await expect(run(makeManager({ kind: 'success' }))).resolves.toBe('✅ 压缩完成');
    await expect(run(makeManager({ kind: 'error' }))).resolves.toBe('❌ 压缩失败');
  });

  it('当前 preset 没有压缩能力：只回一行，不点名具体 preset', async () => {
    await expect(run(makeManager({ kind: 'unsupported' }))).resolves.toBe('⚠️ 当前 preset 没有压缩能力');
  });

  it('没有活跃会话时先拉起再执行', async () => {
    const manager = makeManager({ kind: 'success', text: 'No compactable history yet.' });

    await run(manager);

    expect(manager.getOrCreate).toHaveBeenCalledWith('c2c', 'user1', 'user1', {
      scope: 'c2c',
      targetId: 'user1',
    });
  });
});
