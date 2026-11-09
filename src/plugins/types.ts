/**
 * 宿主插件管理服务的最小接口
 *
 * `@deepseek-ai/dsh-plugin-manager` 不在本仓库的依赖里（宿主提供），这里只声明
 * 命令真正用到的形状，避免为了几个类型新增 peerDependency。字段含义见宿主
 * 的 `lib/types/types.d.ts`。
 */

/** 操作失败原因（宿主的 ManagementError.code） */
export type PluginErrorCode =
  | 'unknown-plugin'
  | 'invalid-spec'
  | 'already-installed'
  | 'ambiguous-install'
  | 'not-bundle'
  | 'not-removable'
  | 'stop-profile'
  | 'bundle-in-use'
  | 'stale-approval'
  | 'incompatible-version'
  | 'unsupported-platform'
  | 'operation-error'
  | 'unknown';

export interface ManagementErrorLike {
  code: PluginErrorCode | string;
  /** 宿主给的排障信息（pnpm 输出 / 版本冲突等），可能很长 */
  diagnostic?: string;
}

/** 安装结果：`application` 说明这次变更是否已在当前进程生效 */
export interface ChangeResultLike {
  changed: boolean;
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled';
  restartReason?: string;
  stage?: 'install' | 'enable' | 'remove';
  target: string;
  error?: ManagementErrorLike;
  /** 安装后被构建脚本策略拦下的包名，需用户显式批准 */
  pendingBuilds?: string[];
  /** 装上的版本（manifest 声明时才有） */
  version?: string;
  bundle?: string;
}

/** `listBundles()` 的一行：只取命令要用到的字段 */
export interface BundleInfoLike {
  name: string;
  official: boolean;
  version?: string;
  installed: boolean;
  enabled: boolean;
  updatable: boolean;
  removable: boolean;
  source?: string;
  description?: string;
  installTarget?: { spec: string; version: string };
}

/** registry 上的一个版本 */
export interface PluginVersionLike {
  version: string;
  tags: readonly string[];
  prerelease: boolean;
  deprecated?: string;
  bundle: boolean;
  incompatible?: unknown;
}

/** `listVersions()`：只列比已安装版本更新的版本 */
export type PluginVersionListLike =
  | { status: 'listed'; installed: string; versions: readonly PluginVersionLike[] }
  | { status: 'refused'; problem: 'not-updatable' | 'not-found' | 'network' | 'unknown'; reason: string };

export interface PluginUpdateResultLike {
  from: string;
  to: string;
  step: 'check' | 'remove' | 'install';
  result: ChangeResultLike;
  /** 装新版本失败后自动装回旧版本的结果 */
  restore?: ChangeResultLike;
}

export interface InstallOptionsLike {
  approvedBuilds?: string[];
}

/** 宿主 `pluginManager` 服务 */
export interface PluginManagerLike {
  listBundles(): Promise<BundleInfoLike[]>;
  installBundle(spec: string, options?: InstallOptionsLike): Promise<ChangeResultLike>;
  updateBundle(name: string, version: string): Promise<PluginUpdateResultLike>;
  listVersions(name: string): Promise<PluginVersionListLike>;
}
