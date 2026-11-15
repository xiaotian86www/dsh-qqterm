/**
 * 扫码呈现策略：Desktop 判定、终端通道与三平台浏览器拉起。
 *
 * 平台分支不依赖宿主操作系统：用 withPlatform 临时改写 process.platform，
 * 断言 darwin / win32 / 其它平台各自使用的命令。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../fixtures/platform.ts';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { createBrowserPresenter, createTerminalPresenter, isDesktopHost } = await import(
  '../../src/setup/presenters.ts'
);

interface FakeChild {
  on: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  emitError(err: Error): void;
}

function fakeChild(): FakeChild {
  let onError: ((err: Error) => void) | undefined;
  return {
    on: vi.fn((event: string, listener: (err: Error) => void) => {
      if (event === 'error') onError = listener;
    }),
    unref: vi.fn(),
    emitError(err: Error): void {
      onError?.(err);
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const versions = process.versions as { electron?: string };
const initialElectron = versions.electron;
const initialElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
let child: FakeChild;
let logged: string[];

beforeEach(() => {
  spawnMock.mockReset();
  child = fakeChild();
  spawnMock.mockReturnValue(child);
  logger.warn.mockClear();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  delete process.env.ELECTRON_RUN_AS_NODE;
  delete versions.electron;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (initialElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = initialElectronRunAsNode;
  if (initialElectron === undefined) delete versions.electron;
  else versions.electron = initialElectron;
});

describe('isDesktopHost', () => {
  it('Electron 子进程标记与 electron 版本同时存在才算 Desktop', () => {
    expect(isDesktopHost()).toBe(false);
    process.env.ELECTRON_RUN_AS_NODE = '1';
    expect(isDesktopHost()).toBe(false);
    versions.electron = '33.0.0';
    expect(isDesktopHost()).toBe(true);
    delete process.env.ELECTRON_RUN_AS_NODE;
    expect(isDesktopHost()).toBe(false);
  });
});

describe('createTerminalPresenter', () => {
  it('打印可点击链接，二维码本身交给 connector', () => {
    const presenter = createTerminalPresenter();

    expect(presenter.printQrToConsole).toBe(true);
    presenter.onQrDisplayed('https://example.com/qr');

    const text = logged.join('\n');
    expect(text).toContain('https://example.com/qr');
    expect(text).toContain('\u001b]8;;https://example.com/qr');
  });

  it('过期提示', () => {
    createTerminalPresenter().onQrExpired?.();

    expect(logged.join('\n')).toContain('二维码已过期');
  });
});

describe('createBrowserPresenter', () => {
  it('首次显示二维码时打开浏览器，刷新不重复打开', () => {
    const presenter = createBrowserPresenter(logger);

    presenter.onQrDisplayed('https://example.com/qr');
    presenter.onQrDisplayed('https://example.com/qr2');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(logged.join('\n')).toContain('扫码绑定链接: https://example.com/qr');
  });

  it.each([
    ['darwin', 'open', ['https://example.com/qr']],
    ['win32', 'cmd', ['/c', 'start', '', 'https://example.com/qr']],
    ['linux', 'xdg-open', ['https://example.com/qr']],
  ] as const)('%s 平台使用 %s 拉起浏览器', async (platform, command, args) => {
    await withPlatform(platform, () => {
      createBrowserPresenter(logger).onQrDisplayed('https://example.com/qr');
    });

    expect(spawnMock).toHaveBeenCalledWith(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  });

  it('spawn 异步报错只记 warn，不影响绑定', () => {
    const presenter = createBrowserPresenter(logger);

    presenter.onQrDisplayed('https://example.com/qr');
    child.emitError(new Error('EACCES'));

    expect(logger.warn).toHaveBeenCalledWith('拉起浏览器失败: EACCES');
  });

  it('spawn 同步抛错也只记 warn', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => createBrowserPresenter(logger).onQrDisplayed('https://example.com/qr')).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith('拉起浏览器失败: boom');
  });
});
