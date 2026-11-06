# AGENTS.md — dsh-qqbot 开发约束

给在本仓库工作的开发者 / AI 助手：这里记录**开发、测试、打包发布**中不能违反的约束。
面向用户的安装与配置说明见 [README.md](./README.md)，版本变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 1. 项目速览

- 定位：DeepSeek Harness（dsh）的 QQ Bot IM 通道插件，纯 Cordis 插件，不修改宿主 loop。
- 运行形态：宿主加载 `lib/index.js`（Cordis 插件），浏览器加载 `lib/client.js`（dsh.client 模块）。
- 技术栈：Node ≥ 20.3、TypeScript ESM、pnpm、vitest、tsdown（客户端 bundle）。
- 当前宿主 dsh 0.2.1-rc.5 实测可运行；`package.json` 的 `dsh.compatibility` 只是兼容性声明，宿主升级后必须重新验收并更新。
- 产物入库：`lib/` 的 js 需要提交（保证开箱即用），`lib/**/*.d.ts` 与 `lib/**/*.map` 被 .gitignore 排除。

## 2. 目录地图

| 路径 | 职责 |
|---|---|
| `src/index.ts` | Cordis 插件入口：`name` / `inject` / `Config` / `apply` |
| `src/gateway/` | 网关组装：中间件、事件、出站、生命周期 |
| `src/setup/` | 扫码绑定状态机、凭据持久化、端内绑定页路由 |
| `src/features/` | 问答（ask_user_question）、审批、指令面板、按钮协议 |
| `src/session/` | 聊天会话寻址、后台会话切换（`/sessions`、`/new`） |
| `src/transport/` | 入站、出站、分片、附件、回复目标 |
| `src/commands/` | `/bot-*`、`/model`、`/preset`、`/sessions` 等指令 |
| `src/media/` | 富媒体理解、附件发送、清理 |
| `src/host/` | 宿主 Agent/Session 适配 |
| `src/client/` | 浏览器端（settings.section、sidebarRightTabs） |
| `cordis.patch.yml` | bundle 层 patch，插入 `im-qqbot` 条目（随包分发） |
| `cordis.dev.yml` | `--patch` 调试 overlay（绝对路径加载源码） |
| `locale/*.json` | 插件 meta 文案（宿主读）；命令与消息文案内联在 `src/` |
| `lib/` | 构建产物，**不要手改** |

## 3. 硬约束（改代码前必读）

### 3.1 宿主依赖

- `@deepseek-ai/*` 一律放 `peerDependencies`（由宿主安装副本解析），**禁止**加入 `dependencies`，也**禁止**打进客户端 bundle。
- `inject` 只声明真正依赖的服务；服务缺失时插件应保持 inactive，不能抛错阻塞宿主。本插件采用全硬依赖：凡是用到的 `ctx` 服务都写进 `inject`，运行时不再探测服务是否存在，也不写「能力不可用」的降级分支。
- 不要 import 宿主包的私有深层路径；需要的能力优先走 `ctx` 服务或公开导出。
- 版本号运行时从 `package.json` 读取（`src/shared/utils.ts`），不要另建版本常量。

### 3.2 启动与生命周期

- `apply()` 必须快速返回：扫码、网关连接、长轮询等一律 `void …catch()`，**禁止 await 用户交互**（会阻塞 Host ready / Web URL 输出）。
- 禁止在运行时写 `process.env`；凭据持久化只写 profile 的 `cordis.patch.yml`（会触发 HMR 重载）。
- 未捕获的 rejection 在宿主是 fail-loud 致命错误，所有异步链必须有兜底 catch。
- `export const name = 'im-qqbot'`、bundle patch 里的 entry id `im-qqbot` 都是兼容契约；改动会让用户 profile 里按 id 写的配置覆盖失效。`inject` 随依赖增长而扩展（当前 15 项），只进不退。`compaction` 不进 `inject`：web/desktop 把它挂在 agent preset 作用域里，宿主面没有这个服务，`/compact` 只从会话 preset 取引擎，不退回宿主面。

### 3.3 客户端

