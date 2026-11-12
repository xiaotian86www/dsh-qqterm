/**
 * 本地文件链接改写：`[文件](路径)` → `<qqbot-cmd-input text="/get 绝对路径" .../>`
 *
 * 用真实临时文件判定「存在且是普通文件」，不碰真实工作区。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteLocalFileLinks } from './file-links.ts';

let root = '';
let file = '';
let dir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qqterm-links-'));
  file = join(root, 'report.txt');
  dir = join(root, 'sub');
  writeFileSync(file, 'x');
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 期望的按钮：路径原样进 text，show 是链接文字 */
function button(path: string, show: string): string {
  return `<qqbot-cmd-input text="/get ${path}" show="${show}"/>`;
}

describe('rewriteLocalFileLinks', () => {
  it('绝对路径改成 /get 命令', () => {
    const text = `报告在 [report.txt](${file})`;
    expect(rewriteLocalFileLinks(text, root)).toBe(`报告在 ${button(file, 'report.txt')}`);
  });

  it('相对路径按会话工作目录解析', () => {
    expect(rewriteLocalFileLinks('[report.txt](report.txt)', root)).toBe(button(file, 'report.txt'));
  });

  it('没有链接文字时用文件名', () => {
    expect(rewriteLocalFileLinks(`[](report.txt)`, root)).toBe(button(file, 'report.txt'));
  });

  it('去掉行号片段再判定', () => {
    expect(rewriteLocalFileLinks('[report.txt](report.txt#L3-L5)', root)).toBe(button(file, 'report.txt'));
  });

  it('外链、目录、不存在的文件保持原样', () => {
    const text = [
      '[文档](https://example.com/a?b=1)',
      '[目录](sub)',
      '[旧文件](missing.txt)',
    ].join('\n');
    expect(rewriteLocalFileLinks(text, root)).toBe(text);
  });

  it('代码块与行内代码里的链接不改写', () => {
    const text = [
      '```md',
      `[report.txt](${file})`,
      '```',
      `示例：\`[report.txt](${file})\` 与 [真链接](${file})`,
    ].join('\n');
    expect(rewriteLocalFileLinks(text, root)).toBe(
      [
        '```md',
        `[report.txt](${file})`,
        '```',
        `示例：\`[report.txt](${file})\` 与 ${button(file, '真链接')}`,
      ].join('\n'),
    );
  });

  it('工作目录未知时只改写绝对路径', () => {
    expect(rewriteLocalFileLinks('[report.txt](report.txt)', undefined)).toBe('[report.txt](report.txt)');
    expect(rewriteLocalFileLinks(`[report.txt](${file})`, undefined)).toBe(button(file, 'report.txt'));
  });

  it('链接文字里的 markdown 字符被净化', () => {
    expect(rewriteLocalFileLinks(`[**报告 _v2_**](${file})`, root)).toBe(button(file, '报告 v2'));
  });
});
