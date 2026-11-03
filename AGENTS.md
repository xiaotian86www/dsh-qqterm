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
| `src/features/` | 问答（ask_user_question）、审批、历史缓冲、按钮协议 |
| `src/session/` | 会话管理、闲置回收、会话存储/管理 |
| `src/transport/` | 入站、出站、分片、附件、回复目标 |
| `src/commands/` | `/bot-*`、`/model`、`/preset`、`/sessions` 等指令 |
| `src/media/` | 富媒体理解、附件发送、清理 |
| `src/host/` | 宿主 Agent/Session 适配 |
| `src/client/` | 浏览器端（settings.section、sidebarRightTabs） |
| `cordis.patch.yml` | bundle 层 patch，插入 `im-qqbot` 条目（随包分发） |
| `cordis.dev.yml` | `--patch` 调试 overlay（绝对路径加载源码） |
| `locale/*.json` | 用户可见文案 |
| `lib/` | 构建产物，**不要手改** |

## 3. 硬约束（改代码前必读）

### 3.1 宿主依赖

- `@deepseek-ai/*` 一律放 `peerDependencies`（由宿主安装副本解析），**禁止**加入 `dependencies`，也**禁止**打进客户端 bundle。
- `inject` 只声明真正依赖的服务；服务缺失时插件应保持 inactive，不能抛错阻塞宿主。
- 不要 import 宿主包的私有深层路径；需要的能力优先走 `ctx` 服务或公开导出。
- 版本号运行时从 `package.json` 读取（`src/shared/utils.ts`），不要另建版本常量。

### 3.2 启动与生命周期

- `apply()` 必须快速返回：扫码、网关连接、长轮询等一律 `void …catch()`，**禁止 await 用户交互**（会阻塞 Host ready / Web URL 输出）。
- 禁止在运行时写 `process.env`；凭据持久化只写 profile 的 `cordis.patch.yml`（会触发 HMR 重载）。
- 未捕获的 rejection 在宿主是 fail-loud 致命错误，所有异步链必须有兜底 catch。
- `export const name = 'im-qqbot'`、`inject = ['agents']`、bundle patch 里的 entry id `im-qqbot` 都是兼容契约；改动会让用户 profile 里按 id 写的配置覆盖失效。

### 3.3 客户端

- 入口 id 必须等于包名（tsdown 从 package.json 读取；`window.__ModuleLoader__.load({ id })`）。改包名要同步 `cordis.patch.yml` 的 `name` 和客户端 `PACKAGE_NAME` 常量，否则报 “loaded without registering”。
- 客户端只把 `react` / `react-dom` 当外部依赖（见 `tsdown.client.config.ts` 的 BASELINE_EXTERNALS），其余依赖全部内联；新增依赖要考虑 bundle 体积。
- 依赖的槽位：`settings.section`、`sidebarRightTabs`、`sidebar.right.pane.tab`。宿主大版本升级后要在 Desktop 与 dsh web 两端重新验收；服务缺失时应静默 inactive，不能让页面白屏。

### 3.4 交互与消息

- 按钮键盘只在 C2C 稳定可用，群聊可能被 QQ 拒绝；发送失败必须保留文本回退（现有实现会降级并记 warn）。改问答/审批时 C2C 与群聊都要验证。
- `ask_user_question` / `approval` 走宿主 waterfall 通道，不要再退回 `userQuestions.ask` 这类服务探测式实现。
- 会话 key 固定为 `qqbot:${appId}:${scope}:${peerId}`；0.5.x 老会话按原派生 id 恢复，改动必须保持向后兼容。
- Markdown 输出按 `textChunkLimit` 分片，代码块/表格感知切分在 `src/transport/chunker.ts`，不要绕过。
- 用户可见文案放 `locale/*.json`；注释、内部日志保持中文。

## 4. 构建 / 测试 / 调试

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

## 5. 版本、打包与发布

