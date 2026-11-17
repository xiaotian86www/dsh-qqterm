/**
 * 共享工具层
 */
export {
  getProfileDir,
  resolveProfileDir,
  errorText,
  resolveEnv,
  formatRelativeTime,
  buildUserAgent,
  pluginVersion,
  shortSessionId,
  outsideHmrTransaction,
  optionalService,
} from './utils.ts';
export { entryUids, changedEntries, entryReplaced, type LoaderLike } from './entries.ts';
export { getScopePeer } from './scope.ts';
export { PLUGIN_HOME, resolveAgentCwd } from './dirs.ts';
export { sendMarkdownChunked } from './send-helper.ts';
export {
  createSettledWatch,
  type SettledState,
  type SettledWatch,
  type SettledWatchOptions,
} from './state-watch.ts';
