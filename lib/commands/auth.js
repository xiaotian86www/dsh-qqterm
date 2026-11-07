const DENIED = '⚠️ 无权限执行此命令';
/** 构造「仅绑定用户可用」鉴权回调 */
export function ownerOnlyAuth(config, logger) {
    return (ctx) => {
        const owner = config.access.owner.trim();
        const senderId = ctx.message.senderId;
        if (owner !== '' && senderId === owner)
            return true;
        logger?.warn(`im-qqbot: command auth denied: sender=${senderId ?? '(missing)'}`);
        return DENIED;
    };
}
//# sourceMappingURL=auth.js.map