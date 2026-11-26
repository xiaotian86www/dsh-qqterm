/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 插件只接收 C2C 私聊消息。内容组装逻辑：
 * - Layer 1: userContent（文本 + 语音转录）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（引用块 + 正文）
 * - Layer 4: dynamicCtx（媒体元数据）
 *
 * 消息始终落到「当前会话」；其它已获取会话由 `/sessions resume`、`/to` 与
 * 问答通道驱动，不从这条普通消息路径直接写。
 */
import { WorktreeError, worktreeErrorText } from "../session/index.js";
import { queuedPromptReceipt, sessionTitleOf, steeredPromptReceipt, } from "./session-source.js";
import { classifyContentType, isVoiceContentType } from "./attachment.js";
import { errorMessage } from "../shared/utils.js";
import { buildQuotePart, isQuoteResolvable, quoteAttachmentLines, renderMediaLine } from "./prompt-body.js";
// ── 主处理函数 ──
/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(ctx, manager, logger, 
/** 发提示文本用的函数（bootstrap 注入 sender.text：分片 + 网络类重试） */
sendText) {
    const msg = ctx.message;
    const mwState = ctx.state;
    const scope = 'c2c';
    const peerId = msg.senderId;
    const replyTarget = { scope, targetId: peerId };
    // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
    const agentBody = assembleAgentBody(msg, mwState, logger);
    if (!agentBody)
        return;
    logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);
    // ── 获取或创建会话 ──
    let record;
    try {
        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
    }
    catch (err) {
        logger.error(`ERROR creating session: ${errorMessage(err)}`);
        // 宿主 logger 在 headless profile 里不进终端，补一条 stderr：会话打不开时
        // 用户只看到兜底文案，没有这一行就无法定位（如 SessionAlreadyOwnedError）。
        console.error('[qqterm] getOrCreate failed:', err);
        // 兜底回复：会话创建失败时告知用户，避免静默无响应
        try {
            // 工作树失败是最常见的一种：说清「会话没建」或「目录回不来」，别混进通用兜底
            const text = err instanceof WorktreeError
                ? worktreeErrorText(err)
                : '⚠️ 处理消息时出现异常';
            await sendText(replyTarget, text);
        }
        catch (sendErr) {
            logger.error(`fallback reply failed: ${errorMessage(sendErr)}`);
        }
        return;
    }
    // `/new --worktree` 的建树回执只发一次：先把分支、父分支与路径交代清楚
    if (record.worktreeNotice !== undefined) {
        const notice = record.worktreeNotice;
        delete record.worktreeNotice;
        try {
            await sendText(replyTarget, notice);
        }
        catch (sendErr) {
            logger.warn(`worktree notice failed: ${errorMessage(sendErr)}`);
        }
    }
    // ── 构建 UserMessage → 交给宿主 ──
    // submitPrompt 统一决定排队还是插话（读宿主 ui-conversation.busyEnter），并记下
    // 消息 id 与落点。这里绝不能 await whenIdle()：concurrencyGuard 以 QQ 用户为键，
    // 处理函数挂到本轮结束会把同一个人的所有消息串成一条队列——正在生成的会话会挡住
    // 另一个空闲会话（多会话下表现为「消息发给空闲会话，却在排队」）。
    const submitted = manager.submitPrompt(record, agentBody);
    logger.info(`→ prompt sent: key=${scope}:${peerId} placement=${submitted.placement}`);
    // 排队 / 插话的回执是提示，不挡返回：发不出去只记日志，消息已经交给宿主
    if (submitted.placement !== 'started') {
        const current = manager.isCurrentSession(record.sessionId);
        const title = sessionTitleOf(record);
        const receipt = submitted.placement === 'queued'
            ? queuedPromptReceipt(record.sessionId, title, submitted.messageId, current, manager.canMutateQueue())
            : steeredPromptReceipt(record.sessionId, title, current);
        try {
            void sendText(replyTarget, receipt).catch((sendErr) => {
                logger.warn(`placement receipt failed: ${errorMessage(sendErr)}`);
            });
        }
        catch (sendErr) {
            // sendText 正常是 async；真同步抛错也不能挡返回（消息已经交给宿主）
            logger.warn(`placement receipt failed: ${errorMessage(sendErr)}`);
        }
    }
}
// ══════════════════════════════════════════════════════════════
// Body Assembly（c2c + quote + attachments）
// ══════════════════════════════════════════════════════════════
/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(msg, state, logger) {
    const userContent = buildUserContent(msg, state, logger);
    // 只有引用、没有正文与附件也是有效消息：引用块本身就是内容
    if (isEmptyMessage(userContent, msg.attachments) && !isQuoteResolvable(state.quote))
        return null;
    const quotePart = buildQuotePart(state.quote, { hasCurrentText: userContent !== '' });
    const userMessage = `${quotePart}${userContent}`;
    const dynamicCtx = buildDynamicCtx(msg, state);
    return dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
}
/**
 * 判断消息是否为空：无文本/语音/附件。
 */
function isEmptyMessage(userContent, attachments) {
    if (userContent)
        return false;
    if (attachments && attachments.length > 0)
        return false;
    return true;
}
/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg, state, logger) {
    const parts = [];
    const text = (msg.content ?? '').trim();
    if (text) {
        parts.push(text);
    }
    const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
    if (voiceTexts.length > 0) {
        for (const vt of voiceTexts) {
            const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
            parts.push(`[Voice message${durationTag}] ${vt.text}`);
        }
    }
    // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
    const attachmentTags = buildAttachmentTags(msg.attachments);
    if (attachmentTags) {
        parts.push(attachmentTags);
    }
    return parts.join('\n');
}
/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg, state) {
    const lines = [];
    if (msg.attachments && msg.attachments.length > 0) {
        const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
        const voices = [];
        // 一次遍历归类 + 生成媒体行
        for (const att of msg.attachments) {
            const kind = classifyContentType(att.content_type);
            if (kind === 'voice') {
                voices.push(att);
                continue;
            }
            const d = downloadedByFilename.get(att.filename);
            lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
        }
        // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
        if (voices.length > 0) {
            const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
            if (asrTexts.length > 0) {
                lines.push(`- ASR: ${asrTexts.join(' | ')}`);
            }
            else {
                const urls = voices.map(a => a.url).filter(Boolean);
                if (urls.length > 0)
                    lines.push(`- Voice: ${urls.join(', ')}`);
            }
        }
    }
    // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
    lines.push(...quoteAttachmentLines(state.quote, state.downloadedQuoteFiles));
    return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}
function extractVoiceTexts(attachments, processed, _logger) {
    const results = [];
    if (processed) {
        for (const pa of processed) {
            if (pa.type === 'voice' && pa.voiceText) {
                results.push({
                    text: pa.voiceText,
                    duration: pa.duration,
                    source: pa.voiceSource ?? 'stt',
                });
            }
        }
    }
    if (results.length === 0 && attachments) {
        for (const att of attachments) {
            if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
                results.push({
                    text: att.asr_refer_text.trim(),
                    source: 'asr',
                });
            }
        }
    }
    return results;
}
/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments) {
    if (!attachments || attachments.length === 0)
        return '';
    const labels = {
        image: '[图片]',
        video: '[视频]',
        file: '[文件]',
    };
    const seen = new Set();
    const tags = [];
    for (const att of attachments) {
        const kind = classifyContentType(att.content_type);
        if (kind === 'voice' || seen.has(kind))
            continue;
        seen.add(kind);
        const label = labels[kind];
        if (label)
            tags.push(label);
    }
    return tags.join(' ');
}
//# sourceMappingURL=inbound.js.map