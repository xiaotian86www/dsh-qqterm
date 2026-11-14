# AGENTS.md — dsh-qqterm 开发约束

给在本仓库工作的开发者 / AI 助手：这里只写**不能违反的约束**和查表用的定值。
安装配置见 [README.md](./README.md)，版本变更见 [CHANGELOG.md](./CHANGELOG.md)。

## 1. 项目速览

- dsh（DeepSeek Harness）的 QQ Bot IM 通道插件，纯 Cordis 插件，不改宿主 loop。
- 宿主加载 `lib/index.js`，浏览器加载 `lib/client.js`（dsh.client 模块）。
- Node ≥ 20.3、TypeScript ESM、pnpm、vitest、tsdown。
- 当前宿主 dsh 0.2.2-rc.1 实测可运行；`dsh.compatibility` 只是声明，宿主升级后必须重新验收并更新。
- `lib/` 的 js 要提交（开箱即用）；`lib/**/*.d.ts`、`lib/**/*.map` 被 .gitignore 排除。

## 2. 目录地图

| 路径 | 职责 |
|---|---|
| `src/index.ts` | Cordis 入口：`name` / `inject` / `Config` / `apply` |
| `src/gateway/` | 中间件、事件、出站、生命周期 |
| `src/setup/` | 扫码绑定状态机、凭据持久化、端内绑定页 |
| `src/features/` | 问答、审批、指令面板、按钮协议 |
| `src/session/` | 会话寻址、后台会话切换 |
| `src/transport/` | 入站、出站、分片、附件、回复目标 |
| `src/commands/` | `/help`、`/status`、`/model`、`/preset`、`/sessions` 等指令 |
| `src/plugins/` | 插件安装 / 更新 / 热重载 |
| `src/media/` | 富媒体理解、附件发送、清理 |
| `src/host/` | 宿主 Agent/Session 适配 |
| `src/client/` | 浏览器端（settings.section） |
| `cordis.patch.yml` | bundle patch，插入 `qqterm` 条目（随包分发） |
| `cordis.dev.yml` | `--patch` 调试 overlay |
| `locale/*.json` | 插件 meta 文案；命令与消息文案内联在 `src/` |
| `tests/` | vitest 用例，`tests/**/*.spec.ts` 镜像 `src/` 目录，不进 `lib/` |
| `lib/` | 构建产物，**不要手改** |

## 3. 硬约束

### 3.1 宿主依赖

- `@deepseek-ai/*` 一律 `peerDependencies`，禁止进 `dependencies`，禁止打进客户端 bundle。
- 全硬依赖：用到的 `ctx` 服务都写进 `inject`，运行时不探测、不写降级分支；服务缺失时插件 inactive，不能抛错阻塞宿主。
  四个例外（不在 `inject` 里，部署可能没有）：
  - `agentPresets`：没有 `agent-preset-registry` 时插件照常激活，`/preset` 整条命令不注册（输入按未知指令处理），建会话走宿主默认组合。
  - `webServer`：只有 web / Desktop 组合包提供 `dsh-host-webserver`。端内绑定页经 `mountBindRoutes`（`src/setup/bind-routes.ts`）用 `ctx.inject(['webServer'], …)` 订阅，服务到位时注册、离开或替换时由 Cordis 注销；没有服务时扫码只走终端 / 浏览器降级通道。
  - `sessionController`：不是能力依赖。`/model`、`/reasoning` 一律走宿主 dsh-agent 的 `agent.model.select`（与 Web 端切模型落同一条 `model/selection`，见 §3.4），插件只在 `createHostAdapter` 里软读一次 `list()`，取 `/sessions` 排序用的 `updatedAt`（`max(createdAt, lastPromptAt)`）与 `blank`；缺服务或读取失败只丢排序与空白会话过滤，列表照常返回。
  - `workspaceRegistry`：只有 web 组合包挂载 `dsh-workspace`，归档 / 置顶集合没有 base 等价数据。缺服务时 `supportsWorkspaceRegistry()` 为 false：`/sessions` 仍按会话目录分组，但组标题只显示路径（没有工作区名、不出 `📌`），归档 / 取消归档子命令按未知子命令处理（与其它拼错的子命令同一句，用法页不列），`/new <名字>` 回不支持（绝对路径照常，用法页、`/status` 的工作区行与成功回执都只给路径），不调宿主归档。没有 `hmr` 时 `/plugins reload` 同样按未知子命令处理，不写「未启用热重载」。
