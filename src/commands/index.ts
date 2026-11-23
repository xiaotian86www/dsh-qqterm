/**
 * 斜杠命令注册中心
 *
 * 每个命令拆分为独立文件，此处仅编排。工厂函数注入依赖，统一导出命令列表。
 */
import type { CommandDeps, SlashCommand } from './types.ts';
import { newCommand, resetCommand, compactCommand } from './session.ts';
import { goalCommand } from './goal.ts';
import { sessionsCommand } from './sessions.ts';
import { renameCommand } from './rename.ts';
import { toCommand } from './to.ts';
import { lsCommand } from './ls.ts';
import { getCommand } from './get.ts';
import { modelCommand } from './model.ts';
import { reasoningCommand } from './reasoning.ts';
import { costCommand } from './cost.ts';
import { sessionStatusCommand } from './session-status.ts';
import { presetCommand } from './preset.ts';
import { permissionCommand } from './permission.ts';
import { retryCommand } from './retry.ts';
import { helpCommand } from './help.ts';
import { pluginsCommand } from './plugins.ts';
import { steerCommand, stopCommand } from './misc.ts';

/**
 * 构建标准命令列表
 */
export function buildCommandList(deps: CommandDeps): SlashCommand[] {
  const commands: SlashCommand[] = [
    newCommand(deps),
    resetCommand(deps),
    compactCommand(deps),
    goalCommand(deps),
    sessionsCommand(deps),
    renameCommand(deps),
    toCommand(deps),
    lsCommand(deps),
    getCommand(deps),
    modelCommand(deps),
    reasoningCommand(deps),
    costCommand(deps),
    sessionStatusCommand(deps),
    // 部署里没有 agentPresets 服务时整条命令不注册：用户输入 /preset 按未知指令处理，
    // 不再额外解释「当前部署没有该能力」。
    ...(deps.manager.presetsAvailable() ? [presetCommand(deps)] : []),
    permissionCommand(deps),
    stopCommand(deps),
    // 插话走宿主 sessionController.updateQueue；没有该服务时不注册，
    // 用户输入 /steer 按未知指令处理，排队回执也不给链接。
    ...(deps.manager.canSteer() ? [steerCommand(deps)] : []),
    retryCommand(deps),
    pluginsCommand(deps),
  ];

  // help 需要访问完整列表（含自身），通过闭包惰性引用
  commands.push(helpCommand(deps, () => commands));

  return commands;
}