import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../src/config.ts';

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
    expect(cfg.panel.autoSync).toBe(true);
    expect(cfg.menu.autoSync).toBe(true);
  });
});