- 可选服务一律用 `ctx.get(name)` 读（`src/shared/utils.ts` 的 `optionalService`）：属性访问在服务不在 `inject` 里时会直接抛 `cannot get property "x" without inject`，可选链兜不住。
- 因可选服务缺失而不可用的能力**不解释、不提示**：整条命令不注册（`/preset`），子命令按未知子命令处理（`/sessions archive|archived|unarchive`、`/plugins reload`），用法页也不列——聊天里不出现「当前部署不支持」这类部署差异。
- 不 import 宿主包私有深层路径，能力走 `ctx` 服务或公开导出。
- 版本号运行时读 `package.json`（`src/shared/utils.ts`），不另建常量。

### 3.2 启动与生命周期

- `apply()` 必须立即返回：扫码、网关、长轮询一律 `void …catch()`，禁止 await 用户交互。
- 禁止运行时写 `process.env`；凭据只写 profile 的 `cordis.patch.yml`。
- 未捕获 rejection 在宿主是致命错误，所有异步链必须有兜底 catch。
- 长生命周期对象（网关 socket、定时器）必须在 `outsideHmrTransaction` 里创建（`src/index.ts` 两处 `bootstrapGateway`）：宿主用 AsyncLocalStorage 标记「正在应用变更」，在事务里建的 socket 会一直带着它，之后每条入站消息写配置都报 `HMR transactions cannot be nested`。
- `name = 'qqterm'` 与 patch entry id 是兼容契约，改了用户 profile 里按 id 的配置覆盖会失效。`inject` 只进不退（当前 14 项；不在其中的可选服务是 `agentPresets`、`webServer`、`workspaceRegistry`，`sessionController` 只是 `/sessions` 排序用的软读）。`compaction` 不进 `inject`：它挂在 agent preset 作用域，`/compact` 的判定与执行都交给 base 的 `commands` 登记簿（`find` 判可见性、`execute` 转发宿主命令），插件不解析 preset 服务。

### 3.3 客户端

- 入口 id 必须等于包名（tsdown 读 package.json）；改包名要同步 `cordis.patch.yml` 的 `name` 与 `PACKAGE_NAME`，否则报 “loaded without registering”。
- 外部依赖只有 `react` / `react-dom`（`tsdown.client.config.ts` 的 `BASELINE_EXTERNALS`），其余内联；新增依赖先看体积。
- 唯一槽位 `settings.section`：绑定 / 换凭据 / 解绑 / 配置编辑全在设置页一个栏目。不要注册 `sidebar.right.pane.tab`、`main`、`sidebar.panellist` 或插件详情动作。宿主大版本升级后 Desktop 与 dsh web 两端重新验收；服务缺失时静默 inactive，不能白屏。

### 3.4 交互与消息

