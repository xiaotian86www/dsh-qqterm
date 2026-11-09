/**
 * Loader entry 快照
 *
 * 「这次操作把哪个 entry 换掉了」是热重载与插件安装共用的判定：两边都要在
 * 操作前后各拍一次 uid，比较有没有换。抽在这里是因为两份实现一旦漂移，
 * 补发通知就会时有时无——判断错的代价是「结果发不出去」或「重复发一遍」。
 */
/**
 * 当前各个 entry 的 fiber uid；拿不到 loader 时返回 undefined。
 *
 * 注意 uid 是 Cordis 分配的**数字**（dispose 后为 null），fiber 在跑才有值：
 * 按字符串判会一个都收不到，diff 就永远返回「什么都没变」。
 */
export function entryUids(loader) {
    if (loader === undefined)
        return undefined;
    try {
        const uids = new Map();
        for (const entry of loader.entries()) {
            const id = entry.options?.id;
            const uid = entry.fiber?.uid;
            if (typeof id !== 'string')
                continue;
            if (typeof uid === 'number' || typeof uid === 'string')
                uids.set(id, uid);
        }
        // 一个都读不到说明形状又变了，别拿空表冒充「没有变更」
        return uids.size === 0 ? undefined : uids;
    }
    catch {
        // loader 在重载期间可能已经失效，判不出就交给调用方兜底
        return undefined;
    }
}
/** 被替换的 entry：uid 变了或整个消失了；两边有一边读不到时返回 undefined */
export function changedEntries(before, after) {
    if (before === undefined || after === undefined)
        return undefined;
    const changed = [];
    for (const [id, uid] of after) {
        const previous = before.get(id);
        if (previous !== undefined && previous !== uid)
            changed.push(id);
    }
    for (const id of before.keys()) {
        if (!after.has(id))
            changed.push(id);
    }
    return changed;
}
/** 指定 entry 有没有被换掉：true=换了，false=还在，undefined=判不出来 */
export function entryReplaced(before, after, id) {
    if (before === undefined || after === undefined)
        return undefined;
    return before.get(id) !== after.get(id);
}
//# sourceMappingURL=entries.js.map