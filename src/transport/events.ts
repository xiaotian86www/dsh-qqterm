/**
 * 出站事件解析 — 将 dsh session/event 归一化为强类型
 *
 * 原始事件（ctx.on('session/event') 回调参数）是弱类型：
 *   { type: string, data: Record<string, unknown> }
 * 这里把可识别的事件解析为 discriminated union，未知类型或字段缺失返回 undefined。
 */

/** 原始 dsh 事件（弱类型，来自 ctx.on('session/event')） */
export interface RawSessionEvent {
  type: string;
  data: Record<string, unknown>;
}

/** turn/end 事件的 reason 结构（兼容 error/failure/顶层 message 三种形态） */
export interface TurnEndReason {
  kind?: string;
  error?: { message?: string; code?: string };
  failure?: { message?: string; code?: string };
  message?: string;
  code?: string;
}

/** assistant/chunk 事件（仅保留 text-delta） */
export interface ChunkEvent {
  type: 'assistant/chunk';
  text: string;
}

/** assistant/message 事件 */
export interface MessageEvent {
  type: 'assistant/message';
  content: Array<{ type: string; text?: string }>;
}

/** tool/call 事件 */
export interface ToolCallEvent {
  type: 'tool/call';
  callId: string;
  name: string;
  arguments: string;
}

/** tool/result 事件 */
export interface ToolResultEvent {
  type: 'tool/result';
  callId: string;
  error?: { name: string; code: string };
  /** 原始 data 透传给 presenter 做结构化展示 */
  raw: Record<string, unknown>;
}

/** turn/end 事件 */
export interface TurnEndEvent {
  type: 'turn/end';
  reason: TurnEndReason;
}

/**
 * llm/retry 事件（宿主重试执行器在退避前发布的 session 事件）。
 *
 * 只是计数用途：失败告知里要写「重试了几次」，次数由宿主实际行为决定，
 * 不能按配置里的配额猜。
 */
export interface RetryEvent {
  type: 'llm/retry';
  /** 本轮第几次重试（从 1 开始） */
  retry: number;
  /** normal 模式下的配额；always 模式没有 */
  maxRetries?: number;
  provider: string;
  /** 本次退避时长(ms)，即多久后发起这次重试 */
  delayMs?: number;
  /** 触发重试的上游错误（原样保留，供用户观察具体原因） */
  failure?: { code: string; message: string };
}

/** present 工具声明的一个交付文件 */
export interface PresentedFileRef {
  /** 绝对路径，或相对 Session 工作目录的路径（仅历史声明） */
  path: string;
  /** 模型提供的可选说明 */
  description?: string;
}

/** deliverables/presented 事件（present 声明的交付文件，含嵌套调用） */
export interface DeliverablesPresentedEvent {
  type: 'deliverables/presented';
  turn: number;
  callId: string;
  files: PresentedFileRef[];
}

/** 出站事件联合类型 */
export type OutboundEvent =
  | ChunkEvent
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | TurnEndEvent
  | RetryEvent
  | DeliverablesPresentedEvent;

/** llm/retry 的 failure 是宿主的错误对象，只取 code / message 并保持原文 */
function parseRetryFailure(raw: unknown): { code: string; message: string } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { code, message } = raw as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' && typeof message !== 'string') return undefined;
  return {
    code: typeof code === 'string' ? code : 'UNKNOWN',
    message: typeof message === 'string' ? message : '',
  };
}

/**
 * 解析原始事件为强类型
 *
 * 未知类型或缺失关键字段时返回 undefined，由调用方直接跳过。
 */
