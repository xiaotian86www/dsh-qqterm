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

四种方式任选其一。凭据保存在 profile 的 `cordis.patch.yml`，媒体缓存与会话偏好数据在 `~/.dsh-qqterm`。

### 方式一：桌面版安装（推荐）

无需命令行，全程在应用内完成：

1. **安装**：左侧栏点击「插件」→「添加插件」→ 输入 `dsh-qqterm` → 安装并立即启动

<img src="./assets/docs/install.png" alt="端内添加插件" width="560" />

2. **连接**：左下角头像 → 设置 →「QQ 超级终端」→ 手机 QQ 扫码连接

<img src="./assets/docs/setting.png" alt="设置页扫码连接" width="560" />

扫码成功后凭据自动保存，后续启动无需再次扫码。

### 方式二：命令行安装

```bash
# 安装到 profile
npx @deepseek-ai/dsh plugin --profile qqterm add dsh-qqterm

# 启动
npx @deepseek-ai/dsh --profile qqterm
```

首次启动时，插件检测到凭据未配置会自动进入扫码引导，用手机 QQ 扫终端里的二维码完成绑定。

也可以直接用环境变量提供凭据：

```bash
export QQBOT_APPID="xxx"
export QQBOT_SECRET="xxx"
```

浏览器打不开时设置 `QQBOT_BIND_OPEN_BROWSER=1`，扫码页会改用系统默认浏览器打开。

<img src="./assets/docs/qrcode.png" alt="终端扫码" width="560" />

### 方式三：本地路径安装

```bash
npx @deepseek-ai/dsh plugin --profile qqterm add /path/to/dsh-qqterm
```

适合开发验证。主 profile 建议安装已发布版本或冻结的 tgz 快照，不要指向会持续构建的开发目录。

### 方式四：`--patch` 开发模式

```bash
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqterm/cordis.dev.yml
```

不用安装进 profile，适合临时调试。

## 配置

配置写在 profile 的插件配置里；`appId` / `appSecret` 也可以由环境变量提供。

### 基础配置

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `appId` | string | `""` | QQ Bot AppID；留空时启动扫码绑定 |
| `appSecret` | string | `""` | QQ Bot AppSecret |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数，超出按此分片（QQ 上限约 5000） |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `askTimeoutMs` | number | `300000` | 待答问题超时（毫秒），超时自动拒绝并提示；`0` 为不超时 |
| `retryOffer.enabled` | boolean | `true` | 轮次失败后是否用「重发 / 放弃」卡片询问 |
| `retryOffer.timeoutMs` | number | `600000` | 卡片有效期（毫秒），超时后按钮失效；`0` 为永不过期 |
| `showToolResults` | boolean | `false` | 是否展示工具调用结果（成功与失败都受控） |
| `debug` | boolean | `false` | 调试日志 |

### 访问控制

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `access.owner` | string | `""` | 唯一允许使用机器人的 QQ 用户 OpenID；空字符串拒绝所有私聊 |

白名单只有一个用户，群消息一律拒绝；按钮点击（提问 / 审批 / 重试 / 确认）会校验点击者等于 `access.owner`。换绑或解绑在设置页完成。

### 富媒体

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `media.enabled` | boolean | `true` | 是否启用富媒体理解（图片 / 视频下载后交给工具分析） |
| `media.maxMB` | number | `200` | 单次下载大小上限（MB） |
| `media.ttlHours` | number | `24` | 缓存存活时长（小时）；`0` 为永不过期 |

下载的文件落在 `~/.dsh-qqterm/media`，按 TTL 清理。关闭 `media.enabled` 后附件仍会收到，但不会下载和分析。

### 交付文件

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sendFile.sendPresentedFiles` | boolean | `true` | 是否把 `present` 声明的交付文件在轮末发到当前会话 |
| `sendFile.maxFiles` | number | `4` | 单轮最多投递的交付文件数（小于 1 按 1 处理） |

交付文件由 agent 通过 `present` 声明，轮末统一发送；路径不限，但只发给 `access.owner`。入站附件下载由 `media` 控制。

### 指令面板

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `panel.autoSync` | boolean | `true` | 机器人就绪后是否把内置指令同步到 QQ 指令面板 |

同步是整表覆盖，remark 固定为 `qqterm:commands`；没有变化时跳过写入。

### 自定义菜单

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `menu.autoSync` | boolean | `true` | 机器人就绪后是否把固定入口同步到单聊自定义菜单 |

菜单固定七项：会话状态、会话列表、重置会话、压缩会话、长期目标、权限预设、思考强度。权限与思考强度是二级菜单，其余项直接指向对应指令。菜单是 bot 级的整表覆盖，不按用户区分。

## 会话、工作区与交互

### 一个当前会话，多份已获取会话

全 bot 只有一个「当前会话」：普通消息都续写它，key 固定为 `qqterm:${appId}:chat`。

后台会话可以有多份：普通消息、`/sessions resume`、`/to` 拿到的 agent 都进「已获取集合」，输出、提问、审批都回 QQ。当前会话的回复直接发；其它会话的回复在正文前单独一行 `> #短id · 标题`，正文后空一行给「回复」「恢复」两个链接（正在生成时再加「停止」，有归档能力时再加「归档」）。

