<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_SuperTerm-blue?style=for-the-badge" alt="QQ SuperTerm" />

**把 deepseek-harness 装进 QQ 私聊：会话、模型、权限、文件、审批，都在聊天窗口里完成。**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](https://nodejs.org/)

<br/>

**[English](./README_EN.md) | 简体中文**

</div>

## 这是什么

QQ 超级终端（`dsh-qqterm`）是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 QQ 渠道终端。它把 dsh 的 agent 能力接到 QQ 私聊里：发一条消息就是一轮对话，发一条 `/` 开头的指令就能查看和切换会话、模型、思考强度、权限预设，也能让 agent 直接读写工作区、发送文件。

特性：

- **一个窗口就是终端** — 对话、指令、面板、菜单都在 QQ 私聊里，不需要另开网页或客户端。
- **会话可切换** — `/sessions` 按工作区分组列出会话，`/to` 给任意会话发消息，后台会话继续跑并把结果发回 QQ。
- **贴着宿主核心行为** — 模型、preset、思考强度、权限预设都走 dsh 自己的选择路径，插件不另存一套偏好。
- **能干活** — 工作区读写、附件理解、文件发送、`ask_user_question` 问答、`approval` 审批确认。
- **单用户私聊** — 只服务绑定的那一个人，群聊不支持；扫码即完成绑定。

## 架构

```
QQ 用户 → QQ WebSocket → dsh-qqterm → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

插件本身是一个纯 Cordis 插件：宿主加载 `lib/index.js`，浏览器加载 `lib/client.js` 提供设置页入口，不修改宿主 loop。

## 安装

### 方式一：桌面版安装（推荐）

无需命令行，全程在应用内完成：

1. **安装**：左侧栏点击「插件」→「添加插件」→ 输入 `dsh-qqterm` → 安装并立即启动

<img src="./assets/docs/install.png" alt="端内添加插件" width="560" />

2. **连接**：左下角头像 → 设置 →「QQ 超级终端」→ 手机 QQ 扫码连接

<img src="./assets/docs/setting.png" alt="设置页扫码连接" width="560" />

扫码成功后凭据自动保存，后续启动无需再次扫码。

### 方式二：手动执行

```bash
# 安装到 profile
npx @deepseek-ai/dsh plugin --profile qqterm add dsh-qqterm

# 启动
npx @deepseek-ai/dsh --profile qqterm
```

首次启动时，插件检测到凭据未配置会自动进入扫码引导：终端输出二维码 → 手机 QQ 扫码绑定 → 凭据自动保存到 profile，后续启动无需再次扫码。

无端内绑定页的环境（如纯 CLI）可设置 `QQBOT_BIND_OPEN_BROWSER=1`，额外拉起系统浏览器扫码页作为降级通道。

<img src="./assets/docs/qrcode.png" alt="二维码扫码示意图" width="280" />

### 方式三：本地路径安装

```bash
# 构建
cd /path/to/dsh-qqterm
pnpm install && pnpm build

# 安装到 profile（本地路径）
npx @deepseek-ai/dsh plugin --profile qqterm add /path/to/dsh-qqterm

# 启动
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh --profile qqterm
```

### 方式四：--patch 开发模式

```bash
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqterm/cordis.dev.yml
```

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | **必填** | QQ Bot AppID（或通过 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | **必填** | QQ Bot AppSecret（或通过 `QQBOT_SECRET` 环境变量） |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `askTimeoutMs` | number | `300000` | 待答问题超时(ms)，默认 5 分钟（ask_user_question），0=不超时 |
| `showToolResults` | boolean | `false` | 是否展示工具调用结果（成功与失败都受此开关控制） |
| `debug` | boolean | `false` | 调试模式 |

### 聊天会话与后台会话

插件区分两个概念：**聊天会话**是 QQ 这一侧当前的对话现场，**后台会话**是宿主里的 session 日志。

- 当前聊天会话全 bot 只有一个：任何私聊窗口续写、看到的都是同一段上下文。
- 后台会话仍有多份：`/sessions` 默认按工作区分组列出工作中会话，`/sessions all` 看全部会话，`/new` 新开一个。`/sessions resume` 与 `/to` 实际拿到的会话会留在「已获取集合」里继续活着，输出、提问、审批都回 QQ（非当前会话的消息在正文前标 `#短id · 标题`，正文后空一行、单独一行给「回复」「恢复」两个链接）。
- 会话不按闲置时间回收：长任务跑再久也不会被中断。
- 排队只发生在同一个会话内部：当前会话空闲时消息立刻开跑，不会因为另一个会话正在生成而等待；同一会话连发多条则按顺序各跑一轮。

多个私聊同时说话时，回复发给最后一条消息所在的私聊。

### 模型、preset 与思考强度

模型与思考强度跟着**当前会话**走，preset 是部署级设置，都沿用宿主核心行为：

- 新会话（`/new`、第一条消息）取宿主核心的当前值：`settings.yaml` → 宿主 agentDefaultModel → `deepseek-official/deepseek-v4-flash`。插件配置里没有 `provider` / `model` / `preset`，这三项以宿主为准。
- `/model` 走宿主同一条切换路径：选择记进当前会话（不重建、不改历史），下一轮生效；没有活跃会话时直接写部署默认值，回执与有会话时一致。
- `/reasoning` 走同一个入口：写进当前会话，下一轮生效；按核心行为，它同时成为全局的当前选择，新会话会跟随；没有活跃会话时同样写部署默认值。
- `/preset` 与设置页「设为默认」是同一个入口：写入的 preset 对之后新建的会话生效，已开始的会话保持自己的 preset。
- 没有会话时，`/model`、`/reasoning`、`/permission` 的查看视图照常展示当前值——那就是部署默认值（新建会话会拿到的值），写法不变。
- `/permission` 有会话时立即作用于当前会话；没有会话时写部署默认预设。

### 访问控制（access）

超级终端只服务一个用户：其他私聊一律拒绝，群聊不支持。扫码绑定会把扫码者自动写成唯一用户；手动绑定或换人时在设置页填 OpenID。

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `access.owner` | string | `""` | 唯一允许的用户（QQ OpenID）；留空拒绝所有人 |

### 富媒体理解（media）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | 是否启用富媒体理解（图片/视频下载 + 工具分析） |
| `media.maxMB` | number | `200` | 富媒体下载大小上限(MB) |
| `media.ttlHours` | number | `24` | 富媒体存活时长(小时)，0=永不过期 |

### 附件发送（sendFile）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sendFile.sendPresentedFiles` | boolean | `true` | 是否把 present 声明的交付文件发送到当前会话 |
| `sendFile.maxFiles` | number | `4` | 单轮最多投递的交付文件数 |

交付文件与 `/get` 都只发给唯一绑定用户（`access.owner`），因此不限制目录：`~/.dsh-qqterm/media`、当前会话工作目录、任意绝对路径都能发。助手消息里的图片由附件服务定位后直接发送。

助手正文里的本地文件链接（`/`、`./`、`../`、盘符开头，或相对工作目录能命中的路径）在发送前改写成 `/get <绝对路径>` 命令链接：QQ 点不开本地路径，点这个链接由插件把文件发到聊天里。`/get <路径>` 也可以手动输入，路径不限。

### 指令面板（panel）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `panel.autoSync` | boolean | `true` | 机器人就绪后自动把当前指令同步到指令面板 |

指令面板就是手机 QQ 里输入 `/` 后弹出的指令列表。开启 `panel.autoSync` 后，每次机器人就绪都会把插件内置命令（含说明）推到私聊全局面板；没有面板时创建，已有本插件建的面板（`remark` 为 `qqterm:commands`）时原地更新。

### 自定义菜单（menu）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `menu.autoSync` | boolean | `true` | 机器人就绪后自动同步单聊自定义菜单 |

菜单是**私聊窗口底部**的七个固定入口：`会话状态`（`/status`）、`会话列表`（`/sessions`）、`重置会话`（`/reset`）、`压缩会话`（`/compact`）、`长期目标`（`/goal`），以及两个直接带子菜单的折叠项——`权限预设`（`查看权限` / `仅可查看` / `工作区内修改` / `完全权限` / `自动审查`）和 `思考强度`（`查看强度` / `关闭` / `低` / `高` / `最高`）。点击任意一项都会把对应命令填进输入框，权限与当前会话仍由命令自己校验。

菜单是机器人级全局配置，所有用户看到同一份，而且改完要退出对话框再进来才看得到新内容——所以这里只放静态动作，不做按会话变化的动态文案（上下文占比看 `/status`）。机器人就绪时同步一次，内容没变不会重复写；`menu.autoSync=false` 可关掉自动同步。菜单接口是整体覆盖：每次同步写入本插件这一份固定入口，其它按钮不会保留。

## 内置命令

| 命令 | 说明 |
|------|------|
| `/new` | 开始新会话（清空上下文）；可带工作区：`/new <工作区\|路径>`；目录在 Git 仓库里时先建一棵工作树、会话落在树里；不停旧会话，直接执行 |
| `/clear`（别名 `/reset`） | 停止当前会话并在原工作区开启新会话；`/clear all` 停掉所有已获取会话；有会话时先发确认卡，5 分钟内点 ✅ 才执行 |
| `/compact` | 压缩会话历史（摘要替换旧记录，保留上下文）；成败按宿主命令结果，回复原样带出宿主文本 |
| `/goal` | 设定或查看当前会话的长期目标；`/goal <目标>` 设定，`edit` / `pause` / `resume` / `clear` 管理；回复原样带出宿主文本 |
| `/sessions`（别名 `/session`） | 会话管理：默认按工作区分组列出工作中会话（含状态与当前项），`all` 看全部会话 |
| `/rename` | 修改当前会话名（标题固定，不被自动标题覆盖） |
| `/to` | 向指定会话发消息，或在它提问时提交答案 |
| `/ls` | 列出目录里的子目录与文件：点目录逐层进入，点文件直接发送（`/get`） |
| `/get` | 把工作区里的文件发到当前聊天（图片 / 视频 / 语音按类型发送） |
| `/model` | 查看或切换当前会话的模型（下一轮生效） |
| `/reasoning`（别名 `/think`） | 查看或切换当前会话的思考强度（档位由模型决定） |
| `/preset` | 查看或切换当前 agent preset |
| `/permission` | 查看或切换权限预设（沙箱模式 + 审批策略，当前会话立即生效；仅绑定用户可用） |
| `/worktree` | 查看或切换之后新建的会话是否开工作树（默认开，已有会话不受影响；仅绑定用户可用） |
| `/cost` | 查看当前会话的 token 消耗 |
| `/status` | 查看会话状态：会话名与短 id / 工作区 / 工作树 / 模型 / 思考强度 / 上下文 / token |
| `/stop` | 中止当前生成；`/stop all` 中止所有已获取会话中正在生成的 |
| `/help` | 查看所有指令；`/help <命令>` 查看该命令的参数与用法 |
| `/plugins` | 插件管理：不带参数列出已安装插件，`install <包名>` / `update <包名> [版本]` 走 registry，`reload` 应用磁盘上的插件变更（仅绑定用户可用） |

> 指令名拼错（如 `/modle`、`/sesions`）不会被当作提问转发给大模型：机器人直接回「没有这个指令」，能猜到意图时给出可点击的正确指令。只有「斜杠 + ASCII 指令名」算指令，`/usr/local/bin`、`/今天` 这类文本照旧交给模型；全角 `／` 与半角 `/` 等价，中文输入法下可以直接敲。

### 插件安装、更新与热重载（`/plugins`）

`/plugins` 调宿主的插件管理服务，包管理只管从 registry 安装的 bundle：

- `/plugins` 列出已安装的第三方插件，后台查到新版本的行尾带 `→ 新版本` 与「更新」链接；`/plugins 2` 翻页。
- 后台会定时查 registry（启动 2 分钟后一次，之后每 6 小时一次），查到新版本只在列表里标 `→ 新版本`，不主动发消息、也不自动安装。
- `/plugins install <包名>` 装完即生效：宿主会 reconcile profile，不需要再发 `/plugins reload`。
- `/plugins update <包名> [版本]` 不带版本时取 registry 上最新的兼容版本；装新版失败会自动装回旧版本。
- 依赖带构建脚本时 pnpm 默认拒绝执行，结果里给「继续安装」按钮，点了才授予该包在本 profile 的构建权限。
- `/plugins reload` 应用磁盘上已变更的插件文件：只替换实际变更的插件，需要重启的改动会如实回报。
- 本地 tgz 快照（`pnpm dev:reload`）先换包再 `/plugins reload`，不在 install / update 里。

## 工作区（workspace）

工作区是宿主对「一个目录 + 跑在这个目录里的会话」的持久分组记录（`ctx.workspaceRegistry`），Web 侧栏看到的项目分组就是它。本插件遵循同一套规则：

- **没有 `cwd` 配置**：会话的工作目录由宿主决定。
- **新会话落在宿主的默认工作区**（首次使用时建在 `Documents/deepseek-harness/default-workspace`）；宿主没有默认工作区时退回 dsh 的启动目录。
- **工作区跟着会话走**：`/sessions resume` 切到哪个会话，这个聊天的工作目录就变成那个会话的目录；之后 `/new` 也留在同一个工作区，重启后依然记得（记录在 `~/.dsh-qqterm/model-prefs.json` 的 `dirs` 里）。
- **新会话开在 Git 工作树里**：目录在 Git 仓库内时，`/new` 之后的第一条消息先建一棵工作树（分支 `dsh-<会话短 id>`，基点为当前 HEAD），会话落在这棵树里，与 Web 侧一致；`/new <工作区|路径>` 行为相同，目录只决定在哪儿建树。建树失败时这一轮不创建会话，回两行原因。没有工作树服务、不是 Git 仓库或默认沙箱只读时就地创建，聊天里不出现工作树字样；`/worktree 关` 之后新建的会话直接在主检出里跑。`/status` 多一行工作树（分支与树路径），工作区行仍是主仓库；归档会删掉干净的工作树并保留分支，有改动则整棵留下。
- **显示名用目录名**：工作区标题由宿主按目录最后一段自动命名，你手动改过的标题不会被覆盖。
- **没有工作区注册表时**：`/sessions` 仍按目录分组，组标题只显示路径；`/new` 只认绝对路径，不能按名字或目录名匹配，用法页与回执也只给路径。

### 换工作区（`/new <工作区>`）

工作区就是会话的 `cwd`。它在会话创建时写进会话 header，宿主没有修改它的接口，所以换工作区只能在**会话落盘之前**生效——入口就是 `/new` 本身：

| 用法 | 说明 |
|------|------|
| `/new <名字\|路径>` | 一步到位：在新工作区开新会话 |
| `/ls` | 拿不准路径时先列目录，点条目逐层进入 |

- 工作区认**标题**、**目录名**（大小写不敏感，支持唯一前缀）或**绝对路径**；换完的下一条消息会在新目录里创建会话，宿主的侧边栏里同时出现对应工作区。目录不存在或不是目录会被拒绝，不会留下半改状态；`/new <路径>` 会先校验再动会话，路径写错不会把当前会话弄丢。部署里没有 workspaceRegistry 时只认绝对路径。
- 不知道路径怎么写就用 `/ls`：列出当前工作区的子目录与文件，点目录逐层进入、点文件直接发到聊天；每个条目填进输入框的都是绝对路径，点进第几层都不会跑偏。
- 与 `/sessions` 同一权限面：只允许**私聊 + 唯一绑定用户**（`access.owner`）——换工作区等于换 agent 能读写的目录。不带参数的 `/new` 不受限制。

### 会话管理（`/sessions`）

`/sessions` 默认回答“QQ 现在持有哪些会话”，数据来自运行期的已获取集合；全部视图与 Web 侧栏同一来源（宿主 `sessionQuery` / `sessionPersistence`）。

| 用法 | 说明 |
|------|------|
| `/sessions` | 按工作区分组列出工作中会话（当前项优先）；组标题带工作区路径，组内每行展示 `生成中` / `空闲`，当前项行尾 `✅`；当前指针不在工作中会话列表里时单独补一行 `待恢复`；行首只有 8 位短 id，不编号；每页 10 条 |
| `/sessions <页码>` | 工作中会话列表的下一页，例如 `/sessions 2`；页脚给出 `上一页 · 第 1/2 页 · 下一页` |
| `/sessions all` | 按工作区分组列出全部会话（组内先置顶），跨项目找会话用；已持有会话标 `📌`，不标当前项；组内只用短 id；每页 10 条 |
| `/sessions all <页码>` | 全部会话视图的下一页；翻页后仍会重复页首会话所属的工作区标题；页脚格式相同 |
| `/sessions resume <id>` | 把当前聊天切到该会话，历史接上继续聊（目标若已归档会顺带取消归档），工作区跟着切；目标用 8 位短 id |
| `/sessions rename <id> <新标题>` | 修改会话名；标题会被固定，不被自动标题覆盖。目标须已打开（先 `/sessions resume`） |
| `/sessions archive [页码]` | 不带目标时列出所有工作区的归档候选（与 `/sessions all` 同源），按工作区分组，标题给 `X 个工作区 · Y 个会话`，候选不编号；只给页码时翻页，例如 `/sessions archive 2` |
| `/sessions archive <id>[,<id>…]` | 归档会话：从本命令与 Web 侧栏隐藏，**磁盘日志保留**，可随时取消归档；多个目标用英文逗号分隔（一次最多 10 个） |
| `/sessions archived [页码]` | 查看已归档会话；每行带短 id 与所属工作区，点一下把 `/sessions unarchive <id>` 填进输入框；底部的翻页与返回列表也是链接 |
| `/sessions unarchive <id>[,<id>…]` | 取消归档，让它重新出现在列表里 |
| `/to <会话> <文本>` | 向指定会话发一条消息；目标在等 `ask_user_question` 时，文本会作为答案提交 |
| `/to <会话>` | 目标在等答案时进入「下一条消息作为回答」模式 |

注意：

- **句柄规则**：所有目标一律用 8 位短 id（形如 `#3f2a9b1c`，`#` 可省略）；列表不编号，翻页、分组后也不存在「第几条」这种写法，避免和实际行对不上。
- **分页**：多页列表的页脚统一为 `上一页 · 第 1/2 页 · 下一页`，缺哪边省略哪边；页码不放在标题里，也不显示「还有 N 个」。
- 状态词只在工作中会话列表里出现：`生成中`（agent 正在跑）、`空闲`（持有但待命）；当前指针指向但尚未获取的会话显示 `待恢复`。`/new` 之后没有当前指针，不会补这一行。其它视图只给已持有会话标 `📌`（表示 QQ 已持有），不标当前，也不显示状态。
- 只允许**私聊**使用，且操作者必须是唯一绑定用户（`access.owner`）——会话标题、归档状态都涉及其他聊天的数据；未配置用户时命令直接不可用。
- 归档走宿主 `workspaceRegistry.archiveSession`，只写 registry 的全局归档集，**不删任何文件**；本插件不提供物理删除，需要清理磁盘请到 Web 端或手动处理。`workspaceRegistry` 是可选服务（不在 `inject` 里）：缺它时这些命令照常可用，只是不列归档、也不提供归档 / 取消归档子命令（按未知子命令处理）。
- 归档前会释放该会话在本进程内的 agent；如果它就是当前会话，还会清掉聊天映射，下一条消息落到全新会话——归档会话会被宿主的 `agent/pre-step` 闸门拒绝，继续挂在它上面聊天会收不到回复。
- **多个会话可以同时活着**：普通消息、`/sessions resume`、`/to` 实际拿到 agent 的会话都会加入「已获取集合」。所有已获取会话的输出、提问、审批都会发回 QQ；当前会话不加标记，其它会话的消息在正文前单独一行标 `#短id · 标题`，正文后空一行、单独一行给「回复」「恢复」两个链接。已获取集合只在运行期存在，重启后只有当前会话从 `model-prefs.json` 恢复。
- **切走不释放**：`/sessions resume` 只改当前指针，旧会话继续在后台跑、输出继续回 QQ；`/new` 只清掉当前指针，旧会话同样继续跑。插件卸载时只 dispose 自己创建的 agent，Web/TUI 创建的只丢引用。
- **问答按会话路由**：当前会话直接回文本；其它会话的按钮带 session id，点按钮就能答；没有选项按钮的问题在正文引导行给「回答」「恢复」两个链接。一条没走按钮或 `/to` 的纯文本不会误发给当前模型，会提示用按钮或 `/to`。
- 持有列表按「当前 → 其它持有（获取时间倒序）」排，行里的时间取会话的最近人类消息时间（取不到时回退创建时间）；`/sessions all` 的工作区内顺序同样按这个时间倒序（与 Web 侧栏同一份 `updatedAt`），置顶会话仍在最前，工作区顺序不变。
- 跨工作区恢复后，agent 会在**那个会话自己的目录**里干活；相对路径（含 `/get` 的相对写法）也以该目录为准。

## 核心模块

```
src/
├── index.ts                    # Cordis 插件入口（async apply）
├── config.ts                   # 配置 Schema
├── types.ts                    # 全局类型定义
├── setup/                      # 凭据绑定（扫码）
│   ├── index.ts                # 绑定编排（ensureCredentials）
│   ├── binding-service.ts      # 扫码状态机（宿主内唯一事实源）
│   ├── bind-routes.ts          # 端内绑定页路由（/qqterm/bind）
│   ├── presenters.ts           # 呈现策略（终端/浏览器降级）
│   ├── qr-svg.ts               # 二维码 SVG 渲染（宿主侧）
│   └── persist.ts              # 凭据写入 cordis.patch.yml
├── client/                     # 浏览器半边（dsh.client Web Bundle）
│   ├── index.ts                # 设置页入口注册
│   ├── bind-page.ts            # 端内绑定页（二维码 + 状态轮询）
│   └── config-panel.ts         # 设置面板（可编辑配置）
├── gateway/                    # 网关装配
│   ├── bootstrap.ts            # 启动装配（监听 session/event 等）
│   └── middleware-setup.ts     # 中间件链配置
├── transport/                  # 传输层
│   ├── inbound.ts              # QQ 入站消息 → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-images.ts      # 助手消息 image 块 → QQ 图片
│   ├── reply-store.ts          # 被动回复凭证（msgid/eventid + 用量，msgid 落盘）
│   ├── reply-bot.ts            # bot 实例装饰：所有发送统一取被动凭证
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
│   ├── retry-channel.ts        # 失败重发卡片
│   ├── command-panel.ts        # 指令面板同步
│   └── command-menu.ts         # 自定义菜单同步
├── media/                      # 多媒体
│   ├── send-media.ts           # 媒体发送（按扩展名分发）
│   └── media-cleaner.ts        # 媒体 TTL 清理
├── middleware/                 # 中间件
│   ├── question-answer.ts      # 问答答案处理
│   ├── unknown-command.ts      # 拼错指令拦截（不转发给模型）
│   └── attachment.ts           # 附件处理
├── shared/                     # 共享工具
│   ├── utils.ts                # 通用函数
│   ├── entries.ts              # loader entry 快照（重载 / 安装共用）
│   ├── dirs.ts                 # 数据目录（~/.dsh-qqterm）
│   ├── scope.ts                # scope/peer 提取
│   └── send-helper.ts          # 分块发送
├── reload/                     # 热重载（/plugins reload，应用磁盘变更）
├── plugins/                    # /plugins（安装 / 更新插件）
└── commands/                   # 斜杠命令
```

## 会话路由

聊天会话的 key 固定为 `qqterm:${appId}:chat`，它只决定「当前接哪个会话」；已获取的会话可以有多份。当前会话在第一次真正用到时铸造 UUID 会话 id 并持久化到 `model-prefs.json`，重启后只有当前会话按持久化 id 恢复；没有映射即视为全新会话。`/new`、`/clear` 只是清掉这个映射（以及当前会话），不会预先铸造一个还没有创建的会话。

解析策略：已获取记录 → 进程内 live agent → 持久化恢复 → 全新创建（仅当前会话；`/sessions resume` 失败不创建）。

## 设计原则

- **纯 Cordis 插件** — 遵循 dsh "Plugins, not loop changes" 原则
- **声明式依赖** — `inject` 列出全部必需服务（会话、模型、工作区、归档、工具、附件、Web 服务等），缺任一就不激活，不在运行时探测或降级；可选服务有五个：`agentPresets`（缺失时 `/preset` 整条命令不出现、建会话不挂 preset）、`webServer`（缺失时不注册端内绑定页，扫码只走终端）与 `workspaceRegistry`（缺失时 `/sessions` 仍按目录分组，组标题只有路径、无置顶 / 归档，归档子命令按未知子命令处理，`/new` 只保留绝对路径写法）、`worktrees`（缺失时新会话就地创建，聊天里不出现工作树字样，`/worktree` 整条命令不注册）；因服务缺失而不可用的整条命令或子命令不出现，输入时按未知指令 / 未知子命令处理（`/plugins reload` 在没有 hmr 时同样如此）；`sessionController` 不参与功能，只被 adapter 软读一次 `list()` 取 `/sessions` 排序用的最近活动时间，缺失时按创建时间排
- **一个当前会话 + 多份已获取会话** — 任何 QQ 窗口续写同一个当前会话；`/sessions resume` 与 `/to` 获取过的会话继续活着并把输出发回 QQ
- **Preset 支持** — 可通过 `agent-presets` 服务挂载预设（工具集、prompt 等）；`/preset` 改的是全局值，与设置页「设为默认」一致。该服务可选，缺失时 `/preset` 整条命令不出现
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块/表格感知切分
- **图片转发** — 助手消息里的图片内容块按出现位置作为 QQ 图片发出，文本在图片处切成前后两条消息
- **交付文件** — `present` 声明的文件在轮末发送给用户（默认启用，路径不限）
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
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqterm/cordis.dev.yml
```

## License

[MIT](./LICENSE)
