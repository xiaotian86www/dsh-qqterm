/**
 * 命令依赖类型
 *
 * 每个命令工厂函数接收 CommandDeps，由 commands/index.ts 统一注入。
 */
import type { QQBot, SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Reloader } from '../reload/index.ts';
import type { Logger } from '../types.ts';

export interface CommandDeps {
  manager: SessionManager;
  config: ImQQBotConfig;
  logger?: Logger;
  /** QQBot 实例：指令面板这类要直连 OpenAPI 的命令用，单测可缺省 */
  bot?: QQBot;
  /** 热重载能力：profile 未启用 HMR 时 available=false，单测可缺省 */
  reloader?: Reloader;
}

/** 命令分类：agent = 底层 agent 通用能力，qqbot = 插件特有 */
export type CommandCategory = 'agent' | 'qqbot';

/** 带分类的斜杠命令（category 供 help 分组展示，SDK 忽略未知字段） */
export interface CategorizedCommand extends SlashCommand {
  category: CommandCategory;
  /** 指令面板里的一句话说明（缺省用 description；面板只放一行，超长会截断） */
  panelDesc?: string;
}