- 只做 C2C 私聊，群消息在 accessPolicy 拦掉，代码里没有群聊分支。按钮键盘只在 C2C 可用，发送失败必须降级成文本并记 warn；改问答 / 审批时在 C2C 验证回退。
- `ask_user_question` / `approval` 走宿主 waterfall，不要退回 `userQuestions.ask` 式探测。QQ 卡片投递失败必须 `return nextFn()` 交回宿主其它通道（Web 仍能弹窗），不能判成 `unavailable` 吞掉。
- 聊天会话 key 固定 `qqterm:${appId}:chat`，全 bot 只有一个「当前会话」。已获取会话可以有多份，全部输出回 QQ；非当前会话消息首行 `` > `#短id` · 标题 ``，正文后空一行给「回复」「恢复」链接（长回复只在首片带首行、末片带链接）。
- `/sessions` 默认按工作区分组列工作中会话（组标题带路径，行带 `生成中` / `空闲` 与 `✅`）；`/sessions all` 看全部、只标 `📌`。没有 `workspaceRegistry` 时仍按目录分组、组标题只显示路径、不标 `📌`、不给归档入口，归档相关子命令按未知子命令处理，`/new` 只认绝对路径（见 §3.1）。`resume` 只改当前指针；`/new` 清指针（不预先铸 id，下一条消息再建会话）；切走不 dispose 旧会话；`/clear`（别名 `/reset`）停当前再开新，`/clear all` 停全部；`/stop` 停当前，`/stop all` 停全部正在生成的。无映射即全新会话，id 由 `mintSessionId()` 铸造。
- 启动恢复：QQ `ready` 后 `SessionManager.restoreCurrentSession()` 按 prefs 指针走 `getOrCreate`（singleflight）；盘上已无则跳过并清指针，**恢复失败绝不新建**；占用 / 后端故障时指针保持原样。
- 回复目标持久化在 `model-prefs.json` 的 `targets`（`sessionKey → openid`），`touch()` 里值变化才写。恢复失败（locked / 宿主报错）用它推 `⚠️ 上次的会话没能恢复` + `/sessions resume` 按钮，`not-found` 静默。持久化写在消息路径上，不写卸载钩子（强杀不执行）。
- 模型 / preset / 思考强度沿用宿主核心行为，插件不另立：没有 `provider` / `model` / `preset` 配置项，新会话取核心默认值。`/model`、`/reasoning` 有活跃会话时调 `agent.model.select` 写进该会话的 `model/selection`（不 fork 不重建，下轮生效），同时把同一份选择写成部署默认值；无会话时只写部署默认值（`agentDefaultModel.saveSelection`；`/permission` 走 `settings.update('permission', { defaultPreset })`），不为切换拉起会话。整段「读当前值 → 校验 → 写回」走 `serializeSelection`，同一会话的 QQ 侧写入串行（Web 端并发不算在内）。两种情况下查看视图都显示当前值并标 `✅`，不造「全局」标签。`/preset` 写 `agent-preset-registry.selectedDefault`，对新建会话生效，已开会话保持自己的 preset；插件不存 preset。部署里没有该注册表时 `/preset` 不注册，建会话不挂 preset。`create` / `resume` 的 `agentOptions` 传 getter 读 `agentDefaultModel.currentSelection()`。插件只在 `~/.dsh-qqterm/model-prefs.json` 存 `sessionIds` / `dirs` / `targets`；聊天工作目录以内存变量为唯一读写来源，磁盘只做镜像：构造时优先读回上次记下的目录（目录已不在才退回宿主默认工作区），之后由已获取会话、切换会话、`/new <工作区|路径>` 与运行期 `working-directory/change` 覆盖并落盘，读取不回退。
- 会话标题由 `sessionTitle.rename` 写入 `session/title`，写完即固定。`/rename` 只改当前会话；`/sessions rename <id> <标题>` 改已打开会话（同样私聊 + `access.owner`）。两者只接受 live session，冷会话提示先 `/sessions resume`，不偷偷拉起。
- 入站 `source.kind` 必须是 `user`（`src/session/user-message.ts`）：会话标题、最近提问时间、轮次大纲、replay 断点都以「人类消息」为触发条件。自造 kind 的后果是所有新会话停在「未命名会话」。
- Markdown 按 `textChunkLimit` 分片，代码块 / 表格感知切分在 `src/transport/chunker.ts`，不要绕过。
- 普通消息在 `agent.followup()` 之后必须立刻返回：`concurrencyGuard` 以 QQ 用户为键，`await agent.whenIdle()` 会占着锁把别的会话一起堵住。轮内顺序由宿主 next-turn inbox 保证，跨会话必须互不阻塞。
- 工具结果只在 `showToolResults` 打开时推送，默认一条不发；失败按 §4.3 的两行格式给目标与原因，不是裸的「执行失败」。
- 用户可见文案内联在 `src/`（`locale/*.json` 只有插件 meta）；注释与内部日志用中文。

### 3.5 简单优先

