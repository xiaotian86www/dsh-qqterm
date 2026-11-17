import { buttonLabel, decodeButtonData, encodeButtonData } from "./button-utils.js";
/** 确认卡有效期：过期的按钮点了没有任何反应 */
const CONFIRM_TTL_MS = 5 * 60_000;
/**
 * 卡片正文：与审批 / 问答卡片同一骨架——加粗标题（是什么）+ 空行 +
 * 一句正文（会发生什么）+ 空行 + 引用块（怎么操作）。
 *
 * 标题不用 markdown 标题：QQ 端 `###` 会放大字号，整条消息更像模型正文。
 * 三种动作各给一句后果，`/new` 与 `/clear` 的差别正在这里：前者旧会话
 * 继续跑，后者会把它停掉。
 */
function confirmText(action) {
    const [title, body] = action === 'new'
        ? ['**⚠️ 确认新建会话**', '当前会话继续运行，下一条消息开新会话。']
        : action === 'reset-all'
            ? ['**⚠️ 确认重置全部会话**', '全部会话都会停止，下一条消息开新会话。']
            : ['**⚠️ 确认重置会话**', '当前会话会停止，下一条消息开新会话。'];
    return [title, '', body, '', '> 👇 点「确认」继续'].join('\n');
}
/** 两个按钮：确认 / 取消，button_data 带 nonce 与决策 */
export function buildConfirmKeyboard(nonce) {
    const payload = (decision) => encodeButtonData({ t: 'confirm', n: nonce, d: decision });
    const confirm = {
        id: `confirm-yes-${nonce}`,
        render_data: {
            label: buttonLabel('✅ 确认'),
            visited_label: '✓ 已确认',
            style: 1,
        },
        action: {
            type: 1,
            permission: { type: 2 },
            click_limit: 1,
            data: payload('yes'),
        },
    };
    const cancel = {
        id: `confirm-no-${nonce}`,
        render_data: { label: buttonLabel('❌ 取消'), visited_label: '✓ 已取消', style: 0 },
        action: {
            type: 1,
            permission: { type: 2 },
            click_limit: 1,
            data: payload('no'),
        },
    };
    return { content: { rows: [{ buttons: [confirm, cancel] }] } };
}
/** nonce 只需在同一进程内区分新旧卡片 */
let nonceSeq = 0;
export class SessionConfirmChannel {
    /** 同一聊天只留最新一张卡：发新卡即作废旧卡 */
    pending;
    manager;
    sender;
    logger;
    constructor(manager, sender, logger) {
        this.manager = manager;
        this.sender = sender;
        this.logger = logger;
    }
    /**
     * 发确认卡。
     *
     * @returns true = 卡片已送达、等待点击；false = 发送失败，调用方应放弃本次动作
     *          （失败不能退回「直接执行」：那等于没有二次确认）。
     */
    async offer(request) {
        this.cancelPending();
        const nonce = `${Date.now().toString(36)}-${(nonceSeq++).toString(36)}`;
        try {
            await this.sender.sendMarkdown(request.target, confirmText(request.action), {
                keyboard: buildConfirmKeyboard(nonce),
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`qqterm: session confirm send failed: ${message}`);
            return false;
        }
        const timer = setTimeout(() => this.onTimeout(nonce), CONFIRM_TTL_MS);
        timer.unref?.();
        this.pending = { ...request, nonce, timer };
        return true;
    }
    /** 按钮点击：只认最新一张卡的 nonce，过期 / 旧卡片的点击直接忽略 */
    handleInteraction(event) {
        const raw = event.data?.resolved?.button_data;
        if (!raw)
            return false;
        const button = decodeButtonData(raw);
        if (!button || button.t !== 'confirm')
            return false;
        const pending = this.pending;
        if (!pending || pending.nonce !== button.n)
            return false;
        this.cancelPending();
        if (button.d === 'no') {
            void this.reply(pending.target, '✅ 已取消');
            return true;
        }
        void this.execute(pending);
        return true;
    }
    /** 会话释放 / 渠道回退 / 卸载：清掉待确认状态与定时器 */
    cancelPending() {
        const pending = this.pending;
        if (!pending)
            return;
        this.pending = undefined;
        if (pending.timer)
            clearTimeout(pending.timer);
    }
    onTimeout(nonce) {
        const pending = this.pending;
        if (!pending || pending.nonce !== nonce)
            return;
        this.pending = undefined;
        this.logger.debug('qqterm: session confirm expired');
    }
    async execute(pending) {
        // 卡片发出后会话变了（例如 Web 端切了会话）：别把新会话停掉
        const currentId = this.manager.currentSessionId?.();
        if (pending.currentId !== undefined && currentId !== pending.currentId) {
            await this.reply(pending.target, '⚠️ 当前会话已变化，重新发一次命令。');
            return;
        }
        try {
            await this.reply(pending.target, await pending.run());
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`qqterm: session confirm action failed: ${message}`);
            await this.reply(pending.target, `❌ 操作失败: ${message}\n稍等片刻再试一次。`);
        }
    }
    reply(target, text) {
        return this.sender
            .sendMarkdown(target, text)
            .then(() => { })
            .catch((err) => {
            this.logger.error(`qqterm: session confirm reply failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
}
//# sourceMappingURL=session-confirm.js.map