/**
 * /goal — 当前会话的长期任务目标
 *
 * 只做转发：参数原样交给宿主的 `/goal` 命令（创建 / 查看 / 修改 / 暂停 / 继续 / 清除），
 * 插件不存目标、不解释语义、不判断状态机。宿主文本自带标题行（Goal created 等），
 * 所以只在第一行加状态图标，不再叠一句中文结论。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { getScopePeer } from '../shared/index.ts';

/** /goal — 转发宿主的长期目标命令 */
export function goalCommand({ manager }: CommandDeps): SlashCommand {
  return {
    name: 'goal',
    scope: 'all',
    description: '设定或查看长期目标',
    usage: [
      '### 📖 /goal 用法',
      '',
      '`/goal` 查看当前目标',
      '`/goal <目标>` 设定目标',
      '`/goal edit <目标>` 修改目标',
      '`/goal pause` · `/goal resume` · `/goal clear` 暂停 / 继续 / 清除',
    ].join('\n'),
    handler: async (cmdCtx) => {
      const msg = cmdCtx.message;
      const { scope, peerId } = getScopePeer(cmdCtx);
      const raw = (cmdCtx.command?.raw ?? '').trim();
      // 没有活跃会话时从磁盘拉起：目标挂在会话上，新建会话与其它命令一致
      const record = await manager.getOrCreate(scope, peerId, msg.senderId, {
        scope,
        targetId: peerId,
      });
      // 参数原样透传：create / edit / pause / resume / clear 由宿主解析
      const run = await manager.runHostCommand(record.agent, 'goal', raw === '' ? [] : [raw]);

      if (run.kind === 'unsupported') return '⚠️ 当前 preset 没有目标能力';
      if (run.kind === 'threw') return `❌ 目标操作失败: ${run.message}`;
      if (run.kind === 'success') return run.text ? `✅ ${run.text}` : '✅ 目标';
      return run.text ? `❌ ${run.text}` : '❌ 目标操作失败';
    },
  };
}
