import { commandAllowlistAuth } from "./auth.js";
import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
export function modelCommand({ manager, config, logger }) {
    return {
        name: 'model',
        category: 'agent',
        // 管理类指令：私聊/群聊均可用，但仅限白名单用户（与 /preset 同构）
        scope: 'all',
        authorized: commandAllowlistAuth(config, logger),
        description: '查看或切换模型（用法: /model [provider/model]）',
        handler: async (cmdCtx) => {
            const { scope, peerId } = getScopePeer(cmdCtx);
            const args = (cmdCtx.command?.raw ?? '').trim();
            // 无参数：显示当前模型 + 可用模型列表（可点击）
            if (!args) {
                const current = manager.getEffectiveModel(scope, peerId);
                const models = await manager.listAvailableModels();
                // 当前模型展示：别名 + provider；列表按 provider 分组后不必再重复完整路径
                let currentDisplay = '宿主默认配置';
                if (current) {
                    const matched = models.find((m) => m.provider === current.provider && m.id === current.model);
                    currentDisplay = matched
                        ? `${shortModelName(current.model, matched.name)} · ${current.provider}`
                        : `${current.provider}/${current.model}`;
                }
                const lines = [
                    '### 🤖 模型配置',
                    '',
                    `**当前模型**: ${currentDisplay}`,
                ];
                if (models.length > 0) {
                    lines.push('', '**可用模型（点击切换）:**');
                    // 参考 /sessions all：按 provider 分组，组标题承担 provider，行内只留短名
                    const grouped = new Map();
                    for (const m of models) {
                        const bucket = grouped.get(m.provider);
                        if (bucket)
                            bucket.push(m);
                        else
                            grouped.set(m.provider, [m]);
                    }
                    for (const [provider, entries] of grouped) {
                        lines.push('', `**${provider}**`);
                        for (const m of entries) {
                            // 列表链接统一指向真实切换命令；当前项的「无变化」由命令自身兜底
                            const isCurrent = current?.provider === m.provider && current?.model === m.id;
                            const suffix = isCurrent ? ' ✅' : '';
                            lines.push(`<qqbot-cmd-input text="/model ${m.provider}/${m.id}" show="/model ${shortModelName(m.id, m.name)}${suffix}"/>`);
                        }
                    }
                }
                lines.push('', '手动指定: `/model provider/model`');
                await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
                return { kind: 'noop' };
            }
            // 解析 provider/model 格式
            let provider;
            let model;
            if (args.includes('/')) {
                const parts = args.split('/');
                provider = parts[0] ?? '';
                model = parts.slice(1).join('/');
            }
            else {
                // 仅指定 model 名，provider 从当前路由继承
                const current = manager.getEffectiveModel(scope, peerId);
                provider = current?.provider ?? 'deepseek-official';
                model = args;
            }
            if (!provider || !model) {
                return '用法: /model provider/model\n示例: /model deepseek-official/deepseek-v4-flash';
            }
            const outcome = await manager.setModelOverride(scope, peerId, { provider, model });
            if (outcome.unchanged) {
                return `✅ 已是当前模型: ${provider}/${model}`;
            }
            return `✅ 模型已切换: ${provider}/${model}（立即生效）`;
        },
    };
}
/**
 * 列表内展示名：provider 已由分组标题给出，这里只留别名或 id，
 * 避免每行都重复一遍完整 `provider/id`。
 */
function shortModelName(id, name) {
    const alias = name?.trim();
    return alias && alias !== id ? alias : id;
}
//# sourceMappingURL=model.js.map