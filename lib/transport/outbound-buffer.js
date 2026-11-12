import { chunkMarkdownText } from "./chunker.js";
import { StreamingWriter } from "./streaming-writer.js";
/** 流式输出节流间隔(ms)：连续 chunk 累积后停顿该间隔才推送 */
const STREAM_THROTTLE_MS = 200;
export class OutboundBuffer {
    buffer = '';
    flushing = false;
    writer;
    record;
    bot;
    limit;
    logger;
    /** 发送前的文本改写（本地文件链接 → /get）；流式与静态都过一遍 */
    transform;
    constructor(record, bot, limit, logger, streamingEnabled, transform) {
        this.record = record;
        this.bot = bot;
        this.limit = limit;
        this.logger = logger;
        this.transform = transform;
        this.writer = streamingEnabled
            ? new StreamingWriter({
                bot,
                target: record.replyTarget,
                logger,
                throttleMs: STREAM_THROTTLE_MS,
                ...(transform === undefined ? {} : { transform }),
            })
            : null;
    }
    /** 是否走流式（仅当前会话）；false 时由出站路由统一加来源标注后静态发送 */
    get isStreaming() {
        return this.writer !== null;
    }
    /** 追加文本增量 */
    append(text) {
        this.buffer += text;
        this.writer?.append(text);
    }
    /** 获取当前累积文本 */
    get text() {
        return this.buffer;
    }
    /** 重置累积文本（LLM 重试的新 attempt），流式会话保留由全量 update 重写 */
    reset() {
        this.buffer = '';
        this.writer?.reset();
    }
    /** 发送所有累积文本：流式优先，降级静态 */
    async flush() {
        if (this.flushing || !this.buffer.trim())
            return;
        this.flushing = true;
        try {
            if (this.writer) {
                await this.writer.finish();
                // 流式成功（未降级）→ 直接返回
                if (!this.writer.shouldFallback)
                    return;
            }
            // 降级：静态发送（writer 不存在 or 流式失败）
            const text = this.transform === undefined ? this.buffer : this.transform(this.buffer);
            const chunks = chunkMarkdownText(text, this.limit);
            for (const chunk of chunks) {
                await this.bot.sendMarkdown(this.record.replyTarget, chunk);
            }
        }
        catch (err) {
            this.logger.error(`qqterm: flush failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            this.buffer = '';
            this.flushing = false;
        }
    }
    /**
     * 只发送前 `prefix` 段文本：流式消息收尾到该长度，后续内容由调用方另发。
     * 用于在文本中间插入图片（QQ 流式消息是一条持续全量替换的消息，插不进图片）。
     */
    async flushUpTo(prefix) {
        this.buffer = prefix;
        this.writer?.truncate(prefix);
        await this.flush();
    }
    /** 取消（异常/丢弃），中止流式并清空缓冲 */
    cancel() {
        this.writer?.abort();
        this.buffer = '';
    }
}
//# sourceMappingURL=outbound-buffer.js.map