- 入口 id 必须等于包名（tsdown 从 package.json 读取；`window.__ModuleLoader__.load({ id })`）。改包名要同步 `cordis.patch.yml` 的 `name` 和客户端 `PACKAGE_NAME` 常量，否则报 “loaded without registering”。
- 客户端只把 `react` / `react-dom` 当外部依赖（见 `tsdown.client.config.ts` 的 BASELINE_EXTERNALS），其余依赖全部内联；新增依赖要考虑 bundle 体积。
- 依赖的槽位：`settings.section`、`sidebarRightTabs`、`sidebar.right.pane.tab`。宿主大版本升级后要在 Desktop 与 dsh web 两端重新验收；服务缺失时应静默 inactive，不能让页面白屏。

### 3.4 交互与消息

- 插件只处理 C2C 私聊：群消息在 accessPolicy 层被拦掉，代码里不再有群聊分支。按钮键盘只在 C2C 可用，发送失败必须保留文本回退（现有实现会降级并记 warn）。改问答/审批时在 C2C 验证按钮回退。
- `ask_user_question` / `approval` 走宿主 waterfall 通道，不要再退回 `userQuestions.ask` 这类服务探测式实现。
- 聊天会话 key 固定为 `qqbot:${appId}:chat`：全 bot 只有一个「当前会话」，任何 QQ 窗口共享它；已获取集合（普通消息 / `/sessions resume` / `/to` 实际拿到 agent 的会话）可以有多份，全部输出回 QQ，非当前会话的消息首行标 `` > `#短id` · 标题 ``、末行给「回复」「恢复」两个链接（长回复只在首片带标题、末片带链接；提问 / 审批用同一个首行，见 §4.12）。`/sessions` 默认按工作区分组列出工作中会话（组标题带路径，行带 `生成中` / `空闲` 与当前 `✅`），`/sessions all` 看全部会话，只标 `📌`，不标当前。`/sessions resume` 与 `/new` 只改当前指针，切走不 dispose 旧会话；`/reset`（别名 `/clear`）会先停掉当前会话再开新的，`/reset all` 停掉全部已获取会话。`/stop` 只停当前会话，`/stop all` 停掉所有正在生成的已获取会话。没有映射即视为全新会话，会话 id 由 `mintSessionId()` 铸造。
- 会话名（标题）由宿主 `sessionTitle.rename` 写入 `session/title` 事件，写完即固定，自动标题不再覆盖。`/rename <新标题>` 只改当前会话（与聊天同一权限面，不限白名单）；`/sessions rename <id> <新标题>` 改已打开的其他会话，沿用 `/sessions` 的私聊 + 白名单。两者都只接受 live session：冷会话提示先 `/sessions resume`，不要为了改名悄悄拉起会话。
- 入站消息的 `source.kind` 必须是 `user`（`src/session/user-message.ts`）：宿主把「人类消息」作为一批能力的触发条件——会话标题（`dsh-session-title` 只对 `kind === 'user'` 排期，内置回退标题也走这条路）、最近提问时间、轮次大纲、replay 断点。自造 kind（如早期的 `qqbot`）会让这些能力静默失效，症状是所有新建会话停在「未命名会话」。宿主自带的外部通道（ACP / JSON-RPC SDK / headless）同样发 `{ kind: 'user' }`。
- Markdown 输出按 `textChunkLimit` 分片，代码块/表格感知切分在 `src/transport/chunker.ts`，不要绕过。
- 普通消息的入站处理在 `agent.followup()` 之后必须立刻返回：`concurrencyGuard` 以 QQ 用户为键，处理函数若 `await agent.whenIdle()` 会一直占着锁，正在生成的会话就把空闲会话的消息一起堵在队列里。会话内的先后由宿主 next-turn inbox 保证（`followup` 排在当前轮之后，不打断），跨会话必须互不阻塞。
- 工具结果（成功与失败）只在 `showToolResults` 打开时推送到 QQ，默认一条都不发；失败消息按 §4.2 的两行格式给目标与原因，不是裸的「执行失败」。
- 用户可见文案内联在 `src/` 对应模块（`locale/*.json` 只有插件 meta）；写法见 §4，注释与内部日志保持中文。

## 4. 用户可见文案格式规范

管的是用户在 QQ 里看到的每一条消息、每一颗按钮、端内面板上的每一行字。

规范的目标不是「好看」，是**同一种意思只长成一个样子**：本版之前 `/new` 回 `已开启新会话 ✓`、`/model` 回 `✅ 模型已切换: …`，两个「成功」一半黑白、一半彩色，就是这条没定下来的代价。

