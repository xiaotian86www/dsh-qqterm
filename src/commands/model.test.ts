/**
 * /model：当前模型与模型列表都必须带 provider
 *
 * 同名模型可能来自不同 provider，只显示别名会让用户无法区分、也无法判断
 * 点击按钮后切到哪一个。这里用 manager 替身验证文案与按钮参数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { ModelEntry, ModelRoute } from '../model/index.ts';
import type { Logger } from '../types.ts';
import { modelCommand } from './model.ts';

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

const MODELS: ModelEntry[] = [
  // 同名不同 provider：必须能区分
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'openrouter', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  // 只有 id、没有别名
  { provider: 'openrouter', id: 'openai/gpt-4o' },
];

function makeManager(
  options: { current?: ModelRoute; models?: ModelEntry[]; unchanged?: boolean } = {},
) {
  return {
    getEffectiveModel: vi.fn(() => options.current),
    listAvailableModels: vi.fn(async () => options.models ?? MODELS),
    setModelOverride: vi.fn(async (_scope: unknown, _peer: unknown, route: ModelRoute) => ({
      ...route,
      ...(options.unchanged ? { unchanged: true } : {}),
    })),
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
  const command = modelCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw));
  return typeof result === 'string' ? result : state.sent.at(-1) ?? '';
}

beforeEach(() => {
  state.sent.length = 0;
});

describe('/model（查看）', () => {
  it('当前模型显示为「别名 · provider」，不用裸别名', async () => {
    const text = await run(
      makeManager({ current: { provider: 'openrouter', model: 'deepseek-v4-flash' } }),
    );
    expect(text).toContain('### 🤖 模型配置');
    expect(text).toContain('**当前模型**: DeepSeek V4 Flash · openrouter');
    // 不再是无法区分 provider 的裸别名
    expect(text).not.toContain('**当前模型**: DeepSeek V4 Flash\n');
  });

  it('当前模型不在列表里时回退到 provider/model', async () => {
    const text = await run(makeManager({ current: { provider: 'custom', model: 'my-model' } }));
    expect(text).toContain('**当前模型**: custom/my-model');
  });

  it('未解析到模型时显示宿主默认配置', async () => {
    const text = await run(makeManager({ current: undefined }));
    expect(text).toContain('**当前模型**: 宿主默认配置');
  });

  it('模型列表按 provider 分组，组内只显示短名', async () => {
    const text = await run(makeManager({ current: { provider: 'openrouter', model: 'deepseek-v4-flash' } }));
    const lines = text.split('\n');

    // 分组标题按 listAvailableModels 的 provider 顺序出现
    const official = lines.indexOf('**deepseek-official**');
    const openrouter = lines.indexOf('**openrouter**');
    expect(official).toBeGreaterThan(-1);
    expect(openrouter).toBeGreaterThan(official);

    // 当前模型在 openrouter 组内：带 ✅；链接仍指向真实切换命令
    expect(text).toContain('text="/model openrouter/deepseek-v4-flash" show="/model DeepSeek V4 Flash ✅"');

    // 非当前项发送完整路由，但展示文案不再重复 provider
    expect(text).toContain(
      'text="/model deepseek-official/deepseek-v4-flash" show="/model DeepSeek V4 Flash"',
    );
    expect(text).toContain('text="/model openrouter/openai/gpt-4o" show="/model openai/gpt-4o"');
  });

  it('只有 provider 与 id 都匹配的项才算当前模型', async () => {
    const text = await run(makeManager({ current: { provider: 'openrouter', model: 'deepseek-v4-flash' } }));
    const lines = text.split('\n').filter((line) => line.includes('qqbot-cmd-input'));

    // 两家 provider 下同名同 id，只有 openrouter 那行带 ✅
    expect(lines.filter((line) => line.includes('✅'))).toHaveLength(1);
    expect(lines.find((line) => line.includes('deepseek-official/deepseek-v4-flash'))).not.toContain('✅');
  });

  it('当前模型不在列表里时列表不带 ✅', async () => {
    const text = await run(makeManager({ current: { provider: 'custom', model: 'my-model' } }));
    expect(text).not.toContain('✅');
  });

  it('模型名与 id 相同时只显示一次', async () => {
    const text = await run(
      makeManager({ models: [{ provider: 'deepseek-official', id: 'deepseek-chat', name: 'deepseek-chat' }] }),
    );
    expect(text).toContain('**deepseek-official**');
    expect(text).toContain('show="/model deepseek-chat"');
    expect(text).not.toContain('deepseek-chat (deepseek-official/deepseek-chat)');
  });
});

describe('/model（切换）', () => {
  it('provider/model 原样写入并回显完整路由', async () => {
    const manager = makeManager();
    const text = await run(manager, 'openrouter/deepseek-v4-flash');
    expect(manager.setModelOverride).toHaveBeenCalledWith('c2c', 'owner', {
      provider: 'openrouter',
      model: 'deepseek-v4-flash',
    });
    expect(text).toBe('✅ 模型已切换: openrouter/deepseek-v4-flash（立即生效）');
  });

  it('切到当前模型是可重入的，返回「已是当前模型」', async () => {
    const manager = makeManager({
      current: { provider: 'openrouter', model: 'deepseek-v4-flash' },
      unchanged: true,
    });
    const text = await run(manager, 'openrouter/deepseek-v4-flash');
    expect(text).toBe('✅ 已是当前模型: openrouter/deepseek-v4-flash');
  });

  it('只写模型名时继承当前 provider', async () => {
    const manager = makeManager({ current: { provider: 'openrouter', model: 'deepseek-v4-flash' } });
    await run(manager, 'deepseek-v4-pro');
    expect(manager.setModelOverride).toHaveBeenCalledWith('c2c', 'owner', {
      provider: 'openrouter',
      model: 'deepseek-v4-pro',
    });
  });
});