- 设计先问「能不改结构吗」，再问「怎么改最小」。
- 每多一个实体（模块、类型、选项、配置、命令、分支、钩子、依赖、文档章节、测试设施）都要先证明必要；优先用默认值、已有别名、已有事件与服务、现有命令参数——扩展优于新建，参数优于新命令，复用优于抽象。
- 新增实体前三问：现有结构为什么表达不了？第二个使用方在哪？删掉会坏哪个用户可见行为？答不上来就不加。
- 同一事实只留一处来源。兼容契约（§3.2 / §3.3 的 id）、错误兜底与安全校验（§8）不因「少一个分支」被删。

## 4. 用户可见文案

覆盖 QQ 消息正文（markdown + 纯文本回退）、键盘 `label` / `visited_label`、端内面板、终端扫码引导；不含注释与内部日志。目标：**同一意思只长成一个样子**。

### 4.1 状态符号

| 语义 | 符号 | 位置 |
|---|---|---|
| 成功 / 已完成 | `✅` | 行首 |
| 失败 / 拒绝 | `❌` | 行首 |
| 警示 / 降级 | `⚠️`（必须是 `U+26A0 U+FE0F`） | 行首 |
| 提示 / 引导 | `💡` | 不占行首（`> 💡 …`） |

- 命令回复第一行必须带图标：状态类用上表，信息类用领域图标；裸文本开头会被读成模型正文。
- 正文与按钮 label 禁用 `✓ ✔ ☑ √ × ✗`（无 emoji 字形，混排必割裂）；一行最多一个状态图标且在行首（批量结果清单除外）。
- 例外：按钮 `visited_label` 用纯文本 `✓ 已允许` / `✓ 已拒绝` / `✓ 已选`（与 label 成对，改要一起改并同步 `src/features/*-renderer` 单测）；终端日志前缀 `✔`（`src/setup/persist.ts`、`src/setup/binding-service.ts`）只进终端。

### 4.2 领域图标

新增场景先补这一行再用，不当装饰或对齐符号：

`🤖` 指令 / 模型 · `🗂` 会话 · `📌` 已持有 · `🗄` 归档 · `♻️` 取消归档 · `📁` 目录 · `📊` 状态 · `🛡️` 权限 · `🧩` preset · `🧠` 思考 · `💰` 计费 · `🔌` 插件 · `🔐` 审批 · `❓` 提问 · `🔧` 工具 · `🆔` 身份 · `💬` 私聊 · `👇` / `💡` 引导 · `⛔` 中止 · `📎` 附件 · `📖` 用法

### 4.3 消息骨架

- 视图型：标题 `### 图标 标题`（是什么 + 多少个，不加句号）；区块间一个空行，结尾不留空行。
- 字段行 `**字段**: 值`（字段名 2–4 字，id / 路径 / 命令 / 预设名用反引号），字段之间不空行。
- 列表：有序 `1. `，无序 `· `，不嵌套，不用 `-` / `*`；会话行是按钮，行首直接 `#id` 不加前缀；按工作区分组，组标题与 `/sessions all` 同写法；目标一律 8 位短 id，不编号。
- 分页一页 10 条（`PAGE_SIZE`），页脚 `上一页 · 第 1/2 页 · 下一页`，缺哪边省略，标题不写页码。
- 批量结果：首行汇总（`🗄 已归档 3 个会话，1 个失败`），随后每行 `✅/⚠️ + 序号 + 标题 + id`，跳过项 `· ` 单列。
- 反馈型：第一行就是结论（图标 + 动词短语 + 值），不写垫场；需要下一步就给一行动作，不需要就只回一行。
- 篇幅：反馈 ≤ 3 行，视图 ≤ 12 行（列表分页，指令清单不受限）；一行 ≤ 40 个汉字。

### 4.4 标点与空格