**覆盖**：QQ 消息正文（markdown 通道 + 纯文本回退通道）、内联键盘 `label` / `visited_label`、端内绑定页与设置面板文案、终端扫码引导。
**不覆盖**：源码注释、内部日志（仍用中文，但不追求观感）。

### 4.1 四条底线

1. **同一语义只用一个符号**：成功永远是 `✅`，不会今天 `✓` 明天 `✅`。
2. **同一类信息用同一种句式与标点**：「标签 + 值」一律 `标签: 值`（半角冒号 + 一个空格）。
3. **markdown 版与纯文本版只差标记，不差事实**。
4. **只留必要信息**：能删的提示、解释、强调都删掉（见 4.9）。

### 4.2 状态符号（硬约束）

| 语义 | 符号 | 位置 | 例 |
|---|---|---|---|
| 成功 / 已完成 | `✅` | 行首前缀 | `✅ 模型已切换: openrouter/deepseek-v4-flash` |
| 失败 / 拒绝 | `❌` | 行首前缀 | `❌ 工具 \`edit\` 执行失败: \`src/index.ts\`` |
| 警示 / 降级 / 未达成 | `⚠️` | 行首前缀 | `⚠️ 目录不存在: \`D:\nope\`` |
| 提示 / 引导 | 不占行首 | 句首或引用块内 | `> 💡 回复编号选择` |

- `⚠️` 必须写成 `U+26A0 U+FE0F`（带变体选择符）。少写 `U+FE0F` 时部分客户端会退化成黑白小字，和 `✅` 摆一起就是两种字体。
- **消息正文与按钮 label 禁用文字符号**：`✓` `✔` `☑` `√` `×` `✗`。这些字符没有 emoji 字形，字号与颜色跟着正文字体走，与 emoji 混排必然割裂。
- 一行最多一个状态图标，且只在行首。批量操作清单（每条一行结果）是唯一允许多行各带图标的场景。
- **例外一**：按钮 `visited_label` 用纯文本 `✓`（`✓ 已允许` / `✓ 已拒绝` / `✓ 已选`）。按钮点击后不可再点，彩色 `✅` 会被读成「还能点」；同一键盘里 label 用 emoji、visited_label 用文本勾是**成对设计**，要改两个一起改，并同步 `src/features/*-renderer` 的单测。
- **例外二**：终端日志前缀 `✔`（`src/setup/persist.ts`、`src/setup/binding-service.ts`）只出现在终端，不进 QQ 消息；同一份终端输出里不要与 `✅` 混用。
- **例外三**：列表行的当前项标记 `… ✅` 放行尾（见 §4.6）。它是「选中标记」不是状态图标，不受「只在行首」约束；同一行不要再出现别的状态图标。
- **命令回复的第一行必须带图标**：状态类用 `✅` / `❌` / `⚠️`，信息类用领域图标（`🤖` 版本、`🗂` 会话、`📁` 目录…）。裸文本开头的回复会被读成大模型的正文——命令输出要跟模型输出一眼分开，`/bot-version`、`/bot-status` 这类「没有成功也没有失败」的回复同样算在内。

### 4.3 领域图标

列表 / 视图标题的图标在这里定死，新增场景先补表再用：

| 场景 | 图标 | 现有位置 |
|---|---|---|
| 指令总览 / 模型配置 | 🤖 | `/bot-help`、`/model` |
| 会话 / 工作区 | 🗂 | `/sessions`、`/sessions all` |
| 已持有会话 | 📌 | `/sessions all`、归档候选的行尾 |
| 归档 | 🗄 | `/sessions archived`、归档结果 |
| 取消归档 | ♻️ | `unarchive` 结果 |
| 目录浏览 | 📁 | `/ls` |
| 会话状态 | 📊 | `/status`、`/bot-status` |
| 权限预设 | 🛡️ | `/permission` |
| agent preset | 🧩 | `/preset` |
| 思考强度 | 🧠 | `/reasoning`、`/model`、`/status` |
| 计费 | 💰 | `/cost` |
| 审批 | 🔐 | 审批卡片 |
| 工具调用 | 🔧 | 工具结果 |
| 身份 | 🆔 | `/bot-me` |
| 作用域标签 | 💬 私聊 | `/bot-help` |
| 引导 | 👇 / 💡 | 问答 / 审批卡片底部 |
| 中止 | ⛔ | `/stop` |
| 附件 | 📎 | 交付物发送 |

