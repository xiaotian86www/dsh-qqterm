/**
 * 命令鉴权 — 挂到 SlashCommand.authorized 的白名单校验
 *
 * 名单语义与审批按钮校验（approval-channel）一致：c2cMode=allowlist 时发送者
 * 必须在 c2cAllow；身份缺失同样拒绝（fail-closed）。open 模式放行。
 */
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { Logger } from '../types.ts';

/** 鉴权配置投影（结构化，便于单测） */
export interface CommandAuthConfigLike {
  access: {
    c2cMode: 'open' | 'allowlist' | 'disabled';
    c2cAllow: readonly string[];
  };
}

const DENIED = '⚠️ 无权限执行此命令';

/** 构造命令白名单鉴权回调 */
export function commandAllowlistAuth(
  config: CommandAuthConfigLike,
  logger?: Logger,
): (ctx: SlashCommandHandlerContext) => boolean | string {
  return (ctx) => {
    if (config.access.c2cMode !== 'allowlist') return true;
    const senderId = ctx.message.senderId;
    if (!senderId || !config.access.c2cAllow.includes(senderId)) {
      logger?.warn(`im-qqbot: command auth denied: sender=${senderId ?? '(missing)'}`);
      return DENIED;
    }
    return true;
  };
}

const PERMISSION_DENIED = '⚠️ `/permission` 仅限白名单用户：需要把你加入 `access.c2cAllow`';

/**
 * `/permission` 专用鉴权：不看 c2cMode，一律要求发送者在 c2cAllow 里。
 *
 * 这是唯一能把沙箱关掉的指令（`auto` 与 `danger-full-access` 都不启用沙箱）。
 * `c2cMode=open` 下沿用 commandAllowlistAuth 的放行语义，等于把「关沙箱」开放给
 * 任意私聊用户；空名单 / 身份缺失同样 fail-closed。
 */
export function permissionCommandAuth(
  config: CommandAuthConfigLike,
  logger?: Logger,
): (ctx: SlashCommandHandlerContext) => boolean | string {
  return (ctx) => {
    const senderId = ctx.message.senderId;
    // 配置缺字段（老 profile / 手写 patch）时按空名单处理，绝不能在这里抛
    const allow = Array.isArray(config.access?.c2cAllow) ? config.access.c2cAllow : [];
    if (senderId && allow.includes(senderId)) return true;
    logger?.warn(`im-qqbot: /permission denied: sender=${senderId ?? '(missing)'}`);
    return PERMISSION_DENIED;
  };
}
