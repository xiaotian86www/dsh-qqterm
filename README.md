<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_SuperTerm-blue?style=for-the-badge" alt="QQ SuperTerm" />

**把 deepseek-harness 装进 QQ 私聊：会话、模型、权限、文件、审批，都在聊天窗口里完成。**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.0.2-blue)](./CHANGELOG.md)

<br/>

**[English](./README_EN.md) | 简体中文**

</div>

## 这是什么

QQ 超级终端（`dsh-qqterm`）是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 QQ 渠道终端。它**自身不提供任何 agent 能力**，只把宿主与已装插件的完整能力面接到 QQ 私聊里：宿主能做什么（模型、思考强度、preset、权限、压缩、工作区、工作树、插件安装、MCP 与工具），QQ 里就能做什么。能力面随宿主和插件走，插件版本不承诺一份落后的功能清单。

它自有的东西只有渠道适配：入站解析、分片与投递、附件、回复目标、绑定、多会话寻址与文案。判定线是一句话——**去掉 QQ 这层，这段代码还成立吗？成立就说明它属于宿主，插件只能问不能判。**

在这层适配里，唯一称得上「功能」的是**多会话管理**：QQ 只有一个聊天窗口，而 dsh 可以同时跑多个会话；名字、指针、寻址、快捷操作和后台回传都得由渠道自己发明。所以下面的介绍从它开始。

## 多会话管理

dsh 可以同时跑多个会话，QQ 只有一个聊天窗口。这一层是 dsh-qqterm 唯一自有的功能，也是本项目重点：宿主提供会话，但不提供「当前是哪个」「怎么在聊天里切」「后台跑完怎么回来」。

### 一个当前会话，一份名册

- 全 bot 只有一个「当前会话」：普通消息都续写它，key 固定为 `qqterm:${appId}:chat`。
- 被 `/sessions resume`、`/to`、后台消息碰到过的会话进「已获取集合」，它们的输出、提问、审批都回 QQ。
- 名册记最近 20 个会话（`model-prefs.json`），重启后列表照常列出冷会话；`/sessions resume` 才真正打开。
- 切走不释放：换「当前」不影响旧会话继续跑，下次 `resume` 接着它的完整历史。会话不按闲置时间回收。

### 寻址：8 位短 id

| 写法 | 含义 |
|---|---|
| `#a1b2c3d4` | 完整短 id，`#` 只是视觉前缀 |
| `a1b2c3d4` | 不带 `#` 也认 |
| `a1b2` | 前缀，至少 4 位且必须唯一 |
| `#a1b2,a3c4` | 批量，逗号（含全角）分隔，一次最多 10 个 |

列表**不编号**：翻页、分组之后「第几条」必然对不上，短 id 才是唯一句柄。

### 快捷操作：点一下就把命令填好

- `/sessions` 每行行尾直接给动作：`回复` / `停止`（只在生成中给）/ `归档`；归档视图每行给 `取消归档`；工作区组标题点一下是 `/new --dir <路径> -- `，补上提示词即可。
- 非当前会话的每条回复、提问、审批、失败卡片，尾部都给 `回复` 与 `恢复`；生成中加 `停止`，部署有归档能力时加 `归档`。
- 点击是把最小命令（`/to #a1b2c3d4 -- `、`/stop #a1b2c3d4`、`/sessions archive #a1b2c3d4`）填进输入框，**不替用户执行**：误触不产生动作，`/to` 与工作区入口都用 `--` 收尾并留一个空格，光标直接落在正文或提示词开头，带空格或以 `-` 开头的内容也不用再包引号。
- 点击与键盘走同一条命令路径：鉴权、文案、日志只有一份，按钮旁边永远能看见等价的命令原文。

### 后台会话的回传

- 非当前会话的输出在正文前单独一行 `> #短id · 标题`，正文后空一行给动作行。
- 当前会话的回复不加署名，所以「有署名 = 不是你现在盯着的那个会话」。
- 提问与审批带同一个 `#短id`；降级成纯文本时，回复用 `/to #短id` 指认会话。

### 每条命令只改它声明的那一样