图标承载「这是哪一类信息」，不承载语气；不要拿 emoji 当装饰或对齐符号。

### 4.4 消息骨架

**视图型**（多字段 / 列表）：

```
### 🗂 工作中会话（2 个工作区 · 3 个会话）

**repo** · `D:\repo`

#3f2a9b1c · 修登录 · 生成中 · 3d 前 ✅
#9d2c4410 · 写文档 · 空闲 · 5h 前

**docs** · `D:\docs`

#7b1e0022 · 补文档 · 空闲 · 2h 前

归档 `/sessions archive <id>` · `/sessions all` 看全部会话
```

- 标题 `### 图标 标题`：图标后一个空格；标题说清「是什么 + 多少个」，不加句号。
- 标题后、区块之间各一个空行；结尾不留空行。
- 字段行 `**字段**: 值`，字段名 2–4 字；值里的 id / 路径 / 命令 / 预设名用反引号。
- 多字段视图字段之间不空行；分组小标题（如 `**通用能力**`）独占一行，后接条目。
- 工作中会话列表按工作区分组，组标题与 `/sessions all` 同一写法；归档候选同样按工作区分组（组内不再重复工作区名）；所有目标都用 8 位短 id，列表与候选都不编号。
- 列表：有序 `1. `；无序行首 `· `；不嵌套，不用 `-` / `*`（QQ 渲染不稳，且与行内分隔符 ` · ` 撞脸）。会话行是可点击按钮，行首直接是 `#id`，不加列表前缀。
- 分页：一页 10 条（`PAGE_SIZE`）；多页时页脚只放分页控件，写成 `上一页 · 第 1/2 页 · 下一页`，缺哪边就省略哪边；标题只写「是什么 + 多少个」，不重复页码，也不在控件里夹「还有 N 个」。
- 批量结果：首行汇总（`🗄 已归档 3 个会话，1 个失败`），随后每行 `✅/⚠️ + 序号 + 标题 + id`，跳过项用 `· ` 单列。

**反馈型**（单条命令结果）：

```
✅ 工作区已切到 **repo** · `D:\repo`
```

```
⚠️ 目录不存在: `D:\nope`
换一个存在的目录，或直接给绝对路径。
```

- 第一行就是结论（`✅` / `⚠️` / `❌` + 动词短语 + 值），不要「操作完成，结果如下」这类垫场；纯信息类（版本、无会话提示）用领域图标开头。
- 需要下一步时只给一行动作；不需要就只回一行。同一件事不要正文说一遍、结尾再说一遍。
- 不在成功回复里补「祝你愉快」这类客套。

### 4.5 标点、空格与数字

**冒号只有两种**：

- 「标签: 值」结构（字段行、列表项、用法提示、原始错误消息）→ 半角 `: `，冒号后恰好一个空格。
- 中文句子里引出一整段说明 → 全角 `：`。例：`⚠️ \`/permission\` 仅限白名单用户：需要把你加入 \`access.c2cAllow\`。`

判据：冒号后面是**一个值**（名字、路径、id、数字、原始错误消息）就用半角；是**一句话**（含标点、动词短语、能独立成句）就用全角。状态行（`✅` / `⚠️` / `❌` 开头）按同一条判据走，不另立规则。

- 句子用全角标点 `，。；！？`；引号用 `「」`（会话标题、用户原话），不要 `""` / `''`。
- 括号：中文内容用全角 `（…）`；纯 ASCII 内容用半角并在前留一个空格，如 `工作区内修改 (workspace-write)`。
- 省略号用 `…`，不写 `...`；中文破折号用 `——`，不写 `—` 或 `--`。
- 中文与英文 / 数字之间留一个半角空格：`约 128 tokens`、`dsh-qqbot v0.5.5`、`共 3 个`。
- 单位紧贴数字：`12ms`、`27m`、`2h10m`；计数用千分位且固定 en-US（`num()`），如 `1,234`。
- 英文拟声与纯英文句用半角 `!`（`✅ pong!`）；中文句子用全角 `！`；同一句不混用。
- 行内分隔统一 ` · `（前后各一个空格）；不要用 `|`、`、`、`/` 当分隔符（`/` 留给命令与模型 id）。
- 时间用相对格式 `3d 前` / `2h10m 后`；未知值写 `—`，不要 `N/A`、`无`、`-` 混用。
- 会话 id 用 8 位短 id 并在前面加 `#`；正文行内引用一律反引号（`` `#3f2a9b1c` ``、`` `D:\repo` ``），路径不转义、不做跨平台改写。
- 不要输出 ANSI 颜色、全角空格或制表符对齐；对齐只能靠一格半角空格与 ` · `。

