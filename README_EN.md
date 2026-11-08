<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_SuperTerm-blue?style=for-the-badge" alt="QQ SuperTerm" />

**DeepSeek Harness inside a QQ private chat: sessions, models, permissions, files, and approvals, all from the chat window.**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.3-brightgreen)](https://nodejs.org/)

<br/>

**[简体中文](./README.md) | English**

</div>

## What it is

QQ SuperTerm (`dsh-qqterm`) is a QQ channel terminal for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). It puts the dsh agent into a QQ private chat: a message is one turn, and any `/` command lets you inspect and switch sessions, models, reasoning effort, and permission presets — or let the agent read and write a workspace and send files back.

Highlights:

- **The chat window is the terminal** — conversation, commands, panels, and menus all live in QQ private chat; no separate web page or client.
- **Switchable sessions** — `/sessions` groups sessions by workspace, `/to` messages any session, and background sessions keep running and posting their output back to QQ.
- **Close to host behaviour** — models, presets, reasoning effort, and permission presets all go through dsh's own selection paths; the plugin keeps no parallel preferences.
- **It can actually do work** — workspace read/write, attachment understanding, file sending, `ask_user_question`, and `approval` confirmations.
- **Single-user private chat** — only the bound user is served; group chats are unsupported. One QR scan finishes binding.

## Architecture

```
QQ User → QQ WebSocket → dsh-qqterm → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

The plugin is a pure Cordis plugin: the host loads `lib/index.js`, the browser loads `lib/client.js` for the settings section and sidebar entry, and the host loop is never modified.

## Installation

### Method 1: Desktop install (recommended)

No command line needed — everything happens inside the app:

1. **Install**: click "Plugins" in the left sidebar → "Add plugin" → enter `@tencent-connect/dsh-qqterm` → install and start now

<img src="./assets/docs/install.png" alt="In-app plugin install" width="560" />

2. **Connect**: avatar at the bottom-left → Settings → "QQ SuperTerm" → scan the QR code with mobile QQ

<img src="./assets/docs/setting.png" alt="Settings QR binding" width="560" />

Credentials are saved automatically after the scan; later launches need no re-scan.

### Method 2: Manual

```bash
# Add to a profile
npx @deepseek-ai/dsh plugin --profile qqterm add @tencent-connect/dsh-qqterm

# Start
npx @deepseek-ai/dsh --profile qqterm
```

On first launch, the plugin detects missing credentials and automatically starts the QR flow: a QR code is printed in the terminal → scan it with the QQ mobile app → credentials are saved to the profile, so subsequent launches require no re-scan.

In environments without the in-app binding page (pure CLI), set `QQBOT_BIND_OPEN_BROWSER=1` to additionally open a browser QR page as a fallback.

<img src="./assets/docs/qrcode.png" alt="QR code scan example" width="280" />

### Method 3: Local path

```bash
# Build
cd /path/to/dsh-qqterm
pnpm install && pnpm build

# Add to a profile (local path)
npx @deepseek-ai/dsh plugin --profile qqterm add /path/to/dsh-qqterm

# Start
export QQBOT_APPID="yourAppID" QQBOT_SECRET="yourAppSecret"
npx @deepseek-ai/dsh --profile qqterm
```

### Method 4: --patch dev mode

```bash
export QQBOT_APPID="yourAppID" QQBOT_SECRET="yourAppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqterm/cordis.dev.yml
```

## Configuration

| Config | Type | Default | Description |
|------|------|--------|------|
| `appId` | string | **required** | QQ Bot AppID (or via `QQBOT_APPID` env var) |
| `appSecret` | string | **required** | QQ Bot AppSecret (or via `QQBOT_SECRET` env var) |
| `directPrompt` | string | - | Extra system prompt for private chats |
| `textChunkLimit` | number | `4500` | Max chars per message |
| `streaming` | boolean | `true` | Enable streaming output |
| `processingTimeoutMs` | number | `1800000` | Processing timeout (ms), aborts the current LLM call |
| `maxQueue` | number | `20` | Max concurrent queue length |
| `askTimeoutMs` | number | `300000` | Question timeout (ms), default 5 min (ask_user_question) |
| `showToolResults` | boolean | `false` | Show tool-call results, both success and failure |
| `debug` | boolean | `false` | Debug mode |

### Chat session vs background sessions

The plugin separates two things: the **chat session** is the conversation the QQ side is in,
and **background sessions** are the host's session logs.

- There is exactly one *current* chat session: every private chat window reads and continues the same context.
- Background sessions stay multiple: `/sessions` groups the sessions QQ holds by workspace by default, `/sessions all` shows every session, and `/new` starts one. Sessions actually acquired by `/sessions resume` or `/to` stay in a runtime acquired set — their output, questions, and approvals still come back to QQ (messages from a non-current session get a source line `#shortid · title` above the body and a `/to` reply link at the end).
- Sessions are never reclaimed by time: long-running tasks are never interrupted.
- Queueing is per session: a message for an idle current session starts at once even while another session is generating, while several messages sent to the same session run one turn each, in order.

