/**
 * dsh-qqterm 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema = Schema.object({
    owner: Schema.string().default('').description('唯一允许的用户（QQ OpenID），空=拒绝所有人'),
});
export const ConfigSchema = Schema.object({
    appId: Schema.string().default('').description('QQ 机器人 AppID'),
    appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
    textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
    streaming: Schema.boolean().default(true).description('是否启用流式输出'),
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
});
//# sourceMappingURL=config.js.map