已获取集合只在运行期存在；会话名册（最近 20 个）写进 `model-prefs.json`，重启后列表照常列出，`/sessions resume` 才真正打开。当前会话仍由启动自动恢复。

切走不释放：`/sessions resume` 换的是「当前」，旧会话继续跑；下次 `resume` 直接接着它的完整历史。

排队只发生在同一会话内部：同一会话的消息按到达顺序执行；不同会话互不阻塞。会话不按闲置时间回收，只要进程还在、agent 还没卸载就一直可用。

### 工作区

工作区是宿主的 `workspaceRegistry` 概念，dsh-qqterm 不维护自己的目录列表。

- 没有 `cwd` 配置。新会话落在宿主的默认工作区（`Documents/deepseek-harness/default-workspace`），宿主读不到时用 dsh 的启动目录。
- 工作区跟着会话走：`/sessions resume` 在会话自己的工作区里跑，不要求先切目录；跨工作区恢复也照常。
- 换工作区只能通过 `/new --dir <工作区>` 决定下一条消息的落点；`/new` 本身留在当前工作区。
- 匹配顺序：工作区标题 → 目录名（大小写不敏感，唯一前缀匹配）→ 绝对路径。没有 `workspaceRegistry` 时只认绝对路径。
- 标题默认取目录最后一段，可以在 Web 侧栏改；手动改过的标题不会被自动改写。
- 工作树：`/new --worktree` 让下一条消息先按当前目录的 HEAD 建树，再在树里开会话，分支名 `dsh-<会话短 id>`。未提交改动不会带进树里。读不到 HEAD 或建树失败时这一轮不建会话，回复原因和下一步，意图保留，重发即重试；目录不是 Git 仓库时就地开会话并提示；只读沙箱在 `/new` 当场拒绝。归档会话时宿主会删掉干净的工作树、保留分支，有未提交改动则保留树。
- 运行目录与工作区是两个概念：运行期 `cd` 只改运行目录（`/get`、`/ls` 的相对路径基准）；工作区分组、`/status` 的工作区行、下一条 `/new` 的落点仍用会话创建时的 `header.cwd`。工作树会话的工作区是主仓库根，树只作运行目录。

### 模型、preset 与思考强度

- 新会话的模型按 `settings.yaml` → `agentDefaultModel` → `deepseek-official/deepseek-v4-flash` 解析。
- `/model`、`/reasoning`：有活跃会话时写进当前会话，下一轮生效（不 fork、不重建），同时写部署默认；没有会话时只写默认。
- `/reasoning` 选的档位同时成为全局默认，之后的会话沿用。
- `/preset` 是部署级：落盘到 `settings.yaml`，只影响新建会话；插件不存 preset。
- `/permission`：有活跃会话时在当前会话立即生效，没有会话时改默认。
- 查看视图显示当前值并标 `✅`，不造「全局」标签。

### 文件与富媒体

- 入站图片 / 视频按 `media` 配置下载，交给工具分析；缓存落在 `~/.dsh-qqterm/media`，按 TTL 清理。
- 助手消息里的图片内容块按出现位置作为 QQ 图片发出，文本在图片处切成前后两条。
- `present` 声明的交付文件在轮末发送（`sendFile.sendPresentedFiles`，单轮最多 `maxFiles` 个）。
- `/get` 可以发任意路径的文件，目录会被拒绝；`/ls` 用来浏览并点选。
- 助手正文里的本地文件链接会改写成 `/get <绝对路径>`，点开即发。
- 交付文件与 `/get` 都只发给 `access.owner`。

### 问答、审批与失败重发

