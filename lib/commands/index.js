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
        // 可选能力门控命令始终注册，由命令自己现查可用性并「按未知指令」回复。
        // 不能在构造期求值：服务可能晚于插件 apply 才挂载。
        presetCommand(deps),
        permissionCommand(deps),
        stopCommand(deps),
        // 插话走宿主 sessionController.updateQueue；能力现查，缺服务时按未知指令处理，
        // 排队回执也不给链接。
        steerCommand(deps),
        retryCommand(deps),
        pluginsCommand(deps),
    ];
    // help 需要访问完整列表（含自身），通过闭包惰性引用
    commands.push(helpCommand(deps, () => commands));
    return commands;
}
//# sourceMappingURL=index.js.map