export function parseEvent(raw: RawSessionEvent): OutboundEvent | undefined {
  switch (raw.type) {
    case 'assistant/chunk': {
      const chunk = (raw.data as { chunk?: { type?: string; text?: string } }).chunk;
      if (chunk === undefined || chunk.type !== 'text-delta' || !chunk.text) return undefined;
      return { type: 'assistant/chunk', text: chunk.text };
    }

    case 'assistant/message': {
      const message = (raw.data as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
      if (message === undefined || !Array.isArray(message.content)) return undefined;
      return { type: 'assistant/message', content: message.content };
    }

    case 'tool/call': {
      const data = raw.data as { callId?: string; name?: string; arguments?: string };
      if (!data.callId || !data.name) return undefined;
      return { type: 'tool/call', callId: data.callId, name: data.name, arguments: data.arguments ?? '' };
    }

    case 'tool/result': {
      const data = raw.data as { message?: { source?: { callId?: string } }; error?: { name: string; code: string } };
      const callId = data.message?.source?.callId;
      if (!callId) return undefined;
      return { type: 'tool/result', callId, error: data.error, raw: raw.data };
    }

    case 'turn/end': {
      const reason = (raw.data as { reason?: TurnEndReason }).reason ?? {};
      return { type: 'turn/end', reason };
    }

    case 'llm/retry': {
      const data = raw.data as {
        retry?: unknown;
        maxRetries?: unknown;
        provider?: unknown;
        delayMs?: unknown;
        failure?: unknown;
      };
      if (typeof data.retry !== 'number' || data.retry <= 0) return undefined;
      const failure = parseRetryFailure(data.failure);
      return {
        type: 'llm/retry',
        retry: data.retry,
        ...(typeof data.maxRetries === 'number' ? { maxRetries: data.maxRetries } : {}),
        provider: typeof data.provider === 'string' ? data.provider : '',
        ...(typeof data.delayMs === 'number' ? { delayMs: data.delayMs } : {}),
        ...(failure !== undefined ? { failure } : {}),
      };
    }

    case 'deliverables/presented': {
      const data = raw.data as { turn?: unknown; callId?: unknown; files?: unknown };
      if (typeof data.turn !== 'number' || typeof data.callId !== 'string' || !data.callId) return undefined;
      if (!Array.isArray(data.files) || data.files.length === 0) return undefined;
      const files: PresentedFileRef[] = [];
      for (const file of data.files) {
        if (file === null || typeof file !== 'object' || Array.isArray(file)) return undefined;
        const { path, description } = file as { path?: unknown; description?: unknown };
        if (typeof path !== 'string' || !path) return undefined;
        if (description !== undefined && typeof description !== 'string') return undefined;
        files.push(description === undefined ? { path } : { path, description });
      }
      return { type: 'deliverables/presented', turn: data.turn, callId: data.callId, files };
    }

    default:
      return undefined;
  }
}

/**
 * 从 turn/end reason 提取错误信息
 *
 * 兼容三种形态：error（新格式）、failure（旧格式）、顶层 message/code（最旧格式）。
 */
export function extractTurnError(reason: TurnEndReason): { code: string; message: string } | undefined {
  if (reason.kind !== 'error') return undefined;

  const detail = reason.error ?? reason.failure;
  return {
    code: detail?.code ?? reason.code ?? 'UNKNOWN',
    message: detail?.message ?? reason.message ?? 'unknown error',
  };
}

// ── agent/assistant-stream 实时流式帧（宿主 v2+） ──

/**
 * 归一化后的流式增量（`agent/assistant-stream` 瞬态帧，chunk 不进 session log）。
 */
export type StreamDelta =
  | { kind: 'attempt-start'; attemptId: string }
  | { kind: 'text-delta'; attemptId: string; text: string };

/**
 * 解析 `agent/assistant-stream` 的 payload（对齐 @deepseek-ai/dsh-agent 的
 * AssistantStreamFrame 最小契约，避免硬依赖）。
 *
 * 只归一化两类帧：start（新 attempt）与 chunk 的 text-delta（文本增量）。
 * reasoning-delta / tool-call-delta 不进用户消息；end 帧不处理——收尾由 durable
 * `assistant/message` / `turn/end` 事件负责。未知形态返回 undefined。
 */
export function parseStreamFrame(raw: unknown): { agentId: string; delta: StreamDelta } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const agentId = (raw as { agent?: { id?: unknown } }).agent?.id;
  if (typeof agentId !== 'string' || !agentId) return undefined;

  const frame = (raw as { frame?: unknown }).frame;
  if (frame === null || typeof frame !== 'object') return undefined;
  const { type, attemptId } = frame as { type?: unknown; attemptId?: unknown };
  if (typeof attemptId !== 'string' || !attemptId) return undefined;

  if (type === 'start') {
    return { agentId, delta: { kind: 'attempt-start', attemptId } };
  }
  if (type === 'chunk') {
    const chunk = (frame as { chunk?: { type?: unknown; text?: unknown } | null }).chunk;
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || !chunk.text) return undefined;
    return { agentId, delta: { kind: 'text-delta', attemptId, text: chunk.text } };
  }
  return undefined;
}
