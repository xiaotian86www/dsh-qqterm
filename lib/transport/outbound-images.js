/** 从消息内容里挑出 image 块（去重、跳过已 offload 的块，非法引用直接忽略） */
export function collectImageBlocks(content) {
    const seen = new Set();
    const refs = [];
    for (const block of content) {
        if (block.type !== 'image' || block.offloaded === true)
            continue;
        const ref = block.attachment;
        if (ref === undefined || typeof ref.attachmentId !== 'string' || ref.attachmentId === '')
            continue;
        if (seen.has(ref.attachmentId))
            continue;
        seen.add(ref.attachmentId);
        refs.push({
            attachmentId: ref.attachmentId,
            mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : '',
            ...(typeof ref.width === 'number' ? { width: ref.width } : {}),
            ...(typeof ref.height === 'number' ? { height: ref.height } : {}),
            ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
        });
    }
    return refs;
}
export class OutboundImages {
    bot;
    attachments;
    logger;
    constructor(bot, attachments, logger) {
        this.bot = bot;
        this.attachments = attachments;
        this.logger = logger;
    }
    /**
     * 逐张发送图片：单张失败只记日志，不影响后续图片与已在排队的文本。
     * 调用方负责放进每会话发送链（保证排在文本之后）。
     */
    async send(record, refs) {
        for (const ref of refs) {
            try {
                const source = await this.resolve(ref);
                if (source === undefined) {
                    this.logger.debug(`qqterm: 图片无法定位附件 attachmentId=${ref.attachmentId}`);
                    continue;
                }
                await this.bot.sendImage(record.replyTarget, source);
            }
            catch (err) {
                this.logger.warn(`qqterm: 图片发送失败 attachmentId=${ref.attachmentId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    /** 优先用宿主文件路径（免读字节）；非文件后端退回 readImage 的原始字节 */
    async resolve(ref) {
        const store = this.attachments;
        if (store === undefined)
            return undefined;
        if (store.imageHostPath !== undefined) {
            const path = store.imageHostPath(ref);
            if (path !== undefined && path !== '')
                return { localPath: path };
        }
        if (store.readImage === undefined)
            return undefined;
        const stored = await store.readImage(ref);
        if (stored.data.length === 0)
            return undefined;
        return { buffer: Buffer.from(stored.data) };
    }
}
//# sourceMappingURL=outbound-images.js.map