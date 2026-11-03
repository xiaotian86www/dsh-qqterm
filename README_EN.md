<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

**A QQ Bot plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), connecting DeepSeek AI assistants to QQ private and group chats.**

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
| `requireMention` | boolean | `true` | Whether group messages require @bot to trigger |
| `groupPrompt` | string | - | Extra system prompt for group chats |
| `directPrompt` | string | - | Extra system prompt for direct chats |
| `textChunkLimit` | number | `4500` | Max chars per message |
| `streaming` | boolean | `true` | Enable streaming output (always disabled in groups) |
| `sessionIdleTimeout` | number | `1800000` | Session idle timeout (ms), default 30 min |
| `processingTimeoutMs` | number | `1800000` | Processing timeout (ms), aborts the current LLM call |
| `maxQueue` | number | `20` | Max concurrent queue length |
| `historyLimit` | number | `10` | Group history buffer size |
| `askTimeoutMs` | number | `300000` | Question timeout (ms), default 5 min (ask_user_question) |
| `showToolResults` | boolean | `false` | Show successful tool-call results (errors always shown) |
| `debug` | boolean | `false` | Debug mode |

### Access control (access)

| Config | Type | Default | Description |
|------|------|--------|------|
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | Direct-chat access mode |
| `access.c2cAllow` | string[] | `[]` | Direct-chat allowlist (user openid) |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | Group access mode |
| `access.groupAllow` | string[] | `[]` | Group allowlist (group openid) |

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
| `/new` (aliases `/reset` `/clear`) | Start a new session (clear context) |
| `/compact` | Compact session history (replace old records with a summary) |
| `/sessions` (alias `/session`) | Session management: list by workspace, resume, archive / unarchive |
| `/workspace` | Workspace: view / switch (only right after `/new`) |
| `/model` | View or switch model |
| `/preset` | View or switch agent preset (applies to new sessions) |
| `/cost` | View token usage of the current session |
| `/stop` | Abort the current generation |
| `/bot-ping` | Network latency test (transport & processing time) |
| `/bot-version` | View version info |
| `/bot-me` | View your OpenID (for access allowlists) |
| `/bot-status` | View current session status |
| `/bot-help` | View all commands |

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
| `/workspace` | Show the current workspace (title / path / whether it can still change) |
| `/workspace <name\|path>` | Switch workspace: accepts a workspace title or directory name (case-insensitive, unique prefix) or an absolute path |

- There are only two moments: **right after `/new`**, or before this chat has ever talked. Once a session exists the command refuses and points at "`/new` first, then `/workspace <name>`" — the directory is already in that session's header, and editing the record would not take effect (a resumed session keeps its own `cwd`).
- The next message after a switch creates the session in the new directory, and the workspace shows up in the host sidebar; a missing directory (or a file) is rejected without leaving a half-applied state.
- Same permission surface as `/sessions`: **private chat + allowlist** (`access.c2cAllow`) only — switching workspace means changing the directories the agent may touch.

### Session management (`/sessions`)

`/sessions` lists the same sessions the Web sidebar shows (host `sessionQuery` / `sessionPersistence`), scoped to **the workspace of the current session** — a session created in the Web UI inside this workspace is visible and resumable from QQ too.

| Usage | Description |
|------|------|
| `/sessions` | List unarchived sessions of the current workspace (newest first, 10 per page); every row shows its 8-char short id, and clicking fills `/sessions resume <id>` into the input box |
| `/sessions <page>` | Next page of the same list, e.g. `/sessions 2` |
| `/sessions all` | List every session grouped by workspace (pinned first inside a group); groups show **no index**, only short ids |
| `/sessions resume <index\|id>` | Rebind this chat to that session and continue its history (an archived target is unarchived on the way); the workspace follows |
| `/sessions archive <index\|id>[,<index\|id>…]` | Archive the session: hidden from this command and the Web sidebar, **on-disk log kept**, restorable at any time; separate multiple targets with commas (up to 10 per command) |
| `/sessions archived [page]` | List archived sessions; each row shows its short id and workspace and fills `/sessions unarchive <id>` into the input box |
| `/sessions unarchive <id>[,<id>…]` | Restore the session to the regular list |

Notes:

- **One handle rule**: every row shows an 8-char short id (like `#3f2a9b1c`; the `#` is optional) that works from any view; an **index only means a row of the `/sessions` page**. `/sessions all` numbers rows per group, which cannot match the command's resolution order, so it shows no indexes at all — only short ids.
- Private chat only, and the operator must be in the allowlist (`access.c2cAllow`) — titles and archive state touch other chats' data; with no allowlist configured the command is disabled (`/bot-me` shows your OpenID).
- Archiving goes through the host `workspaceRegistry.archiveSession` and only writes the registry-global archive set — **no file is deleted**. This plugin offers no hard delete; clean up on disk from the Web side or by hand.
- Archiving needs the host workspace registry (`@deepseek-ai/dsh-workspace`): the web / Desktop profiles ship it, while a minimal custom profile (just `dsh-base` + this plugin) must mount it explicitly, otherwise the command reports "no session archive API mounted".
- Archiving disposes the session's agent in this process and repoints per-chat mappings to a new session — an archived session is rejected by the host `agent/pre-step` gate, so a chat left bound to it would stop getting replies.
- The time column is the **creation time** (the host header stores no "last used" timestamp), which is why the heading says "newest first".
- A session can be held by one chat per process — resuming one that another chat is using is refused.
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
│   ├── session-manager.ts      # QQ peer → Agent mapping
│   └── idle-evictor.ts         # Idle eviction
├── model/                      # Model routing
│   ├── model-resolver.ts       # Route resolution
│   ├── prefs-store.ts          # Per-peer preference persistence
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
│   └── attachment.ts           # Attachment handling
├── shared/                     # Shared utilities
│   ├── utils.ts                # Common helpers
│   ├── scope.ts                # scope/peer extraction
│   └── send-helper.ts          # Chunked send
└── commands/                   # Slash commands
```

## Session Routing

sessionKey: `qqbot:${appId}:${scope}:${peerId}`; a UUID session id is minted for new sessions and persisted to `model-prefs.json`, resuming by the persisted id after restarts; pre-0.6 sessions keep their originally derived ids.

Resolution strategy: in-process reuse → persisted resume → fresh create.

## Design Principles

- **Pure Cordis plugin** — follows the dsh "Plugins, not loop changes" principle
- **Declarative dependencies** — `inject = ['agents']`, no direct coupling to other plugins
- **Session isolation** — one independent Agent per QQ direct user / group
- **Preset support** — mount presets (toolkits, prompts, etc.) via the `agent-presets` service
- **Idle eviction** — auto-dispose Agents on timeout to prevent memory leaks
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