When several private chats talk at once, the reply goes to the chat of the latest message.

### Models, presets, and reasoning effort

Model and reasoning effort follow the **current session**; the preset is a deployment-level setting. All three reuse host core behaviour:

- A new session (`/new`, the first message) takes the host's current value: `settings.yaml` → host `agentDefaultModel` → `deepseek-official/deepseek-v4-flash`. The plugin config has no `provider` / `model` / `preset`; the host owns those three.
- `/model` goes through the same host switch path: the choice is recorded in the current session (no rebuild, no history rewrite) and applies next turn; without a live session it refuses and asks you to send a message first.
- `/reasoning` uses the same entry point: written into the current session, effective next turn; per core behaviour it also becomes the global current choice, so new sessions follow it.
- `/preset` is the same entry as the settings page's "make default": the written preset applies to sessions created afterwards, while an already started session keeps its own.
- With no session, the `/model`, `/reasoning`, and `/permission` views still show the current value — the core default, i.e. what a new session would get; switching still requires a session.

### Access control (access)

The terminal serves exactly one user: every other private chat is rejected, and group chats are unsupported. QR binding writes the scanning user as the owner automatically; for manual binding or changing the owner, fill in the OpenID in settings (`/bot-me` shows it).

| Config | Type | Default | Description |
|------|------|--------|------|
| `access.owner` | string | `""` | The only allowed user (QQ OpenID); empty rejects everyone |

### Rich media (media)

| Config | Type | Default | Description |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | Enable rich media understanding (image/video download + tool analysis) |
| `media.maxMB` | number | `200` | Max download size (MB) |
| `media.ttlHours` | number | `24` | Media lifetime (hours), 0 = never expire |

### Vision (vision)

| Config | Type | Default | Description |
|------|------|--------|------|
| `vision.enabled` | boolean | `false` | Enable vision (qqbot_describe_image tool) |
| `vision.provider` | string | - | Vision model provider (e.g. pi-ai) |
| `vision.model` | string | - | Vision model id (e.g. qwen-vl-max) |
| `vision.maxBytes` | number | `10MB` | Max image bytes |
| `vision.maxTokens` | number | `1024` | Max output tokens |
| `vision.timeoutMs` | number | `120000` | Vision call timeout (ms) |

### File sending (sendFile)

