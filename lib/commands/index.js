import { newCommand, resetCommand, compactCommand } from "./session.js";
import { sessionsCommand } from "./sessions.js";
import { renameCommand } from "./rename.js";
import { toCommand } from "./to.js";
import { lsCommand } from "./ls.js";
import { getCommand } from "./get.js";
import { modelCommand } from "./model.js";
import { reasoningCommand } from "./reasoning.js";
import { costCommand } from "./cost.js";
import { sessionStatusCommand } from "./session-status.js";
import { presetCommand } from "./preset.js";
import { permissionCommand } from "./permission.js";
import { retryCommand } from "./retry.js";
import { helpCommand } from "./help.js";
import { pluginsCommand } from "./plugins.js";
import { stopCommand } from "./misc.js";
/**
 * 构建标准命令列表
 */
export function buildCommandList(deps) {
    const commands = [
        newCommand(deps),
        resetCommand(deps),
        compactCommand(deps),
        sessionsCommand(deps),
        renameCommand(deps),
        toCommand(deps),
        lsCommand(deps),
        getCommand(deps),
        modelCommand(deps),
        reasoningCommand(deps),
        costCommand(deps),
        sessionStatusCommand(deps),
        presetCommand(deps),
        permissionCommand(deps),
        stopCommand(deps),
        retryCommand(deps),
        pluginsCommand(deps),
    ];
    // help 需要访问完整列表（含自身），通过闭包惰性引用
    commands.push(helpCommand(deps, () => commands));
    return commands;
}
//# sourceMappingURL=index.js.map