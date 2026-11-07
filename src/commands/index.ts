/**
 * 斜杠命令注册中心
 *
 * 每个命令拆分为独立文件，此处仅编排。工厂函数注入依赖，统一导出命令列表。
 *
 * 命令按 category 分两类：
 *   - agent：底层 dsh agent 通用能力（new/compact/model/status/cost）
 *   - qqbot：插件自身特有（bot-ping/bot-version/bot-status/bot-help）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { newCommand, resetCommand, compactCommand } from './session.ts';
import { sessionsCommand } from './sessions.ts';
import { renameCommand } from './rename.ts';
import { toCommand } from './to.ts';
import { lsCommand } from './ls.ts';
import { modelCommand } from './model.ts';
import { reasoningCommand } from './reasoning.ts';
import { costCommand } from './cost.ts';
import { sessionStatusCommand } from './session-status.ts';
import { presetCommand } from './preset.ts';
import { permissionCommand } from './permission.ts';
import { statusCommand } from './status.ts';
import { retryCommand } from './retry.ts';
import { helpCommand } from './help.ts';
import { syncCommand } from './sync.ts';
import { reloadCommand } from './reload.ts';
import { pingCommand, versionCommand, stopCommand, meCommand } from './misc.ts';

/**
 * 构建标准命令列表
 */
export function buildCommandList(deps: CommandDeps): CategorizedCommand[] {
  const commands: CategorizedCommand[] = [
    // 通用能力（底层 agent）
    newCommand(deps),
    resetCommand(deps),
    compactCommand(deps),
    sessionsCommand(deps),
    renameCommand(deps),
    toCommand(deps),
    lsCommand(deps),
    modelCommand(deps),
    reasoningCommand(deps),
    costCommand(deps),
    sessionStatusCommand(deps),
    presetCommand(deps),
    permissionCommand(deps),
    stopCommand(deps),
    retryCommand(deps),
    // QQBot 特有
    pingCommand(),
    versionCommand(deps),
    meCommand(deps),
    statusCommand(deps),
    reloadCommand(deps),
  ];

  // help / sync 需要访问完整列表（含自身），通过闭包惰性引用
  commands.push(helpCommand(deps, () => commands));
  commands.push(syncCommand(deps, () => commands));

  return commands;
}
