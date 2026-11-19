import { parseRest } from "./args.js";
import { getScopePeer } from "../shared/index.js";
/** /goal — 转发宿主的长期目标命令 */
export function goalCommand({ manager }) {
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
            // 整行都是目标参数：带空格的写法不用引号也对，写了引号就去掉
            const raw = parseRest(cmdCtx.command?.raw ?? '');
            // 没有活跃会话时从磁盘拉起：目标挂在会话上，新建会话与其它命令一致
            const record = await manager.getOrCreate(scope, peerId, msg.senderId, {
                scope,
                targetId: peerId,
            });
            // 参数原样透传：create / edit / pause / resume / clear 由宿主解析
            const run = await manager.runHostCommand(record.agent, 'goal', raw === '' ? [] : [raw]);
            if (run.kind === 'unsupported')
                return '⚠️ 当前 preset 没有目标能力';
            if (run.kind === 'threw')
                return `❌ 目标操作失败: ${run.message}`;
            if (run.kind === 'success')
                return run.text ? `✅ ${run.text}` : '✅ 目标';
            return run.text ? `❌ ${run.text}` : '❌ 目标操作失败';
        },
    };
}
//# sourceMappingURL=goal.js.map