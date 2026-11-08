/**
 * apply() 扫码成功后的网关启动策略：
 * - 凭据未落盘：立即在本 fiber 启动（重启后需重扫）
 * - 凭据已落盘：先等热重载宽限窗口，超时仍未重载则由本 fiber 启动
 * - fiber 在窗口内被销毁（热重载成功）：定时器取消，避免双网关
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { QQTermConfig } from './config.ts';

const ensureCredentials = vi.fn();
const persistCredentialsToProfile = vi.fn();
const registerBoundCredentialRoutes = vi.fn();
const bootstrapGateway = vi.fn();

vi.mock('./setup/index.ts', () => ({
  ensureCredentials: (...args: unknown[]) => ensureCredentials(...args),
  persistCredentialsToProfile: (...args: unknown[]) => persistCredentialsToProfile(...args),
  registerBoundCredentialRoutes: (...args: unknown[]) => registerBoundCredentialRoutes(...args),
}));

vi.mock('./gateway/index.ts', () => ({
  bootstrapGateway: (...args: unknown[]) => bootstrapGateway(...args),
}));

const { apply } = await import('./index.ts');

/** 最小 ctx：只提供 apply 用到的 agents / logger / effect */
function makeCtx(): { ctx: Context; dispose: () => void } {
  const disposers: Array<() => void> = [];
  const ctx = {
    agents: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(fn: () => () => void) {
      disposers.push(fn());
    },
  } as unknown as Context;
  return {
    ctx,
    dispose: () => { for (const dispose of disposers) dispose(); },
  };
}

/** 让 then 链跑完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const CONFIG = {} as QQTermConfig;

beforeEach(() => {
  vi.useFakeTimers();
  ensureCredentials.mockReset();
  persistCredentialsToProfile.mockReset();
  registerBoundCredentialRoutes.mockReset();
  bootstrapGateway.mockReset();
  bootstrapGateway.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('apply 扫码绑定后的网关启动', () => {
  it('凭据未落盘：立即启动网关，状态回显为已绑定', async () => {
    let bound: string | null | undefined;
    ensureCredentials.mockImplementation(async (_ctx: unknown, options: { boundAppId?: () => string | null }) => {
      bound = options.boundAppId?.() ?? null;
      return { appId: 'qr-app', appSecret: 'qr-secret' };
    });
    persistCredentialsToProfile.mockReturnValue(false);

    const { ctx } = makeCtx();
    await apply(ctx, CONFIG);
    await flush();

    expect(bound).toBeNull();
    expect(bootstrapGateway).toHaveBeenCalledTimes(1);
    expect(bootstrapGateway.mock.calls[0]![2]).toMatchObject({ appId: 'qr-app', appSecret: 'qr-secret' });
  });

  it('凭据已落盘：宽限窗口内不启动，超时后由本 fiber 启动', async () => {
    ensureCredentials.mockResolvedValue({ appId: 'qr-app', appSecret: 'qr-secret' });
    persistCredentialsToProfile.mockReturnValue(true);

    const { ctx } = makeCtx();
    await apply(ctx, CONFIG);
    await flush();
    expect(bootstrapGateway).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1999);
    expect(bootstrapGateway).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(bootstrapGateway).toHaveBeenCalledTimes(1);
  });

  it('fiber 在窗口内销毁（热重载成功）：取消补启，不产生双网关', async () => {
    ensureCredentials.mockResolvedValue({ appId: 'qr-app', appSecret: 'qr-secret' });
    persistCredentialsToProfile.mockReturnValue(true);

    const { ctx, dispose } = makeCtx();
    await apply(ctx, CONFIG);
    await flush();

    dispose();
    vi.advanceTimersByTime(5000);
    expect(bootstrapGateway).not.toHaveBeenCalled();
  });

  it('扫码取消（resolve null）：不启动网关', async () => {
    ensureCredentials.mockResolvedValue(null);

    const { ctx } = makeCtx();
    await apply(ctx, CONFIG);
    await flush();
    vi.advanceTimersByTime(5000);

    expect(persistCredentialsToProfile).not.toHaveBeenCalled();
    expect(bootstrapGateway).not.toHaveBeenCalled();
  });
});
