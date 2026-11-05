<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 QQ Bot 插件，将 DeepSeek AI 助手接入 QQ 私聊。**

[![npm version](https://img.shields.io/npm/v/@tencent-connect/dsh-qqbot)](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tencent-connect/dsh-qqbot)](https://github.com/tencent-connect/dsh-qqbot)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)

<br/>

**[English](./README_EN.md) | 简体中文**

扫码加入 QQ 群 / 频道

<table>
<tr>
<td align="center" width="50%"><img src="./assets/docs/qqgroup.jpg" height="360" alt="QQ 群二维码" /><br /><b>QQ 开发者交流群</b><br /><sub>1群: 1032635674 · 2群: 1056948758</sub></td>
<td align="center" width="50%"><img src="./assets/docs/qqchannel.jpg" height="360" alt="QQ 频道二维码" /><br /><b>QQ 开发者社区频道</b><br /><sub>频道号: 20dnumts4z</sub></td>
</tr>
</table>

</div>

## 架构

```
QQ 用户 → QQ WebSocket → dsh-qqbot → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

## 安装

### 方式一：桌面版安装（推荐）

无需命令行，全程在应用内完成：

1. **安装**：左侧栏点击「插件」→「添加插件」→ 输入 `@tencent-connect/dsh-qqbot@latest` → 安装并立即启动

<img src="./assets/docs/install.png" alt="端内添加插件" width="560" />

2. **连接**：左下角头像 → 设置 →「QQ 机器人」→ 手机 QQ 扫码连接

<img src="./assets/docs/setting.png" alt="设置页扫码连接" width="560" />

扫码成功后凭据自动保存，后续启动无需再次扫码。

### 方式二：手动执行

```bash
# 安装到 profile
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# 启动
npx @deepseek-ai/dsh --profile qqbot
```

首次启动时，插件检测到凭据未配置会自动进入扫码引导：终端输出二维码 → 手机 QQ 扫码绑定 → 凭据自动保存到 profile，后续启动无需再次扫码。

无端内绑定页的环境（如纯 CLI）可设置 `QQBOT_BIND_OPEN_BROWSER=1`，额外拉起系统浏览器扫码页作为降级通道。

<img src="./assets/docs/qrcode.png" alt="二维码扫码示意图" width="280" />

> **提示**：建议升级至 `0.4.0` 以上版本扫码，支持点击链接在浏览器打开，避免部分终端二维码渲染错位的问题。

### 方式三：本地路径安装

```bash
# 构建
cd /path/to/dsh-qqbot
pnpm install && pnpm build

# 安装到 profile（本地路径）
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot

# 启动
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh --profile qqbot
```

### 方式四：--patch 开发模式

```bash
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | **必填** | QQ Bot AppID（或通过 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | **必填** | QQ Bot AppSecret（或通过 `QQBOT_SECRET` 环境变量） |
| `provider` | string | `deepseek-official` | LLM 提供商名称 |
| `model` | string | `deepseek-chat` | 模型名称 |
| `preset` | string | - | Agent preset id |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `streaming` | boolean | `true` | 是否启用流式输出 |
| `processingTimeoutMs` | number | `1800000` | 处理超时(ms)，超时中断当前 LLM 调用 |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `askTimeoutMs` | number | `300000` | 待答问题超时(ms)，默认 5 分钟（ask_user_question） |
| `showToolResults` | boolean | `false` | 是否展示工具调用成功结果（错误始终展示） |
| `debug` | boolean | `false` | 调试模式 |

### 聊天会话与后台会话

插件区分两个概念：**聊天会话**是 QQ 这一侧当前的对话现场，**后台会话**是宿主里的 session 日志。

- 当前聊天会话全 bot 只有一个：任何私聊窗口续写、看到的都是同一段上下文。
- 后台会话仍有多份：`/sessions` 默认列出 QQ 已持有的会话，`/sessions workspace` 看当前工作区，`/new` 新开一个。`/sessions resume` 与 `/to` 实际拿到的会话会留在「已获取集合」里继续活着，输出、提问、审批都回 QQ（非当前带 `[#短id]`）。
- 会话不按闲置时间回收：长任务跑再久也不会被中断。

多个私聊同时说话时，回复发给最后一条消息所在的私聊。

### 访问控制（access）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | 私聊访问模式 |
| `access.c2cAllow` | string[] | `[]` | 私聊白名单（user openid） |

### 富媒体理解（media）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | 是否启用富媒体理解（图片/视频下载 + 工具分析） |
| `media.maxMB` | number | `200` | 富媒体下载大小上限(MB) |
| `media.ttlHours` | number | `24` | 富媒体存活时长(小时)，0=永不过期 |

### 视觉理解（vision）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vision.enabled` | boolean | `false` | 是否启用视觉理解（qqbot_describe_image 工具） |
| `vision.provider` | string | - | 视觉模型 provider（如 pi-ai） |
| `vision.model` | string | - | 视觉模型 id（如 qwen-vl-max） |
| `vision.maxBytes` | number | `10MB` | 图片字节上限 |
| `vision.maxTokens` | number | `1024` | 输出 token 上限 |
| `vision.timeoutMs` | number | `120000` | 视觉调用超时(ms) |

### 附件发送（sendFile）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | 是否启用路径白名单（仅 media + 当前会话工作目录 + extraRoots） |
| `sendFile.extraRoots` | string[] | `[]` | 额外允许访问的根目录 |

### 指令面板（panel）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `panel.autoSync` | boolean | `true` | 机器人就绪后自动把当前指令同步到指令面板 |

指令面板就是手机 QQ 里输入 `/` 后弹出的指令列表。开启 `panel.autoSync` 后，每次机器人就绪都会把插件内置命令（含说明）推到私聊全局面板；没有面板时创建，已有本插件建的面板（`remark` 为 `im-qqbot:commands`）时原地更新。改完命令想立即重推，发 `/bot-sync`（仅白名单可用）。

### 自定义菜单（menu）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `menu.autoSync` | boolean | `true` | 机器人就绪后自动同步单聊自定义菜单 |

菜单是**私聊窗口底部**的四个按钮：`会话状态`（`/status`）、`会话列表`（`/sessions`）、`创建会话`（`/new`）、`压缩会话`（`/compact`），点击后把对应命令填进输入框。

菜单是机器人级全局配置，所有用户看到同一份，而且改完要退出对话框再进来才看得到新内容——所以这里只放静态动作，不做按会话变化的动态文案（上下文占比看 `/status`）。机器人就绪时同步一次，内容没变不会重复写；手动重推用 `/bot-sync`（仅白名单可用），`menu.autoSync=false` 可关掉自动同步。菜单接口是整体覆盖，同步时按 `send_message` 认领本插件的按钮，用户手工加的其它按钮会原样保留在后面。

## 内置命令

| 命令 | 说明 |
|------|------|
| `/new` | 开始新会话（清空上下文）；可带工作区：`/new <工作区\|路径>` |
| `/reset`（别名 `/clear`） | 停止当前会话并在原工作区开启新会话；`/reset all` 停掉所有已获取会话 |
| `/compact` | 压缩会话历史（摘要替换旧记录，保留上下文）；回复只报压缩条数与 token |
| `/sessions`（别名 `/session`） | 会话管理：默认列出 QQ 已持有的会话（含状态与当前项），`workspace` 看当前工作区，`all` 看全部 |
| `/to` | 向指定会话发消息，或在它提问时提交答案 |
| `/workspace` | 工作区：查看 / 切换（只能在 `/new` 之后改） |
| `/ls` | 列出目录里的子目录，点条目逐层进入 |
| `/model` | 查看或切换模型 |
| `/preset` | 查看或切换 agent preset（新会话生效） |
| `/permission` | 查看或切换权限预设（沙箱模式 + 审批策略，当前会话立即生效；仅白名单可用） |
| `/cost` | 查看当前会话的 token 消耗 |
| `/status` | 查看会话状态：工作区 / 模型 / 上下文 / token |
| `/stop` | 中止当前生成；`/stop all` 中止所有已获取会话中正在生成的 |
| `/bot-ping` | 网络延迟检测（返回传输与处理耗时） |
| `/bot-version` | 查看版本信息 |
| `/bot-me` | 查看你的 OpenID（配置白名单用） |
| `/bot-status` | 查看当前会话状态（简版，完整状态看 `/status`） |
| `/bot-help` | 查看所有指令 |
| `/bot-sync`（别名 `/bot-refresh`） | 同步指令面板与自定义菜单（仅白名单可用） |

> 指令名拼错（如 `/modle`、`/sesions`）不会被当作提问转发给大模型：机器人直接回「没有这个指令」，能猜到意图时给出可点击的正确指令。只有「斜杠 + ASCII 指令名」算指令，`/usr/local/bin`、`/今天` 这类文本照旧交给模型；全角 `／` 与半角 `/` 等价，中文输入法下可以直接敲。

## 工作区（workspace）

工作区是宿主对「一个目录 + 跑在这个目录里的会话」的持久分组记录（`ctx.workspaceRegistry`），Web 侧栏看到的项目分组就是它。本插件遵循同一套规则：

- **没有 `cwd` 配置**：会话的工作目录由宿主决定，插件不再写死一个目录。
- **新会话落在宿主的默认工作区**（首次使用时建在 `Documents/deepseek-harness/default-workspace`）；宿主没有默认工作区时退回 dsh 的启动目录。
- **工作区跟着会话走**：`/sessions resume` 切到哪个会话，这个聊天的工作目录就变成那个会话的目录；之后 `/new` 也留在同一个工作区，重启后依然记得（记录在 `~/.dsh-qqbot/model-prefs.json` 的 `dirs` 里）。
- **显示名用目录名**：插件不再给工作区起 `QQBot` 这种名字，宿主按目录最后一段自动命名；老版本留下的 `QQBot` 标题会在下次挂载时迁移成目录名（用户自己改过的名字不动）。

### 换工作区（`/workspace`）

工作区就是会话的 `cwd`。它在会话创建时写进会话 header，宿主没有修改它的接口，所以换工作区只能在**会话落盘之前**生效：

| 用法 | 说明 |
|------|------|
| `/new <名字\|路径>` | 一步到位：在新工作区开新会话（最常用） |
| `/workspace` | 查看当前工作区（标题 / 路径 / 还能不能改） |
| `/workspace <名字\|路径>` | 只换工作区、不开新会话（`/new` 之后用） |

- 时机只有两个：**`/new` 之后**，或这个聊天还没说过话。已有会话时 `/workspace` 会拒绝，并提示改用 `/new <名字|路径>`——已有会话的目录已经写进它的 header，改记录不会生效（恢复会话时以 header 为准）。
- 工作区认**标题**、**目录名**（大小写不敏感，支持唯一前缀）或**绝对路径**；换完的下一条消息会在新目录里创建会话，宿主的侧边栏里同时出现对应工作区。目录不存在或不是目录会被拒绝，不会留下半改状态；`/new <路径>` 会先校验再动会话，路径写错不会把当前会话弄丢。
- 不知道路径怎么写就用 `/ls`：列出当前工作区的子目录，点条目逐层进入，每个条目填进输入框的都是绝对路径，点进第几层都不会跑偏。
- 与 `/sessions` 同一权限面：只允许**私聊 + 白名单**（`access.c2cAllow`）——换工作区等于换 agent 能读写的目录。不带参数的 `/new` 不受限制。

### 会话管理（`/sessions`）

`/sessions` 默认回答“QQ 现在持有哪些会话”，数据来自运行期的已获取集合；工作区视图和全部视图仍与 Web 侧栏同一来源（宿主 `sessionQuery` / `sessionPersistence`）。

| 用法 | 说明 |
|------|------|
| `/sessions` | 列出 QQ 已持有的会话（跨工作区，当前项优先）；每行展示 `生成中` / `空闲`，当前项行尾 `✅`；当前指针不在持有集合里时单独补一行 `待恢复`；每页 10 条 |
| `/sessions <页码>` | 持有列表的下一页，例如 `/sessions 2`；页脚给出 `上一页 · 第 1/2 页 · 下一页` |
| `/sessions workspace` | 列出**当前工作区**里未归档的会话（按创建时间倒序，每页 10 条）；只给持有会话标 `📌`，不标当前项，也不显示生成状态 |
| `/sessions workspace <页码>` | 工作区视图的下一页；页脚格式与持有列表相同 |
| `/sessions all` | 按工作区分组列出全部会话（组内先置顶），跨项目找会话用；持有会话标 `📌`，不标当前项；组内不显示序号，只用短 id；每页 10 条 |
| `/sessions all <页码>` | 全部工作区视图的下一页；翻页后仍会重复页首会话所属的工作区标题；页脚格式相同 |
| `/sessions resume <序号\|id>` | 把当前聊天切到该会话，历史接上继续聊（目标若已归档会顺带取消归档），工作区跟着切；**序号只按持有列表解析** |
| `/sessions archive <序号\|id>[,<序号\|id>…]` | 归档会话：从本命令与 Web 侧栏隐藏，**磁盘日志保留**，可随时取消归档；多个目标用英文逗号分隔（一次最多 10 个）；不带目标时先列当前工作区候选，再补其它工作区的持有会话供点击（不编号，超过一页用 `page <页码>` 翻页） |
| `/sessions archived [页码]` | 查看已归档会话；每行带短 id 与所属工作区，点一下把 `/sessions unarchive <id>` 填进输入框；底部的翻页与返回列表也是链接 |
| `/sessions unarchive <id>[,<id>…]` | 取消归档，让它重新出现在列表里 |
| `/to <会话> <文本>` | 向指定会话发一条消息；目标在等 `ask_user_question` 时，文本会作为答案提交 |
| `/to <会话>` | 目标在等答案时进入「下一条消息作为回答」模式 |

注意：

- **句柄规则**：每行都显示 8 位短 id（形如 `#3f2a9b1c`，`#` 可省略），任何视图都能用它操作；**序号只对 `/sessions` 的持有列表有效**，且跨页连续。`workspace` / `all` / `archived` / 归档候选都不编号。
- **分页**：多页列表的页脚统一为 `上一页 · 第 1/2 页 · 下一页`，缺哪边省略哪边；页码不放在标题里，也不显示「还有 N 个」。
- 状态词只在持有列表里出现：`生成中`（agent 正在跑）、`空闲`（持有但待命）；当前指针指向但尚未获取的会话显示 `待恢复`。其它视图只给持有会话标 `📌`（表示 QQ 已持有），不标当前，也不显示状态。
- 只允许**私聊**使用，且操作者必须在白名单（`access.c2cAllow`）内——会话标题、归档状态都涉及其他聊天的数据；未配置名单时命令直接不可用（`/bot-me` 可查自己的 OpenID）。
- 归档走宿主 `workspaceRegistry.archiveSession`，只写 registry 的全局归档集，**不删任何文件**；本插件不提供物理删除，需要清理磁盘请到 Web 端或手动处理。
- 归档依赖宿主的 workspace registry（`@deepseek-ai/dsh-workspace`）：web / Desktop profile 自带；只装 `dsh-base` + 本插件的自建最小 profile 需要手动挂载它，否则命令会提示「宿主未挂载会话归档接口」。
- 归档前会释放该会话在本进程内的 agent；如果它就是当前会话，还会把聊天映射改到新会话——归档会话会被宿主的 `agent/pre-step` 闸门拒绝，继续挂在它上面聊天会收不到回复。
- **多个会话可以同时活着**：普通消息、`/sessions resume`、`/to` 实际拿到 agent 的会话都会加入「已获取集合」。所有已获取会话的输出、提问、审批都会发回 QQ；当前会话不加标记，其它会话的消息带 `[#短id]`。已获取集合只在运行期存在，重启后只有当前会话从 `model-prefs.json` 恢复。
- **切走不释放**：`/sessions resume` 只改当前指针，旧会话继续在后台跑、输出继续回 QQ；`/new` 同理。插件卸载时只 dispose 自己创建的 agent，Web/TUI 创建的只丢引用。
- **问答按会话路由**：当前会话直接回文本；其它会话的按钮带 session id，点按钮就能答；没有按钮的问题会附 `/to #id ` 链接。一条没走链接的纯文本不会误发给当前模型，会提示用按钮或 `/to`。
- 持有列表按「当前 → 其它持有（获取时间倒序）」排；工作区视图按创建时间倒序。列表时间是**创建时间**（宿主 header 不存「最后使用时间」）。
- 跨工作区恢复后，agent 会在**那个会话自己的目录**里干活；文件发送白名单也随该目录变化。


## 核心模块

```
src/
├── index.ts                    # Cordis 插件入口（async apply）
├── config.ts                   # 配置 Schema
├── types.ts                    # 全局类型定义
├── setup/                      # 凭据绑定（扫码）
│   ├── index.ts                # 绑定编排（ensureCredentials）
│   ├── binding-service.ts      # 扫码状态机（宿主内唯一事实源）
│   ├── bind-routes.ts          # 端内绑定页路由（/qqbot/im-qqbot/bind）
│   ├── presenters.ts           # 呈现策略（终端/浏览器降级）
│   ├── qr-svg.ts               # 二维码 SVG 渲染（宿主侧）
│   └── persist.ts              # 凭据写入 cordis.patch.yml
├── client/                     # 浏览器半边（dsh.client Web Bundle）
│   ├── index.ts                # 侧栏 Tab 注册 + 待绑定自动引导
│   └── bind-page.ts             # 端内绑定页（二维码 + 状态轮询）
├── gateway/                    # 网关装配
│   ├── bootstrap.ts            # 启动装配（监听 session/event 等）
│   └── middleware-setup.ts     # 中间件链配置
├── transport/                  # 传输层
│   ├── inbound.ts              # QQ 入站消息 → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # 流式缓冲
│   ├── streaming-writer.ts     # 流式写入
│   ├── reply-target.ts         # 回复目标解析
│   ├── msgid-cache.ts          # 被动回复 msgid 缓存
│   ├── reply-limiter.ts        # 被动回复限流
│   ├── tool-presenter.ts       # 工具调用展示
│   └── chunker.ts              # Markdown 文本切分
├── session/                    # 会话管理层
│   └── session-manager.ts      # 聊天会话 → Agent 映射与后台会话切换
├── model/                      # 模型路由层
│   ├── model-resolver.ts       # 路由解析
│   ├── prefs-store.ts          # 偏好持久化
│   └── settings-reader.ts      # settings.yaml 只读
├── features/                   # 交互特性
│   ├── question-channel.ts     # ask_user_question 问答通道
│   ├── approval-channel.ts     # approval 审批确认通道
│   └── answer-parser.ts        # 答案解析
├── media/                      # 多媒体
│   ├── vision-tool.ts          # 图片视觉理解
│   ├── send-file-tool.ts       # 发送本地文件
│   └── media-cleaner.ts        # 媒体 TTL 清理
├── middleware/                 # 中间件
│   ├── question-answer.ts      # 问答答案处理
│   ├── unknown-command.ts      # 拼错指令拦截（不转发给模型）
│   └── attachment.ts           # 附件处理
├── shared/                     # 共享工具
│   ├── utils.ts                # 通用函数
│   ├── scope.ts                # scope/peer 提取
│   └── send-helper.ts          # 分块发送
└── commands/                   # 斜杠命令
```

## 会话路由

聊天会话的 key 固定为 `qqbot:${appId}:chat`，它只决定「当前接哪个会话」；已获取的会话可以有多份。新会话铸造 UUID 会话 id 并持久化到 `model-prefs.json`，重启后只有当前会话按持久化 id 恢复；没有映射即视为全新会话。

解析策略：已获取记录 → 进程内 live agent → 持久化恢复 → 全新创建（仅当前会话；`/sessions resume` 失败不创建）。

## 设计原则

- **纯 Cordis 插件** — 遵循 dsh "Plugins, not loop changes" 原则
- **声明式依赖** — `inject = ['agents']`，不直接耦合其他插件
- **一个当前会话 + 多份已获取会话** — 任何 QQ 窗口续写同一个当前会话；`/sessions resume` 与 `/to` 获取过的会话继续活着并把输出发回 QQ
- **Preset 支持** — 可通过 `agent-presets` 服务挂载预设（工具集、prompt 等）
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块/表格感知切分
- **图片理解** — 支持 `qqbot_describe_image` 视觉理解，可分析用户发送的图片
- **附件发送** — 支持 `qqbot_send_file` 将本地文件发送给用户（默认启用路径白名单）
- **问答互动** — 支持 `ask_user_question`，单选生成内联按钮（点一个其余变灰）、多选回复编号，逐题推进 + 问题级超时
- **操作确认** — 支持 `approval/request`，关键操作通过「允许/拒绝」按钮请求用户确认

## 本地开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 开发模式（watch）
pnpm dev

# 用 --patch 方式调试
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## License

[MIT](./LICENSE)