- `ask_user_question`：单选生成内联按钮（点一个其余变灰），多选回复编号；逐题推进，问题级超时 `askTimeoutMs`。
- `approval/request`：关键操作通过「允许 / 拒绝」按钮确认；按钮发不出去时降级成纯文本。
- 轮次失败：默认用「重发 / 放弃」卡片询问（`retryOffer`）；卡片失效后可用 `/retry` 重发上一条用户消息。
- 提问 / 审批的路由与会话一致：当前会话直接发；其它会话的按钮带 `#短id`。如果提问降级成了纯文本，回复时用 `/to #短id` 指明会话。

## 内置命令

| 指令 | 说明 |
|---|---|
| `/new` | 新建会话；`--dir`（`-d`）指定工作区，`--worktree`（`-w`）让第一条消息先建工作树，`--background`（`-b`）后台另开一条且不动当前会话；剩下的文字作为提示词立即发出；旧会话继续跑 |
| `/clear`（别名 `/reset`） | 停止当前会话，下一条消息在原工作区开新会话；`/clear all` 停掉所有已获取会话；先发 5 分钟确认卡 |
| `/compact` | 压缩会话历史（摘要替换旧记录），回复带出宿主命令的结果 |
| `/goal` | 设定或查看当前会话的长期目标；`/goal <目标>` 设定，`edit` / `pause` / `resume` / `clear` 管理 |
| `/sessions`（别名 `/session`） | 会话管理：默认列出 QQ 持有的会话（含重启后尚未打开的冷会话），`all` 看全部，`archived` 看归档 |
| `/rename` | 修改当前会话标题；`/sessions rename <id> <标题>` 改已打开会话 |
| `/to` | 向指定会话发消息；目标在等答案时提交答案；尚未打开的会话先接回再发 |
| `/ls` | 列出目录里的子目录与文件，点目录进入、点文件发送 |
| `/get` | 把文件发到当前聊天（图片 / 视频 / 语音按类型发送），路径不限 |
| `/model` | 查看或切换当前会话的模型 |
| `/reasoning`（别名 `/think`） | 查看或切换当前会话的思考强度 |
| `/preset` | 查看或切换当前 agent preset（只对新建会话生效） |
| `/permission` | 查看或切换当前会话的权限预设（仅绑定用户） |
| `/cost` | 查看当前会话的 token 消耗 |
| `/status` | 查看会话状态：会话、状态、工作区、工作树、模型、思考强度、preset、权限、上下文 |
| `/stop` | 中止当前生成；`/stop <id>` 停指定已获取会话；`/stop all` 停全部 |
| `/retry` | 重发当前会话上一条用户消息 |
| `/help` | 查看所有指令；`/help <命令>` 查看参数与用法 |
| `/plugins` | 插件管理：列出、`install` / `update`、`check`、`reload`（仅绑定用户） |

补充说明：

- 参数统一支持引号：空格分隔，带空格的值用引号包起来；`--dir=值` 等价于 `--dir 值`。引号没闭合回「引号没有闭合 + 用法」，认不出的参数回「未知参数 + 用法」，不会静默跳过。
- 拼错的 `/` 指令会在入站层拦下并提示用法，不会转发给模型；前缀匹配有歧义时按「指代不清」拒绝。
- 宿主缺某条命令依赖的服务时，整条命令不出现，输入按未知指令处理。

### `/new` 用法

| 写法 | 效果 |
|---|---|
| `/new` | 清掉当前指针，下一条消息在原工作区建新会话；旧会话继续跑 |
| `/new <提示词>` | 立刻在新会话发出这条提示词 |
| `/new --dir <工作区>` | 在指定工作区开新会话（`-d`，只收一个词） |
| `/new --background <提示词>` | 后台另开一条，不动当前会话与工作区（`-b`，必须带提示词） |
| `/new --worktree [提示词]` | 下一条消息先建工作树（`-w`，见「工作区」） |

- 参数和提示词顺序随意，剩下的文字连起来作为提示词；`--` 之后的全部算提示词。
- `-w` 与 `-b` 可合写为 `-wb`；短参数连写时带值的 `-d` 放最后（`-wbd <工作区>`）。
- `--dir` 只收一个词；路径带空格时用引号包起来，也认 `--dir=路径`。
- 参数校验先于动会话：不存在的目录 / 文件直接拒绝，当前会话不受影响。
- 带参数的 `/new` 只对绑定用户开放；裸 `/new` 不限。
- 不知道路径时先用 `/ls` 走到目标目录，再照着用法发 `/new --dir`。

### `/sessions` 用法