| 命令 | 改什么 | 不动什么 |
|---|---|---|
| `/to <id>` | 把消息发给目标；未打开的会话先接回来 | 当前指针 |
| `/sessions resume <id>` | 当前指针（并接回历史） | 其它会话 |
| `/new` | 清当前指针，下一条消息建新会话 | 不停旧会话 |
| `/new --background` | 另开一条后台会话并立刻发提示词 | 当前指针、工作区 |
| `/stop [<id>\|all]` | 中止生成，丢弃该会话排队中的消息 | 指针 |
| `/clear` / `/clear all` | 停当前（`all` 停全部）+ 清指针（`all` 另清空已持有集合） | 会话日志 |
| `/sessions archive` | 宿主的归档状态 | 会话记录 |

### 归档与恢复

- 归档只改宿主 `workspaceRegistry` 的状态：从本列表与 Web 侧栏隐藏，日志原样保留，随时可以取消归档。
- 不提供物理删除：宿主没有删除 API，按存储布局删目录不可恢复，Windows 上还会撞上文件占用。
- `/sessions resume` 一个已归档的会话会先取消归档，回执里注明。
- 归档带工作树的会话时，宿主清掉干净的工作树、保留分支；插件只回执。
- 多个目标用逗号写在同一个词里（`#a,#b`），或整段写到 `--` 之后；没包引号又写成多段会按参数错误回绝。
- 当前会话被归档时指针清空，下一条消息落到新会话。
- 没有 `workspaceRegistry` 的部署里，归档相关子命令按未知子命令处理。

### 生成中与排队

- 排队只发生在同一会话内部：同一会话按到达顺序执行，跨会话互不阻塞。
- 会话正在生成时再发提示词，落点由宿主的 `ui-conversation.busyEnter` 决定：默认排队到本轮结束（回执 `✅ 已排队`，带 `/steer` 插话与 `/unqueue` 取消入口），宿主设为插话时在下一步消费（回执 `✅ 已插话`）。
- `/steer` 只改一条排队消息的落点，`/unqueue` 只删这一条，都不中止当前生成；`/stop` 才中止，并丢弃排队中的消息。

### 常用写法

| 写法 | 效果 |
|---|---|
| `/sessions` | 列出 QQ 持有的会话，按工作区分组，一页 10 条 |
| `/sessions all` | 列出全部会话，含别的项目 |
| `/sessions <页码>` | 翻页 |
| `/sessions resume <id>` | 打开指定会话（已归档的先取消归档）；失败不新建 |
| `/sessions rename <id> <标题>` | 改已打开会话的标题；冷会话先恢复；标题有空格就用引号包起来，或写到 `--` 之后 |
| `/sessions archive` | 列出可归档的会话；`<页码>` 翻页 |
| `/sessions archive <id>[,<id>…]` | 归档一个或多个（最多 10 个）；目标写成一个词，或整段写到 `--` 之后 |
| `/sessions archived` | 列出已归档的会话 |
| `/sessions unarchive <id>[,<id>…]` | 取消归档；目标写法同归档 |

- 只有正在生成的会话在行首标 `⚡`（默认列表与 `/sessions all` 都标）；空闲行不写状态词，行尾 `✅`（当前）/ `📌`（已持有）是标记，可与 `⚡` 同行。
- 排序按最近一条人类消息倒序，同一时间按 id 升序；当前项不置顶，只靠行尾 `✅`。
- 分页页脚 `上一页 · 第 1/2 页 · 下一页`，缺哪边省略。
- 只在 C2C 私聊、且发送者等于 `access.owner` 时可用。

## 环境要求

- Node.js ≥ 22.12（见 `package.json` 的 `engines`）。
- 宿主 deepseek-harness 0.2.2-rc.1 / 0.2.2-rc.3（见 `package.json` 的 `dsh.compatibility`）；宿主大版本升级后需重新验收设置页与扫码绑定。
- 一个 QQ 机器人（Bot API v2）的 AppID 与 AppSecret；只服务 `access.owner` 一个用户，只支持单聊。

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

