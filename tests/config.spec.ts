import { describe, it, expect } from 'vitest';
import { ConfigSchema, DEFAULT_PANEL_COMMANDS } from '../src/config.ts';

describe('ConfigSchema 访问控制（唯一绑定用户）', () => {
  it('完全省略 access → owner 为空（拒绝所有人）', () => {
    const cfg = ConfigSchema({});
    expect(cfg.access.owner).toBe('');
  });

  it('access: {} → owner 默认空字符串', () => {
    const cfg = ConfigSchema({ access: {} });
    expect(cfg.access.owner).toBe('');
  });

  it('access 空值（YAML access: 后无内容）→ owner 为空', () => {
    const cfg = ConfigSchema({ access: null });
    expect(cfg.access.owner).toBe('');
  });

  it('显式配置 owner 原样保留', () => {
    const cfg = ConfigSchema({ access: { owner: 'u1' } });
    expect(cfg.access.owner).toBe('u1');
  });

  it('旧版 c2cMode/c2cAllow 不再放行，owner 仍为空', () => {
    const cfg = ConfigSchema({ access: { c2cMode: 'open', c2cAllow: ['u1'] } });
    expect(cfg.access.owner).toBe('');
  });

  it('嵌套配置省略时子字段默认值仍生效（不依赖对象级 default 字面量）', () => {
    const cfg = ConfigSchema({ appId: 'x' });
    expect(cfg.retryOffer).toEqual({ enabled: true, timeoutMs: 600_000 });
    expect(cfg.media).toEqual({ enabled: true, maxMB: 200, ttlHours: 24 });
    expect(cfg.sendFile.maxFiles).toBe(4);
    expect(cfg.panel.enabled).toBe(true);
    expect(cfg.panel.commands).toEqual([...DEFAULT_PANEL_COMMANDS]);
    expect(cfg.menu.autoSync).toBe(true);
  });
});

describe('ConfigSchema 本地命令执行', () => {
  it('省略 exec → shell 与参数模板都给平台的默认值（根目录固定为宿主进程当前目录）', () => {
    // 默认值写进配置而不是只在运行期推导：配置里看得见才改得动。
    const { exec } = ConfigSchema({});
    if (process.platform === 'win32') {
      expect(exec.shell.toLowerCase()).toContain('cmd');
      expect(exec.shellArgs).toEqual(['/d', '/s', '/c']);
    } else {
      expect(exec.shell).toBe('/bin/sh');
      expect(exec.shellArgs).toEqual(['-c']);
    }
  });

  it('显式配置原样保留，含参数模板', () => {
    const cfg = ConfigSchema({
      exec: { shell: '/bin/zsh', shellArgs: ['-l', '-c', '{command}'] },
    });
    expect(cfg.exec).toEqual({ shell: '/bin/zsh', shellArgs: ['-l', '-c', '{command}'] });
  });
});
