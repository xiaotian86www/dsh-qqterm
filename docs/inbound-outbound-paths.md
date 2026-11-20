# 入站与出站路径

> 现状清单，不含改造方案。**入站**是 QQ 聊天框进入 bot 的事件（消息、按钮点击）；**出站**是 bot 发到 QQ 聊天框的内容（文本、键盘、图片、文件）。

## 1. 边界

- 入站只有两类：消息（文本、图片、文件、语音、引用）和按钮点击。网关信号 `ready` / `resumed` / `error` / `disconnected` 不是入站消息，但会触发出站（补发、恢复通知、公告），所以单列。
- `typing`、按钮 `ack`、指令面板与自定义菜单同步是平台 API 调用，不是聊天消息，单列为 O13。
- 一个 QQ 窗口对应多个 dsh 会话：非当前会话的输出、提问、审批都要带署名首行与动作尾行，规则见 AGENTS.md §4.9。

## 2. 平台约束

矩阵里每一列都对应一条绕不开的约束，不是可选优化：

| 约束 | 表现 | 实现位置 |
|---|---|---|
| 被动回复凭证 | 只能回复最近一条用户消息或交互；5 分钟内有效；每条消息最多回 4 条；过期报 40034005 | `src/transport/reply-store.ts`、`src/transport/reply-bot.ts:41` |
| 单条长度 | 平台上限约 5000 字符，配置 `textChunkLimit` 默认 4500；超长报 40054007 / 40054018 | `src/transport/chunker.ts:92` |
| 失败要分类 | 网络类可重试、超长要重切、风控与鉴权重试无用 | `src/transport/outbox.ts` 的 `classifyDeliveryError` |
| 单窗口多会话 | 所有会话的输出都回到同一个 QQ 窗口，必须靠署名区分 | `src/transport/session-source.ts` |

## 3. 入站路径

| # | 路径 | 触发与入口 | 要做的事 |
|---|---|---|---|
| I1 | 普通消息 → agent | `bot.on('message')`（`src/gateway/bootstrap.ts:105`）穿过中间件链后落到 `handleInbound`（`src/transport/inbound.ts:70`） | 访问控制、凭证登记、内容清洗、限流、并发合并、输入状态、引用解析、附件下载、语音转写、媒体元数据、组装 agent body、会话获取或创建、工作树回执、`lastPrompt` 落盘、`agent.followup()`、失败兜底提示 |
| I2 | 斜杠命令 | SDK `slashCommand` 中间件（`src/gateway/middleware-setup.ts:92`），命令表在 `src/commands/index.ts:28` | owner 校验、前缀识别（`/` 与 `／`）、指令解析与分发、转发宿主命令登记簿、结果分片回复、`/clear` 的确认卡 |
| I3 | 提问答案 | `questionAnswer` 中间件（`src/gateway/middleware-setup.ts:95`）→ `question-channel.tryAnswer`（`src/features/question-channel.ts:296`） | 按 peer 匹配挂起项、答案解析（选项与自由文本）、唤醒提问 Promise、阻断后续链路 |
| I4 | 未知指令 | `rejectUnknownCommands`（`src/gateway/middleware-setup.ts:99`）→ `src/middleware/unknown-command.ts:168` | 候选解析、编辑距离建议、markdown 与纯文本两版、发送降级、发送失败放行 |
| I5 | 按钮点击 | `bot.on('interaction')`（`src/gateway/bootstrap.ts:194`）→ `dispatchInteraction`（`:44`） | `button_data` 解码、owner 校验（网关之外四个通道再各复核一次）、凭证登记、按 `t` 分发到提问 / 审批 / 重试 / 确认四个通道、nonce 与会话校验、状态机推进、`acknowledgeInteraction`（`:201`） |
| I6 | 网关信号 | `ready` / `resumed` / `error` / `disconnected`（`src/gateway/bootstrap.ts:222`） | 补发积压、恢复当前会话、恢复失败通知、插件与安装公告、指令面板与菜单同步、断线清队、释放挂起项 |

## 4. 出站路径

