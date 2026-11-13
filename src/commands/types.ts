/**
 * 命令依赖类型
 *
 * 每个命令工厂函数接收 CommandDeps，由 commands/index.ts 统一注入。
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
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

/** 斜杠命令（SDK 类型，统一从本模块转出，命令文件不用直接依赖宿主包） */
export type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