| 写法 | 效果 |
|---|---|
| `/sessions` | 列出 QQ 持有的会话（含重启后尚未打开的冷会话），按工作区分组 |
| `/sessions <页码>` | 翻页（一页 10 条） |
| `/sessions all` | 列出全部会话，含别的项目 |
| `/sessions resume <id>` | 打开指定会话（已归档的会先取消归档）；失败不新建 |
| `/sessions rename <id> <标题>` | 改已打开会话的标题；冷会话会提示先恢复 |
| `/sessions archive` | 列出可归档的会话；`<页码>` 翻页 |
| `/sessions archive <id>[,<id>...]` | 归档一个或多个（逗号分隔，最多 10 个） |
| `/sessions archived` | 列出已归档的会话 |
| `/sessions unarchive <id>[,<id>...]` | 取消归档 |

注意：

- 会话 id 一律 8 位短 id，行里不编号；目标可以带 `#`，前缀至少 4 位且必须唯一。
- 分页一页 10 条，页脚 `上一页 · 第 1/2 页 · 下一页`，缺哪边省略。
- 状态（生成中 / 空闲）只在默认列表标；其它视图只标 `📌`。
- 只在 C2C 私聊、且发送者等于 `access.owner` 时可用。
- 归档只改宿主状态，不删会话记录；当前会话被归档时指针清空，下一条消息落到新会话。没有 `workspaceRegistry` 时归档子命令按未知子命令处理。
- 多份活跃会话同时产出时，每条回复正文前有 `> #短id · 标题`，正文后是「回复」「恢复」链接；切走不释放，排队只发生在同一会话内部。
- 排序按最近一条人类消息倒序，同一时间按 id 升序；当前项不置顶，只靠行尾 `✅`。
- 跨工作区恢复会在会话自己的目录里跑。

### `/plugins`

- 列出 registry 里的插件包，有新版本的项带「→ 新版本」和更新链接。
- `install` / `update` 立即调宿主的 reconcile：安装新版本、更新时选最新的兼容版本，失败回滚旧版本；带构建脚本的包会先停下来等「继续安装」按钮。
- `check` 立即向 registry 查一遍可更新项，不等定时检查；回执给出检查数量、可更新数量与查询失败数量。
- `reload` 按已加载模块的磁盘身份替换变化的项，磁盘没变时提示没有变更。
- 本地 tgz 开发包先用 `pnpm dev:reload` 打快照并装进开发 profile，再发 `/plugins reload`。
- 启动 2 分钟后自动检查一次更新，之后每 6 小时一次；`check` 是同一份检查的手工触发。仅绑定用户可执行。

## 核心模块

```
src/
├── index.ts                     # Cordis 插件入口：inject、命令注册、事件接线
├── config.ts                    # 配置 Schema
├── host/adapter.ts              # 宿主服务适配：必需服务与可选服务软读
├── setup/                       # 凭据绑定
│   ├── binding-service.ts       # 扫码绑定状态机
│   ├── bind-routes.ts           # 端内绑定页路由
│   └── persist.ts               # 凭据写回 profile
├── client/                      # 浏览器半边
│   ├── config-panel.ts          # 设置页（绑定 / 换凭据 / 解绑 / 配置编辑）
│   └── bind-page.ts             # 端内扫码页
├── gateway/                     # 网关装配
│   ├── bootstrap.ts             # 启动与重连
│   ├── gateway-session.ts       # 单连接生命周期
│   └── middleware-setup.ts      # 中间件链
├── transport/                   # 入站与出站
│   ├── inbound.ts               # 入站消息
│   ├── outbound.ts              # 回复与推送
│   ├── send.ts                  # 统一发送路径（分片 → 入队 → 重试）
│   ├── outbox.ts                # 待发队列
│   ├── chunker.ts               # Markdown 感知切分
│   ├── deliverables.ts          # present 交付文件
│   └── file-links.ts            # 本地文件链接改写
├── session/                     # 会话
│   ├── session-manager.ts       # 当前会话、已获取集合、名册
│   ├── worktree.ts              # 工作树创建与恢复
│   └── session-id.ts            # 会话 id 与短 id
├── model/                       # 模型 / 思考强度 / preset
│   ├── model-resolver.ts        # 解析顺序
│   ├── prefs-store.ts           # 偏好持久化
│   └── settings-reader.ts       # settings.yaml 只读
├── features/                    # 交互特性
│   ├── question-channel.ts      # 问答通道
│   ├── approval-channel.ts      # 审批通道
│   ├── retry-channel.ts         # 失败重发
│   ├── command-panel.ts         # 指令面板
│   └── command-menu.ts          # 自定义菜单
├── middleware/                  # 入站中间件
│   ├── question-answer.ts       # 答案处理
│   ├── unknown-command.ts       # 拼错指令拦截
│   ├── multiline-command.ts     # 多行指令
│   └── attachment.ts            # 附件
├── media/                       # 媒体发送与 TTL 清理
├── shared/                      # 共享工具（分页、内联指令、数据目录）
├── reload/                      # /plugins reload
├── plugins/                     # /plugins 安装与更新
└── commands/                    # 斜杠命令
```

