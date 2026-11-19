/**
 * /rename — 修改当前会话名（会话标题）
 *
 * 标题走宿主的 `sessionTitle.rename`：作为显式用户修订写进 `session/title`
 * 事件，并固定该标题，后续不再被自动标题覆盖。宿主的标题服务只接受存活的
 * session，所以当前会话还没打开时只如实拒绝，不在改名里偷偷拉起会话。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { parseRest } from './args.ts';

/** 回复里展示标题的上限（宿主标题上限 80 字节，这里只防一行过长） */
const TITLE_MAX = 40;

/** 标题压成单行：换行会打散回复，markdown 字符会被 QQ 渲染掉 */
function displayTitle(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`*_~<>"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return '未命名会话';
  const chars = [...cleaned];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : cleaned;
}

/** 当前没有可改名的会话时的统一提示 */
const NO_SESSION = '⚠️ 当前没有会话';

export function renameCommand({ manager }: CommandDeps): SlashCommand {
  return {
    name: 'rename',
    scope: 'all',
    description: '重命名会话',
    usage: [
      '### 📖 /rename 用法',
      '',
      '`/rename <标题>` 重命名当前会话',
      '改别的会话用 `/sessions rename <id> <标题>`',
    ].join('\n'),
    handler: (cmdCtx) => {
      // 整行都是标题：带空格的标题不用引号也对，写了引号就去掉
      const raw = parseRest(cmdCtx.command?.raw ?? '');
      const currentId = manager.currentSessionId();

      // 不带参数 = 看一下现在叫什么，顺带给出下一步
      if (raw === '') {
        if (!manager.hasCurrentSession() || currentId === undefined) return NO_SESSION;
        const title = displayTitle(manager.sessionTitle(currentId));
        return `🗂 当前会话名: 「${title}」\n改名用 /rename <新标题>`;
      }

      const outcome = manager.renameCurrentSession(raw);
      if (outcome.ok) return `✅ 会话名已改为「${displayTitle(outcome.title)}」`;

      switch (outcome.reason) {
        case 'no-session':
          return NO_SESSION;
        case 'invalid':
          return '⚠️ 新标题不能为空';
        case 'not-live':
          return '⚠️ 会话已关闭';
        default:
          return `❌ 改名失败: ${outcome.message ?? '未知错误'}`;
      }
    },
  };
}