菜单固定六项：会话状态、会话列表、重置会话、压缩会话、权限预设、思考强度。权限与思考强度是二级菜单，其余项直接指向对应指令。菜单是 bot 级的整表覆盖，不按用户区分。

### 本地命令与目录（特殊功能）

`/run`、`/ls`、`/get` 不是宿主能力的转发，而是通道自己加的一组特殊功能：在 QQ 里直接操作运行 dsh 的这台电脑。它们不经过宿主的 shell 与沙箱，也不受权限预设、会话工作区或运行目录约束——效果等同于让能发消息的人坐到这台电脑的终端前。

三个命令共用同一个基准——**dsh 进程启动时所在的目录**（`process.cwd()`），与会话工作区、运行目录都无关，运行期 `cd` 也不改它。

`/run` 只接受一条命令：写在 `--` 之后时整段原样交给 shell，例如 `/run -- cd /d D:\source && dir`，管道、`&&` 与命令自己的 `-` 参数都不用再包一层；不写 `--` 时整条命令算一个位置参数，有空格就用引号包起来（`/run "cd /d D:\source && dir"`）。多给一个词按参数格式错误回绝；`--timeout` 这类开关只能写在 `--` 之前。命令字符串原样交给 shell，管道与 `&&` 都由 shell 在自己的命令行里解释。

| 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `exec.shell` | string | Windows `cmd.exe` 的实际路径；其它 `/bin/sh` | 执行 `/run` 的 shell；默认值按平台写进配置（Windows 优先环境里的 `ComSpec`），清空就是空（执行前报错），运行期不回落默认值 |
| `exec.shellArgs` | string[] | Windows `["/d","/s","/c"]`；其它 `["-c"]` | 传给 shell 的参数模板，`{command}` 原位展开成整条命令；默认值按平台写进配置，运行时按字面用（空就是不传参数），换 shell 不会自动改参数 |

`/get` 与 `/ls` 的绝对路径不受基准限制；`/run` 的命令是用户亲手打出来的，后果由用户承担，不套宿主沙箱。

**风险**

这组功能把「在这台电脑上执行任意命令、读任意文件」搬到了 QQ 消息上，风险与便利是同一件事：

- 发消息的人就能执行命令。`access.owner` 只认一个用户，但账号被盗、登录态被冒用或 owner 填错时，对方拿到的是与运行 dsh 的账号同等的权限：`/run` 能改文件、装东西、连外网，`/get` 能把任意可读文件发进对话。
- 没有沙箱、没有二次确认、没有命令白名单。插件不在执行前判断危险与否，也不问「确定吗」；宿主的沙箱与权限预设保护的是宿主自己的工具，对 `/run` 不生效。
- 命令以运行 dsh 的用户身份执行，能碰到的就是这个账号能碰到的一切；工作目录与环境变量（含凭据）对它可见。
- 输出与文件都经过 QQ 平台：`/run` 的输出回到对话里，`/get` 把文件直接发出去。

因此这组功能适合「一个人、一台自己的电脑、QQ 只自己登录」的场景。不接受这些风险就不要用：清空 `exec.shell` 只是让 `/run` 报错（`/ls`、`/get` 不依赖 shell，仍然可用），要整组去掉只能不部署带这组命令的版本。至少做到：owner 只填自己、QQ 账号开设备锁与二次验证、不要把这台电脑上的凭据放进会话目录。

## 会话、工作区与交互

### 工作区

工作区是宿主的 `workspaceRegistry` 概念，dsh-qqterm 不维护自己的目录列表。

