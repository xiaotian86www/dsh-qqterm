/**
 * 模型命令：/model — 查看或切换模型
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { commandAllowlistAuth } from './auth.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { effortLabel } from '../model/effort-label.ts';

export function modelCommand({ manager, config, logger }: CommandDeps): CategorizedCommand {
  return {
    name: 'model',
    category: 'agent',
    // 管理类指令：私聊可用，但仅限白名单用户（与 /preset 同构）
    scope: 'all',
    authorized: commandAllowlistAuth(config, logger),
    description: '查看或切换当前会话的模型（用法: /model [provider/model]）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();

      // 无参数：显示当前模型 + 可用模型列表（可点击）
      if (!args) {
        const current = manager.getEffectiveModel(scope, peerId);
        const models = await manager.listAvailableModels();

        // 当前模型展示：别名 + provider；列表按 provider 分组后不必再重复完整路径
        const matched = models.find((m) => m.provider === current.provider && m.id === current.model);
        const currentDisplay = matched
          ? `${shortModelName(current.model, matched.name)} · ${current.provider}`
          : `${current.provider}/${current.model}`;

        const lines: string[] = ['### 🤖 模型配置'];

        // 没有会话时不显示「当前」：那是核心默认值，不是任何会话的状态
        const hasSession = manager.hasCurrentSession();
        if (hasSession) {
          lines.push('', `**当前模型**: ${currentDisplay}`);

          // 思考强度是模型配置的一部分：有档位才显示，免得给不支持思考的模型挂一行噪声
          const effort = await manager.getEffortView(scope, peerId);
          if (effort.current) {
            lines.push(`**思考强度**: ${effortLabel(effort.current)}`);
          }
        }

        if (models.length > 0) {
          lines.push('', '**可用模型**');

          // 参考 /sessions all：按 provider 分组，组标题承担 provider，行内只留短名
          const grouped = new Map<string, typeof models>();
          for (const m of models) {
            const bucket = grouped.get(m.provider);
            if (bucket) bucket.push(m);
            else grouped.set(m.provider, [m]);
          }

          for (const [provider, entries] of grouped) {
            lines.push('', `**${provider}**`);
            for (const m of entries) {
              // 列表链接统一指向真实切换命令；当前项的「无变化」由命令自身兜底
              const isCurrent = hasSession && current.provider === m.provider && current.model === m.id;
              const suffix = isCurrent ? ' ✅' : '';
              lines.push(
                `<qqbot-cmd-input text="/model ${m.provider}/${m.id}" show="/model ${shortModelName(m.id, m.name)}${suffix}"/>`,
              );
            }
          }
        }

        lines.push('', '手动指定: `/model provider/model`');

        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      // 解析 provider/model 格式
      let provider: string;
      let model: string;

      if (args.includes('/')) {
        const parts = args.split('/');
        provider = parts[0] ?? '';
        model = parts.slice(1).join('/');
      } else {
        // 仅指定 model 名，provider 从当前路由继承
        const current = manager.getEffectiveModel(scope, peerId);
        provider = current.provider;
        model = args;
      }

      if (!provider || !model) {
        return '⚠️ 用法: /model provider/model';
      }

      const outcome = await manager.setModelOverride(scope, peerId, { provider, model });
      if (outcome.reason === 'no-session') {
        return '⚠️ 当前没有会话';
      }
      if (outcome.reason === 'failed') {
        return `❌ 模型切换失败: ${outcome.message ?? '未知错误'}`;
      }
      if (outcome.unchanged) {
        return `✅ 已是当前模型: ${provider}/${model}`;
      }
      return `✅ 模型已切换: ${provider}/${model}`;
    },
  };
}

/**
 * 列表内展示名：provider 已由分组标题给出，这里只留别名或 id，
 * 避免每行都重复一遍完整 `provider/id`。
 */
function shortModelName(id: string, name?: string): string {
  const alias = name?.trim();
  return alias && alias !== id ? alias : id;
}
