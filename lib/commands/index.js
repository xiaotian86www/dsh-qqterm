import { newCommand, resetCommand, compactCommand } from "./session.js";
import { goalCommand } from "./goal.js";
import { sessionsCommand } from "./sessions.js";
import { renameCommand } from "./rename.js";
import { toCommand } from "./to.js";
import { lsCommand } from "./ls.js";
import { getCommand } from "./get.js";
import { runCommand } from "./run.js";
import { modelCommand } from "./model.js";
import { reasoningCommand } from "./reasoning.js";
import { costCommand } from "./cost.js";
import { sessionStatusCommand } from "./session-status.js";
import { presetCommand } from "./preset.js";
import { permissionCommand } from "./permission.js";
import { retryCommand } from "./retry.js";
import { helpCommand } from "./help.js";
import { pluginsCommand } from "./plugins.js";
import { steerCommand, stopCommand } from "./misc.js";
/**
 * 构建标准命令列表
 */
export function buildCommandList(deps) {
    const commands = [
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
//# sourceMappingURL=index.js.map