import { describe, it, expect } from 'vitest';
import { parseEvent, type RawSessionEvent } from './events.ts';

describe('parseEvent: deliverables/presented', () => {
  const presented = (data: unknown): RawSessionEvent => ({ type: 'deliverables/presented', data: data as Record<string, unknown> });
  const file = (path: string, description?: string) => (description === undefined ? { path } : { path, description });

  it('合法事件解析为强类型（含可选 description）', () => {
    expect(parseEvent(presented({ turn: 3, callId: 'call-1', files: [file('/tmp/a.png'), file('/tmp/b.md', '说明')] })))
      .toEqual({
        type: 'deliverables/presented',
        turn: 3,
        callId: 'call-1',
        files: [{ path: '/tmp/a.png' }, { path: '/tmp/b.md', description: '说明' }],
      });
  });

  it.each([
    ['缺 turn', { callId: 'c', files: [file('a')] }],
    ['turn 非 number', { turn: '3', callId: 'c', files: [file('a')] }],
    ['缺 callId', { turn: 1, files: [file('a')] }],
    ['callId 为空串', { turn: 1, callId: '', files: [file('a')] }],
    ['缺 files', { turn: 1, callId: 'c' }],
    ['files 为空数组', { turn: 1, callId: 'c', files: [] }],
    ['files 非数组', { turn: 1, callId: 'c', files: 'x' }],
    ['文件项缺 path', { turn: 1, callId: 'c', files: [{ description: 'd' }] }],
    ['path 为空串', { turn: 1, callId: 'c', files: [file('')] }],
    ['description 非 string', { turn: 1, callId: 'c', files: [{ path: 'a', description: 1 }] }],
    ['文件项为 null', { turn: 1, callId: 'c', files: [null] }],
  ])('非法事件返回 undefined：%s', (_name, data) => {
    expect(parseEvent(presented(data))).toBeUndefined();
  });
});
