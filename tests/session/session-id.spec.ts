import { describe, it, expect } from 'vitest';
import { mintSessionId } from '../../src/session/session-id.ts';

describe('session-id', () => {
  it('铸造 id 带 session- 前缀且为 UUID 形态（#81）', () => {
    expect(mintSessionId()).toMatch(/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('铸造 id 不重复（多进程并发下不会撞出重复会话 id）', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => mintSessionId()));
    expect(ids.size).toBe(1000);
  });
});