### 4.6 按钮与可点击指令

- `label` ≤ 10 个字符（`BUTTON_LABEL_MAX`，两列布局），超长截断补 `…`（`buttonLabel()`）；完整文本留在正文。
- `label` 用「图标 + 动作短语」：`✅ 允许一次`、`❌ 拒绝`；`visited_label` 用 `✓ 已<动词>`。
- 可点击指令一律 `<qqbot-cmd-input text="/命令 参数" show="展示文本"/>`：
  - `text` 必须是**真能执行**的命令（含真实 provider / id / 页码，重复点击由命令自身幂等兜底）；
  - `show` 是给人看的短标签，**不写 markdown**（键盘按纯文本渲染，反引号会原样显示）；正文里的 `#id` 在 `show` 里裸写。
- 属性值先净化再拼接：去换行、去 `` ` * _ ~ < > " ' ``，超长截断到 28 字补 `…`（`shortTitle()`）；`&` 按上下文转义。
- 当前项标记一律放行尾：`… ✅`（前面一个空格）。按钮 `show` 与正文列表都这样，不用 `✅ ` 前缀——`/sessions` 工作中会话列表、`/model`、`/preset`、`/permission` 共用这一种写法；`/sessions all`、归档页不标当前。
- 持有标记一律放行尾：`… 📌`（前面一个空格），只出现在 `/sessions all` 与归档候选；工作中会话列表本身不重复标 `📌`，同一条消息也不会同时出现 `✅` 和 `📌`。
- 按钮发送失败必须降级成纯文本，保留同样的事实与下一步，不许静默丢消息。

### 4.7 纯文本回退通道

- 需要两版时（如未知指令提示）：markdown 版保留 `**`、反引号、可点击指令；纯文本版**只去掉标记**，指令写成裸 `/cmd`。
- 两版的行数、顺序、事实必须一致；不要只改一版措辞。
- 发送统一走 `textChunkLimit`（默认 4500，QQ 上限约 5000），不手写切分；超长结果截断时写明 `…（已截断）`。

### 4.8 用词与语气

| 统一用 | 不要用 |
|---|---|
| 工作区 | 项目、目录、cwd（混用） |
| 会话 | 对话、chat |
| 归档 / 取消归档 | 删除、隐藏 |
| 权限预设 | 权限模式、沙箱模式 |
| 模型 | 大模型、LLM |
| token | Token、令牌 |
| preset | 预设（agent preset 不译） |
| OpenID | openid、用户 ID |

- 第二人称用「你」；不自称「我们」，不用「您」。
- 失败文案 = 原因 + 下一步：`⚠️ 目录不存在: \`D:\nope\`\n换一个存在的目录，或直接给绝对路径。` 只说失败不给动作，视为没写完。
- 不写「抱歉」「请稍候」「操作成功」；命令本身就是对话，不需要客套。
- 状态用「已 / 正在」：`已切换`、`正在生成`；不叠词（`成功切换完成`）。
- 权限、token、文件路径这类敏感或长值不省略、不概括，宁可多一行。

### 4.9 简洁：描述性文字

目标不是短，是**不让用户读第二遍**。命令回复是交代结果，不是说明书。

硬约束：