| Config | Type | Default | Description |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | Enable path allowlist (media + the session's working directory + extraRoots only) |
| `sendFile.extraRoots` | string[] | `[]` | Extra allowed root directories |

### Command panel (panel)

| Config | Type | Default | Description |
|------|------|--------|------|
| `panel.autoSync` | boolean | `true` | Sync the current commands to the command panel when the bot is ready |

The command panel is the list that pops up in mobile QQ when you type `/`. With `panel.autoSync` on, every ready event pushes the plugin's built-in commands (with descriptions) to the private-chat global panel: it creates one when missing and updates the panel this plugin owns (whose `remark` is `qqterm:commands`) in place. To re-push immediately after changing commands, send `/bot-sync` (bound user only).

### Custom menu (menu)

| Config | Type | Default | Description |
|------|------|--------|------|
| `menu.autoSync` | boolean | `true` | Sync the private-chat custom menu when the bot is ready |

The menu holds the six fixed entries at the **bottom of a private chat**: `会话状态` (`/status`), `会话列表` (`/sessions`), `创建会话` (`/new`), `压缩会话` (`/compact`), plus two collapsible items that carry submenus — `权限` (`查看权限` / `仅可查看` / `工作区内修改` / `完全权限` / `自动审查`) and `思考强度` (`查看强度` / `关闭` / `低` / `高` / `最高`). Clicking any entry fills the matching command into the input box; permission and the current session are still validated by the command itself.

The menu is bot-wide configuration that every user sees, and changes only show after leaving and re-entering the chat — so it only carries static actions, never per-session dynamic text (check `/status` for context usage). It syncs once when the bot is ready and skips identical content; to re-push manually use `/bot-sync` (bound user only), and `menu.autoSync=false` disables the automatic sync. The menu API replaces the whole thing, so the sync claims this plugin's buttons by `send_message` (collapsible items are claimed by name or by their submenu commands) while buttons added by hand are preserved after them.

## Built-in Commands

| Command | Description |
|------|------|
| `/new` | Start a new session (clear context); may take a workspace: `/new <workspace\|path>` |
| `/clear` (alias `/reset`) | Stop the current session and start a new one in the same workspace; `/clear all` stops every acquired session |
| `/compact` | Compact session history (replace old records with a summary); the reply reports only counts and tokens |
| `/sessions` (alias `/session`) | Session management: group working sessions by workspace (status and current marker included); `all` for every session |
| `/rename` | Rename the current session (the title is pinned against automatic titles) |
| `/to` | Send a message to a specific session, or answer its question |
| `/ls` | List the subdirectories of a directory; click a row to go deeper |
| `/model` | View or switch the current session's model (effective next turn) |
| `/reasoning` (alias `/think`) | View or switch the current session's reasoning effort (levels depend on the model) |
| `/preset` | View or switch the current agent preset |
| `/permission` | View or switch the permission preset (sandbox mode + approval policy, effective immediately; bound user only) |
| `/cost` | View token usage of the current session |
| `/status` | View session status: session name and short id / workspace / model / reasoning effort / context / tokens |
| `/stop` | Abort the current generation; `/stop all` aborts every acquired session that is generating |
| `/bot-ping` | Network latency test (transport & processing time) |
| `/bot-version` | View version info |
| `/bot-me` | View your OpenID (to fill in `access.owner`) |
| `/bot-status` | View current session status (brief: session name and short id / model / reasoning effort / preset / message count; see `/status` for the full view) |
| `/bot-help` | View all commands |
| `/bot-sync` (alias `/bot-refresh`) | Sync the command panel and custom menu (bound user only) |

> A misspelled command (like `/modle` or `/sesions`) is not forwarded to the model as a prompt: the bot replies "no such command" and, when the intent is clear enough, offers the correct one as a clickable command. Only "slash + ASCII command name" counts as a command, so text like `/usr/local/bin` or `/今天` still goes to the model; the full-width `／` is equivalent to `/`, so it works straight from a Chinese IME.

## Workspaces

A workspace is the host's durable grouping record for "one directory + the sessions running in it" (`ctx.workspaceRegistry`) — the project groups in the Web sidebar. This plugin follows the same rules:

- **No `cwd` config**: the session's working directory comes from the host.
- **New sessions land in the host's default workspace** (`Documents/deepseek-harness/default-workspace` on first use); when there is no default workspace it falls back to the dsh launch directory.
- **The workspace follows the session**: `/sessions resume` moves this chat into that session's directory; a later `/new` stays in the same workspace, and it survives a restart (persisted in the `dirs` section of `~/.dsh-qqterm/model-prefs.json`).
- **Titles come from directory names**: the host derives the workspace title from the last path segment, and titles you renamed yourself are never overwritten.

### Switching workspace (`/new <workspace>`)

A workspace *is* the session's `cwd`. It is written into the session header when the session is created and the host exposes no API to change it, so switching workspace only takes effect **before a session is persisted** — and the entry point is `/new` itself:

| Usage | Description |
|------|------|
| `/new <name\|path>` | One step: start a new session in that workspace |
| `/ls` | Not sure about the path? List directories and click through |

- A workspace is matched by **title**, **directory name** (case-insensitive, unique prefix), or an **absolute path**; the next message creates the session in the new directory and the workspace shows up in the host sidebar. A missing directory (or a file) is rejected without leaving a half-applied state, and `/new <path>` validates the target *before* touching the session, so a typo never costs you the current one.
- Not sure how to spell the path? Use `/ls`: it lists the subdirectories of the current workspace and every row is clickable to go one level deeper. Rows always fill an absolute path, so descending never drifts.
- Same permission surface as `/sessions`: **private chat + the single bound user** (`access.owner`) only — switching workspace means changing the directories the agent may touch. A plain `/new` is unrestricted.

### Session management (`/sessions`)

`/sessions` answers "which sessions does QQ currently hold?" from the runtime acquired set. The all-sessions view still comes from the same host source as the Web sidebar (`sessionQuery` / `sessionPersistence`).

| Usage | Description |
|------|------|
| `/sessions` | List working sessions grouped by workspace (current first); group headers show the workspace path; each row shows `生成中` / `空闲`, and the current row ends with `✅`; if the current pointer is not among them, a `待恢复` line is added; rows start with the 8-char short id and are never numbered; 10 per page |
| `/sessions <page>` | Next page of the working-session list, e.g. `/sessions 2`; the footer shows `上一页 · 第 1/2 页 · 下一页` |
| `/sessions all` | List every session grouped by workspace (pinned first inside a group); acquired sessions are marked `📌`, with no current marker; groups show only short ids; 10 per page |
| `/sessions all <page>` | Next page of the all-sessions view; the workspace title of the first session on the page is repeated; same footer format |
| `/sessions resume <id>` | Rebind this chat to that session and continue its history (an archived target is unarchived on the way); the workspace follows; targets are 8-char short ids |
| `/sessions rename <id> <title>` | Rename a session; the title is pinned against automatic titles. The target must already be open (use `/sessions resume` first) |
| `/sessions archive [page]` | Without a target it lists archive candidates across every workspace (same source as `/sessions all`), grouped by workspace, titled `X 个工作区 · Y 个会话`, never numbered; a bare page number pages through them, e.g. `/sessions archive 2` |
| `/sessions archive <id>[,<id>…]` | Archive sessions: hidden from this command and the Web sidebar, **on-disk log kept**, restorable at any time; separate multiple targets with commas (up to 10 per command) |
| `/sessions archived [page]` | List archived sessions; each row shows its short id and workspace and fills `/sessions unarchive <id>` into the input box; the paging and back links at the bottom work too |
| `/sessions unarchive <id>[,<id>…]` | Restore the session to the regular list |
| `/to <session> <text>` | Send a message to a specific session; if it is waiting on `ask_user_question`, the text is submitted as the answer |
| `/to <session>` | When the target is waiting for an answer, the next message becomes the answer |

Notes:

- **Handle rule**: every target is an 8-char short id (like `#3f2a9b1c`; the `#` is optional). Lists are never numbered, so paging and grouping cannot desync from "row N".
- **Paging**: multi-page views use `上一页 · 第 1/2 页 · 下一页` in the footer, omitting the missing direction; the page number is not in the title and "N more" is not shown.
- Status words appear only in the working-session list: `生成中` (agent running), `空闲` (held but idle); a current pointer that has not been acquired yet shows `待恢复`. After `/new` there is no current pointer, so no such line is added. Other views only mark acquired sessions with `📌` (QQ holds it), with no current marker and no status.
- Private chat only, and the operator must be the single bound user (`access.owner`) — titles and archive state touch other chats' data; with no owner configured the command is disabled (`/bot-me` shows your OpenID).
- Archiving goes through the host `workspaceRegistry.archiveSession` and only writes the registry-global archive set — **no file is deleted**. This plugin offers no hard delete; clean up on disk from the Web side or by hand.
- `workspaceRegistry` is part of the plugin's `inject`, so a profile missing it keeps the plugin inactive rather than exposing a half-working command.
- Archiving disposes the session's agent in this process; if it is the current session, the chat mapping is cleared and the next message lands in a brand-new session — an archived session is rejected by the host `agent/pre-step` gate, so a chat left bound to it would stop getting replies.
- **Several sessions can stay live at once**: a session joins the acquired set when a normal message, `/sessions resume`, or `/to` actually gets its agent. Output, questions, and approvals from every acquired session go back to QQ; the current session is untagged, while messages from other sessions get a separate source line `#shortid · title` before the body and a `/to` reply link at the end. The acquired set is runtime-only — after a restart only the current session is restored from `model-prefs.json`.
- **Switching does not release**: `/sessions resume` only moves the current pointer; the old session keeps running and its output keeps flowing to QQ. `/new` only clears the current pointer, and the old session keeps running too. On unload the plugin disposes only the agents it created; borrowed Web/TUI agents are just dereferenced.
- **Questions are routed per session**: the current session answers with plain text; buttons from other sessions carry the session id and work when clicked; questions without buttons append a `/to #id ` link. A plain message that did not come through a link is never forwarded to the current model — the user is told to use a button or `/to`.
- The held list is ordered "current → other held (by acquisition time)". The time column is the **creation time** (the host header stores no "last used" timestamp).
- After a cross-workspace resume the agent works inside **that session's own directory**, and the file-send allowlist follows it.


## Core Modules

```
src/
├── index.ts                    # Cordis plugin entry (async apply)
├── config.ts                   # Config schema
├── types.ts                    # Global types
├── setup/                      # Credential binding (QR)
│   ├── index.ts                # Binding orchestration (ensureCredentials)
│   ├── binding-service.ts      # QR state machine (single source of truth in the host)
│   ├── bind-routes.ts          # In-app binding page routes (/qqterm/bind)
│   ├── presenters.ts           # Presentation strategies (terminal/browser fallback)
│   ├── qr-svg.ts               # QR SVG rendering (host side)
│   └── persist.ts              # Credentials written to cordis.patch.yml
├── client/                     # Browser half (dsh.client Web Bundle)
│   ├── index.ts                # Settings/sidebar entry registration
│   ├── bind-page.ts            # In-app binding page (QR + status polling)
│   └── config-panel.ts         # Settings panel (editable config)
├── gateway/                    # Gateway assembly
│   ├── bootstrap.ts            # Startup wiring (session/event listeners, etc.)
│   └── middleware-setup.ts     # Middleware chain config
├── transport/                  # Transport layer
│   ├── inbound.ts              # QQ inbound message → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # Streaming buffer
│   ├── streaming-writer.ts     # Streaming writer
│   ├── reply-store.ts          # Passive reply ids (msgid/eventid + usage, msgid persisted)
│   ├── reply-bot.ts            # Bot decorator: every send resolves the reply id
│   ├── tool-presenter.ts       # Tool-call presentation
│   └── chunker.ts              # Markdown chunking
├── session/                    # Session management
│   └── session-manager.ts      # Chat session → Agent mapping and background switching
├── model/                      # Model routing
│   ├── model-resolver.ts       # Route resolution
│   ├── prefs-store.ts          # Preference persistence
│   └── settings-reader.ts      # settings.yaml read-only
├── features/                   # Interaction features
│   ├── question-channel.ts     # ask_user_question Q&A channel
│   ├── approval-channel.ts     # approval confirmation channel
│   ├── retry-channel.ts        # Retry-after-failure cards
│   ├── command-panel.ts        # Command panel sync
│   └── command-menu.ts         # Custom menu sync
├── media/                      # Media
│   ├── vision-tool.ts          # Image vision understanding
│   ├── send-file-tool.ts       # Send local files
│   └── media-cleaner.ts        # Media TTL cleanup
├── middleware/                 # Middleware
│   ├── question-answer.ts      # Q&A answer handling
│   ├── unknown-command.ts      # Misspelled-command guard (never forwarded to the model)
│   └── attachment.ts           # Attachment handling
├── shared/                     # Shared utilities
│   ├── utils.ts                # Common helpers
│   ├── dirs.ts                 # Data directory (~/.dsh-qqterm)
│   ├── scope.ts                # scope/peer extraction
│   └── send-helper.ts          # Chunked send
├── reload/                     # /bot-reload (apply on-disk changes)
└── commands/                   # Slash commands
```

## Session Routing

The chat session key is `qqterm:${appId}:chat`; it only decides which session is *current*. Acquired sessions can be multiple. A UUID session id is minted the first time the current session is actually used and persisted to `model-prefs.json`; after a restart only the current session resumes from that id. No mapping means a fresh chat session. `/new` and `/clear` only clear that mapping (and, for `/clear`, the current session) — they never pre-mint a session that does not exist yet.

Resolution strategy: acquired record → in-process live agent → persisted resume → fresh create (current session only; `/sessions resume` never creates).

## Design Principles

- **Pure Cordis plugin** — follows the dsh "Plugins, not loop changes" principle
- **Declarative dependencies** — `inject` lists every required service (sessions, models, workspaces, archiving, presets, tools, attachments, web server, and more); a missing service keeps the plugin inactive instead of degrading at runtime
- **One current session + multiple acquired sessions** — every QQ window continues the same current session; sessions acquired via `/sessions resume` or `/to` stay live and keep sending their output to QQ
- **Preset support** — mount presets (toolkits, prompts, etc.) via the `agent-presets` service; `/preset` writes the global value, same as the settings page's "make default"
- **Markdown output** — replies sent as Markdown with code-block/table-aware chunking
- **Image understanding** — supports `qqbot_describe_image` vision to analyze images sent by users
- **File sending** — supports `qqbot_send_file` to send local files to users (path allowlist enabled by default)
- **Question interaction** — supports `ask_user_question` with inline keyboard buttons (mutually exclusive) or numbered replies, one question at a time with timeout
- **Approval confirmation** — supports `approval/request` to ask for user confirmation on critical actions via allow/deny buttons

## Local Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Dev mode (watch)
pnpm dev

# Debug via --patch
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqterm/cordis.dev.yml
```

## License

[MIT](./LICENSE)
