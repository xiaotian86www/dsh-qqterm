import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewaySession } from '../../src/gateway/gateway-session.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqterm-gateway-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createGatewaySession', () => {
  it('票据落盘，下一个实例能读回', () => {
    const dir = tempDir();
    const first = createGatewaySession('app-1', dir);
    first.persistence.save({ sessionId: 'sess-1', lastSeq: 42 });
    first.flush();

    const second = createGatewaySession('app-1', dir);
    expect(second.persistence.load()).toEqual({ sessionId: 'sess-1', lastSeq: 42 });
  });

  it('不同 appId 的票据互不覆盖', () => {
    const dir = tempDir();
    const a = createGatewaySession('app-a', dir);
    a.persistence.save({ sessionId: 'sess-a', lastSeq: 1 });
    a.flush();
    const b = createGatewaySession('app-b', dir);
    b.persistence.save({ sessionId: 'sess-b', lastSeq: 2 });
    b.flush();

    expect(createGatewaySession('app-a', dir).persistence.load()).toEqual({ sessionId: 'sess-a', lastSeq: 1 });
    expect(createGatewaySession('app-b', dir).persistence.load()).toEqual({ sessionId: 'sess-b', lastSeq: 2 });
  });

  it('没有落盘票据时 load 返回 null', () => {
    const session = createGatewaySession('app-empty', tempDir());
    expect(session.persistence.load()).toBeNull();
  });
});
