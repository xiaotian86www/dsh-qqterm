/**
 * 进程内宿主替身 —— 真实 cordis Context + 假服务（与 DSH 生态其它插件的 tests/fixtures 同形态）。
 *
 * 只实现 qqterm 运行期真正读到的服务：sessionPersistence / sessionQuery / sessionTitle /
 * workingDirectory / llm / sessionProjections / agentDefaultModel，以及 agent registry。
 * 不读真实 ~/.dsh、不发网络请求。端到端用例在这里跑真实的 SessionManager、出站路由与分片，
 * 只有 QQ 网关与模型是假的（真网关 / 真模型不能自动化，见 AGENTS §5）。
 */
import { Context } from '@deepseek-ai/cordis';
import { vi } from 'vitest';
import { ConfigSchema, type QQTermConfig } from '../../src/config.ts';
import type { Logger } from '../../src/types.ts';
import type {
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  SessionEventLike,
} from '../../src/session/types.ts';

/** 端到端用例里唯一的 QQ 用户（白名单 owner） */
export const OWNER = 'owner-openid';
/** 用例里的 AppID（会话 key 的一部分） */
export const APP_ID = 'app-e2e';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/** 收集全部日志的 Logger：断言「失败被记下来」时用 */
export interface CapturingLogger extends Logger {
  readonly lines: ReadonlyArray<{ level: LogLevel; message: string }>;
  /** 某个级别里是否有包含该片段的记录 */
  has(level: LogLevel, fragment: string): boolean;
}

export function capturingLogger(): CapturingLogger {
  const lines: Array<{ level: LogLevel; message: string }> = [];
  const record = (level: LogLevel) => (message: string): void => {
    lines.push({ level, message });
  };
  return {
    lines,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    has(level, fragment) {
      return lines.some(line => line.level === level && line.message.includes(fragment));
    },
  };
}

/** 宿主 agent 替身：日记（snapshotEvents）与会话事件同源，followup 只记录不执行 */
export interface FakeAgent extends DshAgent {
  /** 会话事件日志（宿主 snapshotEvents 的返回物） */
  readonly events: SessionEventLike[];
  /** 所有 followup 消息（agent 实际收到的用户消息） */
  readonly followups: unknown[];
  /** 往日志里追加一条事件（不派发；派发用 HostFixture.sessionEvent） */
  pushEvent(event: SessionEventLike): void;
}

export function fakeAgent(id: string, cwd?: string): FakeAgent {
  const events: SessionEventLike[] = [];
  const followups: unknown[] = [];
  const agent = {
    id,
    ctx: {} as Context,
    status: 'idle' as const,
    session: {
      id,
      header: { id, createdAt: Date.now(), ...(cwd === undefined ? {} : { cwd }) },
      snapshotEvents: () => events,
    },
    cancel: vi.fn(),
    followup: vi.fn((message: unknown) => {
      followups.push(message);
    }),
    whenIdle: vi.fn(async () => {}),
    model: { select: vi.fn() },
    events,
    followups,
    pushEvent(event: SessionEventLike): void {
      events.push(event);
    },
  };
  return agent as unknown as FakeAgent;
}

/** 宿主 agents 服务替身：create 造新 agent，resume 只认已注册（冷会话一律 not-found） */
export interface FakeAgents extends DshAgentRegistry {
  /** 进程内活着的 agent（sessionId → agent） */
  readonly live: Map<string, DshAgent>;
  /** create 造出来的 agent（按创建顺序） */
  readonly created: FakeAgent[];
  /** 直接注册一个 live agent（模拟 Web 端已经开着的会话） */
  add(agent: FakeAgent): void;
}

export function fakeAgents(): FakeAgents {
  const live = new Map<string, DshAgent>();
  const created: FakeAgent[] = [];
  const handleOf = (agent: FakeAgent): DshAgentHandle => ({
    agent,
    dispose: async () => {
      live.delete(agent.id);
    },
  });

  const agents = {
    live,
    created,
    add(agent: FakeAgent): void {
      live.set(agent.id, agent);
    },
    get: (sessionId: string): DshAgent | undefined => live.get(sessionId),
    resume: async ({ resumeSessionId }: { resumeSessionId: string }): Promise<DshAgentHandle> => {
      const agent = live.get(resumeSessionId);
      if (agent === undefined) {
        // 与宿主 persistence 同语义：会话不在盘上（只有这种失败允许首次创建）
        throw Object.assign(new Error(`session "${resumeSessionId}" not found`), {
          name: 'SessionPersistenceNotFoundError',
        });
      }
      return handleOf(agent as FakeAgent);
    },
    create: async (options: { sessionId: string; meta?: { cwd?: string } }): Promise<DshAgentHandle> => {
      const agent = fakeAgent(options.sessionId, options.meta?.cwd);
      created.push(agent);
      live.set(options.sessionId, agent);
      return handleOf(agent);
    },
  };

  return agents as unknown as FakeAgents;
}

export interface HostFixtureOptions {
  /** 插件数据目录（临时目录）；spec 里用 vi.mock 把 dirs.ts 指到这里 */
  home: string;
  /** 聊天默认工作区，缺省 `<home>/workspace` */
  workspace?: string;
  /** 覆盖配置项（默认 appId / owner 已填好） */
  config?: Partial<QQTermConfig>;
}

export interface HostFixture {
  ctx: Context;
  config: QQTermConfig;
  logger: CapturingLogger;
  agents: FakeAgents;
  workspace: string;
  /**
   * 派发一条 session/event。
   *
   * 与真实宿主一致：事件按 agent 作用域 emit，插件用 `{ global: true }` 监听才能收到
   * 所有已获取会话的事件。事件同时进 agent 的事件日志（snapshotEvents）。
   */
  sessionEvent(agent: FakeAgent, event: SessionEventLike): void;
  /** 释放 Context（用例结束） */
  dispose(): void;
}

export function createHostFixture(options: HostFixtureOptions): HostFixture {
  const workspace = options.workspace ?? `${options.home}/workspace`;
  const config: QQTermConfig = ConfigSchema({
    appId: APP_ID,
    access: { owner: OWNER },
    ...options.config,
  });

  const ctx = new Context();
  const logger = capturingLogger();
  const agents = fakeAgents();

  // 宿主服务（inject 清单里插件会读到的部分）：形状对齐真实宿主契约，多给字段无害。
  const services: Record<string, unknown> = {
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    },
    sessionProjections: { stateOf: () => undefined },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      saveSelection: async () => {},
    },
    // 磁盘上没有会话：resume 失败后开放首次创建
    sessionPersistence: { stat: async () => undefined },
    sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
    sessionTitle: { rename: () => ({}) },
    workingDirectory: { defaultDirectory: workspace, get: () => workspace },
    commands: { find: () => undefined, execute: async () => undefined },
    permissionPresets: { names: [], optionOf: () => undefined },
  };
  const reflect = (ctx as unknown as { reflect: { provide(name: string, service: unknown): void } }).reflect;
  for (const [name, service] of Object.entries(services)) reflect.provide(name, service);

  const bus = ctx as unknown as {
    emit(name: string, ...args: unknown[]): void;
  };

  return {
    ctx,
    config,
    logger,
    agents,
    workspace,
    sessionEvent(agent: FakeAgent, event: SessionEventLike): void {
      agent.pushEvent(event);
      bus.emit('session/event', agent.session, event);
    },
    dispose(): void {
      const disposable = ctx as unknown as { [Symbol.dispose]?: () => void };
      disposable[Symbol.dispose]?.();
    },
  };
}
