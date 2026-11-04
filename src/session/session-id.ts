/**
 * 会话 id 铸造。统一带 `session-` 前缀对齐宿主约定（#81）：
 * 社区插件按该前缀识别正常会话，裸 UUID 会被误判为子代理会话。
 */
import { randomUUID } from 'node:crypto';

/** 铸造新会话 id（随机全局唯一，避免多进程并发撞出重复 id） */
export function mintSessionId(): string {
  return `session-${randomUUID()}`;
}
