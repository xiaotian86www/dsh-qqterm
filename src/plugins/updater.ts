/**
 * 后台检查插件更新
 *
 * 启动后先等一会（登录、扫码都已完成），之后每 6 小时查一次 registry：
 * 对每个「可自动更新」的包问一遍新版本，结果写进 profile 维度的缓存文件。
 *
 * 检查本身不打扰任何人 —— 不发 QQ 消息（主动推送有额度），也不自动安装：
 * `/plugins` 列表从缓存里读，行尾标 `→ 新版本` 并带更新入口，由用户决定何时点。
 */
import type { Context } from '@deepseek-ai/cordis';
import { errorText } from '../shared/index.ts';
import type { Logger } from '../types.ts';
import type { PluginInstaller } from './index.ts';

/** 启动后延迟：先让扫码 / 登录 / 会话恢复跑完，别和启动抢网络 */
export const CHECK_DELAY_MS = 120_000;
/** 检查周期：请求按包计，6 小时足够发现新版本 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 挂上定时检查。用 `ctx.effect` 持有定时器，插件卸载（含被 reconcile 换掉）时自动清掉：
 * 缓存在磁盘上，新 fiber 起来后由下一次检查刷新，不需要跨 fiber 传内存状态。
 */
export function startUpdateCheck(ctx: Context, installer: PluginInstaller, logger: Logger): void {
  (ctx as unknown as { effect(fn: () => (() => void) | void, name?: string): void }).effect(() => {
    const run = (): void => {
      void installer.checkUpdates().catch((err: unknown) => {
        logger.warn(`插件更新检查失败: ${errorText(err)}`);
      });
    };

    const first = setTimeout(run, CHECK_DELAY_MS);
    const every = setInterval(run, CHECK_INTERVAL_MS);
    first.unref?.();
    every.unref?.();

    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, 'qqterm.plugin-updates');
}
