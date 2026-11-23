/**
 * Markdown 文本切分器
 *
 * QQ 单条消息有字符数限制（约 5000），需要在合适边界切分，
 * 并保持 GFM 表格、代码块的完整性。
 */
const CODE_FENCE_OPEN = /^```/;
const GFM_TABLE_LINE = /^\|.+\|$/;
/** 行内指令标签：QQ 端把它渲染成按钮本身，不算可读正文 */
const INLINE_TAG = /<qqbot-cmd-input\b[^>]*\/>/g;
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
 * 切分只看边界，不认首尾装饰；但每片都得留下可读正文，只剩标签的分片
 * 从上一片借一段过来（见 `keepReadableTail`）。
 */
export function splitForLimit(text, limit) {
    const size = Math.max(1, Math.floor(limit));
    return keepReadableTail(splitByLimit(text, size), size);
}
/** 按边界切 + 超长行硬切，不做可读性回填 */
function splitByLimit(text, size) {
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
/** 去掉行内指令标签与标签之间的分隔符后，还剩不剩正文 */
function hasReadableText(text) {
    return !/^[\s·|•・]*$/.test(text.replace(INLINE_TAG, ''));
}
/** 正文与标签行之间恰好一个空行（上一片尾部可能已经带着换行） */
function joinTail(body, tail) {
    return `${body.replace(/\n+$/, '')}\n\n${tail}`;
}
/**
 * 末片只有行内指令标签时，让上一片分一段正文过来。
 *
 * 标签行单独成条，QQ 端没有正文可渲染，看着就是一条空消息——尾部快捷链接
 * 明明切出来了却像丢了。规则与首尾无关：每片都要有可读正文，不够就从上一片
 * 借，借完仍不够就继续往前借；标签本身撑满上限时无处可借，原样返回。
 */
function keepReadableTail(chunks, limit) {
    let result = chunks;
    while (result.length > 1) {
        const tail = result[result.length - 1];
        if (hasReadableText(tail))
            break;
        const head = result[result.length - 2];
        const rest = result.slice(0, -2);
        // 合得下就直接合，中间留一个空行
        if (head.length + tail.length + 2 <= limit) {
            result = [...rest, joinTail(head, tail)];
            continue;
        }
        const room = limit - tail.length - 2;
        if (room < 1)
            break;
        const parts = splitByLimit(head, room);
        result = [...rest, ...parts.slice(0, -1), joinTail(parts[parts.length - 1], tail)];
    }
    return result;
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