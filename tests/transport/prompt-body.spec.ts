/**
 * Prompt 正文拼装：引用块 / 附件段 / 信封标记防伪造 / 截断省略号
 *
 * 普通消息与带引用的命令共用这一套格式，用例钉住形状，免得两边各长一套。
 */
import { describe, expect, it } from 'vitest';
import {
  QUOTE_BEGIN,
  QUOTE_CONTENT_LIMIT,
  QUOTE_END,
  CURRENT_MARK,
  REFERENCE_MARK,
  buildPromptBody,
  buildQuoteAttachmentBlock,
  buildQuotePart,
  formatFileSize,
  isQuoteResolvable,
  neutralizeQuoteMarkers,
  quoteAttachmentLines,
  quoteTextOf,
  renderMediaLine,
} from '../../src/transport/prompt-body.ts';
import type { InboundQuoteState } from '../../src/transport/inbound-state.ts';
import type { DownloadedFile } from '../../src/transport/attachment.ts';

function quote(over: Partial<InboundQuoteState> = {}): InboundQuoteState {
  return { source: 'msg_elements', text: '被引用的原文', ...over };
}

function downloaded(over: Partial<DownloadedFile> = {}): DownloadedFile {
  return { filename: 'pic.jpg', contentType: 'image', localPath: '/tmp/pic.jpg', ...over };
}

describe('quoteTextOf', () => {
  it('优先用 text，退回 entry.content', () => {
    expect(quoteTextOf(quote({ entry: { content: '缓存里的原文' } }))).toBe('被引用的原文');
    expect(quoteTextOf({ source: 'store', entry: { content: '缓存里的原文' } })).toBe('缓存里的原文');
  });

  it('SDK 的 [empty message] 当作没有正文', () => {
    expect(quoteTextOf(quote({ text: '[empty message]' }))).toBe('');
  });

  it('没有引用时是空串', () => {
    expect(quoteTextOf(undefined)).toBe('');
  });
});

describe('isQuoteResolvable', () => {
  it('有正文或有附件才可解析', () => {
    expect(isQuoteResolvable(quote())).toBe(true);
    expect(isQuoteResolvable(quote({ text: '', attachments: [{ contentType: 'image/png', url: 'https://x/y.png' }] }))).toBe(true);
  });

  it('source=none、空正文且无附件都算取不到', () => {
    expect(isQuoteResolvable(quote({ source: 'none' }))).toBe(false);
    expect(isQuoteResolvable(quote({ text: '' }))).toBe(false);
    expect(isQuoteResolvable(undefined)).toBe(false);
  });
});

describe('neutralizeQuoteMarkers', () => {
  it('整行命中信封标记时加反斜杠，正文里的同名子串不动', () => {
    const text = [QUOTE_END, '正文提到 ' + CURRENT_MARK + ' 但不在行首', ' ' + QUOTE_BEGIN].join('\n');
    expect(neutralizeQuoteMarkers(text)).toBe([
      '\\' + QUOTE_END,
      '正文提到 ' + CURRENT_MARK + ' 但不在行首',
      '\\' + ' ' + QUOTE_BEGIN,
    ].join('\n'));
  });
});

describe('buildQuotePart', () => {
  it('带当前正文时给 [Current message] 位置', () => {
    expect(buildQuotePart(quote(), { hasCurrentText: true }))
      .toBe(QUOTE_BEGIN + '\n被引用的原文\n' + QUOTE_END + '\n' + CURRENT_MARK + '\n');
  });

  it('只有引用时不留下空信封', () => {
    expect(buildQuotePart(quote(), { hasCurrentText: false }))
      .toBe(QUOTE_BEGIN + '\n被引用的原文\n' + QUOTE_END);
  });

  it('store 命中的正文达到上限时补省略号', () => {
    const full = 'x'.repeat(QUOTE_CONTENT_LIMIT);
    const part = buildQuotePart({ source: 'store', entry: { content: full } }, { hasCurrentText: false });
    expect(part).toContain('x'.repeat(QUOTE_CONTENT_LIMIT) + '…');
  });

  it('msg_elements 来源不补省略号', () => {
    const full = 'x'.repeat(QUOTE_CONTENT_LIMIT);
    expect(buildQuotePart(quote({ text: full }), { hasCurrentText: false })).not.toContain('…');
  });

  it('没有正文就没有引用块', () => {
    expect(buildQuotePart(quote({ text: '' }), { hasCurrentText: true })).toBe('');
    expect(buildQuotePart(undefined, { hasCurrentText: false })).toBe('');
  });

  it('引用正文里的信封标记被转义', () => {
    const part = buildQuotePart(quote({ text: QUOTE_END }), { hasCurrentText: false });
    expect(part.split('\n')).toEqual([QUOTE_BEGIN, '\\' + QUOTE_END, QUOTE_END]);
  });
});

