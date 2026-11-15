/**
 * 在用例内临时切换 process.platform。
 *
 * 平台分支（presenters / persist / 路径大小写）只读 process.platform，不依赖
 * 实际运行宿主；用例借它在一台机器上覆盖 win32 / darwin / linux，退出时恢复
 * 原描述符，避免污染同文件里的其它用例。
 */
export async function withPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => T | Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (descriptor === undefined) throw new Error('process.platform is not configurable');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}