- 没有 `cwd` 配置。新会话落在宿主的默认工作区（`Documents/deepseek-harness/default-workspace`），宿主读不到时用 dsh 的启动目录。
- 工作区跟着会话走：`/sessions resume` 在会话自己的工作区里跑，不要求先切目录；跨工作区恢复也照常。
- 换工作区只能通过 `/new --dir <工作区>` 决定下一条消息的落点；`/new` 本身留在当前工作区。
- 匹配顺序：工作区标题 → 目录名（大小写不敏感，唯一前缀匹配）→ 绝对路径。没有 `workspaceRegistry` 时只认绝对路径。
- 标题默认取目录最后一段，可以在 Web 侧栏改；手动改过的标题不会被自动改写。
- 工作树：`/new --worktree` 让下一条消息先按当前目录的 HEAD 建树，再在树里开会话，分支名 `dsh-<会话短 id>`。未提交改动不会带进树里。读不到 HEAD 或建树失败时这一轮不建会话，回复原因和下一步，意图保留，重发即重试；目录不是 Git 仓库时就地开会话并提示；只读沙箱在 `/new` 当场拒绝。归档会话时宿主会删掉干净的工作树、保留分支，有未提交改动则保留树。
- 团队模式：`/new --team` 让下一条消息建的会话开启智能体团队协作，与 Web 端「启用智能体团队协作」是同一个开关；`/status` 给「团队」行，没有会话但留了意图时写「下一条消息: 团队模式」。团队服务不在时按未知参数处理。
- 运行目录与工作区是两个概念：运行期 `cd` 只改运行目录；`/get`、`/ls`、`/run` 不跟它走，基准是 dsh 进程启动时所在的目录。工作区分组、`/status` 的工作区行、下一条 `/new` 的落点仍用会话创建时的 `header.cwd`。工作树会话的工作区是主仓库根，树只作运行目录。`/status` 会给工作区目录的当前 git 分支；有工作树时只在工作树行给树的分支。

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
- `/get` 可以发任意路径的文件，目录会被拒绝；`/ls` 用来浏览并点选。相对路径按 dsh 进程启动时所在的目录解析。
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
| `/new` | 新建会话；`--dir`（`-d`）指定工作区，`--worktree`（`-w`）让第一条消息先建工作树，`--team`（`-t`）让新会话开团队模式，`--background`（`-b`）后台另开一条且不动当前会话；剩下的文字作为提示词立即发出；回复一条消息再发时引用一并带上，只有引用也照常开会话；旧会话继续跑 |
| `/clear`（别名 `/reset`） | 停止当前会话，下一条消息在原工作区开新会话；`/clear all` 停掉所有已获取会话；先发 5 分钟确认卡 |
| `/compact` | 压缩会话历史（摘要替换旧记录），回复带出宿主命令的结果 |
| `/goal` | 设定或查看当前会话的长期目标；`/goal <目标>` 设定，`edit` / `pause` / `resume` / `clear` 管理 |
| `/sessions`（别名 `/session`） | 会话管理：默认列出 QQ 持有的会话（含重启后尚未打开的冷会话），`all` 看全部，`archived` 看归档；寻址、快捷操作与归档语义见「多会话管理」 |
| `/rename` | 修改当前会话标题；`/sessions rename <id> <标题>` 改已打开会话（标题有空格就用引号包起来，或写到 `--` 之后） |
| `/to` | 向指定会话发消息（`/to <id> <文本>` 是一段参数，有空格就用引号包起来；也可写成 `/to <id> -- <文本>`，`--` 之后整段原样；没包引号又有多段、或以 `-` 开头的词按参数错误回绝，只给目标算空正文）；目标在等答案时提交答案；尚未打开的会话先接回再发；回复一条消息再发时引用拼在正文前（目标在等答案时除外） |
| `/ls` | 列出当前目录（dsh 进程启动时所在的位置）里的子目录与文件，点目录进入、点文件发送；路径可用绝对路径或 `~` |
| `/get` | 把文件发到当前聊天（图片 / 视频 / 语音按类型发送），路径不限 |
| `/run` | 在当前目录执行一条本地命令（shell 用系统自带的，可在 `exec` 配置里换）；`--timeout <秒>` 改超时（默认 120 秒、最长 600 秒） |
| `/model` | 查看或切换当前会话的模型 |
| `/reasoning`（别名 `/think`） | 查看或切换当前会话的思考强度 |
| `/preset` | 查看或切换当前 agent preset（只对新建会话生效） |
| `/permission` | 查看或切换当前会话的权限预设（仅绑定用户） |
| `/cost` | 查看当前会话的 token 消耗 |
| `/status` | 查看会话状态：会话、状态、工作区、工作树、模型、思考强度、preset、权限、上下文 |
| `/stop` | 中止当前生成；`/stop <id>` 停指定已获取会话；`/stop all` 停全部；排队中的消息一并丢弃 |
| `/steer` | 把排队中的提示词改成插话（下一步生效）；不带参数用当前会话最近一条，`<id>` 指定已获取会话，`<id> <消息id>` 指定具体消息 |
| `/unqueue` | 取消排队中的提示词（不中止当前生成）；参数与 `/steer` 相同，已插话的消息不能取消 |
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
| `/new <提示词>` | 立刻在新会话发出这条提示词（有空格就用引号包起来，或写到 `--` 之后） |
| `/new --dir <工作区>` | 在指定工作区开新会话（`-d`，只收一个词） |
| `/new --background <提示词>` | 后台另开一条，不动当前会话与工作区（`-b`，必须带提示词） |
| `/new --worktree [提示词]` | 下一条消息先建工作树（`-w`，见「工作区」） |
| `/new --team [提示词]` | 下一条消息建的会话开团队模式（`-t`）；团队服务不可用时按未知参数处理 |