| # | 路径 | 触发与入口 | 要做的事 |
|---|---|---|---|
| O1 | assistant 正文 | `session/event` 的 `assistant/message` → `outbound.route`（`src/transport/outbound.ts:125`） | 事件解析、文本与内嵌图片分段、非当前会话署名、本地文件链接改写、按 `textChunkLimit` 分片、按会话串行、失败分类、transient 重试一次、断网入队补发、超长减半重切、被拦截时提示 |
| O2 | 工具结果 | `tool/result`，仅 `showToolResults` 打开时 | 结果格式化（成功 / 失败 / 带视图），其余同 O1 |
| O3 | 轮次失败与重试提示 | `turn/end`、`llm/retry` | 错误渲染、重试计数与提示（`outbound.ts:297`），其余同 O1 |
| O4 | 交付物 | `deliverables/presented` → `deliverables.deliver`（`src/transport/deliverables.ts:47`） | 逐个文件发送、单轮数量上限、失败聚合、清单渲染；提示文本走 `sender.text`（分片 + transient 重试一次）并带署名，文件本身直发、不入队，轮末排在正文之后 |
| O5 | 内嵌图片 | assistant 内容块 → `OutboundImages.send`（`src/transport/outbound-images.ts:156`） | 取宿主路径或读字节、逐张 `sendImage`、失败只记日志 |
| O6 | 命令回复 | 12 个命令 handler → `sendMarkdownChunked`（`src/shared/send-helper.ts:12`）→ `sendChunkedText`（`src/transport/send.ts:73`） | 目标解析、分片、transient 重试一次；没有署名、不入队 |
| O7 | 提问卡 | `user-questions/request` → `sendQuestion`（`src/features/question-channel.ts:505`） | 题目与选项渲染、`sender.card` 带键盘（失败自动降级纯文本）、非当前会话首行、路由提示、超时通知（`sender.text`）、多题顺序、挂起后重发 |
| O8 | 审批卡 | `approval/request` → `park`（`src/features/approval-channel.ts:250`） | 命令摘要与选项渲染、`sender.card` 带键盘（无纯文本兜底）、发送失败交回宿主答案者、点击校验 owner 与 nonce |
| O9 | 重试卡与确认卡 | `retry-channel.offer`（`src/features/retry-channel.ts:83`）、`session-confirm.offer`（`src/features/session-confirm.ts:113`） | 重试卡 `sender.card` 带纯文本兜底、确认卡 `sender.card` 无兜底；回执 `sender.text`、超时定时器、nonce、署名（`sender.decorate`）；确认卡投递失败直接放弃动作 |
| O10 | 启动与公告 | `ready` 恢复失败（`bootstrap.ts:239`，走 `sender.text`）、`reload/index.ts:145`、`plugins/index.ts:167` | 恢复失败分片 + transient 重试一次；热重载 / 插件结果仍是单条直发；`qqbot-cmd-input` 按钮、目标取自持久化的 `targets` |
| O11 | 未知指令与入站兜底 | I4、I1 的 `followup` 失败（`inbound.ts:107`）、工作树回执（`inbound.ts:119`） | 都走 `SendText`（即 `Sender.text`）：分片 + transient 重试一次；未知指令另带 markdown → 纯文本降级 |
| O12 | 文件与媒体 | `/get`、交付物 | 路径存在性与普通文件校验、`sendFile` / `sendImage`、大小与数量限制 |
| O13 | 平台操作 | `typingIndicator`（`middleware-setup.ts:110`）、按钮 `ack`、面板同步（`bootstrap.ts:259`）、菜单同步（`bootstrap.ts:270`） | 非聊天消息的 API 调用，失败只记日志 |

## 5. 路径 × 功能矩阵

图例：`✓` 已实现；`△` 部分实现或行为有差异；`—` 不涉及。

### 5.1 出站

| # | 路径 | 凭证 | 署名 | 分片 | 串行 · 入队 | 重试 | 降级 | 状态机 | 媒体 |
|---|---|---|---|---|---|---|---|---|---|
| O1 | assistant 正文 | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | △ |
| O2 | 工具结果 | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | △ |
| O3 | 失败与重试提示 | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | △ |
| O4 | 交付物 | ✓ | ✓ | △ | △ | ✓ | — | — | ✓ |
| O5 | 内嵌图片 | ✓ | — | — | △ | — | — | — | ✓ |
| O6 | 命令回复 | ✓ | — | ✓ | — | ✓ | — | — | — |
| O7 | 提问卡 | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | — |
| O8 | 审批卡 | ✓ | ✓ | ✓ | — | ✓ | △ | ✓ | — |
| O9 | 重试卡与确认卡 | ✓ | ✓ | ✓ | — | ✓ | △ | ✓ | — |
| O10 | 启动与公告 | ✓ | — | △ | — | △ | — | — | — |
| O11 | 未知指令与兜底 | ✓ | — | ✓ | — | ✓ | △ | — | — |
| O12 | 文件与媒体 | ✓ | — | — | — | — | — | — | ✓ |
| O13 | 平台操作 | — | — | — | — | — | — | — | — |

差异说明：

