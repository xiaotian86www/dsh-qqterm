import { buildUnknownCommandReply, parseCommandCandidate } from "../middleware/unknown-command.js";
/**
 * 可选能力门控：命令始终注册，但「现在能不能用」必须在每个使用点现算。
 * 不把 `available()` 的结果存成常量——服务可能在插件 apply 之后才挂载，也可能中途卸载。
 * 未声明 `available` 的命令永远可用。
 */
export function isCommandAvailable(command) {
    return command.available?.() ?? true;
}
/** 当前可用的命令子集：帮助、未知指令守卫与指令面板都从这里取。 */
export function visibleCommands(commands) {
    return commands.filter(isCommandAvailable);
}
/**
 * 能力翻转后不可用的命令仍被 SDK 派发到 handler；复用未知指令回复保持文案逐字一致。
 * 候选指令按真实入站文本构造，才能给出正确的「未知指令名」与相近指令建议。
 */
export function unavailableCommandReply(ctx, name) {
    const candidate = parseCommandCandidate(ctx.message?.content ?? '') ?? {
        raw: name,
        name,
        prefix: '/',
    };
    return buildUnknownCommandReply(candidate, undefined).markdown;
}
//# sourceMappingURL=availability.js.map