- 反馈 ≤ 3 行；视图 ≤ 12 行（列表按条数分页，指令清单按分组列，不受此限）。超了就拆命令或分页，不靠缩句硬塞。
- 一行 ≤ 40 个汉字；超了断行或删修饰。
- **一条消息最多一处「下一步」**，放最后一行（分页条属于数据，不算提示）。不要正文说一遍、结尾再说一遍。
- 不复述用户已知的东西：刚发的命令、页面上已有的按钮、会话标题、当前路径。
- 不解释实现：不写宿主服务名、registry、profile 机制、内部错误类名。用户要「怎么办」，不要「为什么这样」；原始错误码只在排障必要时留一行。
- `**` 只用于两类：字段标签（`**会话**: …`）和消息里唯一的具名实体（工作区标题、OpenID）。不拿加粗当强调，一条消息不出现第二处强调性加粗；也不是每个字段都要配图标。
- 不用「注意」「重要」「务必」「强烈建议」「一定要」；不堆感叹号；不用反问句施压。
- 括号最多一层，只补必要信息；括号里套括号，说明该拆行。
- 不给备选方案清单，给一个最佳动作；确实要第二条路，并进同一行用 ` · ` 隔开。
- 删虚词：`非常`、`可能`、`基本上`、`建议您`、`请务必`、`相应`。
- 用正向表述：`换一个存在的目录` 优于 `不要用不存在的目录`。

改前 / 改后（同一件事）：

```
差  ✅ 模型已切换: openrouter/deepseek-v4-flash
    立即生效，对话上下文保留。如果你需要切回原模型，可以先发送 /model 查看列表，
    再点击对应条目（注意：仅对当前会话生效，新会话仍使用 profile 默认配置）。

好  ✅ 模型已切换: openrouter/deepseek-v4-flash（立即生效）
```

```
差  ⚠️ 归档失败：宿主未挂载会话归档接口。归档依赖宿主的 workspace registry
    （@deepseek-ai/dsh-workspace）：web / desktop profile 自带，自建的最小 profile
    需要手动挂载。你可以检查 profile 配置，或者换一个 profile 再试。

好  ⚠️ 归档失败: 会话仍在运行（先 `/stop` 再归档）
```

```
差  ✅ 已开启新会话
    工作区: repo · `D:\repo`

    下一条消息会在这里开新会话。想换工作区的话，可以发 `/new <名字|路径>`，
    也可以在 `/sessions all` 里看看有哪些工作区。

好  ✅ 已开启新会话
    工作区: repo · `D:\repo`
```

审稿只问两句：删掉这一行，用户会少知道什么**必要**信息？这一行是事实，还是劝说？

### 4.10 客户端面板文案（`src/client/`）

- 标题是名词短语（`扫码绑定 QQ 机器人`），按钮是动词短语（`改用扫码绑定`、`解绑`），不加句末标点。
- 状态行可用 emoji（`✅ 扫码成功`），同样禁用 `✓`；失败态必须给可执行入口。
- 表单与错误提示写「哪错了 + 怎么改」，不要直接把宿主原文抛给用户。

### 4.11 自查

改文案或新增命令后至少跑一遍：

