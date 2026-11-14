/**
 * /preset：列出可用 preset 并标注核心默认值；切换只改默认值
 *
 * manager 用替身，只验证「默认值 → 标注 → 按钮参数」；真正的写入与默认值语义
 * 由 session-manager.spec.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { PresetEntry, SessionManager } from '../../src/session/index.ts';
import type { Logger } from '../../src/types.ts';
import { presetCommand } from '../../src/commands/preset.ts';
import { buildCommandList } from '../../src/commands/index.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../../src/shared/send-helper.ts', () => ({
  sendMarkdownChunked: async (_ctx: unknown, content: string): Promise<void> => {
    state.sent.push(content);
  },
}));

const config = ConfigSchema({
  appId: 'app',
  appSecret: 'secret',
  access: { owner: 'owner' },
} as QQTermConfig);
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const PRESETS: PresetEntry[] = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta', isDefault: true },
  { id: 'gamma' },
];

interface StubOptions {
  presets?: PresetEntry[];
  /** 部署默认 preset（agentPresets.defaultId） */
  effective?: string;
  /** 切换结果是否为「已经是默认值」 */
  unchanged?: boolean;
  /** 切换失败原因 */
  fail?: 'unknown-preset' | 'broken' | 'failed' | 'unavailable';
  /** 部署里有没有 agentPresets 服务（决定命令是否注册） */
  available?: boolean;
}

function makeManager(options: StubOptions = {}) {
  return {
    presetsAvailable: vi.fn(() => options.available ?? true),
    listPresets: vi.fn(async () => options.presets ?? PRESETS),
    getEffectivePreset: vi.fn(() => options.effective),
    setPresetOverride: vi.fn(async (_scope: unknown, _peer: unknown, id: string) => (
      options.fail
        ? { ok: false, reason: options.fail, message: options.fail === 'failed' ? 'write failed' : undefined }
        : { ok: true, presetId: id, ...(options.unchanged ? { unchanged: true } : {}) }
    )),
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
  it('默认项带 ✅，链接仍指向真实切换命令', async () => {
    const text = await run(makeManager({ effective: 'beta' }));

    expect(text).toContain('**当前**: beta');
    expect(text).toContain('text="/preset beta" show="/preset Beta (beta) ✅"');
    expect(text).toContain('text="/preset alpha" show="/preset Alpha (alpha)"');
    // 只有默认项带 ✅
    expect(text.split('✅')).toHaveLength(2);
    expect(text).not.toContain('可用 preset');
    expect(text).not.toContain('对之后新建的会话生效');
  });

  it('没有默认值时按列表的 isDefault 标注，不重复显示 ✅', async () => {
    const text = await run(makeManager());

    expect(text).toContain('**当前**: beta');
    expect(text).toContain('text="/preset beta" show="/preset Beta (beta) ✅"');
    expect(text.split('✅')).toHaveLength(2);
  });

  it('无别名的项直接显示 id，列表没标 isDefault 时用生效默认值', async () => {
    const text = await run(makeManager({
      effective: 'gamma',
      presets: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }, { id: 'gamma' }],
    }));

    expect(text).toContain('**当前**: gamma');
    expect(text).toContain('text="/preset gamma" show="/preset gamma ✅"');
    expect(text.split('✅')).toHaveLength(2);
  });
});

describe('/preset（切换）', () => {
  it('切换成功只回显 preset id', async () => {
    const manager = makeManager({ effective: 'alpha' });
    const text = await run(manager, 'beta');

    expect(manager.setPresetOverride).toHaveBeenCalledWith('c2c', 'owner', 'beta');
    expect(text).toBe('✅ preset 已切换: beta');
  });

  it('切到当前默认值是幂等的，只回一行', async () => {
    const manager = makeManager({ effective: 'beta', unchanged: true });
    const text = await run(manager, 'beta');

    expect(text).toBe('✅ 已是当前 preset: beta');
  });

  it('未知 preset 给警告', async () => {
    const text = await run(makeManager({ fail: 'unknown-preset' }), 'nope');

    expect(text).toBe('⚠️ 未知 preset: nope');
  });

  it('preset 加载失败给原因', async () => {
    const text = await run(makeManager({ fail: 'broken' }), 'beta');

    expect(text).toBe('❌ preset beta 加载失败: 未知错误');
  });

  it('写入失败给原因', async () => {
    const text = await run(makeManager({ fail: 'failed' }), 'beta');

    expect(text).toBe('❌ preset 切换失败: write failed');
  });

  it('部署里没有注册表时与查看同一句提示', async () => {
    const text = await run(makeManager({ fail: 'unavailable' }), 'beta');

    expect(text).toBe('⚠️ 当前部署无可用的 agent preset');
  });
});

describe('/preset 注册', () => {
  const namesOf = (available: boolean): string[] => buildCommandList({
    manager: makeManager({ available }),
    config,
    logger,
  }).flatMap((command) => (Array.isArray(command.name) ? command.name : [command.name]));

  it('有 agentPresets 服务时注册', () => {
    expect(namesOf(true)).toContain('preset');
  });

  it('没有 agentPresets 服务时整条命令不出现', () => {
    expect(namesOf(false)).not.toContain('preset');
  });
});
