import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { sessionTargetLabel, sessionTitleOf } from "../transport/session-source.js";
import { effortLabel } from "../model/effort-label.js";
import { presetLabel } from "./permission.js";
/** 千分位（与 /cost 一致，避免不同环境的本地化分隔符） */
function num(n) {
    return n.toLocaleString('en-US');
}
/** 上下文占用：占用 / 窗口 / 剩余（窗口没上报时只给占用量） */
function renderContext(ctx) {
    const { used, window } = ctx;
    if (used !== undefined && window !== undefined && window > 0) {
        const pct = ((used / window) * 100).toFixed(1);
        return `${num(used)} / ${num(window)}（${pct}%，剩 ${num(Math.max(0, window - used))}）`;
    }
    if (used !== undefined)
        return `${num(used)}（窗口未上报）`;
    if (window !== undefined)
        return `窗口 ${num(window)}（还没有请求）`;
    return undefined;
}
/** 渲染会话状态正文（handler 只负责兜错与发送） */
async function renderStatus(manager, scope, peerId, extras) {
    const status = manager.getStatus(scope, peerId);
    const record = manager.getSessionRecord(scope, peerId);
    const lines = ['### 📊 会话状态', ''];
    // 会话：标题 + 短 id + 是否正在生成（标题还没生成时只给 id）
    if (status.active && status.sessionId) {
        const running = record?.agent.status === 'running';
        const title = record === undefined ? undefined : sessionTitleOf(record);
        lines.push(`**会话**: ${sessionTargetLabel(status.sessionId, title)} · ${running ? '生成中' : '空闲'}`);
    }
    else {
        lines.push('**会话**: 未建立');
    }
    // 工作区：会话落在哪个目录（读不到就跳过，不影响其它字段）
    const workspace = await manager.currentWorkspaceInfo(scope, peerId).catch(() => undefined);
    if (workspace) {
        const missing = workspace.missing ? ' ⚠️ 目录已不存在' : '';
        lines.push(`**工作区**: ${workspace.title} · \`${workspace.path}\`${missing}`);
    }
    // 模型 / 思考强度 / preset / 权限：没有会话时展示部署默认值（新建会话会用它），
    // 与各命令的「当前」口径一致，不另标默认
    if (status.model) {
        lines.push(`**模型**: ${status.provider}/${status.model}`);
    }
    // 思考强度跟着模型走：只在模型支持时显示
    const effort = await manager.getEffortView(scope, peerId);
    if (effort.current) {
        lines.push(`**思考强度**: ${effortLabel(effort.current)}`);
    }
    const preset = manager.getEffectivePreset(scope, peerId);
    if (preset)
        lines.push(`**Preset**: ${preset}`);
    const permission = manager.getPermissionPreset(scope, peerId);
    if (permission) {
        const entry = manager.listPermissionPresets().find((item) => item.id === permission);
        lines.push(`**权限**: ${presetLabel(permission, entry)}`);
    }
    else {
        // 宿主读不出权限（目录投影缺失等）时也保留字段，不能整行消失
        lines.push('**权限**: —');
    }
    // 以下只在会话已建立时有意义
    if (status.active) {
        lines.push(`**消息**: ${num(status.messageCount ?? 0)} 条`);
        const contextLine = renderContext(manager.getContextUsage(scope, peerId));
        if (contextLine)
            lines.push(`**上下文**: ${contextLine}`);
        const usage = manager.getTokenUsage(scope, peerId);
        if (usage.input + usage.output > 0) {
            lines.push(`**Token**: 输入 ${num(usage.input)} · 输出 ${num(usage.output)}（累计）`);
        }
    }
    // 插件侧最近一次动作：排障时用来确认重载 / 安装是否真的生效
    const lastReload = extras?.reloader?.describe();
    if (lastReload !== undefined)
        lines.push(`**上次重载**: ${lastReload}`);
    const lastPlugins = extras?.installer?.describe();
    if (lastPlugins !== undefined)
        lines.push(`**上次插件操作**: ${lastPlugins}`);
    return lines.join('\n');
}
/** /status — 查看当前会话的完整状态 */
export function sessionStatusCommand({ manager, config, logger, reloader, installer }) {
    return {
        name: 'status',
        scope: 'all',
        description: '查看会话状态',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            let text;
            try {
                text = await renderStatus(manager, scope, peerId, { reloader, installer });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger?.warn(`/status 失败: ${message}`);
                text = `⚠️ 读取会话状态失败: ${message}`;
            }
            // 统一走 markdown 通道：否则 `###` 与 `**` 会成为字面文本
            await sendMarkdownChunked(cmdCtx, text, config.textChunkLimit);
            return { kind: 'noop' };
        },
    };
}
//# sourceMappingURL=session-status.js.map