- **开发快照**：保持基线版本不变，只加 `-dev.N` 后缀（例：官方 `0.5.5` → 快照 `0.5.5-dev.0`）；不要把 dev 快照抬成 `0.5.6`。
- **正式发布**：更新 `CHANGELOG.md` 与 `CHANGELOG_EN.md`（Keep a Changelog 格式）→ 改版本号 → `pnpm build` → 打包/发布。
- `prepublishOnly` 会再跑一次 build；发布前仍要确认 `lib/` 与 `src/` 一致。
- 发布走内网 CI（`.orange-ci.yml` 引用 `git.woa.com` 配置），不要随意改动其 include。
- `ci:prepare-test-pkg` 会把包名改成 `@tencent/dsh-qqbot` 并改写 `cordis.patch.yml`，**只在一次性分支/临时目录运行**，不要把它的改动提交。
- 宿主升级后：更新 `dsh.compatibility.dshReleases` 与 note，重新验收客户端槽位和扫码绑定全流程。

## 6. 安装与 profile 隔离（联调）

- **主 profile 禁止 `link:` 开发目录**：只装官方版或 `file:` 冻结快照，避免本地半成品在下次重启后直接影响线上机器人。
- 开发调试用独立 profile（本机为 `qqdev`）：独立机器人应用 + `link:` 指向本仓库，与主 profile 并行、互不影响。
- 主 profile 换本地包：

  ```bash
  pnpm build && pnpm pack
  dsh plugin --profile web add file:<绝对路径>/tencent-connect-dsh-qqbot-<版本>.tgz
  ```

  装完必须重启 dsh；客户端改动还要刷新页面。`node_modules` 里是实体副本，之后仓库改动不会自动进入 profile。
- 回滚：`dsh plugin --profile web add @tencent-connect/dsh-qqbot@<官方版本>`，或恢复安装前备份的 `package.json` / `pnpm-lock.yaml`。
- profile 的 pnpm 版本要与创建时一致（如 web 由 pnpm 10.34.9 / store v10 创建）；用不匹配的大版本可能触发 store v10→v11 重装。
- 本地快照 tgz 是 profile 的依赖目标，不要删除或移动；重新打包会产生新路径。

## 7. 安全与隐私底线

- **绝不提交真实 appId/appSecret、用户 OpenID、会话日志**。凭据只放 profile 的 `cordis.patch.yml` 或 `QQBOT_APPID` / `QQBOT_SECRET` 环境变量；示例一律占位符。
- 访问控制默认值不得放宽：私聊默认白名单、空名单拒绝；群聊默认开放但需 @bot；审批/提问按钮必须校验点击者在白名单内。
- 文件发送走路径白名单，按真实路径（realpath）判定，禁止绕过符号链接检查。
- 媒体/缓存落在 `~/.dsh-qqbot/`，不要写进仓库。
- `.env`、`.dsh-sessions/`、`docs/` 已在 .gitignore 中，不要为了提交方便移除这些忽略。

## 8. 提交前检查清单

- [ ] `pnpm build` 通过，`lib/` 的 js 已更新并提交
- [ ] `pnpm test` 全绿；新逻辑有对应 `*.test.ts`
- [ ] 未新增 `@deepseek-ai/*` 运行期依赖；`inject` 与实际依赖一致
- [ ] `apply()` 没有阻塞式 await；异步错误都有 catch
- [ ] 客户端改动已 typecheck，并在 C2C + 群聊各验证一次按钮回退
- [ ] 没有提交 secrets、快照 tgz、备份目录等临时产物
- [ ] 版本号符合规则（正式版 / `-dev.N` 快照）
- [ ] 发布相关改动同步了中英文 CHANGELOG

## 9. 已知坑

- 在 DSH 沙箱会话里直接 `pnpm build` 可能因 ACL 无法写仓库已有子目录（`lib/`、`src/`，报 EPERM）；用普通终端构建，或在会话内提权执行。与仓库本身无关。
- 某些 pnpm 版本执行 `pnpm run build` 时会先做依赖校验并尝试重建 `node_modules`；可直接跑 `node_modules/.bin/tsc` + `node_modules/.bin/tsdown`，等价于 `pnpm build`。
- 改包名后只重建、不清宿主模块缓存，客户端可能报 “loaded without registering”。
