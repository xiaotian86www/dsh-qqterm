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

/** turn/end 事件的 reason 结构 */
export interface TurnEndReason {
  kind?: string;
  error?: { message?: string; code?: string };
}

/**
 * assistant/message 的内容块（只保留出站用得到的字段）
 *
 * 宿主 ContentBlock 是 merge-extensible 联合，这里不穷举类型：未知块原样
 * 忽略；image 块带宿主 attachment 服务的图片引用，由出站转发到 QQ。
 */
export interface MessageContentBlock {
  type: string;
  text?: string;
  /** image 块：只读到发送所需的引用字段，其余字段不使用 */
  attachment?: {
    attachmentId?: unknown;
    mediaType?: unknown;
    width?: unknown;
    height?: unknown;
    name?: unknown;
  };
  /** 已被宿主离线化（请求超预算），此时不再作为图片发送 */
  offloaded?: boolean;
}

/** assistant/message 事件 */
export interface MessageEvent {
  type: 'assistant/message';
  content: MessageContentBlock[];
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
  /** 文件绝对路径 */
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
    case 'assistant/message': {
      const message = (raw.data as { message?: { content?: MessageContentBlock[] } }).message;
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

/** 从 turn/end reason 提取错误信息 */
export function extractTurnError(reason: TurnEndReason): { code: string; message: string } | undefined {
  if (reason.kind !== 'error') return undefined;
  return {
    code: reason.error?.code ?? 'UNKNOWN',
    message: reason.error?.message ?? 'unknown error',
  };
}