## 会话路由

聊天会话的 key 固定为 `qqterm:${appId}:chat`，它只决定「当前接哪个会话」；已获取的会话可以有多份。当前会话在第一次真正用到时铸造 UUID 会话 id 并持久化到 `model-prefs.json`，重启后只有当前会话按持久化 id 恢复；没有映射即视为全新会话。`/new`、`/clear` 只是清掉这个映射（以及当前会话），不会预先铸造一个还没有创建的会话。

解析策略：已获取记录 → 进程内 live agent → 持久化恢复 → 全新创建（仅当前会话；`/sessions resume` 失败不创建）。

## 设计原则

- **纯 Cordis 插件** — 遵循 dsh「Plugins, not loop changes」原则。
- **声明式依赖** — `inject` 列出 14 个必需服务：`agents`、`llm`、`agentDefaultModel`、`sessionProjections`、`sessionPersistence`、`sessionQuery`、`sessionTitle`、`permissionPresets`、`settings`、`commands`、`tools`、`attachments`、`workingDirectory`、`pluginManager`。缺任一就不激活，不在运行时探测或降级。
- **可选服务软读** — 可选能力不进 `inject`，在使用点现查；缺失只缩小能力面，不改变语义，也不解释、不提示。

| 可选服务 | 缺了以后 |
|---|---|
| `agentPresets` | `/preset` 不注册，建会话不挂 preset |
| `webServer` | 端内绑定页不注册，扫码只走终端 / 浏览器 |
| `workspaceRegistry` | `/sessions` 仍按目录分组，但组标题只有路径，没有 `📌` / 归档入口；归档子命令按未知处理；`/new --dir` 只认绝对路径 |
| `worktrees` | `/new --worktree` 按未知参数处理，新会话就地创建 |
| `sessionController` | `/sessions` 的排序退化为创建时间 |

- **一个当前会话 + 多份已获取会话** — 任何 QQ 窗口续写同一个当前会话；`/sessions resume` 与 `/to` 获取过的会话继续活着并把输出发回 QQ。
- **薄层** — 模型、preset、思考强度、权限、压缩、工作区都转发给宿主；插件只留通道独有的一层：入站解析、分片、附件、回复目标、绑定、多会话寻址与文案渲染。
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块 / 表格感知切分。
- **图片转发** — 助手消息里的图片内容块按出现位置作为 QQ 图片发出，文本在图片处切成前后两条消息。
- **交付文件** — `present` 声明的文件在轮末发送给用户（默认启用，路径不限）。
- **问答互动** — 支持 `ask_user_question`，单选生成内联按钮（点一个其余变灰）、多选回复编号，逐题推进 + 问题级超时。
- **操作确认** — 支持 `approval/request`，关键操作通过「允许 / 拒绝」按钮请求用户确认。
- **单用户私聊** — 只服务 `access.owner`，群消息一律拒绝。

## 本地开发

```bash
# 安装依赖
pnpm install

# 类型检查 + 打包
pnpm build

# 跑测试
pnpm test

# 类型检查 watch（客户端改动要手动 build）
pnpm dev
```

| 命令 | 用途 |
|---|---|
| `pnpm build` | 类型检查 + 打包，产出 `lib/index.js` 与 `lib/client.js` |
| `pnpm build:client` | 只重建客户端 |
| `pnpm dev` | 类型检查 watch |
| `pnpm test` | 跑测试（vitest） |
| `pnpm typecheck:client` | 客户端类型检查 |
| `pnpm dev:reload` | 打本地 tgz 快照并装进开发 profile |
| `pnpm run lint` | 没有 eslint 配置，不是门禁 |

测试放顶层 `tests/`，按模块镜像 `src/`，不访问真实 `~/.dsh`、真实凭据或外网。

## 延伸阅读

- [入站 / 出站路径](./docs/inbound-outbound-paths.md)
- [多会话设计](./docs/multi-conversation-design.md)
- [文案风格](./docs/copy-style.md)

## License

[MIT](./LICENSE)
