# 已获取会话：接收、切换与回答（v8）

> 状态：已实现 · 2026-11-05
> 收敛：不判断 owner，不区分 create/resume/get；范围是 **QQ 已经获取的会话**，不是所有 live。
> 已获取集合只在运行期存在，不落盘。

---

## 0. 结论

| 能力 | 做法 |
|---|---|
| 会话范围 | QQ 通过普通消息、`/sessions resume`、`/to` 实际拿到的会话；只看到列表不算 |
| 接收 | 所有已获取会话的 `session/event` 都回 QQ；current 不加标记，非 current 加 `[#短id]` |
| 切换 | `/sessions resume <id>`：live 直接接上只改 current；不 live 就 `agents.resume`；旧会话保持 live |
| 向指定会话发 prompt | `/to <id> <文本>`；目标必须已获取或 live |
| 问答 | current 直接文本回答；非 current 有按钮点按钮，没按钮用 `/to` 链接回答 |
| 审批 | 所有已获取会话的审批都进 QQ；按钮带 session id |
| owner | 不判断；只保留 `handle?` 表示“能不能 dispose” |
| 持久化 | 已获取集合不落盘；重启/重载后只有 current 从 prefs 恢复 |

---

## 1. 术语与范围

### 1.1 “已获取”

`SessionManager.records: Map<sessionId, SessionRecord>` 里存在的会话。

进入 `records` 的路径只有三条：

1. 普通 QQ 消息落到 current：`agents.get` 命中，或 `agents.resume` / `agents.create` 成功；
2. `/sessions resume <id>`：`agents.get` 命中，或 `agents.resume` 成功；
3. `/to <id>`：`agents.get` 命中。

只在 `/sessions` 列表里出现、没有实际拿到 agent 的会话，不算已获取。

### 1.2 两种“拿到”

| 方式 | 有 `agent` | 有 `handle` | 能收消息/提问 | 能 cancel | 能 dispose |
|---|---|---|---|---|---|
| `agents.create` / `agents.resume` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `agents.get`（live，可能是 Web/TUI 创建的） | ✅ | ❌ | ✅ | ✅ | ❌ |
| 冷会话（没有 live agent） | ❌ | ❌ | ❌ | ❌ | ❌ |

- `dispose()` 是创建者持有的 capability；`ctx.agents.get(id)` 只返回裸 Agent。
- 所以不判断 owner，也不假装所有已获取会话都能 dispose；用 `handle?` 判断。
- `cancel` 对拿到的 agent 都能调；如果它是 Web 创建的，会打断 Web 那一轮，这是接受的语义。

### 1.3 不落盘

- `records` 是运行期集合；插件重启/重载后清空。
- `currentByKey` 仍走现有 prefs（`model-prefs.json` 的 `sessionIds[chatKey]`）。
- 重载后只有 current 会在下一条消息时恢复；其它会话要重新 `/to` 或 `/sessions resume`。

---

## 2. SessionManager 数据模型

```ts
interface SessionRecord {
  sessionId: string;
  agent: DshAgent;
  handle?: DshAgentHandle;   // create/resume 才有
  replyTarget: ReplyTarget;  // 获取它的那条 QQ 消息
  scope: ChatScope;
  peerId: string;
  senderId: string;
  agentPreset?: string;
  acquiredAt: number;
}

class SessionManager {
  private records = new Map<string, SessionRecord>();   // sessionId → record
  private currentByKey = new Map<string, string>();     // chatKey → sessionId
}
```

- `getSessionRecord(scope, peerId)`：按 current 取。
- `findBySessionId(sessionId)`：O(1)。
- `getRecordBySessionId`：供 outbound/question/approval 用。
- `currentSessionId(scope, peerId)`：读 `currentByKey`，没有则读 prefs。
- `sessions.size` 不再用于“当前是否存在”，只表示已获取数量。

---

## 3. 出站

[outbound](../../src/transport/outbound.ts) 从“只命中当前记录”改成“命中所有已获取记录”：

| 事件来源 | 行为 |
|---|---|
| current | 现有链路，不加标记 |
| 非 current、已获取 | 发送，首行/每片加 `[#短id]` |
| 未获取 | 忽略 |
| 子 agent（`origin === 'subagent'`） | 忽略 |

- 每个 record 保留自己的 `replyTarget`；被动回复限额按 msgId 独立计算。
- 加每会话发送链，保证一个会话的分片连续发送，不与别的会话交错。
- 流式只给 current；非 current 用静态消息，避免多个流互相覆盖。
- 交付文件按 record 的目录/目标发送。

