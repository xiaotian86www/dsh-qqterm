/**
 * 插件命令的渲染
 *
 * 列表、即时结果、ready 补发共用同一套文案：同一次操作不管从哪条路送达，
 * 用户看到的都必须是同一句话。
 */
import type { BundleInfoLike, PluginVersionLike } from './types.ts';
import type { PluginOpState } from './state.ts';

/** 一页展示多少条插件 */
const PAGE_SIZE = 10;

/** 失败原因码 → 一句话（能直说的不摆原始 code） */
const ERROR_REASON: Record<string, string> = {
  'already-installed': '已经安装，更新用 /plugins update',
  'unknown-plugin': '找不到这个包',
  'invalid-spec': '包名或版本无效',
  'ambiguous-install': '无法确定安装了哪个包',
  'not-bundle': '这个包不是 dsh 插件',
  'not-removable': '这个插件不能卸载',
  'stop-profile': 'profile 正在被宿主占用',
  'bundle-in-use': '插件仍在使用中',
  'stale-approval': '构建批准已失效，重新安装一次',
  'incompatible-version': '版本与当前 dsh 不兼容',
  'unsupported-platform': '不支持当前平台',
  'operation-error': '安装命令执行失败',
  'pending-builds': '安装脚本未获批准',
  'not-updatable': '本地安装，不能自动更新',
  timeout: '操作超时，没有返回结果',
  cancelled: '已取消',
};

/** 行内展示净化：换行会打散列表，markdown / 属性字符会破坏渲染 */
function cleanInline(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`*_~<>"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 超长文本截断（带省略号） */
function clip(raw: string, max: number): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** XML 属性值转义（`&` 在 QQ 的指令标签里必须先转义） */
function attrValue(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** 可点击命令：QQ 渲染成按钮，点一下把 `command` 填进输入框 */
function commandLink(command: string, show: string): string {
  return `<qqbot-cmd-input text="${attrValue(command)}" show="${attrValue(cleanInline(show) || command)}"/>`;
}

/** 失败原因：能映射的用固定文案，其余保留宿主诊断（截断一行） */
export function errorReason(code: string | undefined, detail?: string): string {
  const mapped = code === undefined ? undefined : ERROR_REASON[code];
  const text = detail?.trim();
  if (code === 'operation-error' || (mapped === undefined && text !== undefined && text !== '')) {
    return clip(text ?? '安装命令执行失败', 120);
  }
  if (mapped !== undefined) return mapped;
  return text === undefined || text === '' ? '操作失败' : clip(text, 120);
}

/**
 * 选一个可升级的版本。
 *
 * 宿主的 `versions` 只列比已安装版本更新的版本，按新到旧排列；优先 `latest`
 * 标签，其次最新正式版，最后才退到预发布。不兼容、已废弃、不带 bundle 的跳过。
 */
export function pickLatestVersion(versions: readonly PluginVersionLike[]): PluginVersionLike | undefined {
  const usable = versions.filter(
    (item) => item.bundle && item.incompatible === undefined && item.deprecated === undefined,
  );
  return usable.find((item) => item.tags.includes('latest'))
    ?? usable.find((item) => !item.prerelease)
    ?? usable[0];
}

/** 已安装的第三方插件（官方 bundle 由宿主自己管，这里不列） */
function thirdParty(bundles: readonly BundleInfoLike[]): BundleInfoLike[] {
  return bundles
    .filter((bundle) => bundle.installed && !bundle.official)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 列表一行：`**名字** · \`版本\``；只在后台查到新版本时给箭头与更新入口，停用的补一句 */
function bundleLine(bundle: BundleInfoLike, latest: Readonly<Record<string, string>>): string {
  const parts = [`**${cleanInline(bundle.name)}**`];
  const version = bundle.version === undefined || bundle.version === '' ? '' : `\`${cleanInline(bundle.version)}\``;
  // 只有「可自动更新 + 后台查到更新的版本」才值得占用行内空间；没有新版本时不给更新链接
  const next = bundle.updatable ? latest[bundle.name] : undefined;
  const hasUpdate = next !== undefined && next !== bundle.version;
  // 版本与箭头是一个整体（`1.0.0 → 1.1.0`），中间不插行内分隔符
  if (hasUpdate && next !== undefined) {
    parts.push(version === '' ? `→ \`${cleanInline(next)}\`` : `${version} → \`${cleanInline(next)}\``);
  } else if (version !== '') {
    parts.push(version);
  }
  if (!bundle.enabled) parts.push('已停用');
  if (hasUpdate) parts.push(commandLink(`/plugins update ${bundle.name}`, '更新'));
  return parts.join(' · ');
}

/** 已安装插件列表（按页切片；页码越界时夹到有效范围） */
export function renderPluginList(
  bundles: readonly BundleInfoLike[],
  page: number,
  latest: Readonly<Record<string, string>> = {},
): string {
  const entries = thirdParty(bundles);
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 1), pages);
  const start = (current - 1) * PAGE_SIZE;
  const shown = entries.slice(start, start + PAGE_SIZE);

  const lines: string[] = [`### 🔌 已安装插件（${entries.length} 个）`, ''];
  for (const bundle of shown) lines.push(bundleLine(bundle, latest));

  lines.push('');
  if (pages > 1) lines.push(pageLinks(current, pages).join(' · '), '');
  lines.push(footerLinks());
  return lines.join('\n');
}

