/**
 * dsh-qqterm 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** 唯一允许使用机器人的 QQ 用户 OpenID；空字符串 = 拒绝所有人 */
  owner: string;
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
}

/** 附件投递配置（present 交付物发送；入站下载见 media） */
export interface SendFileConfig {
  /** 是否把 present 声明的交付文件在轮末发送到当前会话 */
  sendPresentedFiles: boolean;
  /** 单轮最多投递的交付文件数 */
  maxFiles: number;
}

/**
 * 指令面板默认展示的常用命令（主名，不含斜杠）。
 *
 * 面板最多 20 项，这里正好填满；steer / unqueue 属于进阶操作，留给用户按需勾选。
 */
export const DEFAULT_PANEL_COMMANDS = [
  'new', 'sessions', 'status', 'model', 'reasoning', 'compact', 'clear', 'stop', 'to',
  'goal', 'rename', 'ls', 'get', 'run', 'cost', 'preset', 'permission', 'retry', 'plugins', 'help',
] as const;

/** 指令面板配置 */
export interface PanelConfig {
  /** 是否展示指令面板（关闭后移除本插件创建的面板） */
  enabled: boolean;
  /** 展示在指令面板的命令主名；[] = 一条都不展示（面板最多 20 项） */
  commands: string[];
}

/** 自定义菜单配置 */
export interface MenuConfig {
  /** 机器人就绪后是否自动把固定入口同步到单聊自定义菜单 */
  autoSync: boolean;
}

/** 轮次失败后的重发询问配置 */
export interface RetryOfferConfig {
  /** 是否用「重发 / 放弃」卡片代替纯文本失败告知 */
  enabled: boolean;
  /** 卡片有效期(ms)，超时后按钮失效；0 = 永不过期 */
  timeoutMs: number;
}

/**
 * `exec.shell` 的平台默认值：Windows 用命令解释器（优先环境里的 ComSpec），其它用 `/bin/sh`。
 *
 * 只写进 Schema 默认值：配置里看得见才改得动，用户清空就是清空，运行期不再补。
 */
export const DEFAULT_SHELL: string =
  process.platform === 'win32'
    ? process.env.ComSpec?.trim() || 'C:\\Windows\\System32\\cmd.exe'
    : '/bin/sh';

/**
 * `exec.shellArgs` 的平台默认值：与默认 shell 配套，用来执行一条命令字符串。
 *
 * Windows 的 cmd 用 `/d /s /c`；POSIX shell 用 `-c` 收一条脚本字符串。两者都只吃
 * 一条命令，插件不拆解命令内容。
 *
 * 同样只写进 Schema 默认值；运行时按配置字面用，空就是空，不按 shell 另推一套。
 */
export const DEFAULT_SHELL_ARGS: string[] =
  process.platform === 'win32' ? ['/d', '/s', '/c'] : ['-c'];

/** 本地命令执行配置：`/run` 用的 shell（根目录固定为宿主进程当前目录，不配置） */
export interface ExecConfig {
  /** 执行 `/run` 用的 shell；默认按平台写进配置（Windows 的 cmd.exe，其它 /bin/sh），空 = 空（执行前报错） */
  shell: string;
  /**
   * 传给 shell 的参数模板，`{command}` 原位展开成整条命令。
   *
   * 默认值按平台写进配置（cmd 是 `/d /s /c`，其它是 `-c`），运行时按字面用：换
   * shell 或清空都不再另算，要改就改这里。
   */
  shellArgs: string[];
}

export interface QQTermConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 轮次失败后的重发询问 */
  retryOffer: RetryOfferConfig;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用结果（成功与失败都受此开关控制） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 附件投递（present 交付物发送；入站下载见 media） */
  sendFile: SendFileConfig;
  /** 指令面板（把当前指令写进 QQ 指令面板） */
  panel: PanelConfig;
  /** 自定义菜单（单聊窗口底部的固定按钮） */
  menu: MenuConfig;
  /** 本地命令执行（`/run` 的 shell；根目录固定为宿主进程当前目录） */
  exec: ExecConfig;
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  owner: Schema.string().default('').description('唯一允许的用户（QQ OpenID），空=拒绝所有人'),
});

/** 指令面板子 Schema（独立导出：config 路由的服务端校验与设置页共用） */
export const PanelConfigSchema: Schema<PanelConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否展示指令面板，关闭后移除本插件创建的面板'),
  commands: Schema.array(Schema.string()).default([...DEFAULT_PANEL_COMMANDS]).description('展示在指令面板的命令名（不带斜杠）；默认预置常用命令，显式空数组=不展示，总开关关闭或没有选任何命令时移除本插件创建的面板'),
}).description('指令面板配置');

export const ConfigSchema: Schema<QQTermConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示，0=不超时'),
  retryOffer: Schema.object({
    enabled: Schema.boolean().default(true).description('轮次失败后是否用「重发 / 放弃」卡片询问'),
    timeoutMs: Schema.number().default(10 * 60 * 1000).description('重发卡片有效期(ms)，超时后按钮失效，0=永不过期'),
  }).description('失败重发询问配置'),
  access: AccessControlSchema.description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用结果（成功与失败都受此开关控制）'),
  debug: Schema.boolean().default(false),
  media: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
    maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
    ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
  }).description('富媒体理解配置'),
  sendFile: Schema.object({
    sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
    maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数（小于 1 按 1 处理）'),
  }).description('附件投递配置'),
  panel: PanelConfigSchema,
  menu: Schema.object({
    autoSync: Schema.boolean().default(true).description('机器人就绪后自动同步自定义菜单'),
  }).description('自定义菜单配置'),
  exec: Schema.object({
    shell: Schema.string()
      .default(DEFAULT_SHELL)
      .description('执行 /run 的 shell，默认按平台（Windows: cmd.exe 的实际路径，其它: /bin/sh）；清空就是空，执行前报错'),
    shellArgs: Schema.array(Schema.string())
      .default(DEFAULT_SHELL_ARGS)
      .description('shell 参数模板，{command} 原位展开成整条命令；默认按平台（cmd: /d /s /c，其它: -c），改成别的才按字面用'),
  }).description('本地命令执行配置'),
});
