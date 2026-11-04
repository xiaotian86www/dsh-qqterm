/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

/** 附件发送配置（qqbot_send_file 工具与 present 交付物投递共用） */
export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
  /** 是否把 present 声明的交付文件在轮末发送到当前会话 */
  sendPresentedFiles: boolean;
  /** 单轮最多投递的交付文件数 */
  maxFiles: number;
}

/** 指令面板配置 */
export interface PanelConfig {
  /** 机器人就绪后是否自动把当前指令同步到 QQ 指令面板 */
  autoSync: boolean;
}

/** 自定义菜单配置 */
export interface MenuConfig {
  /** 机器人就绪后是否自动把固定按钮同步到单聊自定义菜单 */
  autoSync: boolean;
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出 */
  streaming: boolean;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 附件发送（qqbot_send_file 工具与交付物投递共用） */
  sendFile: SendFileConfig;
  /** 指令面板（把当前指令写进 QQ 指令面板） */
  panel: PanelConfig;
  /** 自定义菜单（单聊窗口底部的固定按钮） */
  menu: MenuConfig;
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式（默认开放）'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单（QQ OpenID）'),
});

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streaming: Schema.boolean().default(true).description('是否启用流式输出'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
  access: AccessControlSchema.default({
    c2cMode: 'open',
    c2cAllow: [],
  }).description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
  debug: Schema.boolean().default(false),
  media: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
    maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
    ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
  }).default({
    enabled: true,
    maxMB: 200,
    ttlHours: 24,
  }).description('富媒体理解配置'),
  vision: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
    provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
    model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
    defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
    maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
    maxTokens: Schema.number().default(1024).description('输出 token 上限'),
    timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
  }).default({
    enabled: false,
    provider: '',
    model: '',
    defaultPrompt: 'Describe this image in detail.',
    maxBytes: 10 * 1024 * 1024,
    maxTokens: 1024,
    timeoutMs: 120000,
  }).description('视觉理解配置'),
  sendFile: Schema.object({
    restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
    extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
    sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
    maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数'),
  }).default({
    restrictPaths: true,
    extraRoots: [],
    sendPresentedFiles: true,
    maxFiles: 4,
  }).description('附件发送配置'),
  panel: Schema.object({
    autoSync: Schema.boolean().default(true).description('机器人就绪后自动同步指令面板'),
  }).default({
    autoSync: true,
  }).description('指令面板配置'),
  menu: Schema.object({
    autoSync: Schema.boolean().default(true).description('机器人就绪后自动同步自定义菜单'),
  }).default({
    autoSync: true,
  }).description('自定义菜单配置'),
});