/** 列表页脚：其它子命令都写成同一种可点链接，不单独给某条命令加说明 */
function footerLinks(): string {
  return [
    commandLink('/plugins install', '安装插件'),
    commandLink('/plugins update', '更新插件'),
    commandLink('/plugins reload', '热重载'),
  ].join(' · ');
}

/** 分页导航：多页时给出 上一页 · 第 x/y 页 · 下一页，缺哪边省略哪边 */
function pageLinks(page: number, pages: number): string[] {
  const links: string[] = [];
  if (page > 1) links.push(commandLink(`/plugins ${page - 1}`, '上一页'));
  links.push(`第 ${page}/${pages} 页`);
  if (page < pages) links.push(commandLink(`/plugins ${page + 1}`, '下一页'));
  return links;
}

/** 一次操作的结果文案；还在跑（没有 phase）时返回 undefined */
export function renderPluginResult(state: PluginOpState): string | undefined {
  if (state.phase === undefined) return undefined;
  const label = state.action === 'install' ? '安装' : '更新';

  // 构建脚本被拦下不算失败：给出批准后重试的入口，而不是让用户自己拼参数
  if (state.pendingBuilds !== undefined && state.pendingBuilds.length > 0) {
    const names = state.pendingBuilds.join(' · ');
    const retry = `/plugins install ${state.target} --allow-builds=${state.pendingBuilds.join(',')}`;
    return [`⚠️ 安装被构建脚本拦下: ${names}`, commandLink(retry, '继续安装')].join('\n');
  }

  if (state.phase === 'failed') {
    const reason = errorReason(state.code, state.error);
    if (state.action === 'update' && state.rolledBack === true) {
      return `❌ 更新失败: ${reason}\n已回到 ${state.from ?? '原版本'}`;
    }
    return `❌ ${label}失败: ${reason}`;
  }

  if (state.action === 'install') {
    const version = state.version === undefined || state.version === '' ? '' : `@${cleanInline(state.version)}`;
    const name = cleanInline(state.name ?? state.target);
    if (state.application === 'restart-required') {
      return `✅ 已安装 ${name}${version}\n⚠️ 重启 dsh 后生效`;
    }
    if (state.application === 'overridden') {
      return `⚠️ 已安装 ${name}${version}，profile 里的配置会覆盖它`;
    }
    return `✅ 已安装 ${name}${version}`;
  }

  if (state.upToDate === true) {
    return `✅ 已是最新版本: ${cleanInline(state.target)}@${cleanInline(state.version ?? '—')}`;
  }
  if (state.from !== undefined && state.to !== undefined && state.from !== '' && state.to !== '') {
    return `✅ 已更新 ${cleanInline(state.target)}: ${cleanInline(state.from)} → ${cleanInline(state.to)}`;
  }
  return `✅ 已更新 ${cleanInline(state.target)}`;
}