---

## 4. `/sessions resume`

```
/sessions resume <序号|id>
```

1. 解析目标。
2. 目标已归档 → 先取消归档；失败则不改任何状态。
3. 目标等于 current → 直接返回“已是当前会话”。
4. `agents.get(target)`：
   - 命中：拿到裸 Agent，`handle` 为空；如果 `records` 没有就加入，`replyTarget` 用本条命令消息；只改 current。
   - 未命中：`agents.resume({ resumeSessionId: target, ... })`；成功则加入 `records`（有 handle），改 current；失败则报错，**不 create**。
5. 旧 current 不 cancel、不 dispose、不从 `records` 删除；它继续 live、继续被接收。
6. 失败不改变 current，也不动旧记录。

错误文案：

| 情况 | 回复 |
|---|---|
| 已归档且取消归档失败 | `⚠️ 该会话已归档，取消归档失败: <原因>` |
| 不存在 | `⚠️ 磁盘上没有这个会话（可能已被删除）` |
| 写锁被其它进程持有 | `⚠️ 该会话正在另一个端运行（先在那里关闭再恢复）` |
| 其它 resume 失败 | `⚠️ 恢复失败: <原因>` |

不再出现“owner 不是自己”这一种失败；同进程 live 一律可接。

模型：冷启动 resume 仍用 `getResumeRoute(chatKey)` 的模型（per-chat 覆盖 > 插件配置 > 默认链），与旧行为一致；不沿用目标会话上次使用的模型。宿主 `{{model}}` 变量要求 resume 时必须有值，改成“读目标会话自己的模型”需要另做宿主侧适配，不在本版。

---

## 5. `/to`

```
/to <会话> <文本>
```

1. 解析目标；目标必须能在 `agents.get` 命中，或已在 `records`。
2. 目标未获取且不 live → 拒绝：`⚠️ 会话未运行: #id`，提示先 `/sessions resume` 或在 Web 打开。
3. 目标 live → 加入 `records`（没有 handle），`replyTarget` 用本条命令消息。
4. **先看目标有没有待答问题**：
   - 有 pending，且 `<文本>` 非空 → 当作答案：`questionChannel.answer(sessionId, text)`，回复 `✅ 已回答 #id`；**不 followup**。
   - 有 pending，且 `<文本>` 为空 → 进入“下一条消息作为回答”模式，回复 `💡 请发送回答`；下一条该 peer 的普通文本交给问题通道，答完自动退出（多题时保持到整组结束）。
   - 无 pending、`<文本>` 非空 → 正常 `followup(createQQUserMessage(text))`，回复 `✅ 已发送到 #id`。
   - 无 pending、`<文本>` 为空 → 拒绝：`⚠️ 缺少文本`。
5. 不改 current。

注意：`/to` 不是“再发一条新 prompt”就完事；目标在等答案时，它必须先走答案通道，否则新消息只会排在问题后面，永远答不上。

实现细节：

- 目标解析用 `/sessions all` 的全量清单（支持 8 位短 id / 完整 id / 唯一前缀）；列表里没有但 `agents.get` 命中的 live 会话，允许直接写完整 id。
- 已归档目标拒绝，给 `/sessions unarchive` 入口；冷目标拒绝，给 `/sessions resume` 入口。例外：目标就是 current 时走普通消息同一条打开路径（重启后尚未打开也能直接 `/to`）。
- 命令本身不改 current，也不跟随目标工作区变化。

---

## 6. 问答

### 6.1 pending 按 sessionId 存

`QuestionChannel.pending: Map<sessionId, PendingEntry>`，不再按 chatKey。`SessionRecord` 切走后，旧问题仍属于旧 sessionId，不会和新 current 撞 key。

`tryAnswer` 改成：

1. 如果该 peer 有显式 answer target（`/to #id` 空文本进入的模式），先答它；
2. 否则答 current 的 pending；
3. 都没有 → `false`，继续走普通消息。

### 6.2 当前会话

- 问题直接发 QQ，不附加 `/to` 链接。
- 用户直接回文本：`questionAnswer` 中间件截获，`tryAnswer(currentSessionId, text)`。
- 有按钮时也可以点按钮，或回编号。

### 6.3 非当前会话

