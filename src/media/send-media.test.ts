import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { resolveAgentCwd } from './send-media.ts';

describe('resolveAgentCwd（agent 工作目录单一事实源）', () => {
  it('未配置/空串 → 默认 ~/.dsh-qqterm/workspace（不随宿主进程 cwd）', () => {
    const expected = resolve(homedir(), '.dsh-qqterm', 'workspace');
    expect(resolveAgentCwd(undefined)).toBe(expected);
    expect(resolveAgentCwd('')).toBe(expected);
  });

  it('显式配置 → 原样使用', () => {
    expect(resolveAgentCwd('/opt/my-workspace')).toBe('/opt/my-workspace');
  });
});
