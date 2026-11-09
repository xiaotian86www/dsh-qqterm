import { errorText } from "../shared/index.js";
/** 启动后延迟：先让扫码 / 登录 / 会话恢复跑完，别和启动抢网络 */
export const CHECK_DELAY_MS = 120_000;
/** 检查周期：请求按包计，6 小时足够发现新版本 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * 挂上定时检查。用 `ctx.effect` 持有定时器，插件卸载（含被 reconcile 换掉）时自动清掉：
 * 缓存在磁盘上，新 fiber 起来后由下一次检查刷新，不需要跨 fiber 传内存状态。
 */
export function startUpdateCheck(ctx, installer, logger) {
    ctx.effect(() => {
        const run = () => {
            void installer.checkUpdates().catch((err) => {
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
//# sourceMappingURL=updater.js.map