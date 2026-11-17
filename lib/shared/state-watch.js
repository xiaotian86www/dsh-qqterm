import { errorText } from "./utils.js";
export function createSettledWatch(options) {
    const { pollMs, staleMs, read, write, expire, logger } = options;
    let watching = false;
    return (startedAt, deliver) => {
        if (watching)
            return;
        watching = true;
        const deadline = Date.now() + staleMs;
        const tick = async () => {
            try {
                const latest = read();
                // 又发起了一轮新操作：让位，等那一轮自己的 ready
                if (latest === undefined || latest.startedAt !== startedAt) {
                    watching = false;
                    return;
                }
                if (latest.phase !== undefined) {
                    watching = false;
                    await deliver(latest);
                    return;
                }
                if (Date.now() >= deadline) {
                    const expired = expire(latest);
                    write(expired);
                    watching = false;
                    await deliver(expired);
                    return;
                }
                setTimeout(() => void tick(), pollMs).unref?.();
            }
            catch (err) {
                watching = false;
                logger.warn(`状态文件轮询失败: ${errorText(err)}`);
            }
        };
        setTimeout(() => void tick(), pollMs).unref?.();
    };
}
//# sourceMappingURL=state-watch.js.map