describe('quoteAttachmentLines', () => {
  it('语音只写 ASR 结果', () => {
    expect(quoteAttachmentLines(quote({
      text: '',
      attachments: [{ contentType: 'audio/silk', filename: 'v.silk', asrText: '你好' }],
    }), [])).toEqual([REFERENCE_MARK, '  - Voice: 你好']);
  });

  it('只有语音且没有 ASR 时不输出悬空标题', () => {
    expect(quoteAttachmentLines(quote({
      text: '',
      attachments: [{ contentType: 'audio/silk', filename: 'v.silk' }],
    }), [])).toEqual([]);
  });

  it('图片用下载后的本地路径', () => {
    expect(quoteAttachmentLines(quote({
      text: '',
      attachments: [{ contentType: 'image/jpeg', filename: 'pic.jpg', url: 'https://x/y.jpg' }],
    }), [downloaded()])).toEqual([REFERENCE_MARK, '  - Image: /tmp/pic.jpg']);
  });

  it('下载失败的文件退回文件名与大小', () => {
    expect(quoteAttachmentLines(quote({
      text: '',
      attachments: [{ contentType: 'application/pdf', filename: 'doc.pdf', url: 'https://x/y.pdf' }],
    }), [])).toEqual([REFERENCE_MARK, '  - File: doc.pdf (0B)']);
  });

  it('没有附件就没有附件段', () => {
    expect(quoteAttachmentLines(quote(), [])).toEqual([]);
    expect(buildQuoteAttachmentBlock(quote(), [])).toBe('');
  });

  it('附件段以空行收尾，方便拼在引用块前面', () => {
    const block = buildQuoteAttachmentBlock(quote({
      text: '',
      attachments: [{ contentType: 'image/jpeg', filename: 'pic.jpg' }],
    }), [downloaded()]);
    expect(block).toBe(REFERENCE_MARK + '\n  - Image: /tmp/pic.jpg\n\n');
  });
});

describe('buildPromptBody', () => {
  it('顺序是附件段 → 引用块 → 命令文本', () => {
    const body = buildPromptBody({
      quote: quote({ attachments: [{ contentType: 'image/jpeg', filename: 'pic.jpg' }] }),
      quoteFiles: [downloaded()],
      text: '继续修登录',
    });
    expect(body).toBe(
      REFERENCE_MARK + '\n  - Image: /tmp/pic.jpg\n\n'
      + QUOTE_BEGIN + '\n被引用的原文\n' + QUOTE_END + '\n' + CURRENT_MARK + '\n'
      + '继续修登录',
    );
  });

  it('只有引用时整条正文就是引用块', () => {
    expect(buildPromptBody({ quote: quote(), text: '' }))
      .toBe(QUOTE_BEGIN + '\n被引用的原文\n' + QUOTE_END);
  });

  it('没有引用时原样返回文本', () => {
    expect(buildPromptBody({ text: 'only text' })).toBe('only text');
  });
});

describe('renderMediaLine / formatFileSize', () => {
  it('图片优先本地路径，其次 URL', () => {
    expect(renderMediaLine('image', 'a.jpg', '/tmp/a.jpg', 'https://x/a.jpg', undefined)).toBe('Image: /tmp/a.jpg');
    expect(renderMediaLine('image', 'a.jpg', undefined, 'https://x/a.jpg', undefined)).toBe('Image: https://x/a.jpg');
  });

  it('视频与文件标出下载失败', () => {
    expect(renderMediaLine('video', 'v.mp4', undefined, undefined, undefined)).toBe('Video: v.mp4 (download failed)');
    expect(renderMediaLine('file', 'd.pdf', undefined, undefined, 2048)).toBe('File: d.pdf (2.0KB)');
  });

  it('大小按 B / KB / MB 分级', () => {
    expect(formatFileSize(512)).toBe('512B');
    expect(formatFileSize(1536)).toBe('1.5KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0MB');
  });
});