- 所有已获取会话的问题都发 QQ；消息带 `[#短id]`。
- **有按钮**：按钮 `button_data` 带 `s: sessionId`；`handleInteraction` 按 `s` 找 pending，不再依赖 current。
- **没有按钮**（纯文本题，或按钮发送失败降级成文本）：问题末尾附链接：

```html
<qqbot-cmd-input text="/to #3f2a9b1c " show="回答 #3f2a9b1c"/>
```

- 链接的 `text` 末尾保留一个空格：如果客户端是“带入输入框”，用户直接接着输入答案；如果是“直接执行”，`/to #id` 空文本会进入上面的 answer 模式，下一条消息作为回答。
- 非 current 的纯文本如果没走链接，直接发到聊天里：不转给 current 模型；回复提示“这条属于 #id，点按钮或 /to #id 回答”。

### 6.4 多题

- 逐题推进逻辑不变。
- 非 current 的 answer 模式在多题期间保持：答完第一题，下一题发出，用户继续输入即可；整组结束或超时后清除。
- 按钮每题重新构建，`q` 仍是当前题 id，旧按钮点击被忽略。

### 6.5 超时 / 取消

- 问题超时：发 `⚠️ 提问已超时，未收到回答。`，reject `ASK_ABORTED`；不自动转 Web。
- 会话 dispose/archive：`cancelPending(sessionId)`，reject 对应 pending；只清该会话。
- 同一 sessionId 新问题顶掉旧问题（理论上同一轮不会发生）。

---

## 7. 审批

- `ApprovalChannel.pending: Map<sessionId, PendingApproval>`。
- 所有已获取会话的审批都进 QQ；消息带 `[#短id]`。
- 按钮 `button_data` 带 `s: sessionId` + `n: nonce`；`handleInteraction` 按 `s` 找 pending，校验点击者是该会话的 QQ 用户后再 settle。
- 旧卡片没有 `s` 时退回 current，兼容升级前发出的卡片；nonce 不匹配仍拒绝。
- 审批没有纯文本回答，不需要 `/to` 链接。
- 发送失败先降级纯文本；仍失败按暂不可用挂起（重试一次，再等网关恢复或新入站消息），不返回 `'unavailable'`。挂起不设插件侧超时，跟随 `request.signal`；渠道释放 / 插件卸载时 `handoffPending` 交还宿主 answerer。

---

## 8. Web 交互

- 同一 host 进程内，Web 打开 QQ 已获取的会话时，`resolve` 先 `agents.get`，命中 live 就直接复用，**不调用 `agents.resume`**，owner/生命周期不变。
- Web 在 QQ 已获取的会话里发 prompt：QQ 照样收到这一轮输出（因为按已获取集合转发），带 `[#id]`（如果它不是 current）。
- Web 另开一个 QQ 没获取的会话：QQ 不自动收；要收就 `/to` 或 `/sessions resume`。
- Web 在另一个进程：`agents.get` 看不到；`agents.resume` 撞写锁失败，不会静默接管。

---

## 9. 生命周期

| 操作 | 行为 |
|---|---|
| `/sessions resume` 切走 | 旧记录保留，不 cancel/dispose |
| `/new` | 只改 current；旧记录保留，继续收 |
| `/reset`（别名 `/clear`） | cancel + 释放 current，摘掉记录，再铸新 id；其它已获取会话不动 |
| `/reset all` | cancel + 释放全部已获取会话，清空集合，再铸新 id |
| `/sessions archive` | 取消归档 / 归档由宿主处理；该 sessionId 的 pending 清理；有 handle 的可 dispose |
| 插件卸载 | 有 handle 的 dispose；没 handle 的只清引用；不 cancel 借来的 |
| `/stop` | 只 cancel current 的 agent；即使是借来的也 cancel（接受的语义） |
| `/stop all` | cancel 所有 running 的已获取会话；顺带清对应 pending |
| agent 被外部 dispose | `agent/disposed` 事件摘掉记录；兜底再比对 `agents.get(id)` 是否换成了另一个 agent |

---

## 10. 失败模式

| 场景 | 行为 |
|---|---|
| 目标不 live，`/to` | 拒绝，提示先 resume / Web 打开 |
| 目标不 live，`/sessions resume` | `agents.resume`；失败报错，不 create |
| 别的进程持有写锁 | 报“正在另一个端运行”，不改 current |
| 已获取 agent 被外部关掉 | `agent/disposed` 摘掉记录；`agents.get` 换成另一个 agent 时也摘掉，后续该会话不再转发 |
| 非 current 纯文本被发到聊天 | 不转 current 模型，提示用按钮或 `/to #id` |
| 非 current 问题无按钮 | 附 `/to #id ` 链接；支持“带入输入框”和“执行后进入回答模式”两种客户端行为 |
| 两个会话同时输出 | 每会话发送链，分片不交错；都带标记（非 current） |
| 被动回复 4 次用尽 | 现有 `resolveReplyTarget` 轮换 / 主动推送兜底 |

