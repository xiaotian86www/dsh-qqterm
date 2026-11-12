/** 把 image 块归一化成发送用的引用；非法引用返回 undefined */
function imageRefOf(block) {
    if (block.offloaded === true)
        return undefined;
    const ref = block.attachment;
    if (ref === undefined || typeof ref.attachmentId !== 'string' || ref.attachmentId === '')
        return undefined;
    return {
        attachmentId: ref.attachmentId,
        mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : '',
        ...(typeof ref.width === 'number' ? { width: ref.width } : {}),
        ...(typeof ref.height === 'number' ? { height: ref.height } : {}),
        ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
    };
}
/** 从消息内容里挑出 image 块（去重、跳过已 offload 的块，非法引用直接忽略） */
export function collectImageBlocks(content) {
    const refs = [];
    for (const block of content) {
        if (block.type !== 'image')
            continue;
        const ref = imageRefOf(block);
        if (ref === undefined)
            continue;
        if (!refs.some((item) => item.attachmentId === ref.attachmentId))
            refs.push(ref);
    }
    return refs;
}
/**
 * 按内容块顺序切成文本段与图片组（相邻图片归一组，同一附件只发一次）。
 *
 * 出站据此在文本之间按原位置插图，而不是把整条消息的图片统一挪到最后。
 */
export function segmentMessageContent(content) {
    const segments = [];
    const seen = new Set();
    let text = [];
    let images = [];
    const flushText = () => {
        if (text.length > 0)
            segments.push({ kind: 'text', text: text.join('\n') });
        text = [];
    };
    const flushImages = () => {
        if (images.length > 0)
            segments.push({ kind: 'image', refs: images });
        images = [];
    };
    for (const block of content) {
        if (block.type === 'text') {
            flushImages();
            text.push(typeof block.text === 'string' ? block.text : '');
            continue;
        }
        if (block.type !== 'image')
            continue;
        const ref = imageRefOf(block);
        if (ref === undefined || seen.has(ref.attachmentId))
            continue;
        seen.add(ref.attachmentId);
        flushText();
        images.push(ref);
    }
    flushText();
    flushImages();
    return segments;
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