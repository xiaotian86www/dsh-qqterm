/**
 * 工具调用结果 → Markdown 格式化
 *
 * 适配 QQ 消息通道：优先用工具自定义的 presentResult 视图，
 * fallback 到 raw text。成功与失败都按 config 的 showToolResults 开关
 * （开关在 outbound 层判定，本模块只负责把失败写清楚：哪个工具、对什么、
 * 为什么失败）。
 */
const RESULT_PREVIEW_LIMIT = 1500;
/** 失败消息里「目标」与「原因」的展示上限 */
const ERROR_TARGET_LIMIT = 80;
const ERROR_DETAIL_LIMIT = 200;
/**
 * 将工具调用结果格式化为 Markdown 文本
 *
 * 返回 null 表示无需发送（无内容）。
 */
export function formatToolResult(name, rawArgs, data, toolsRegistry, agent) {
    // 1. 错误优先：交代哪个工具、对什么、为什么失败
    if (data.error) {
        return formatError(name, rawArgs, data, data.error);
    }
    // 2. 尝试工具自定义视图（presentResult）
    const view = presentResultView(name, rawArgs, data, toolsRegistry, agent);
    if (view) {
        const rendered = renderView(name, view);
        if (rendered)
            return rendered;
    }
    // 3. fallback raw text
    const block = data.message.content[0];
    const result = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : '';
    if (!result)
        return null;
    return `🔧 \`${name}\` 完成\n${truncate(result)}`;
}
/**
 * 失败结果：首行「哪个工具对什么失败」，次行给错误码与原始原因。
 *
 * 只有 `❌ 工具 x 执行失败` 一行时，用户看不出是哪次操作、为什么失败，
 * 所以补上调用参数里的操作对象（文件 / 命令 / URL）与工具结果正文里的原因。
 */
function formatError(name, rawArgs, data, error) {
    const target = errorTarget(rawArgs);
    const head = target === undefined
        ? `❌ 工具 \`${name}\` 执行失败`
        : `❌ 工具 \`${name}\` 执行失败: \`${target}\``;
    const code = `\`${error.name}: ${error.code}\``;
    const detail = errorDetail(data);
    return detail === '' ? `${head}\n原因: ${code}` : `${head}\n原因: ${code} · ${detail}`;
}
/** 失败工具的操作对象：文件路径 / 命令 / URL 取第一个可用参数 */
const TARGET_ARG_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'url', 'pattern', 'query'];
function errorTarget(rawArgs) {
    let args;
    try {
        args = JSON.parse(rawArgs);
    }
    catch {
        return undefined;
    }
    if (typeof args !== 'object' || args === null)
        return undefined;
    for (const key of TARGET_ARG_KEYS) {
        const value = args[key];
        if (typeof value === 'string' && value.trim() !== '')
            return inline(value.trim(), ERROR_TARGET_LIMIT);
    }
    return undefined;
}
/** 失败原因：工具结果正文（`Error: …`）去掉前缀后压成一行 */
function errorDetail(data) {
    const block = data.message.content[0];
    const raw = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : '';
    const text = raw.replace(/^Error:\s*/, '').replace(/\s+/g, ' ').trim();
    return text === '' ? '' : inline(text, ERROR_DETAIL_LIMIT);
}
/** 单行化 + 截断 + 去掉会破坏 markdown 的反引号 */
function inline(text, limit) {
    const oneLine = text.replace(/[\r\n]+/g, ' ').replace(/`/g, "'").trim();
    return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`;
}
/** 调用工具自定义 presentResult，失败/不可用时返回 undefined */
function presentResultView(name, rawArgs, data, toolsRegistry, agent) {
    if (!toolsRegistry)
        return undefined;
    try {
        const tool = toolsRegistry.get(name, agent);
        if (tool?.presentResult === undefined)
            return undefined;
        const block = data.message.content[0];
        const content = block !== undefined && block.type === 'tool-result' ? block.content : [];
        return tool.presentResult(JSON.parse(rawArgs), {
            content,
            isError: block?.isError === true,
            ...(data.meta !== undefined ? { meta: data.meta } : {}),
        });
    }
    catch {
        return undefined;
    }
}
/** 将结构化视图渲染为 Markdown */
function renderView(name, view) {
    const header = `🔧 \`${name}\` 完成`;
    switch (view.card) {
        case 'terminal': {
            const output = (view.output ?? '').trimEnd();
            if (!output)
                return null;
            const exit = view.exitCode !== undefined && view.exitCode !== 0 ? `\n退出码 ${view.exitCode}` : '';
            return `${header}\n\`\`\`\n${output}\n\`\`\`${exit}`;
        }
        case 'diff': {
            return `${header}\n\`\`\`diff\n${truncate(renderDiffs(view.diffs))}\n\`\`\``;
        }
        case 'read': {
            const content = view.content ? textOf(view.content) : '';
            if (!content)
                return null;
            const path = view.path ? ` (${view.path})` : '';
            return `${header}${path}\n\`\`\`\n${truncate(content)}\n\`\`\``;
        }
        case 'generic':
        default: {
            const content = view.content ? textOf(view.content) : '';
            if (!content)
                return null;
            return `${header}\n${truncate(content)}`;
        }
    }
}
/** 提取 content blocks 中的纯文本 */
function textOf(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .map((b) => {
        if (typeof b === 'object' && b !== null && b.type === 'text') {
            return b.text ?? '';
        }
        return '';
    })
        .filter(Boolean)
        .join('');
}
/** 渲染 diff hunks 为纯文本 */
function renderDiffs(diffs) {
    return diffs
        .map((d) => {
        if (typeof d === 'object' && d !== null) {
            const { path, hunks } = d;
            const body = (hunks ?? []).map((h) => h.text ?? '').join('\n');
            return path ? `--- ${path} ---\n${body}` : body;
        }
        return '';
    })
        .filter(Boolean)
        .join('\n');
}
/** 截断长文本，避免刷屏 */
function truncate(text) {
    if (text.length <= RESULT_PREVIEW_LIMIT)
        return text;
    return `${text.slice(0, RESULT_PREVIEW_LIMIT)}\n…（已截断）`;
}
//# sourceMappingURL=tool-presenter.js.map