---

## 11. 改动清单

### 11.1 新增

| 文件 | 职责 |
|---|---|
| `src/commands/to.ts` | `/to`：发 prompt；目标有 pending 时改为回答 |
| `src/session/user-message.ts` | 构造 `source.kind='qqbot'` 的 UserMessage（普通消息与 `/to` 共用） |

已获取集合的查询 / current 判断直接并入 `SessionManager`（`findBySessionId` / `isCurrentSession` / `listAcquiredSessions`），没有单独建 `transport/acquired.ts`。

### 11.2 修改

| 文件 | 改动 |
|---|---|
| `src/session/types.ts` | `SessionRecord.handle?`、去掉 `owned`；`SwitchSessionOutcome.reason` 去掉 `in-use` |
| `src/session/session-manager.ts` | `records` 按 sessionId；`currentByKey`；`switchSession` 不 dispose；`getOrCreate` 接 current；`findBySessionId` O(1)；`cancelPendingFor(sessionId)` |
| `src/transport/inbound.ts` | 不再依赖单一 record；按 current 获取；source 改 `qqbot` |
| `src/transport/outbound.ts` | 所有 records 路由；非 current 加标记；每会话发送链；流式只 current |
| `src/features/question-channel.ts` | pending 按 sessionId；非 current 链接；answer(sessionId, text)；answer target 模式；按钮解析 session |
| `src/features/question-renderer.ts` | `formatQuestion` 支持非 current 链接 / 标记；`buildKeyboard` 带 sessionId |
| `src/features/approval-channel.ts` | pending 按 sessionId；按钮带 session；按 session 处理点击 |
| `src/features/button-utils.ts` | `s: sessionId` 字段 |
| `src/middleware/question-answer.ts` | 先 explicit answer target，再 current；非 current 纯文本提示 |
| `src/commands/index.ts` | 注册 `/to` |
| `src/commands/sessions.ts` | resume 去掉 owner 失败分支；错误文案 |
| `README.md` / `CHANGELOG*.md` | `/to`、已获取范围、非 current 标记、问答行为 |

### 11.3 不改

- 工作区列表/归档/模型/preset/permission 的现有语义。
- 被动回复限额、分片、附件、交付物。
- 群聊（已移除）。

---

## 12. 测试

### 12.1 单元

| 用例 | 断言 |
|---|---|
| 已获取集合 | 普通消息 / resume / `/to` 加入；列表不加入；卸载清空 |
| current 指针 | resume 只改指针；旧记录保留；`/new` 旧记录保留 |
| outbound | 所有 records 都发；非 current 带 `[#id]`；未获取不发；subagent 不发 |
| `/to` 正常 | live 目标加入；source qqbot；不改 current |
| `/to` 回答 | 目标有 pending 时走 answer，不 followup；空文本进入 answer 模式 |
| 问答 current | 文本直接答；按钮也答 |
| 问答非 current | 按钮 data 带 session；点击不依赖 current；无按钮带 `/to` 链接 |
| 多题 | 非 current answer 模式跨题保持；整组结束清除 |
| pending 隔离 | 切换 current 后旧 pending 不被新会话误答 |
| dispose 能力 | handle 存在才 dispose；get 来的只丢引用 |
| 外部 dispose | `agents.get` 不一致时移除记录，不再转发 |

### 12.2 手工

1. QQ 发消息创建 A；`/sessions resume B`；A 继续输出，QQ 继续收到并带 `[#A]`。
2. Web 打开 A 发 prompt；QQ 收到 A 的输出；不改变 current。
3. `/to A 继续`：A 跑一轮，输出回 QQ；current 不变。
4. 非当前 A 问一个纯文本问题：QQ 收到带 `/to #A` 链接；点击后输入答案，问题 resolve。
5. 非当前 A 问一个带选项问题：QQ 收到按钮；点击后正确答 A，不影响 current。
6. 当前 B 的问题：直接回文本即可。
7. 重启：只有 current 恢复；A 不再自动收，需 `/to A` 或 resume。