```bash
# 文字符号只应命中按钮 visited_label 与终端日志（4.2 的两个例外）
rg -n '[✓✔☑√×✗]' src --glob '!*.test.ts'
# 全角冒号后跟反引号 / 插值：多半是「标签：值」误用了全角，按 4.5 的判据过一遍（注释命中忽略）
rg -n '：`|：\$\{' src --glob '!*.test.ts'
# 劝导式措辞 / 二次提示（4.9：描述性文字只交代结果）
rg -n '注意|务必|强烈建议|建议您|也可以|另外' src/commands src/features --glob '!*.test.ts'
```

三条命令零命中（或只剩 4.2 的例外）才算过。发现偏差当场改，不要在代码里攒「待统一」清单。

### 4.12 非当前会话标记（消息 / 提问 / 审批）

QQ 里只有一个聊天窗口，多个已获取会话的输出、提问、审批都回到这里。「这条是谁说的」只靠首尾两行标记交代，不靠图标、不靠语气。

**首行**（独占一行，后接空行）：`` > `#短id` · 标题 ``

- 短 id 必须包进行内代码，不要写成 `> #短id`：QQ 的 markdown 会把引用行里以 `#` 开头的内容当成标题，整行渲染成大字加粗。
- 不带 emoji。`🗂` 是「会话列表」这类视图的领域图标（§4.3），来源行只是署名；加上它会和正文结论抢第一眼的注意力，也让人误以为是一条列表。
- 标题取日志里最新一条 `session/title`（`sessionTitleOf`），取不到写 `未命名会话`，压到 20 字以内（`sourceTitle`）。
- 非当前会话的提问、审批用同一个首行；正文里不再塞 `[#id]` 之类的行内标记（那是同一件事的第二种写法）。

**末行**（独占一行，前面空行）：`> <回复> · <恢复>`

- 两个都要：回复是 `/to #短id `（把消息发过去），恢复是 `/sessions resume #短id`（把当前指针切过去）。`show` 分别写 `回复` / `恢复`——id 已经在首行署名里，按钮上不重复。
- 长回复只在首片带首行、末片带末行，中间片一律不带（`chunkDecoratedSessionMessage`）。
- 提问无按钮时末行是 `回答` 与 `恢复`（`sessionReplyLink(id, '回答')`）；有按钮时只留按钮引导，不再给回答链接。
- 流式只作用于「发起时是当前会话」的消息（`shouldStream`），QQ 流式接口是整段 update、改不了首行；生成中途切走当前会话，这一段仍会缺署名。要署名完整，等这一轮结束再切——不要为了补标记去动流式链路。

**不套首行的情形**：会话内的状态提示（如提问超时）在非当前会话里要先给首行——它讲的是那条会话的事；而「这条没转发给当前会话」这类路由警告讲的是**当前这条消息**，不套首行，只在句子里带上 `#短id（标题）`（`sessionLabel`）。

实现集中在 `src/transport/session-source.ts`（`sessionSourceHeader` / `sessionLinkRow`），出站、交付物提示、提问、审批共用，不要在别处另拼一套格式。

## 5. 构建 / 测试 / 调试

| 命令 | 用途 |
|---|---|
| `pnpm install` | 安装依赖（只用 pnpm；不要用 npm/yarn 另生成锁文件，`package-lock.json` 不要与 pnpm 锁混用） |
| `pnpm build` | `tsc` + `tsdown`，产出 `lib/index.js` 与 `lib/client.js` |
| `pnpm build:client` | 只重建客户端 bundle |
| `pnpm dev` | `tsc --watch`（只监听服务端，客户端改动需手动 build） |
| `pnpm test` | `vitest run`（源码旁 `*.test.ts`，默认配置） |
| `pnpm typecheck:client` | 客户端类型检查 |
| `pnpm run lint` | ⚠️ 当前 devDependencies 没有 eslint，不要当作门禁 |

- 测试与源码同目录：`src/**/*.test.ts`，被 tsconfig 排除，不进 `lib/`。
- 测试不得访问真实 `~/.dsh`、真实凭据或外网；用 `mkdtempSync(tmpdir())` 建临时目录，必要时 mock `node:fs` / logger。
- 构建后必须提交 `lib/` 的 js 产物；不要为了“干净”删掉已入库的 lib。
- 提 PR 前至少 `pnpm build` + `pnpm test`；改客户端再加 `pnpm typecheck:client`。
- 相对导入必须带 `.ts` 后缀（`rewriteRelativeImportExtensions` 负责改写），不要改 `tsconfig*` 的 include/exclude 边界。

## 6. 版本、打包与发布

- **开发快照**：保持基线版本不变，只加 `-dev.N` 后缀（例：官方 `0.5.5` → 快照 `0.5.5-dev.0`）；不要把 dev 快照抬成 `0.5.6`。
- **正式发布**：更新 `CHANGELOG.md` 与 `CHANGELOG_EN.md`（Keep a Changelog 格式）→ 改版本号 → `pnpm build` → 打包/发布。
- `prepublishOnly` 会再跑一次 build；发布前仍要确认 `lib/` 与 `src/` 一致。
- 发布走内网 CI（`.orange-ci.yml` 引用 `git.woa.com` 配置），不要随意改动其 include。
- `ci:prepare-test-pkg` 会把包名改成 `@tencent/dsh-qqbot` 并改写 `cordis.patch.yml`，**只在一次性分支/临时目录运行**，不要把它的改动提交。
- 宿主升级后：更新 `dsh.compatibility.dshReleases` 与 note，重新验收客户端槽位和扫码绑定全流程。

## 7. 安装与 profile 隔离（联调）

- **主 profile 禁止 `link:` 开发目录**：只装官方版或 `file:` 冻结快照，避免本地半成品在下次重启后直接影响线上机器人。
- 开发调试用独立 profile（本机为 `qqdev`）：独立机器人应用 + `link:` 指向本仓库，与主 profile 并行、互不影响。
- 主 profile 换本地包：

  ```bash
  pnpm build && pnpm pack --pack-destination .pack
  # 重命名为 .pack/tencent-connect-dsh-qqbot-<版本>-YYYYMMDD-HHmm.tgz
  dsh plugin --profile web add file:<绝对路径>/.pack/tencent-connect-dsh-qqbot-<版本>-<时间戳>.tgz
  ```

  本地快照 tgz 命名规则：`.pack/tencent-connect-dsh-qqbot-<版本>-YYYYMMDD-HHmm.tgz`（例：`.pack/tencent-connect-dsh-qqbot-0.5.5-dev.1-20261105-1029.tgz`）。`pnpm pack` 默认输出不带时间戳，打完按此规则重命名；同一版本重打保留旧包，不覆盖。

  装完必须重启 dsh（`dsh plugin add` 只装包，不会通知运行中的宿主）；客户端改动还要刷新页面。`node_modules` 里是实体副本，之后仓库改动不会自动进入 profile。
- 回滚：`dsh plugin --profile web add @tencent-connect/dsh-qqbot@<官方版本>`，或恢复安装前备份的 `package.json` / `pnpm-lock.yaml`。
- profile 的 pnpm 版本要与它当前 `node_modules` 的 store 一致，而不是固定跟“创建时”的版本走：看 `~/.dsh/profiles/<name>/node_modules/.modules.yaml` 的 `packageManager` / `storeDir`（本机 web 当前为 `pnpm@12.4.2` / `store/v11`）。`dsh plugin` 调用 PATH 里的 `pnpm`，版本不匹配会报 `ERR_PNPM_UNEXPECTED_STORE`；此时换用与 `packageManager` 一致的 pnpm，不要用 `pnpm install` 迁移整个 profile 的 store。
- 本地快照 tgz 是 profile 的依赖目标，不要删除或移动；重新打包会产生新路径。

## 8. 安全与隐私底线

- **绝不提交真实 appId/appSecret、用户 OpenID、会话日志**。凭据只放 profile 的 `cordis.patch.yml` 或 `QQBOT_APPID` / `QQBOT_SECRET` 环境变量；示例一律占位符。
- 访问控制默认值不得放宽：私聊默认白名单、空名单拒绝；群消息一律拒绝（不再支持群聊）；审批/提问按钮必须校验点击者在白名单内。
- 文件发送走路径白名单，按真实路径（realpath）判定，禁止绕过符号链接检查。
- 媒体/缓存落在 `~/.dsh-qqbot/`，不要写进仓库。
- `.env`、`.dsh-sessions/`、`docs/` 已在 .gitignore 中，不要为了提交方便移除这些忽略。

## 9. 提交前检查清单

- [ ] `pnpm build` 通过，`lib/` 的 js 已更新并提交
- [ ] `pnpm test` 全绿；新逻辑有对应 `*.test.ts`
- [ ] 未新增 `@deepseek-ai/*` 运行期依赖；`inject` 与实际依赖一致
- [ ] `apply()` 没有阻塞式 await；异步错误都有 catch
- [ ] 客户端改动已 typecheck，并在 C2C 验证一次按钮回退
- [ ] 新增 / 修改的用户可见文案符合 §4（状态符号唯一、冒号与空格、`show` 内无 markdown）
- [ ] 没有提交 secrets、快照 tgz、备份目录等临时产物
- [ ] 版本号符合规则（正式版 / `-dev.N` 快照）
- [ ] 发布相关改动同步了中英文 CHANGELOG

## 10. 已知坑

- 在 DSH 沙箱会话里直接 `pnpm build` 可能因 ACL 无法写仓库已有子目录（`lib/`、`src/`，报 EPERM）；用普通终端构建，或在会话内提权执行。与仓库本身无关。
- 某些 pnpm 版本执行 `pnpm run build` 时会先做依赖校验并尝试重建 `node_modules`；可直接跑 `node_modules/.bin/tsc` + `node_modules/.bin/tsdown`，等价于 `pnpm build`。
- 改包名后只重建、不清宿主模块缓存，客户端可能报 “loaded without registering”。
