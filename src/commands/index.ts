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
import { runCommand } from './run.ts';
import { modelCommand } from './model.ts';
import { reasoningCommand } from './reasoning.ts';
import { costCommand } from './cost.ts';
import { sessionStatusCommand } from './session-status.ts';
import { presetCommand } from './preset.ts';
import { permissionCommand } from './permission.ts';
import { retryCommand } from './retry.ts';
import { helpCommand } from './help.ts';
import { pluginsCommand } from './plugins.ts';
import { steerCommand, stopCommand, unqueueCommand } from './misc.ts';

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
    runCommand(deps),
    modelCommand(deps),
    reasoningCommand(deps),
    costCommand(deps),
    sessionStatusCommand(deps),
    // 可选能力门控命令始终注册，由命令自己现查可用性并「按未知指令」回复。
    // 不能在构造期求值：服务可能晚于插件 apply 才挂载。
    presetCommand(deps),
    permissionCommand(deps),
    stopCommand(deps),
    // 插话与取消排队走宿主 sessionController.updateQueue；能力现查，缺服务时
    // 按未知指令处理，排队回执也不给链接。
    steerCommand(deps),
    unqueueCommand(deps),
    retryCommand(deps),
    pluginsCommand(deps),
  ];

  // help 需要访问完整列表（含自身），通过闭包惰性引用
  commands.push(helpCommand(deps, () => commands));

  return commands;
}