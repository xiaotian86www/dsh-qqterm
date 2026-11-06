/**
 * 思考强度命令：/reasoning — 查看或切换当前会话的思考强度
 *
 * 档位由宿主 adapter 提供（`ctx.llm.resolveModelInfo` 的 reasoning 段），
 * 读与写都交给宿主（sessionController / agentDefaultModel），插件不存偏好。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { commandAllowlistAuth } from './auth.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { effortLabel } from '../model/effort-label.ts';
import type { EffortOption } from '../model/types.ts';

/** 不支持思考强度时的原因（只报原因，不给下一步） */
const UNSUPPORTED_REASON = '⚠️ 当前模型不支持思考强度';

export function reasoningCommand({ manager, config, logger }: CommandDeps): CategorizedCommand {
  return {
    name: ['reasoning', 'think'],
    category: 'agent',
    scope: 'all',
    // 管理类指令：与 /model 同一权限面
    authorized: commandAllowlistAuth(config, logger),
    description: '查看或切换当前会话的思考强度（用法: /reasoning [档位]）',
    panelDesc: '切换思考强度',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim().toLowerCase();

      const view = await manager.getEffortView(scope, peerId);

      // 无参数：一行现状 + 可点击的档位
      if (!args) {
        if (!view.options || view.options.length === 0) {
          return UNSUPPORTED_REASON;
        }

        const current = view.current;
        const currentLine = current ? `当前: ${optionLabel(current)}` : '当前: —';
        const lines: string[] = ['### 🧠 思考强度', '', currentLine, ''];

        for (const option of view.options) {
          const isCurrent = current?.id === option.id;
          lines.push(
            `<qqbot-cmd-input text="/reasoning ${option.id}" show="/reasoning ${optionLabel(option)}${isCurrent ? ' ✅' : ''}"/>`,
          );
        }

        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
      }

      // 切换
      const outcome = await manager.selectEffort(scope, peerId, args);

      if (!outcome.ok) {
        if (outcome.reason === 'unsupported') {
          return UNSUPPORTED_REASON;
        }
        if (outcome.reason === 'unknown-effort') {
          return `⚠️ 不支持的档位: \`${args}\``;
        }
        if (outcome.reason === 'no') {
          return '⚠️ 当前没有会话';
        }
        return `❌ 思考强度切换失败${outcome.message ? `: ${outcome.message}` : ''}`;
      }

      const label = view.options?.find((option) => option.id === outcome.effort);
      const display = label ? optionLabel(label) : outcome.effort;

      if (outcome.unchanged) return `✅ 已是当前思考强度: ${display}`;
      return `✅ 思考强度已切换: ${display}`;
    },
  };
}

/** 档位在按钮/文案里的展示名：`高 (high)`，未知 id 直接用 id */
function optionLabel(option: EffortOption): string {
  const label = effortLabel(option);
  return label === option.id ? option.id : `${label} (${option.id})`;
}
