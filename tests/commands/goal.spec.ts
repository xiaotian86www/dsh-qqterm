/**
 * /goal：薄壳转发宿主的长期目标命令
 *
 * 插件不解析参数、不判断目标状态机：成败看宿主 kind，文本原样带出。
 * 宿主文本自带标题行，所以只给第一行加状态图标。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../../src/session/index.ts';
import type { HostCommandRun } from '../../src/session/types.ts';
import type { Logger } from '../../src/types.ts';
import { goalCommand } from '../../src/commands/goal.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const AGENT = { id: 's1' };

const GOAL_VIEW = [
  'Goal created',
  'Status: active',
  'Objective: ship it',
  'Rounds: 0/5',
  'Activation: armed',
  '',
  'Commands: /goal edit <objective>, /goal pause, /goal clear',
].join('\n');

function makeCtx(raw = ''): SlashCommandHandlerContext {
  return {
    message: { senderId: 'user1', kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

function makeManager(run: HostCommandRun) {
  return {
    getOrCreate: vi.fn(async () => ({ agent: AGENT })),
    runHostCommand: vi.fn(async () => run),
  };
}

async function run(manager: ReturnType<typeof makeManager>, raw = ''): Promise<string> {
  const command = goalCommand({ manager: manager as unknown as SessionManager, logger } as never);
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : '';
}

describe('/goal', () => {
  it('成功时只加状态图标，宿主多行文本原样带出', async () => {
    const manager = makeManager({ kind: 'success', text: GOAL_VIEW });

    await expect(run(manager, 'ship it')).resolves.toBe(`✅ ${GOAL_VIEW}`);
    expect(manager.runHostCommand).toHaveBeenCalledWith(AGENT, 'goal', ['ship it']);
  });

  it('不带参数时也转发，参数列表为空', async () => {
    const manager = makeManager({ kind: 'success', text: 'No goal is currently set.\nUsage: /goal' });

    await expect(run(manager)).resolves.toBe('✅ No goal is currently set.\nUsage: /goal');
    expect(manager.runHostCommand).toHaveBeenCalledWith(AGENT, 'goal', []);
  });

  it('失败时同样原样带出宿主文本', async () => {
    await expect(run(makeManager({ kind: 'error', text: 'A goal is already active.' }), 'next'))
      .resolves.toBe('❌ A goal is already active.');
  });

  it('宿主抛错时带出 message', async () => {
    await expect(run(makeManager({ kind: 'threw', message: 'goals service missing' })))
      .resolves.toBe('❌ 目标操作失败: goals service missing');
  });

  it('宿主没给文本时只给结论', async () => {
    await expect(run(makeManager({ kind: 'success' }))).resolves.toBe('✅ 目标');
    await expect(run(makeManager({ kind: 'error' }))).resolves.toBe('❌ 目标操作失败');
  });

  it('当前 preset 没有目标能力：只回一行', async () => {
    await expect(run(makeManager({ kind: 'unsupported' }))).resolves.toBe('⚠️ 当前 preset 没有目标能力');
  });

  it('没有活跃会话时先拉起再执行', async () => {
    const manager = makeManager({ kind: 'success', text: 'Goal created' });

    await run(manager);

    expect(manager.getOrCreate).toHaveBeenCalledWith('c2c', 'user1', 'user1', {
      scope: 'c2c',
      targetId: 'user1',
    });
  });
});
