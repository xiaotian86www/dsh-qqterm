import { describe, it, expect } from 'vitest';
import { formatToolResult, type ToolResultData } from '../../src/transport/tool-presenter.ts';

/** 构造失败的工具结果：content 里是 `Error: <原因>`，error 是宿主给的类型化错误 */
function errorResult(
  code: string,
  detail?: string,
  name = 'FsError',
): ToolResultData {
  const content = detail === undefined
    ? []
    : [{ type: 'text', text: `Error: ${detail}` }];
  return {
    message: {
      content: [{ type: 'tool-result', content, isError: true }],
      source: { callId: 'c1' },
    },
    error: { name, code },
  };
}

/** 构造成功的工具结果（原文回退路径） */
function okResult(text: string): ToolResultData {
  return {
    message: {
      content: [{ type: 'tool-result', content: [{ type: 'text', text }] }],
      source: { callId: 'c1' },
    },
  };
}

describe('formatToolResult: 失败消息', () => {
  it('交代工具、目标文件与原因', () => {
    const text = formatToolResult(
      'edit',
      JSON.stringify({ file_path: 'D:\\repo\\CHANGELOG.md', old_string: 'x' }),
      errorResult('FS_AMBIGUOUS_EDIT', 'old_string matched 8 times in "CHANGELOG.md"'),
      undefined,
      undefined,
    );

    expect(text).toBe(
      '❌ 工具 `edit` 执行失败: `D:\\repo\\CHANGELOG.md`\n'
      + '原因: `FsError: FS_AMBIGUOUS_EDIT` · old_string matched 8 times in "CHANGELOG.md"',
    );
  });

  it('命令类工具用 command 当目标', () => {
    const text = formatToolResult(
      'bash',
      JSON.stringify({ command: 'pnpm build' }),
      errorResult('ETIMEDOUT', 'spawn timeout after 30000ms', 'Error'),
      undefined,
      undefined,
    );

    expect(text).toBe(
      '❌ 工具 `bash` 执行失败: `pnpm build`\n'
      + '原因: `Error: ETIMEDOUT` · spawn timeout after 30000ms',
    );
  });

  it('参数不可解析时只给工具名，不编造目标', () => {
    const text = formatToolResult(
      'read',
      'not-json',
      errorResult('FS_NOT_FOUND', 'ENOENT: no such file'),
      undefined,
      undefined,
    );

    expect(text).toBe(
      '❌ 工具 `read` 执行失败\n原因: `FsError: FS_NOT_FOUND` · ENOENT: no such file',
    );
  });

  it('结果正文缺失时只留错误码', () => {
    const text = formatToolResult(
      'edit',
      JSON.stringify({ file_path: 'a.ts' }),
      errorResult('FS_SANDBOX_DENIED'),
      undefined,
      undefined,
    );

    expect(text).toBe('❌ 工具 `edit` 执行失败: `a.ts`\n原因: `FsError: FS_SANDBOX_DENIED`');
  });

  it('长目标与长原因都截断，保持一行', () => {
    const path = `D:\\${'深'.repeat(100)}\\file.ts`;
    const detail = 'why '.repeat(80);
    const text = formatToolResult(
      'edit',
      JSON.stringify({ file_path: path }),
      errorResult('FS_IO_ERROR', detail),
      undefined,
      undefined,
    );

    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('❌ 工具 `edit` 执行失败: `')).toBe(true);
    expect(lines[0].endsWith('…`')).toBe(true);
    expect(lines[0].length).toBeLessThan(120);
    expect(lines[1].startsWith('原因: `FsError: FS_IO_ERROR` · ')).toBe(true);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(lines[1].length).toBeLessThan(260);
    expect(text.includes(path)).toBe(false);
  });

  it('原因里的换行压成一行，反引号被替换', () => {
    const text = formatToolResult(
      'edit',
      JSON.stringify({ file_path: 'a.ts' }),
      errorResult('FS_STALE_VERSION', 'line1\nline2 `quoted`'),
      undefined,
      undefined,
    );

    expect(text).toBe(
      "❌ 工具 `edit` 执行失败: `a.ts`\n原因: `FsError: FS_STALE_VERSION` · line1 line2 'quoted'",
    );
  });
});

describe('formatToolResult: 成功消息（回归）', () => {
  it('失败格式不影响成功结果的 🔧 头', () => {
    const text = formatToolResult('read', JSON.stringify({ file_path: 'a.ts' }), okResult('hello'), undefined, undefined);
    expect(text).toBe('🔧 `read` 完成\nhello');
  });
});