- 冒号：后面是**一个值**（名字、路径、id、数字、原始错误）→ 半角 `: `；引出一整**句** → 全角 `：`；状态行同一条判据。
- 句内用全角 `，。；！？`；引号 `「」`；中文用全角括号，纯 ASCII 用半角并在前留一个空格（`工作区内修改 (workspace-write)`）；英文句与拟声用半角 `!`（`✅ pong!`），中文句用全角 `！`。
- 省略号 `…`，破折号 `——`；中文与英文 / 数字间留一个半角空格（`约 128 tokens`）；单位紧贴数字（`12ms`、`2h10m`）；计数千分位用 `num()`。
- 行内分隔统一 ` · `，不用 `|`、`、`、`/`（`/` 留给命令与模型 id）；不输出 ANSI 颜色、全角空格、制表符对齐。
- 时间用相对格式 `3d 前` / `2h10m 后`，未知写 `—`；会话 id 用 8 位加 `#`，正文里包反引号；路径原样，不转义不改写。

### 4.5 按钮与可点击指令

- `label` ≤ 10 字符（`BUTTON_LABEL_MAX`），超长由 `buttonLabel()` 截断补 `…`；写法「图标 + 动作短语」（`✅ 允许一次`），完整文本留在正文。
- 可点击指令一律 `<qqbot-cmd-input text="/命令 参数" show="展示文本"/>`：`text` 必须真能执行（重复点击由命令幂等兜底），`show` 是纯文本短标签、不写 markdown。
- 属性净化：去换行、去 `` ` * _ ~ < > " ' ``、超长截到 28 字补 `…`（`shortTitle()`），`&` 按上下文转义；例外是 `/sessions` 组标题的路径链接，`show` 用原始路径（只去换行 + 属性转义），不过 `cleanInline()`。
- 当前项 `… ✅`、持有项 `… 📌`：一律行尾、不用前缀，同一条消息不同时出现两者；按钮发送失败必须降级成纯文本，事实与下一步都不能丢。

### 4.6 纯文本回退

- 两版只差标记：去 `**` 与反引号、指令写裸 `/cmd`，行序与事实完全一致；发送统一走 `textChunkLimit`（默认 4500，QQ 上限约 5000），不手写切分，截断写 `…（已截断）`。

### 4.7 用词与语气

| 用 | 不用 |
|---|---|
| 工作区 | 项目、目录、cwd（混用） |
| 会话 | 对话、chat |
| 归档 / 取消归档 | 删除、隐藏 |
| 权限预设 | 权限模式、沙箱模式 |
| 模型 | 大模型、LLM |
| token | Token、令牌 |
| preset | 预设 |
| OpenID | openid、用户 ID |

- 第二人称「你」，不自称「我们」，不用「您」；不写「抱歉」「请稍候」「操作成功」；状态用「已 / 正在」，不叠词。
- 失败文案 = 原因 + 下一步（`换一个存在的目录，或直接给绝对路径。`）；例外：设置类命令（`/model`、`/reasoning`、`/preset`、`/permission`）报错只写原因，「怎么改」由该命令的查看界面给出。
- 权限、token、路径这类敏感或长值不省略、不概括。

### 4.8 简洁

- 交代结果，不是说明书：一条消息最多一处「下一步」放最后一行（分页条不算）；不复述用户已知（刚发的命令、已有按钮、会话标题、当前路径）。
- 不解释实现（宿主服务名、registry、profile 机制、内部错误类名）；原始错误码只在排障必要时留一行。
- `**` 只用于字段标签与消息里唯一的具名实体，不拿加粗当强调；括号最多一层。
- 不用「注意 / 重要 / 务必 / 强烈建议 / 一定要」，不堆感叹号、不用反问句；删虚词（非常 / 可能 / 基本上 / 建议您 / 请务必 / 相应）。
- 不给备选方案清单，给一个最佳动作，第二条路并进同一行用 ` · ` 隔开；用正向表述。

### 4.9 客户端面板

- 标题是名词短语（`扫码绑定 QQ 机器人`），按钮是动词短语（`改用扫码绑定`），不加句末标点。
- 状态行可用 emoji（同样禁用 `✓`），失败态必须给可执行入口；表单与错误提示写「哪错了 + 怎么改」，不直接抛宿主原文。

### 4.10 自查

改文案或新增命令后必跑，三条零命中（或只剩 §4.1 例外）才算过：

```bash
rg -n '[✓✔☑√×✗]' src                              # 文字符号：只该命中 visited_label 与终端日志
rg -n '：`|：\$\{' src                              # 「标签：值」误用全角冒号
rg -n '注意|务必|强烈建议|建议您|也可以|另外' src/commands src/features
```

发现偏差当场改，不攒「待统一」清单。

### 4.11 非当前会话标记

QQ 只有一个窗口，多个已获取会话的输出、提问、审批都回到这里，署名只靠首尾两行；实现集中在 `src/transport/session-source.ts`（`sessionSourceHeader` / `sessionLinkRow`），出站、交付物、提问、审批共用，不要另拼。

- 首行：独占一行、后接空行，`` > `#短id` · 标题 ``；短 id 必须包行内代码（QQ 会把引用行里 `#` 开头的内容渲染成标题）；不带 emoji；标题取最新 `session/title`（`sessionTitleOf`），取不到写 `未命名会话`，压到 20 字内。
- 尾部动作：正文后空一行、独占一行，`回复`（`/to #短id `）+ `恢复`（`/sessions resume #短id`）；长回复只在首片带首行、末片带链接（`chunkDecoratedSessionMessage`）。
- 非当前会话的提问 / 审批用同一首行，正文不塞 `[#id]`；提问在引导行给 `回答 · 恢复`，审批 / 重试有自己的键盘，不追加。
- 不套首行：讲「当前这条消息」的路由警告只在句子里带 `#短id（标题）`（`sessionLabel`）。

