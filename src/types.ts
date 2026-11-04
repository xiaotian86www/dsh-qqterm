/**
 * dsh-im-qqbot 插件内部类型定义
 */

/** 会话作用域 */
export type ChatScope = 'c2c' | 'group';

/** QQ 回复目标 */
export interface ReplyTarget {
  scope: ChatScope;
  targetId: string;
  msgId?: string;
  /** 互动事件 id（带 INTERACTION_CREATE 前缀），填 event_id 字段，与 msgId 互斥 */
  eventId?: string;
}

/** SDK 原始消息附件（snake_case 字段，来自 QQ 网关 C2C_MESSAGE_CREATE） */
export interface RawAttachment {
  content_type: string;
  filename: string;
  size: number;
  url: string;
  asr_refer_text?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

/** 引用消息附件（quoteRef 中间件解析的 camelCase 视图） */
export interface QuotedAttachment {
  contentType?: string;
  url?: string;
  filename?: string;
  asrText?: string;
}

/** 插件 Logger 接口 */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/**
 * OpenAPI 最小接口（指令面板 / 自定义菜单这类直连 REST 的功能用）
 *
 * QQBot 实例的 `bot.api` 结构上满足它；单测直接注入假实现。
 */
export interface OpenApiLike {
  get<T = unknown>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
}
