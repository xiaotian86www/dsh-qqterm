/**
 * /preset：列表里标注当前 preset，样式与 /model、/permission 对齐
 *
 * manager 用替身，只验证「当前值 → 标注 → 按钮参数」；真正的 preset 切换
 * 与锁定语义由 session-manager.test.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { PresetEntry, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { presetCommand } from './preset.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { c2cMode: 'open', c2cAllow: ['owner'], groupMode: 'open', groupAllow: [] },
} as ImQQBotConfig);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const PRESETS: PresetEntry[] = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
  { id: 'gamma' },
];

interface StubOptions {
  presets?: PresetEntry[];
  /** 当前会话锁定的 preset（record.agentPreset） */
  recordPreset?: string;
  /** 新会话将生效的 preset（per-peer 覆盖或 config） */
  effective?: string;
  /** 切换结果是否为「已经是当前值」 */
  unchanged?: boolean;
}

function makeManager(options: StubOptions = {}) {
  return {
    listPresets: vi.fn(async () => options.presets ?? PRESETS),
    getSessionRecord: vi.fn(() =>
      options.recordPreset === undefined ? undefined : ({ agentPreset: options.recordPreset } as never),
    ),
    getEffectivePreset: vi.fn(() => options.effective),
    setPresetOverride: vi.fn(async (_scope: unknown, _peer: unknown, id: string) => ({
      ok: true,
      presetId: id,
      ...(options.unchanged ? { unchanged: true } : {}),
    })),
    clearPresetOverride: vi.fn(async () => ({ ok: true })),
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
  const command = presetCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : state.sent.at(-1) ?? '';
}

beforeEach(() => {
  state.sent.length = 0;
});

describe('/preset（查看）', () => {
  it('当前 preset 带 ✅，链接仍指向真实切换命令', async () => {
    const text = await run(makeManager({ effective: 'beta' }));

    expect(text).toContain('**当前**: beta');
    expect(text).toContain('text="/preset beta" show="/preset Beta (beta) ✅"');
    expect(text).toContain('text="/preset alpha" show="/preset Alpha (alpha)"');
    // 只有当前项带 ✅
    expect(text.split('✅')).toHaveLength(2);
  });

  it('会话锁定的旧 preset 只作提示，标注的仍是新会话将生效的值', async () => {
    const text = await run(makeManager({ recordPreset: 'alpha', effective: 'beta' }));

    expect(text).toContain('**当前**: beta');
    expect(text).toContain('当前会话仍使用 alpha，发送 /new 后切到 beta');
    expect(text).toContain('text="/preset beta" show="/preset Beta (beta) ✅"');
    expect(text).toContain('text="/preset alpha" show="/preset Alpha (alpha)"');
  });

  it('没有当前 preset 时列表不标 ✅，无别名的项直接显示 id', async () => {
    const text = await run(makeManager());

    expect(text).toContain('**当前**: 默认');
    expect(text).not.toContain('✅');
    expect(text).toContain('text="/preset gamma" show="/preset gamma"');
  });
});

describe('/preset（切换）', () => {
  it('切换成功回显 preset id，并提示新会话生效', async () => {
    const manager = makeManager({ effective: 'alpha' });
    const text = await run(manager, 'beta');

    expect(manager.setPresetOverride).toHaveBeenCalledWith('c2c', 'owner', 'beta');
    expect(text).toBe('✅ preset 已切换: beta（新会话生效）');
  });

  it('切到当前 preset 是可重入的，只回一行且提示会话锁定值', async () => {
    const manager = makeManager({ recordPreset: 'alpha', effective: 'beta', unchanged: true });
    const text = await run(manager, 'beta');

    expect(text).toContain('✅ 已是当前 preset: beta');
    expect(text).toContain('当前会话仍使用 alpha，发送 /new 后切到 beta');
  });

  it('reset 清除覆盖，回到默认', async () => {
    const manager = makeManager({ effective: 'beta' });
    const text = await run(manager, 'reset');

    expect(manager.clearPresetOverride).toHaveBeenCalledWith('c2c', 'owner');
    expect(text).toBe('✅ 已重置为默认 preset（新会话生效）');
  });
});
