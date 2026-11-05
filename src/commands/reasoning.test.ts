/**
 * /reasoning：思考强度的查看与切换
 *
 * 档位元数据来自宿主的 adapter，读写都交给宿主；这里只验证「视图 → 文案」
 * 「参数 → 调用」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { EffortSwitchOutcome, EffortView, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { reasoningCommand } from './reasoning.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { c2cMode: 'open', c2cAllow: ['owner'] },
} as ImQQBotConfig);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const OPTIONS = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
];

const DEFAULT_VIEW: EffortView = {
  options: OPTIONS,
  current: { id: 'high', name: 'High' },
  defaulted: true,
};

function makeManager(
  options: { view?: EffortView; outcome?: EffortSwitchOutcome } = {},
) {
  return {
    getEffortView: vi.fn(async () => options.view ?? DEFAULT_VIEW),
    selectEffort: vi.fn(async (_scope: unknown, _peer: unknown, _effort: string | undefined) =>
      options.outcome ?? { ok: true, effort: 'high' }),
  } as unknown as SessionManager;
}

function makeCtx(raw = ''): SlashCommandHandlerContext {
  return {
    message: { senderId: 'owner', kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

/** 跑一次命令：查看类走 sendMarkdownChunked，切换类直接返回文本 */
async function run(manager: SessionManager, raw = ''): Promise<string> {
  state.sent.length = 0;
  const command = reasoningCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : state.sent.at(-1) ?? '';
}

beforeEach(() => {
  state.sent.length = 0;
});

describe('/reasoning 命令声明', () => {
  it('是 agent 类通用命令，带 think 别名', () => {
    const command = reasoningCommand({ manager: makeManager(), config, logger });
    expect(command.name).toEqual(['reasoning', 'think']);
    expect(command.category).toBe('agent');
    expect(command.scope).toBe('all');
    expect(command.panelDesc).toBe('切换思考强度');
    expect(command.authorized).toBeTypeOf('function');
  });
});

describe('/reasoning（查看）', () => {
  it('显示当前档位、可点击的档位列表与恢复默认入口', async () => {
    const text = await run(makeManager());
    expect(text).toContain('### 🧠 思考强度');
    expect(text).toContain('**当前**: 高（模型默认） · `high`');
    // 四档都给出可点击链接，当前档位行尾标 ✅
    expect(text).toContain('text="/reasoning off" show="/reasoning 关闭"');
    expect(text).toContain('text="/reasoning low" show="/reasoning 低"');
    expect(text).toContain('text="/reasoning high" show="/reasoning 高 ✅"');
    expect(text).toContain('text="/reasoning max" show="/reasoning 最高"');
    expect(text).toContain('恢复默认: `/reasoning default`');
  });

  it('显式设置过时不再标「模型默认」', async () => {
    const text = await run(makeManager({
      view: { options: OPTIONS, current: { id: 'max', name: 'Max' }, defaulted: false },
    }));
    expect(text).toContain('**当前**: 最高 · `max`');
    expect(text).not.toContain('（模型默认）');
  });

  it('模型不支持思考强度时给出原因与下一步', async () => {
    const text = await run(makeManager({ view: { defaulted: true } }));
    expect(text).toBe('⚠️ 当前模型不支持思考强度\n换一个模型试试: `/model`');
  });
});

describe('/reasoning（切换）', () => {
  it('切换目标档位并回显中文名', async () => {
    const manager = makeManager({ outcome: { ok: true, effort: 'max' } });
    const text = await run(manager, 'max');
    expect(manager.selectEffort).toHaveBeenCalledWith('c2c', 'owner', 'max');
    expect(text).toBe('✅ 思考强度已切换: 最高（立即生效）');
  });

  it('目标就是当前档位时返回「已是当前」', async () => {
    const manager = makeManager({ outcome: { ok: true, effort: 'high', unchanged: true } });
    expect(await run(manager, 'high')).toBe('✅ 已是当前思考强度: 高');
  });

  it('default 交回模型默认值', async () => {
    const manager = makeManager({ outcome: { ok: true, effort: 'high' } });
    const text = await run(manager, 'default');
    expect(manager.selectEffort).toHaveBeenCalledWith('c2c', 'owner', undefined);
    expect(text).toBe('✅ 思考强度已恢复默认: 高');
  });

  it('已经是默认值时给出「已是模型默认」', async () => {
    const manager = makeManager({ outcome: { ok: true, effort: 'high', unchanged: true } });
    expect(await run(manager, 'default')).toBe('✅ 已是模型默认思考强度: 高');
  });

  it('未知档位列出可选值', async () => {
    const text = await run(
      makeManager({ outcome: { ok: false, reason: 'unknown-effort', options: OPTIONS } }),
      'turbo',
    );
    expect(text).toContain('⚠️ 不支持的档位: `turbo`');
    expect(text).toContain('可选: 关闭 · 低 · 高 · 最高');
  });

  it('模型不支持时与查看一致，给出换模型的下一步', async () => {
    const text = await run(makeManager({ outcome: { ok: false, reason: 'unsupported' } }), 'high');
    expect(text).toBe('⚠️ 当前模型不支持思考强度\n换一个模型试试: `/model`');
  });

  it('没有会话时只回一句没有会话', async () => {
    const text = await run(makeManager({ outcome: { ok: false, reason: 'no' } }), 'high');
    expect(text).toBe('⚠️ 没有会话');
  });
});
