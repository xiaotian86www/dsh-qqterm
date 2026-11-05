<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**A QQ Bot plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), connecting DeepSeek AI assistants to QQ private chats.**

[![npm version](https://img.shields.io/npm/v/@tencent-connect/dsh-qqbot)](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/tencent-connect/dsh-qqbot)](https://github.com/tencent-connect/dsh-qqbot)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)

<br/>

**[简体中文](./README.md) | English**

Scan to join the QQ group / channel

<table>
<tr>
<td align="center" width="50%"><img src="./assets/docs/qqgroup.jpg" height="360" alt="QQ Group QR Code" /><br /><b>QQ Developer Group</b><br /><sub>Group 1: 1032635674 · Group 2: 1056948758</sub></td>
<td align="center" width="50%"><img src="./assets/docs/qqchannel.jpg" height="360" alt="QQ Channel QR Code" /><br /><b>QQ Developer Channel</b><br /><sub>Channel ID: 20dnumts4z</sub></td>
</tr>
</table>

</div>

## Architecture

```
QQ User → QQ WebSocket → dsh-qqbot → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

## Installation

### Method 1: Desktop install (recommended)

No command line needed — everything happens inside the app:

1. **Install**: click "Plugins" in the left sidebar → "Add plugin" → enter `@tencent-connect/dsh-qqbot@latest` → install and start now

<img src="./assets/docs/install.png" alt="In-app plugin install" width="560" />

2. **Connect**: avatar at the bottom-left → Settings → "QQ Bots" → scan the QR code with mobile QQ

<img src="./assets/docs/setting.png" alt="Settings QR binding" width="560" />

Credentials are saved automatically after the scan; later launches need no re-scan.

### Method 2: Manual

```bash
# Add to a profile
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# Start
npx @deepseek-ai/dsh --profile qqbot
```

On first launch, the plugin detects missing credentials and automatically starts the QR flow: a QR code is printed in the terminal → scan it with the QQ mobile app → credentials are saved to the profile, so subsequent launches require no re-scan.

In environments without the in-app binding page (pure CLI), set `QQBOT_BIND_OPEN_BROWSER=1` to additionally open a browser QR page as a fallback.

<img src="./assets/docs/qrcode.png" alt="QR code scan example" width="280" />

> **Note**: Upgrade to `0.4.0` or later for browser-link scanning, which avoids QR code misalignment in some terminals.

### Method 3: Local path

```bash
# Build
cd /path/to/dsh-qqbot
pnpm install && pnpm build

# Add to a profile (local path)
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-qqbot

# Start
export QQBOT_APPID="yourAppID" QQBOT_SECRET="yourAppSecret"
npx @deepseek-ai/dsh --profile qqbot
```

### Method 4: --patch dev mode

```bash
export QQBOT_APPID="yourAppID" QQBOT_SECRET="yourAppSecret"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## Configuration

| Config | Type | Default | Description |
|------|------|--------|------|
| `appId` | string | **required** | QQ Bot AppID (or via `QQBOT_APPID` env var) |
| `appSecret` | string | **required** | QQ Bot AppSecret (or via `QQBOT_SECRET` env var) |
| `provider` | string | `deepseek-official` | LLM provider name |
| `model` | string | `deepseek-chat` | Model name |
| `preset` | string | - | Agent preset id |
| `directPrompt` | string | - | Extra system prompt for direct chats |
| `textChunkLimit` | number | `4500` | Max chars per message |
| `streaming` | boolean | `true` | Enable streaming output |
| `processingTimeoutMs` | number | `1800000` | Processing timeout (ms), aborts the current LLM call |
| `maxQueue` | number | `20` | Max concurrent queue length |
| `askTimeoutMs` | number | `300000` | Question timeout (ms), default 5 min (ask_user_question) |
| `showToolResults` | boolean | `false` | Show successful tool-call results (errors always shown) |
| `debug` | boolean | `false` | Debug mode |

### Chat session vs background sessions

The plugin separates two things: the **chat session** is the conversation the QQ side is in,
and **background sessions** are the host's session logs.

- There is exactly one *current* chat session: every private chat window reads and continues the same context.
- Background sessions stay multiple: `/sessions` lists the sessions QQ holds, `/sessions workspace` shows the current workspace, and `/new` starts one. Sessions actually acquired by `/sessions resume` or `/to` stay in a runtime acquired set — their output, questions, and approvals still come back to QQ (non-current ones prefixed with `[#shortid]`).
- Sessions are never reclaimed by time: long-running tasks are never interrupted.

When several private chats talk at once, the reply goes to the chat of the latest message.

### Access control (access)

| Config | Type | Default | Description |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | Direct-chat access mode |
| `access.c2cAllow` | string[] | `[]` | Direct-chat allowlist (user openid) |

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

## Built-in Commands

| Command | Description |
|------|------|
| `/new` | Start a new session (clear context); may take a workspace: `/new <workspace\|path>` |
| `/reset` (alias `/clear`) | Stop the current session and start a new one in the same workspace; `/reset all` stops every acquired session |
| `/compact` | Compact session history (replace old records with a summary) |
| `/sessions` (alias `/session`) | Session management: list held sessions with status and current marker by default; `workspace` for the current workspace, `all` for everything |
| `/to` | Send a message to a specific session, or answer its question |
| `/workspace` | Workspace: view / switch (only right after `/new`) |
| `/ls` | List the subdirectories of a directory; click a row to go deeper |
| `/model` | View or switch model |
| `/preset` | View or switch agent preset (applies to new sessions) |
| `/permission` | View or switch the permission preset (sandbox mode + approval policy, effective immediately; allowlisted users only) |
| `/cost` | View token usage of the current session |
| `/status` | View session status: workspace / model / context / tokens |
| `/stop` | Abort the current generation; `/stop all` aborts every acquired session that is generating |
| `/bot-ping` | Network latency test (transport & processing time) |
| `/bot-version` | View version info |
| `/bot-me` | View your OpenID (for access allowlists) |
| `/bot-status` | View current session status (brief; see `/status` for the full view) |
| `/bot-help` | View all commands |

> A misspelled command (like `/modle` or `/sesions`) is no longer forwarded to the model as a prompt: the bot replies "no such command" and, when the intent is clear enough, offers the correct one as a clickable command. Only "slash + ASCII command name" counts as a command, so text like `/usr/local/bin` or `/今天` still goes to the model; the full-width `／` is equivalent to `/`, so it works straight from a Chinese IME.

## Workspaces

A workspace is the host's durable grouping record for "one directory + the sessions running in it" (`ctx.workspaceRegistry`) — the project groups in the Web sidebar. This plugin follows the same rules:

- **No `cwd` config**: the session's working directory comes from the host; the plugin no longer pins a directory.
- **New sessions land in the host's default workspace** (`Documents/deepseek-harness/default-workspace` on first use); when there is no default workspace it falls back to the dsh launch directory.
- **The workspace follows the session**: `/sessions resume` moves this chat into that session's directory; a later `/new` stays in the same workspace, and it survives a restart (persisted in the `dirs` section of `~/.dsh-qqbot/model-prefs.json`).
- **Titles come from directory names**: the plugin no longer names workspaces `QQBot`; the host derives the title from the last path segment. Legacy `QQBot` titles are migrated on the next attach (titles the user changed are left alone).

### Switching workspace (`/workspace`)

A workspace *is* the session's `cwd`. It is written into the session header when the session is created and the host exposes no API to change it, so switching workspace only takes effect **before a session is persisted**:

| Usage | Description |
|------|------|
| `/new <name\|path>` | One step: start a new session in that workspace (the common case) |
| `/workspace` | Show the current workspace (title / path / whether it can still change) |
| `/workspace <name\|path>` | Switch workspace only, without starting a session (after `/new`) |

- There are only two moments: **right after `/new`**, or before this chat has ever talked. Once a session exists `/workspace` refuses and points at `/new <name|path>` — the directory is already in that session's header, and editing the record would not take effect (a resumed session keeps its own `cwd`).
- A workspace is matched by **title**, **directory name** (case-insensitive, unique prefix), or an **absolute path**; the next message creates the session in the new directory and the workspace shows up in the host sidebar. A missing directory (or a file) is rejected without leaving a half-applied state, and `/new <path>` validates the target *before* touching the session, so a typo never costs you the current one.
- Not sure how to spell the path? Use `/ls`: it lists the subdirectories of the current workspace and every row is clickable to go one level deeper. Rows always fill an absolute path, so descending never drifts.
- Same permission surface as `/sessions`: **private chat + allowlist** (`access.c2cAllow`) only — switching workspace means changing the directories the agent may touch. A plain `/new` is unrestricted.

### Session management (`/sessions`)

`/sessions` answers "which sessions does QQ currently hold?" from the runtime acquired set. The workspace and all views still come from the same host source as the Web sidebar (`sessionQuery` / `sessionPersistence`).

| Usage | Description |
|------|------|
| `/sessions` | List sessions acquired by QQ across workspaces, current first; each row shows `生成中` / `空闲`, and the current row ends with `✅`; if the current pointer is not in the acquired set, a `待恢复` line is added; 10 per page |
| `/sessions <page>` | Next page of the held list, e.g. `/sessions 2`; the footer shows `上一页 · 第 1/2 页 · 下一页` |
| `/sessions workspace` | List unarchived sessions of **the current workspace** (newest first, 10 per page); only acquired sessions get a `📌` mark, with no current marker and no generation status |
| `/sessions workspace <page>` | Next page of the workspace view; same footer format as the held list |
| `/sessions all` | List every session grouped by workspace (pinned first inside a group); acquired sessions are marked `📌`, with no current marker; groups show no index, only short ids; 10 per page |
| `/sessions all <page>` | Next page of the all-workspaces view; the workspace title of the first session on the page is repeated; same footer format |
| `/sessions resume <index\|id>` | Rebind this chat to that session and continue its history (an archived target is unarchived on the way); the workspace follows; **indexes resolve against the held list only** |
| `/sessions archive <index\|id>[,<index\|id>…]` | Archive the session: hidden from this command and the Web sidebar, **on-disk log kept**, restorable at any time; separate multiple targets with commas (up to 10 per command); without targets it lists current-workspace candidates first, then held sessions from other workspaces (no indexes; use `page <page>` to page through them) |
| `/sessions archived [page]` | List archived sessions; each row shows its short id and workspace and fills `/sessions unarchive <id>` into the input box |
| `/sessions unarchive <id>[,<id>…]` | Restore the session to the regular list |
| `/to <session> <text>` | Send a message to a specific session; if it is waiting on `ask_user_question`, the text is submitted as the answer |
| `/to <session>` | When the target is waiting for an answer, the next message becomes the answer |

Notes:

- **Handle rule**: every row shows an 8-char short id (like `#3f2a9b1c`; the `#` is optional) that works from any view; an **index only means a row of the `/sessions` held list**, and it stays continuous across pages. `workspace` / `all` / `archived` / the archive picker show no indexes.
- **Paging**: multi-page views use `上一页 · 第 1/2 页 · 下一页` in the footer, omitting the missing direction; the page number is not in the title and "N more" is not shown.
- Status words appear only in the held list: `生成中` (agent running), `空闲` (held but idle); a current pointer that has not been acquired yet shows `待恢复`. Other views only mark acquired sessions with `📌` (QQ holds it), with no current marker and no status.
- Private chat only, and the operator must be in the allowlist (`access.c2cAllow`) — titles and archive state touch other chats' data; with no allowlist configured the command is disabled (`/bot-me` shows your OpenID).
- Archiving goes through the host `workspaceRegistry.archiveSession` and only writes the registry-global archive set — **no file is deleted**. This plugin offers no hard delete; clean up on disk from the Web side or by hand.
- Archiving needs the host workspace registry (`@deepseek-ai/dsh-workspace`): the web / Desktop profiles ship it, while a minimal custom profile (just `dsh-base` + this plugin) must mount it explicitly, otherwise the command reports "no session archive API mounted".
- Archiving disposes the session's agent in this process; if it is the current session, the chat mapping is also repointed to a new session — an archived session is rejected by the host `agent/pre-step` gate, so a chat left bound to it would stop getting replies.
- **Several sessions can stay live at once**: a session joins the acquired set when a normal message, `/sessions resume`, or `/to` actually gets its agent. Output, questions, and approvals from every acquired session go back to QQ; the current session is untagged, other sessions are prefixed with `[#shortid]`. The acquired set is runtime-only — after a restart only the current session is restored from `model-prefs.json`.
- **Switching does not release**: `/sessions resume` only moves the current pointer; the old session keeps running and its output keeps flowing to QQ. `/new` behaves the same. On unload the plugin disposes only the agents it created; borrowed Web/TUI agents are just dereferenced.
- **Questions are routed per session**: the current session answers with plain text; buttons from other sessions carry the session id and work when clicked; questions without buttons append a `/to #id ` link. A plain message that did not come through a link is never forwarded to the current model — the user is told to use a button or `/to`.
- The held list is ordered "current → other held (by acquisition time)"; the workspace view stays newest-first. The time column is the **creation time** (the host header stores no "last used" timestamp).
- After a cross-workspace resume the agent works inside **that session's own directory**, and the file-send allowlist follows it.


## Core Modules

```
src/
├── index.ts                    # Cordis plugin entry (async apply)
├── config.ts                   # Config schema
├── types.ts                    # Global types
├── setup.ts                    # Credential binding (QR)
├── gateway/                    # Gateway assembly
│   ├── bootstrap.ts            # Startup wiring (session/event listeners, etc.)
│   └── middleware-setup.ts     # Middleware chain config
├── transport/                  # Transport layer
│   ├── inbound.ts              # QQ inbound message → agent.followup()
│   ├── outbound.ts             # session/event → QQ sendMarkdown
│   ├── outbound-buffer.ts      # Streaming buffer
│   ├── streaming-writer.ts     # Streaming writer
│   ├── reply-target.ts         # Reply target resolution
│   ├── msgid-cache.ts          # Passive reply msgid cache
│   ├── reply-limiter.ts        # Passive reply rate limiter
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
│   └── answer-parser.ts        # Answer parsing
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
│   ├── scope.ts                # scope/peer extraction
│   └── send-helper.ts          # Chunked send
└── commands/                   # Slash commands
```

## Session Routing

The chat session key is `qqbot:${appId}:chat`; it only decides which session is *current*. Acquired sessions can be multiple. A UUID session id is minted for new sessions and persisted to `model-prefs.json`; after a restart only the current session resumes from that id. No mapping means a fresh chat session.

Resolution strategy: acquired record → in-process live agent → persisted resume → fresh create (current session only; `/sessions resume` never creates).

## Design Principles

- **Pure Cordis plugin** — follows the dsh "Plugins, not loop changes" principle
- **Declarative dependencies** — `inject = ['agents']`, no direct coupling to other plugins
- **One current session + multiple acquired sessions** — every QQ window continues the same current session; sessions acquired via `/sessions resume` or `/to` stay live and keep sending their output to QQ
- **Preset support** — mount presets (toolkits, prompts, etc.) via the `agent-presets` service
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
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## License

[MIT](./LICENSE)
