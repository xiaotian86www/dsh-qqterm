/**
 * /permission：权限预设的查看 / 切换 / 重置
 *
 * manager 用替身，只验证「参数 → 调用 → 文案」；鉴权要求白名单（与 /model 不同），
 * 宿主侧真正写沙箱与审批策略的行为由 permission-presets.test.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema, type QQTermConfig } from '../config.ts';
import type { PermissionPresetEntry, PermissionSwitchOutcome, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { permissionCommand } from './permission.ts';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../shared/send-helper.ts', () => ({
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

const PRESETS: PermissionPresetEntry[] = [
  { id: 'read-only', name: 'read-only' },
  { id: 'workspace-write', name: 'workspace-write' },
  { id: 'danger-full-access', name: 'danger-full-access' },
  { id: 'auto', name: 'auto' },
];

interface StubOptions {
  presets?: PermissionPresetEntry[];
  current?: string;
  outcome?: PermissionSwitchOutcome;
  noSession?: boolean;
}

function makeManager(options: StubOptions = {}) {
  return {
    hasCurrentSession: vi.fn(() => !options.noSession),
    listPermissionPresets: vi.fn(() => options.presets ?? PRESETS),
    getPermissionPreset: vi.fn(() => options.current),
    setPermissionPreset: vi.fn(async () => options.outcome ?? { ok: true, preset: 'auto' }),
  } as unknown as SessionManager;
}

function makeCtx(raw: string, senderId: string | undefined = 'owner'): SlashCommandHandlerContext {
  return {
    message: { senderId, kind: 'c2c', messageId: 'm1' },
    command: { raw },
  } as unknown as SlashCommandHandlerContext;
}

/** 跑一次命令：查看类走 sendMarkdownChunked，切换类直接返回文本 */
async function run(manager: SessionManager, raw = '', senderId: string | undefined = 'owner'): Promise<string> {
  state.sent.length = 0;
  const command = permissionCommand({ manager, config, logger });
  const result = await command.handler(makeCtx(raw, senderId));
  return typeof result === 'string' ? result : state.sent.at(-1) ?? '';
}

beforeEach(() => {
  state.sent.length = 0;
});

describe('/permission 命令声明与鉴权', () => {
  it('私聊可用，鉴权只认唯一绑定用户', () => {
    const command = permissionCommand({ manager: makeManager(), config, logger });
    expect(command.name).toBe('permission');
    expect(command.scope).toBe('all');
    const authorized = command.authorized as (ctx: { message: { senderId?: string } }) => boolean | string;
    // 这是唯一能关沙箱的指令，始终按 owner 判定
    expect(authorized({ message: { senderId: 'stranger' } })).toBeTypeOf('string');
    expect(authorized({ message: { senderId: 'owner' } })).toBe(true);
    expect(authorized({ message: {} })).toBeTypeOf('string');
  });

  it('owner 为空时拒绝（fail-closed）', () => {
    const empty = ConfigSchema({
      appId: 'app',
      appSecret: 'secret',
      access: { owner: '' },
    } as QQTermConfig);
    const command = permissionCommand({ manager: makeManager(), config: empty, logger });
    const authorized = command.authorized as (ctx: { message: { senderId?: string } }) => boolean | string;
    expect(authorized({ message: { senderId: 'anyone' } })).toBeTypeOf('string');
  });
});

describe('/permission（查看）', () => {
  it('一行现状 + 可点击选项，不铺说明文字，也不提默认值', async () => {
    const text = await run(makeManager({ current: 'workspace-write' }));
    expect(text).toContain('### 🛡️ 权限预设');
    expect(text).toContain('当前: 工作区内修改 (workspace-write)');
    expect(text).toContain('text="/permission auto"');
    expect(text).toContain('/permission 自动审查 (auto) · EXP');
    // 默认值与说明性的页脚/提示都不要
    expect(text).not.toContain('默认');
    expect(text).not.toContain('手动指定');
    expect(text).not.toContain('立即生效');
  });

  it('取不到当前值时不显示当前行', async () => {
    const text = await run(makeManager({ current: undefined }));
    expect(text).not.toContain('当前:');
    expect(text).toContain('### 🛡️ 权限预设');
  });

  it('没有会话时也照常展示当前值（部署默认预设），写法不变', async () => {
    const text = await run(makeManager({ noSession: true, current: 'auto' }));
    expect(text).toContain('当前: 自动审查 (auto)');
    // 部署默认值同样标 ✅：新建会话会用它（auto 不再追加 EXP）
    expect(text).toContain('/permission 自动审查 (auto) ✅');
  });

  it('部署没有配置权限预设时如实说没有', async () => {
    const text = await run(makeManager({ presets: [] }));
    expect(text).toBe('⚠️ 当前部署没有权限预设');
  });
});

describe('/permission（切换）', () => {
  it('切换成功只回一行结果', async () => {
    const manager = makeManager({ outcome: { ok: true, preset: 'workspace-write' } });
    const text = await run(manager, 'workspace-write');
    expect(manager.setPermissionPreset).toHaveBeenCalledWith(
      'c2c',
      'owner',
      'workspace-write',
    );
    expect(text).toBe('✅ 权限已切换: 工作区内修改 (workspace-write)');
  });

  it('切到当前预设是可重入的：只回一行，不再写会话', async () => {
    const manager = makeManager({ outcome: { ok: true, preset: 'auto', unchanged: true } });
    const text = await run(manager, 'auto');

    expect(manager.setPermissionPreset).toHaveBeenCalled();
    expect(text).toBe('✅ 已是当前权限预设: 自动审查 (auto)');
  });

  it('切到 auto 只补一行风险提示', async () => {
    const text = await run(makeManager({ outcome: { ok: true, preset: 'auto' } }), 'auto');
    expect(text.split('\n')).toEqual(['✅ 权限已切换: 自动审查 (auto)', '⚠️ 不启用沙箱，每次工具调用先由模型预审（额外消耗 token）']);
  });

  it('未知预设只报原因，不写会话', async () => {
    const manager = makeManager({ outcome: { ok: false, reason: 'unknown-preset' } });
    const text = await run(manager, 'nope');
    expect(text).toBe('⚠️ 未知权限预设: nope');
  });

  it('reset 不再特殊处理，按未知预设拒绝', async () => {
    const manager = makeManager({ outcome: { ok: false, reason: 'unknown-preset' } });
    const text = await run(manager, 'reset');
    expect(manager.setPermissionPreset).toHaveBeenCalledWith('c2c', 'owner', 'reset');
    expect(text).toContain('未知权限预设: reset');
  });

  it('写入失败时把宿主错误原样带出（如 auto 集成下线）', async () => {
    const manager = makeManager({ outcome: { ok: false, reason: 'failed', message: 'auto-review: integration is closing' } });
    const text = await run(manager, 'auto');
    expect(text).toContain('切换失败: auto-review: integration is closing');
  });
});
