/**
 * dsh-qqterm 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
/**
 * `exec.shell` 的平台默认值：Windows 用命令解释器（优先环境里的 ComSpec），其它用 `/bin/sh`。
 *
 * 只写进 Schema 默认值：配置里看得见才改得动，用户清空就是清空，运行期不再补。
 */
export const DEFAULT_SHELL = process.platform === 'win32'
    ? process.env.ComSpec?.trim() || 'C:\\Windows\\System32\\cmd.exe'
    : '/bin/sh';
/**
 * `exec.shellArgs` 的平台默认值：与默认 shell 配套（cmd 认 `/d /s /c`，POSIX shell 认 `-c`）。
 *
 * 同样只写进 Schema 默认值；运行时按配置字面用，空就是空，不按 shell 另推一套。
 */
export const DEFAULT_SHELL_ARGS = process.platform === 'win32' ? ['/d', '/s', '/c'] : ['-c'];
/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema = Schema.object({
    owner: Schema.string().default('').description('唯一允许的用户（QQ OpenID），空=拒绝所有人'),
});
export const ConfigSchema = Schema.object({
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
    panel: Schema.object({
        autoSync: Schema.boolean().default(true).description('机器人就绪后自动同步指令面板'),
    }).description('指令面板配置'),
    menu: Schema.object({
        autoSync: Schema.boolean().default(true).description('机器人就绪后自动同步自定义菜单'),
    }).description('自定义菜单配置'),
    exec: Schema.object({
        shell: Schema.string()
            .default(DEFAULT_SHELL)
            .description('执行 /run 的 shell，默认按平台（Windows: cmd.exe 的实际路径，其它: /bin/sh）；清空就是空，执行前报错'),
        shellArgs: Schema.array(Schema.string())
            .default(DEFAULT_SHELL_ARGS)
            .description('shell 参数模板，{command} 原位替换；默认跟随所选 shell（cmd: /d /s /c，其它: -c），改成别的才按字面用'),
    }).description('本地命令执行配置'),
});
//# sourceMappingURL=config.js.map