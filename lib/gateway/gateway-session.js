/**
 * 网关会话票据落盘：热重载 / 重启后新实例可以 RESUME，而不是重新 IDENTIFY。
 *
 * QQ 的 WebSocket 网关按 `session_id` + `seq` 续传：断线期间的事件在 RESUME
 * 之后补发。SDK 默认只在内存里存这份票据，插件 fiber 一被替换就没了——
 * `/bot-reload` 那几秒里用户发的消息因此永远送不到（平台不会对已断开的连接重投），
 * 表现就是「重载后第一条消息没回，再发一条才通」。
 *
 * 落盘之后新实例先 RESUME，补发的事件才有机会被正常处理（超过 TTL 则退化成
 * 全新 IDENTIFY，不会把很久以前的消息重放一遍）。
 *
 * 写入不节流（`saveThrottleMs: 0`）：网关每收到一个事件就落一次 seq，
 * 避免刚处理完的消息因为 seq 还没写盘，在重载后被当成漏收事件重放一遍。
 */
import { join } from 'node:path';
import { FileKVStore, kvSessionPersistence } from '@tencent-connect/qqbot-nodejs';
import { PLUGIN_HOME } from "../shared/index.js";
/**
 * @param appId 机器人 appId，作为 KV key 的一部分，多机器人之间互不覆盖
 * @param dir 票据目录，单测注入临时目录；默认 ~/.dsh-qqterm/gateway
 */
export function createGatewaySession(appId, dir = join(PLUGIN_HOME, 'gateway')) {
    const store = new FileKVStore({
        dir,
        fileName: 'session.json',
        saveThrottleMs: 0,
    });
    return {
        persistence: kvSessionPersistence({ store, accountId: appId }),
        flush: () => store.flush(),
    };
}
//# sourceMappingURL=gateway-session.js.map