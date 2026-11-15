/**
 * 多 profile：解析真实目录布局，并把凭据只写进命中的 profile。
 *
 * 与 bind-integration 的区别：这里不 mock getProfileDir，直接跑「安装路径 →
 * profile 根 → cordis.patch.yml」这条链路，验证 web / desktop 两个 profile
 * 共存时不会串写。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProfileDir, resolveProfileDir } from '../../src/shared/utils.ts';
import { persistCredentialsToProfile } from '../../src/setup/persist.ts';

const log = { info: vi.fn(), warn: vi.fn() };

let root: string;
let home: string;
let web: string;
let desktop: string;
let pluginWeb: string;
let pluginDesktop: string;

function patch(appId: string): string {
  return [
    '- id: qqterm',
    '  config:',
    `    appId: ${appId}`,
    `    appSecret: secret-${appId}`,
  ].join('\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqterm-profiles-'));
  home = join(root, 'home');
  web = join(home, 'profiles', 'web');
  desktop = join(home, 'profiles', 'desktop');
  pluginWeb = join(web, 'node_modules', 'dsh-qqterm');
  // Desktop profile 的 pnpm workspace 嵌套布局
  pluginDesktop = join(
    desktop, 'dependencies', 'node_modules', '.pnpm', 'dsh-qqterm@1.0.0',
    'node_modules', 'dsh-qqterm',
  );

  mkdirSync(pluginWeb, { recursive: true });
  mkdirSync(pluginDesktop, { recursive: true });
  writeFileSync(join(web, 'cordis.patch.yml'), patch('old-web'), 'utf8');
  writeFileSync(join(desktop, 'cordis.patch.yml'), patch('old-desktop'), 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('多 profile 解析与写入', () => {
  it('同一 DSH_HOME 下，web 浅层布局与 desktop 嵌套布局各自命中', () => {
    expect(getProfileDir(pluginWeb)).toBe(web);
    expect(getProfileDir(pluginDesktop)).toBe(desktop);
  });

  it('凭据只写进解析出的 profile，另一个 profile 原样保留', () => {
    const webDir = getProfileDir(pluginWeb);
    expect(webDir).toBe(web);

    expect(persistCredentialsToProfile(
      { appId: 'web-new', appSecret: 'web-secret' },
      webDir ?? undefined,
      log,
    )).toBe(true);

    const webPatch = readFileSync(join(web, 'cordis.patch.yml'), 'utf8');
    const desktopPatch = readFileSync(join(desktop, 'cordis.patch.yml'), 'utf8');
    expect(webPatch).toContain('appId: web-new');
    expect(webPatch).not.toContain('old-web');
    expect(desktopPatch).toContain('appId: old-desktop');
    expect(desktopPatch).not.toContain('web-new');
  });

  it('profileContext 是权威来源，优先于安装路径探测', () => {
    const ctx = {
      get: (name: string) => (name === 'profileContext' ? { dir: desktop } : undefined),
    };

    expect(resolveProfileDir(ctx)).toBe(desktop);
  });
});
