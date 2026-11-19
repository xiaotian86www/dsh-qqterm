/**
 * Markdown 文本切分器
 *
 * QQ 单条消息有字符数限制（约 5000），需要在合适边界切分，
 * 并保持 GFM 表格、代码块的完整性。
 */
const CODE_FENCE_OPEN = /^```/;
const GFM_TABLE_LINE = /^\|.+\|$/;
/**
 * 按换行边界切分 Markdown 文本
 * - 不在代码块中间断开
 * - 不在 GFM 表格中间断开
 * - 优先在空行处断开
 */
export function chunkMarkdownText(text, limit) {
    if (text.length <= limit)
        return [text];
    const lines = text.split('\n');
    const chunks = [];
    let current = '';
    let inCodeBlock = false;
    let tableBuffer = [];
    const flushTable = () => {
        if (tableBuffer.length === 0)
            return;
        const block = tableBuffer.join('\n');
        tableBuffer = [];
        if (!current) {
            current = block;
            return;
        }
        const candidate = `${current}\n${block}`;
        if (candidate.length > limit) {
            chunks.push(current);
            current = block;
        }
        else {
            current = candidate;
        }
    };
    const appendLine = (line) => {
        if (!current) {
            current = line;
            return;
        }
        const candidate = `${current}\n${line}`;
        if (candidate.length > limit) {
            chunks.push(current);
            current = line;
        }
        else {
            current = candidate;
        }
    };
    for (const line of lines) {
        if (CODE_FENCE_OPEN.test(line)) {
            flushTable();
            inCodeBlock = !inCodeBlock;
            appendLine(line);
            continue;
        }
        if (inCodeBlock) {
            appendLine(line);
            continue;
        }
        if (GFM_TABLE_LINE.test(line)) {
            tableBuffer.push(line);
            continue;
        }
        flushTable();
        appendLine(line);
    }
    flushTable();
    if (current)
        chunks.push(current);
    return chunks.length > 0 ? chunks : [text];
}
/**
 * 按上限切分整条消息（含装饰），保证每片不超过 limit 且不丢字符。
 *
 * 先按行 / 表格 / 代码块边界切；单行本身超长时再按字符硬切，
 * 硬切点落在行内标签（`<qqbot-cmd-input …/>`）里就往前退到标签开头。
 */
export function splitForLimit(text, limit) {
    const size = Math.max(1, Math.floor(limit));
    if (text.length <= size)
        return [text];
    const chunks = [];
    for (const chunk of chunkMarkdownText(text, size)) {
        if (chunk.length <= size)
            chunks.push(chunk);
        else
            chunks.push(...hardSplit(chunk, size));
    }
    return chunks;
}
/** 超长行的字符硬切：退到标签边界，避免把行内标签切成两半 */
function hardSplit(text, size) {
    const chunks = [];
    let rest = text;
    while (rest.length > size) {
        let cut = size;
        const open = rest.lastIndexOf('<', cut - 1);
        const close = rest.lastIndexOf('>', cut - 1);
        if (open > close && open > 0)
            cut = open;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest !== '')
        chunks.push(rest);
    return chunks;
}
//# sourceMappingURL=chunker.js.map