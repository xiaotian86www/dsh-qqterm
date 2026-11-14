import { describe, it, expect, vi } from 'vitest';
import { ownerOnlyAuth } from '../../src/commands/auth.ts';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';

function makeCtx(senderId: string | undefined): SlashCommandHandlerContext {
  return {
    message: { senderId, kind: 'c2c' },
  } as unknown as SlashCommandHandlerContext;
}

const bound = { access: { owner: 'u1' } };

describe('ownerOnlyAuth（唯一绑定用户鉴权）', () => {
  it('绑定用户放行', () => {
    expect(ownerOnlyAuth(bound)(makeCtx('u1'))).toBe(true);
  });

  it('其他用户拒绝并返回提示', () => {
    const result = ownerOnlyAuth(bound)(makeCtx('stranger'));
    expect(result).not.toBe(true);
    expect(typeof result).toBe('string');
  });

  it('身份缺失 fail-closed', () => {
    expect(ownerOnlyAuth(bound)(makeCtx(undefined))).not.toBe(true);
  });

  it('owner 为空时谁都拒绝', () => {
    const empty = { access: { owner: '' } };
    expect(ownerOnlyAuth(empty)(makeCtx('u1'))).toBeTypeOf('string');
  });

  it('拒绝时记录 warn 日志', () => {
    const logger = { warn: vi.fn() };
    ownerOnlyAuth(bound, logger)(makeCtx('stranger'));
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toContain('stranger');
  });
});
