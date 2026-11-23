/**
 * 命令依赖类型
 *
 * 每个命令工厂函数接收 CommandDeps，由 commands/index.ts 统一注入。
 */
import type { QQBot, SlashCommand as SdkSlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import type { QQTermConfig } from '../config.ts';
import type { Reloader } from '../reload/index.ts';
import type { PluginInstaller } from '../plugins/index.ts';
import type { Logger } from '../types.ts';

export interface CommandDeps {
  manager: SessionManager;
  config: QQTermConfig;
  logger?: Logger;
  /** QQBot 实例：指令面板这类要直连 OpenAPI 的命令用，单测可缺省 */
  bot?: QQBot;
  /** 热重载能力：profile 未启用 HMR 时 available=false，单测可缺省 */
  reloader?: Reloader;
  /** 插件安装能力：宿主没有 pluginManager 时缺省，单测可注入假实现 */
  installer?: PluginInstaller;
}

/** 斜杠命令（SDK 类型 + 插件登记字段，统一从本模块转出，命令文件不用直接依赖宿主包） */
export type SlashCommand = SdkSlashCommand & {
  /**
   * 这条命令会把随消息一起来的引用并进 prompt（见 commands/quote.ts）。
   * 只有需要引用内容的命令才标：其它命令无视引用，不做「取不到」判断。
   */
  acceptsQuote?: boolean;
};