## 5. 构建 / 测试

| 命令 | 用途 |
|---|---|
| `pnpm install` | 只用 pnpm，不要生成 `package-lock.json` |
| `pnpm build` | `tsc` + `tsdown`，产出 `lib/index.js` 与 `lib/client.js` |
| `pnpm build:client` | 只重建客户端 |
| `pnpm dev` | `tsc --watch`（客户端改动要手动 build） |
| `pnpm test` | `vitest run` |
| `pnpm typecheck:client` | 客户端类型检查 |
| `pnpm run lint` | ⚠️ 没有 eslint，不是门禁 |

- 测试放顶层 `tests/`，镜像 `src/` 的目录结构（`tests/commands/foo.spec.ts` 测 `src/commands/foo.ts`），文件名一律 `*.spec.ts`；由 `vitest.config.ts` 的 `include` 收集，`tsconfig.json` 的 `exclude` 排除，不进 `lib/`。
- 测试不得访问真实 `~/.dsh`、真实凭据或外网；用 `mkdtempSync(tmpdir())` 建临时目录，必要时 mock `node:fs` / logger。
- 构建后提交 `lib/` 的 js；提 PR 前至少 `pnpm build` + `pnpm test`，改客户端再加 `pnpm typecheck:client`。
- 相对导入必须带 `.ts` 后缀（`rewriteRelativeImportExtensions` 负责改写）；不要改 `tsconfig*` 的 include / exclude 边界。

## 6. 版本与发布

- 开发快照保持基线版本，只加 `-dev.N`（`0.0.1` → `0.0.1-dev.0`），不要抬成 `0.0.2`。
- 发布：更新 `CHANGELOG.md` / `CHANGELOG_EN.md`（Keep a Changelog）→ 改版本号 → `pnpm build` → 打包。
- `prepublishOnly` 会再 build 一次；发布前仍要确认 `lib/` 与 `src/` 一致。仓库没有 CI，由维护者本地构建后发布。
- `ci:prepare-test-pkg` 会把包名改成 `@tencent/dsh-qqterm` 并改写 `cordis.patch.yml`，只在一次性分支 / 临时目录跑，不要提交它的改动。
- 宿主升级后更新 `dsh.compatibility.dshReleases` 与 note，重新验收客户端槽位与扫码绑定全流程。

## 7. 安装与 profile 隔离

