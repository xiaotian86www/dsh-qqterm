/**
 * 命令鉴权 — 挂到 SlashCommand.authorized 的唯一用户校验
 *
 * 机器人只有一个白名单用户（`access.owner`）。所有管理命令都要求发送者
 * 恰好是这个用户；owner 为空、身份缺失或不匹配一律拒绝（fail-closed）。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.ts';

/** 鉴权配置投影（结构化，便于单测） */
export interface CommandAuthConfigLike {
  access: {
    owner: string;
  };
}

const DENIED = '⚠️ 无权限执行此命令';

/** 构造「仅绑定用户可用」鉴权回调 */
export function ownerOnlyAuth(
  config: CommandAuthConfigLike,
  logger?: Logger,
): (ctx: SlashCommandHandlerContext) => boolean | string {
  return (ctx) => {
    const owner = config.access.owner.trim();
    const senderId = ctx.message.senderId;
    if (owner !== '' && senderId === owner) return true;
    logger?.warn(`im-qqbot: command auth denied: sender=${senderId ?? '(missing)'}`);
    return DENIED;
  };
}