- 参数和提示词顺序随意；提示词只收一段：有空格就用引号包起来，或写到 `--` 之后（整段原样，不再拆词重拼）。
- `-w` 与 `-b` 可合写为 `-wb`；短参数连写时带值的 `-d` 放最后（`-wbd <工作区>`）。
- `--dir` 只收一个词；路径带空格时用引号包起来，也认 `--dir=路径`。
- 参数校验先于动会话：不存在的目录 / 文件直接拒绝，当前会话不受影响。
- 带参数的 `/new` 只对绑定用户开放；裸 `/new` 不限。
- 不知道路径时先用 `/ls` 走到目标目录，再照着用法发 `/new --dir`。

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
- **可选服务软读** — 可选能力不进 `inject`，在使用点现查；命令表是注册期快照，门控命令始终注册、由 `available` 在每次使用时现查；缺失只缩小能力面（按未知指令处理），不改变语义，也不解释、不提示。晚挂载的服务立刻出现在帮助、白名单与面板里（面板只在每次连接时同步）。

| 可选服务 | 缺了以后 |
|---|---|
| `agentPresets` | `/preset` 按未知指令处理，建会话不挂 preset；能力晚到后立刻可用 |
| `webServer` | 端内绑定页不注册，扫码只走终端 / 浏览器 |
| `workspaceRegistry` | `/sessions` 仍按目录分组，但组标题只有路径，没有 `📌` / 归档入口；归档子命令按未知处理；`/new --dir` 只认绝对路径 |
| `worktrees` | `/new --worktree` 按未知参数处理，新会话就地创建 |
| `agentTeams` | `/new --team` 按未知参数处理，新会话不带团队；`/status` 仍显示已开会话的团队模式（读日志投影，不依赖此服务） |
| `sessionController` | `/sessions` 的排序退化为创建时间；`/steer`、`/unqueue` 按未知指令处理，排队回执不给链接 |

- **一个当前会话 + 多份已获取会话** — 任何 QQ 窗口续写同一个当前会话；`/sessions resume` 与 `/to` 获取过的会话继续活着并把输出发回 QQ。
- **薄层** — 模型、preset、思考强度、权限、压缩、工作区都转发给宿主；插件只留通道独有的一层：入站解析、分片、附件、回复目标、绑定、多会话寻址与文案渲染。
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块 / 表格感知切分。
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
| `pnpm deploy:web` | 拉取 main、构建、测试，打 tgz 快照并装进 web profile |
| `pnpm run lint` | 没有 eslint 配置，不是门禁 |

测试放顶层 `tests/`，按模块镜像 `src/`，不访问真实 `~/.dsh`、真实凭据或外网。

## 延伸阅读

- [入站 / 出站路径](./docs/inbound-outbound-paths.md)
- [多会话设计](./docs/multi-conversation-design.md)
- [文案风格](./docs/copy-style.md)
- [变更记录与已知限制](./CHANGELOG.md)

## License

[MIT](./LICENSE)