- 主 profile 禁止 `link:` 开发目录：只装已发布版本或 `file:` 冻结快照。
- 开发用独立 profile（本机 `dev`）：tgz 实体副本 + HMR 常开，与主 profile 并行。不用 `link:` 是因为 `pnpm build` 会直接改已加载的包，宿主的文件监听与构建互相踩；tgz 让「装包」与「重载」互相独立。
- 开发循环：`pnpm dev:reload dev`（`scripts/dev-reload.mjs`：build → pack 带时间戳 → `dsh plugin add`）→ QQ 里 `/plugins reload`。`✅ 没有需要应用的变更` 表示磁盘没变。
- 开发 profile 的 HMR 保持开启（不要写 `- id: hmr / disabled: true`）；base 组合包默认启用，headless / SDK 组合包没有该服务。
- 主 profile 换本地包：`pnpm build && pnpm pack --pack-destination .pack`，把产物重命名为 `.pack/dsh-qqterm-<版本>-YYYYMMDD-HHmm.tgz`，再 `dsh plugin --profile web add file:<绝对路径>`。装完必须重启 dsh，客户端改动还要刷新页面；tgz 是实体副本，仓库改动不会自动进入 profile。
- 回滚：`dsh plugin --profile web add dsh-qqterm@<已发布版本>`，或恢复安装前的 `package.json` / `pnpm-lock.yaml`。
- profile 的 pnpm 版本要匹配它的 `node_modules`（看 `.modules.yaml` 的 `packageManager` / `storeDir`，本机 web 为 `pnpm@12.4.2` / `store/v11`），不匹配会报 `ERR_PNPM_UNEXPECTED_STORE`；换对应 pnpm，不要用 `pnpm install` 迁移整个 store。
- 快照 tgz 是 profile 的依赖目标，不要删除或移动。

## 8. 安全与隐私

- 绝不提交真实 appId / appSecret、OpenID、会话日志；凭据只放 profile 的 `cordis.patch.yml` 或 `QQBOT_APPID` / `QQBOT_SECRET`，示例一律占位符。
- 白名单只有一个用户：`access.owner` 为空时拒绝所有私聊；群消息一律拒绝；审批 / 提问按钮必须校验点击者等于 owner。
- 文件发送只发给 `access.owner`（唯一的接入用户），因此不限制目录：`/get` 与交付物投递可以是任意路径，但目标必须是存在且可读的普通文件；目录仍需 `statSync` 检查，`/get` 拒绝非文件。
- 媒体 / 缓存落 `~/.dsh-qqterm/`，不进仓库。
- `.env`、`.dsh-sessions/`、`docs/` 已在 .gitignore，不要为提交方便移除。

## 9. 提交前检查

- [ ] `pnpm build` 通过，`lib/` 的 js 已更新并提交
- [ ] `pnpm test` 全绿；新逻辑有对应 `tests/**/*.spec.ts`
- [ ] 未新增 `@deepseek-ai/*` 运行期依赖；`inject` 与实际依赖一致
- [ ] `apply()` 没有阻塞式 await；异步错误都有 catch
- [ ] 客户端改动已 typecheck，并在 C2C 验证一次按钮回退
- [ ] 文案符合 §4（状态符号唯一、冒号与空格、`show` 内无 markdown）
- [ ] 没有提交 secrets、快照 tgz、备份目录
- [ ] 版本号符合规则（正式版 / `-dev.N` 快照）
- [ ] 发布改动同步了中英文 CHANGELOG

## 10. 已知坑

- DSH 沙箱会话里直接 `pnpm build` 可能因 ACL 写不了 `lib/`、`src/`（EPERM）；用普通终端，或在会话内提权。与仓库无关。
- 某些 pnpm 版本跑 `pnpm run build` 会先校验依赖并尝试重建 `node_modules`；可直接跑 `node_modules/.bin/tsc` + `node_modules/.bin/tsdown`。
- 改包名后只重建、不清宿主模块缓存，客户端可能报 “loaded without registering”。
- DSH 沙箱里 `pnpm test` 起不来：Vite 探测网络盘会 `exec("net use")`、worker 走 `child_process`，都被沙箱拦成 `EPERM`。绕法（仅沙箱内，不进仓库）：预加载脚本把 `node:child_process` 的 `exec` / `execFile` 替成失败回调，再跑 `node --import <preload> node_modules/vitest/vitest.mjs run --configLoader native --pool=vmThreads`。`symlinkSync` 相关用例（`tests/shared/utils.spec.ts`）在沙箱里必失败，属环境限制。