- O4：文件本身直发，只有未送达提示走 `sender.text`；轮末等待正文发完再投递，文件不进 Outbox。
- O5：经会话链串行，但不进 Outbox。
- O8：没有纯文本降级，键盘发送失败交回宿主答案者。
- O9：重试卡有纯文本降级；确认卡失败直接放弃动作。
- O10：恢复失败的通知走 `sender.text`（分片 + 重试）；热重载 / 插件结果仍是单条直发，所以分片与重试记为 △。
- O11：已有 markdown → 纯文本的格式降级（仅未知指令；入站兜底没有第二版文案），没有键盘降级。
- O1–O9 的发送动作都收敛到 `src/transport/send.ts`：`text` / `card` / `session` / `decorate` 四个入口，路径按需取用。
- O1–O3 的媒体列是 △：内嵌图片与会话正文里的本地图片走 O5。
- O13 不产生聊天消息，只做 `ack`、输入状态、面板与菜单同步。

### 5.2 入站

| # | 路径 | 访问控制 | 凭证登记 | 附件 · 引用 | 会话寻址 | 宿主转发 | 回复发送 | 状态机 | ack |
|---|---|---|---|---|---|---|---|---|---|
| I1 | 普通消息 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| I2 | 斜杠命令 | ✓ | ✓ | — | △ | ✓ | ✓ | △ | — |
| I3 | 提问答案 | ✓ | ✓ | — | ✓ | — | — | ✓ | — |
| I4 | 未知指令 | ✓ | ✓ | — | — | — | ✓ | — | — |
| I5 | 按钮点击 | ✓ | ✓ | — | ✓ | ✓ | — | ✓ | ✓ |
| I6 | 网关信号 | — | — | — | ✓ | — | ✓ | — | — |

- I2 的会话寻址是 △：只有 `/to`、`/sessions`、`/new` 这类命令涉及会话；状态机是 △：只有 `/clear` 走确认卡。
- I3 命中后只推进状态、不回复，所以回复发送为 `—`。
- I6 的回复发送指恢复失败通知这类单条出站。

## 6. 共用功能

纵向看矩阵，重复出现的行才是需要统一处理的地方：

| 功能 | 涉及路径 |
|---|---|
| 被动凭证 | 全部出站（O13 的 `ack` 不走消息凭证） |
| 目标解析 | 全部聊天发送 |
| 非当前会话署名 | O1–O4、O7–O9（统一实现：`send.ts` 的 `decorate`） |
| 本地链接改写 | O1–O4 |
| 按 4500 分片 | O1–O4、O6–O9、O11（O4 仅提示文本，O10 仅恢复失败通知） |
| 按会话串行 | O1–O5 |
| 失败分类与后续动作 | O1–O4 入队；O6–O9、O11 网络类重试一次；O10 恢复失败与公告都重试一次 |
| 键盘与纯文本降级 | O7–O9 |
| 状态机、超时、nonce | O7–O9 |
| 媒体发送 | O4、O5、O12 |
| 附件、引用、语音 | I1 |
| owner 校验 | I1–I5（I1–I4 由 accessPolicy；I5 网关 + 四个通道） |
| `ack` | I5 |

## 7. 已知不一致

1. 交付物的文件本身不过 Outbox：`deliverables.ts` 的 `sendMediaFile` 直接发，断线不入队，失败只在轮末聚合成一条文字（提示文本已走 `sender.text`）。
2. 热重载 / 插件结果公告由 `bootstrap` 注入 `notify = sender.text`（`reload/index.ts:145`、`plugins/index.ts:167`）；未注入时退回裸 `bot.sendMarkdown`，只出现在独立构造的场景（测试、命令层没有 sender）。
4. 审批卡没有纯文本降级（`approval-channel.ts` 的 `sender.card` 不传 fallback），确认卡同理。
5. 媒体与平台操作（O5、O12、O13）不是聊天文本，仍直接用 SDK 的 `sendFile` / `sendImage` / `ack`。

## 8. 代码入口

| 方向 | 入口 | 位置 |
|---|---|---|
| 入站 | 消息 | `src/gateway/bootstrap.ts:105` → `src/transport/inbound.ts:70` |
| 入站 | 按钮 | `src/gateway/bootstrap.ts:194` |
| 入站 | 中间件顺序 | `src/gateway/middleware-setup.ts:33` |
| 出站 | 事件路由 | `src/transport/outbound.ts:125` |
| 出站 | 统一发送层 | `src/transport/send.ts:95` 的 `createSender`（`text` / `card` / `session` / `decorate`）、`sendChunkedText`（`:73`）、`SendText` 类型（`:61`） |
| 出站 | 发送与入队 | `src/transport/send.ts` 的 `session`（分片 → Outbox → 超长减半 → 拦截提示） |
| 出站 | 凭证 | `src/transport/reply-bot.ts:41`、`src/transport/reply-store.ts` |
| 出站 | 分片 | `src/transport/chunker.ts:92` |
| 出站 | 失败分类 | `src/transport/outbox.ts` 的 `classifyDeliveryError` |
| 出站 | 署名 | `src/transport/session-source.ts` |
