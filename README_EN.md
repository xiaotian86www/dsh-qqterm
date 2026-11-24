<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_SuperTerm-blue?style=for-the-badge" alt="QQ SuperTerm" />

**DeepSeek Harness inside a QQ private chat: sessions, models, permissions, files, and approvals, all from the chat window.**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.0.2-blue)](./CHANGELOG_EN.md)

<br/>

**[简体中文](./README.md) | English**

</div>

## What it is

QQ SuperTerm (`dsh-qqterm`) is a QQ channel terminal for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). It **brings no agent capability of its own**: it exposes the full capability surface of the host and its installed plugins inside a QQ private chat. Whatever the host can do — models, reasoning effort, presets, permissions, compaction, workspaces, worktrees, plugin installs, MCP and tools — can be done from QQ. The surface follows the host and its plugins, so the plugin version never promises a stale feature list.

What it does own is channel adaptation: inbound parsing, splitting and delivery, attachments, reply targets, binding, multi-session addressing, and copy. The test is one sentence — **delete the QQ layer: does this code still stand? If it does, it belongs to the host; the plugin may ask, never rule.**

In that layer exactly one thing qualifies as a feature: **multi-session management**. QQ has a single chat window while dsh can run many sessions at once; the name, the current pointer, addressing, quick actions, and background delivery all have to be invented on the channel side. So the tour starts there.

## Multi-session management

dsh can run many sessions at once; QQ has one chat window. This layer is the only feature dsh-qqterm owns, and the focus of the project: the host provides sessions, but not "which one is current", "how to switch inside a chat", or "how a background run comes back".

### One current session, a roster

- Across the bot there is exactly one current session: ordinary messages continue it, and its key is fixed at `qqterm:${appId}:chat`.
- Sessions touched by `/sessions resume`, `/to`, or a background message join the acquired set, and their output, questions, and approvals all return to QQ.
- The roster keeps the latest 20 sessions (`model-prefs.json`); after a restart the list still shows cold sessions, and `/sessions resume` is what actually opens one.
- Switching away does not release: changing which session is current leaves the old one running, and the next resume continues its full history. Sessions are never reclaimed for idleness.

### Addressing: 8-character short ids

| Form | Meaning |
|---|---|
| `#a1b2c3d4` | Full short id; `#` is only a visual prefix |
| `a1b2c3d4` | Accepted without `#` |
| `a1b2` | Prefix, at least 4 characters and unique |
| `#a1b2,a3c4` | Batch, comma-separated (full-width commas too), at most 10 per command |

Rows are **never numbered**: after paging and grouping, "the third row" is bound to be wrong, so the short id is the only handle.

### Quick actions: tapping fills in the command

- Every `/sessions` row ends with its actions: Reply / Stop (only while generating) / Archive; every archived row offers Unarchive; a workspace group header taps into `/new --dir <path>`.
- Every reply, question, approval, and failure card from a non-current session ends with Reply and Resume; Stop is added while it generates, Archive when the deployment can archive.
- A tap fills the smallest command (`/to #a1b2c3d4 `, `/stop #a1b2c3d4`, `/sessions archive #a1b2c3d4`) into the input box and **never executes it for you**: a stray tap changes nothing, and `/to` keeps the trailing space so the cursor lands at the start of the message body.
- Tapping and typing take the same command path, so authorization, copy, and logs exist once; the equivalent command is always visible next to the action.

### Background sessions report back

- Output from a non-current session starts with a separate line `> #short-id · title` and ends with a blank line carrying the action row.
- Replies from the current session carry no signature, so "signed = not the session you are watching".
- Questions and approvals carry the same `#short-id`; when one degrades to plain text, reply with `/to #short-id` to name the session.

### Every command changes only the fact it names

| Command | Changes | Leaves alone |
|---|---|---|
| `/to <id>` | Sends the message to the target; a not-yet-open session is resumed first | The current pointer |
| `/sessions resume <id>` | The current pointer (and reattaches history) | Other sessions |
| `/new` | Clears the current pointer; the next message opens a new session | The old session keeps running |
| `/new --background` | Opens a background session and sends the prompt now | The current pointer and workspace |
| `/stop [<id>\|all]` | Aborts generation and discards that session's queued messages | The pointer |
| `/clear` / `/clear all` | Stops the current session (`all`: every session) and clears the pointer (`all` also empties the acquired set) | Session logs |
| `/sessions archive` | The host's archive state | Session records |

### Archiving and restoring

- Archiving only changes host `workspaceRegistry` state: the session disappears from this list and the web sidebar, its log is kept, and it can be unarchived at any time.
- There is no physical delete: the host exposes no delete API, deleting directories by storage layout is irreversible, and on Windows it collides with file locks.
- `/sessions resume` on an archived session unarchives it first and says so in the receipt.
- Archiving a session with a worktree makes the host remove a clean tree and keep the branch; the plugin only reports.
- If the current session is archived its pointer is cleared, and the next message lands in a new session.
- In a deployment without `workspaceRegistry`, archive subcommands are treated as unknown.

### Generating and queueing

- Queueing only happens inside one session: messages to the same session run in arrival order and different sessions never block each other.
- While a session generates, where a new prompt lands follows the host's `ui-conversation.busyEnter`: by default it queues after the current turn (receipt `✅ Queued`, with a `/steer` action); when the host is set to steer, it is consumed at the next step (receipt `✅ Steered`).
- `/steer` changes only one queued message's placement without aborting the turn; `/stop` aborts and discards queued messages.

### Common forms

| Form | Effect |
|---|---|
| `/sessions` | List sessions held by QQ, grouped by workspace, 10 per page |
| `/sessions all` | List every session, including other projects |
| `/sessions <page>` | Page through |
| `/sessions resume <id>` | Open a session (an archived one is unarchived first); failure never creates one |
| `/sessions rename <id> <title>` | Rename an opened session; resume a cold one first |
| `/sessions archive` | List sessions that can be archived; `<page>` pages through |
| `/sessions archive <id>[,<id>…]` | Archive one or more (at most 10) |
| `/sessions archived` | List archived sessions |
| `/sessions unarchive <id>[,<id>…]` | Unarchive |

- Only a generating session carries `⚡` at the start of its row (the default list and `/sessions all` alike); idle rows have no state word, and the trailing `✅` (current) / `📌` (held) are markers that may share a row with `⚡`.
- Sorting is by most recent human message, descending, with ties by id ascending; the current session is not pinned and is marked only by `✅`.
- The paging footer is `Previous · Page 1/2 · Next`, omitting whichever side is missing.
- Available only in C2C private chat and when the sender equals `access.owner`.

## Requirements

- Node.js ≥ 22.12 (see `engines` in `package.json`).
- Host deepseek-harness 0.2.2-rc.1 / 0.2.2-rc.3 (see `dsh.compatibility` in `package.json`); after a major host upgrade the settings section and QR binding need re-verification.
- A QQ bot (Bot API v2) AppID and AppSecret; only `access.owner` is served and only private chat is supported.

## Architecture

```
QQ User → QQ WebSocket → dsh-qqterm → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

The plugin is a pure Cordis plugin: the host loads `lib/index.js`, the browser loads `lib/client.js` for the settings section, and the host loop is never modified.

## Installation

Pick any of the four methods. Credentials live in the profile's `cordis.patch.yml`; media cache and session preferences live in `~/.dsh-qqterm`.

### Method 1: Desktop install (recommended)

No command line needed — everything happens inside the app:

1. **Install**: click "Plugins" in the left sidebar → "Add plugin" → enter `dsh-qqterm` → install and start now

<img src="./assets/docs/install.png" alt="In-app plugin install" width="560" />

2. **Connect**: avatar at the bottom-left → Settings → "QQ SuperTerm" → scan the QR code with mobile QQ

<img src="./assets/docs/setting.png" alt="Settings QR binding" width="560" />

Credentials are saved automatically after the scan; later launches need no re-scan.

### Method 2: Command line

```bash
# Install into a profile
npx @deepseek-ai/dsh plugin --profile qqterm add dsh-qqterm

# Start
npx @deepseek-ai/dsh --profile qqterm
```

On first launch, the plugin detects missing credentials and automatically starts the QR flow: scan the QR code in the terminal with mobile QQ to finish binding.

Alternatively, provide credentials through environment variables:

```bash
export QQBOT_APPID="xxx"
export QQBOT_SECRET="xxx"
```

If the browser cannot open, set `QQBOT_BIND_OPEN_BROWSER=1` and the QR page opens in your default browser.

<img src="./assets/docs/qrcode.png" alt="Terminal QR scan" width="560" />

### Method 3: Local path

```bash
npx @deepseek-ai/dsh plugin --profile qqterm add /path/to/dsh-qqterm
```

Suitable for development checks. For the main profile, prefer a published release or a frozen tgz snapshot; do not point it at a directory that keeps rebuilding.

### Method 4: `--patch` dev mode

```bash
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqterm/cordis.dev.yml
```

Nothing is installed into a profile; this is for temporary debugging.

## Configuration

Configuration lives in the profile's plugin config; `appId` / `appSecret` can also come from the environment.

### Basic

| Setting | Type | Default | Description |
|---|---|---|---|
| `appId` | string | `""` | QQ Bot AppID; leave empty to bind by QR at startup |
| `appSecret` | string | `""` | QQ Bot AppSecret |
| `textChunkLimit` | number | `4500` | Max characters per message; longer output is split at this limit (QQ caps at about 5000) |
| `maxQueue` | number | `20` | Max length of the concurrency queue |
| `askTimeoutMs` | number | `300000` | Timeout for an unanswered question (ms); auto-rejects with a notice; `0` disables |
| `retryOffer.enabled` | boolean | `true` | After a failed turn, ask with a "Resend / Give up" card |
| `retryOffer.timeoutMs` | number | `600000` | Card lifetime (ms); buttons expire after this; `0` never expires |
| `showToolResults` | boolean | `false` | Whether to show tool call results (both successes and failures) |
| `debug` | boolean | `false` | Debug logging |

### Access control

| Setting | Type | Default | Description |
|---|---|---|---|
| `access.owner` | string | `""` | OpenID of the only QQ user allowed to use the bot; an empty string rejects all private chats |

Only one user is allowed; group messages are always rejected. Button clicks (question / approval / retry / confirm) verify that the clicker equals `access.owner`. Rebind or unbind from the settings section.

### Rich media

| Setting | Type | Default | Description |
|---|---|---|---|
| `media.enabled` | boolean | `true` | Enable rich-media understanding (images / videos are downloaded and handed to tools) |
| `media.maxMB` | number | `200` | Max download size (MB) |
| `media.ttlHours` | number | `24` | Cache lifetime (hours); `0` never expires |

Downloads land in `~/.dsh-qqterm/media` and are cleaned up by TTL. With `media.enabled` off, attachments are still received but not downloaded or analyzed.

### Deliverables

| Setting | Type | Default | Description |
|---|---|---|---|
| `sendFile.sendPresentedFiles` | boolean | `true` | Send files declared via `present` to the current session at the end of a turn |
| `sendFile.maxFiles` | number | `4` | Max deliverables per turn (values below 1 are treated as 1) |

Deliverables are declared by the agent via `present` and sent together at the end of the turn; any path is allowed, but only `access.owner` receives them. Inbound attachment downloads are controlled by `media`.

### Command panel

| Setting | Type | Default | Description |
|---|---|---|---|
| `panel.autoSync` | boolean | `true` | Sync built-in commands to the QQ command panel once the bot is ready |

Sync is a whole-table overwrite with the remark fixed to `qqterm:commands`; unchanged content skips the write.

### Custom menu

| Setting | Type | Default | Description |
|---|---|---|---|
| `menu.autoSync` | boolean | `true` | Sync fixed entries to the C2C custom menu once the bot is ready |

The menu has six fixed entries: Session status, Session list, Reset session, Compact session, Permission preset, Reasoning effort. Permission and reasoning open submenus; the rest point straight at their command. The menu is a bot-wide whole-table overwrite, not per user.

### Local commands and directories

`/run`, `/ls`, and `/get` are the channel's own extensions: they operate this computer remotely from QQ and never go through the host's shell or sandbox. All three share one base — **the directory the dsh process was started in** (`process.cwd()`), independent of the session workspace and the run directory, and unaffected by a runtime `cd`.

| Setting | Type | Default | Description |
|---|---|---|---|
| `exec.shell` | string | The actual `cmd.exe` path on Windows; `/bin/sh` otherwise | Shell used to run `/run`; the platform default is written into the config (Windows prefers `ComSpec`); clearing it means empty (an error before execution), never re-defaulted at runtime |
| `exec.shellArgs` | string[] | Windows `["/d","/s","/c"]`; otherwise `["-c"]` | Argument template for the shell, `{command}` replaced in place; the platform default is written into the config and used literally at runtime (empty = pass no arguments), switching shells never rewrites it |

Absolute paths in `/get` and `/ls` ignore the base; a `/run` command is typed by the user, so its consequences are the user's, and it is not wrapped in the host sandbox.

## Sessions, workspaces, and interaction

### Workspaces

Workspaces are the host's `workspaceRegistry` concept; dsh-qqterm keeps no directory list of its own.

- There is no `cwd` setting. A new session lands in the host's default workspace (`Documents/deepseek-harness/default-workspace`), or the dsh launch directory when the host cannot read it.
- A workspace follows its session: `/sessions resume` runs in the session's own workspace, with no directory switch first; resuming across workspaces works the same way.
- Changing workspace is only possible through `/new --dir <workspace>`, which decides where the next message lands; bare `/new` stays in the current workspace.
- Matching order: workspace title → directory name (case-insensitive, unique prefix) → absolute path. Without `workspaceRegistry` only absolute paths are accepted.
- The title defaults to the last path segment and can be changed in the web sidebar; a manually edited title is never overwritten automatically.
- Worktrees: `/new --worktree` makes the next message create a tree from the current directory's HEAD first, then opens the session in that tree, on branch `dsh-<short session id>`. Uncommitted changes do not travel into the tree. If HEAD cannot be read or tree creation fails, no session is created that round; the reply gives the reason and next step, the intent is kept, and resending retries. A directory that is not a Git repository opens the session in place with a notice; a read-only sandbox is refused at `/new` on the spot. When a session is archived, the host removes a clean worktree and keeps the branch, and keeps the tree if there are uncommitted changes.
- Run directory and workspace are two different things: a runtime `cd` only changes the run directory, while `/get` and `/ls` keep using the directory the dsh process was started in; workspace grouping, the workspace line in `/status`, and the landing point of the next `/new` still use the session's `header.cwd` at creation. For a worktree session, the workspace is the main repository root and the tree is only the run directory.

### Models, presets, and reasoning effort

- A new session resolves its model through `settings.yaml` → `agentDefaultModel` → `deepseek-official/deepseek-v4-flash`.
- `/model` and `/reasoning` write into the current session when one is active and take effect next turn (no fork, no rebuild); they also write the deployment default. With no session they write only the default.
- The effort chosen by `/reasoning` also becomes the global default, and later sessions inherit it.
- `/preset` is deployment-level: it is persisted to `settings.yaml` and only affects new sessions; the plugin stores no preset.
- `/permission` takes effect immediately in the current session when one is active; otherwise it changes the default.
- Inspection views show the current value with `✅` and invent no "global" label.

### Files and rich media

- Inbound images and videos are downloaded per `media` and handed to tools for analysis; the cache lives in `~/.dsh-qqterm/media` and is cleaned up by TTL.
- Image content blocks in assistant messages are sent as QQ images at their position; text is split into two messages around each image.
- Deliverables declared via `present` are sent at the end of the turn (`sendFile.sendPresentedFiles`, at most `maxFiles` per turn).
- `/get` can send a file from any path; directories are rejected. `/ls` is for browsing and picking.
- Local file links in assistant text are rewritten to `/get <absolute path>`, so opening one sends the file.
- Deliverables and `/get` are sent only to `access.owner`.

### Questions, approvals, and retry

- `ask_user_question`: single-choice questions render inline buttons (picking one greys out the rest), multi-select replies with numbers; questions advance one at a time with a per-question `askTimeoutMs`.
- `approval/request`: sensitive actions ask for confirmation with Allow / Deny buttons; if the buttons cannot be sent, this degrades to plain text.
- Failed turn: by default a "Resend / Give up" card asks what to do (`retryOffer`); after the card expires, `/retry` resends the previous user message.
- Question and approval routing follows sessions: the current session gets them directly; other sessions carry a `#short-id` on the buttons. If a question degraded to plain text, reply with `/to #short-id` to name the session.

## Built-in commands

| Command | Description |
|---|---|
| `/new` | New session; `--dir` (`-d`) picks the workspace, `--worktree` (`-w`) makes the first message create a worktree first, `--background` (`-b`) opens another session in the background without touching the current one; the remaining text is sent immediately as the prompt; replying to a message carries its quote along and a quote alone opens the session too; the old session keeps running |
| `/clear` (alias `/reset`) | Stop the current session; the next message opens a new one in the original workspace; `/clear all` stops every acquired session; a 5-minute confirmation card comes first |
| `/compact` | Compact session history (summaries replace older records); the reply includes the host command's result |
| `/goal` | Set or view the current session's long-term goal; `/goal <goal>` sets it, `edit` / `pause` / `resume` / `clear` manage it |
| `/sessions` (alias `/session`) | Session management: by default lists sessions held by QQ (including cold sessions not yet opened after a restart), `all` shows everything, `archived` shows archived sessions; addressing, quick actions, and archive semantics live in "Multi-session management" |
| `/rename` | Rename the current session; `/sessions rename <id> <title>` renames an opened session |
| `/to` | Send a message to a given session; submits an answer when that session is waiting for one; a not-yet-open session is resumed first; replying to a message places its quote ahead of the body (except while the target awaits an answer) |
| `/ls` | List subdirectories and files in the current directory (where the dsh process was started); click a directory to enter, a file to send; paths may be absolute or start with `~` |
| `/get` | Send a file to the current chat (images / videos / voice by type); any path, relative ones resolved against the same base |
| `/run` | Run a local command in the current directory (shell is the OS one, configurable via `exec`); `--timeout <seconds>` changes the timeout (120 s by default, 600 s max) |
| `/model` | View or switch the current session's model |
| `/reasoning` (alias `/think`) | View or switch the current session's reasoning effort |
| `/preset` | View or switch the current agent preset (only affects new sessions) |
| `/permission` | View or switch the current session's permission preset (bound user only) |
| `/cost` | View the current session's token usage |
| `/status` | View session status: session, state, workspace, worktree, model, reasoning effort, preset, permission, context |
| `/stop` | Abort the current generation; `/stop <id>` stops a given acquired session; `/stop all` stops everything; queued messages are discarded |
| `/steer` | Change a queued prompt to steering (takes effect at the next step); no argument uses the latest queued message in the current session, `<id>` names an acquired session, `<id> <message-id>` picks one message |
| `/retry` | Resend the current session's previous user message |
| `/help` | Show all commands; `/help <command>` shows arguments and usage |
| `/plugins` | Plugin management: list, `install` / `update`, `check`, `reload` (bound user only) |

Notes:

- Arguments share one parser: whitespace separates them, and values with spaces go in quotes; `--dir=value` equals `--dir value`. An unclosed quote replies "quote not closed + usage", an unrecognized argument replies "unknown argument + usage", and nothing is silently skipped.
- A misspelled `/` command is caught at the inbound layer and given usage; it never reaches the model. An ambiguous prefix is rejected as "ambiguous".
- When the host lacks a service that a command depends on, the whole command does not appear and input is treated as an unknown command.

### `/new` usage

| Form | Effect |
|---|---|
| `/new` | Clear the current pointer; the next message creates a new session in the original workspace; the old session keeps running |
| `/new <prompt>` | Send this prompt immediately in the new session |
| `/new --dir <workspace>` | Open the new session in the given workspace (`-d`, one word only) |
| `/new --background <prompt>` | Open another session in the background without touching the current session or workspace (`-b`, prompt required) |
| `/new --worktree [prompt]` | Create a worktree before the next message (`-w`, see "Workspaces") |

- Arguments and prompt may come in any order; the remaining text is joined as the prompt, and everything after `--` counts as prompt.
- `-w` and `-b` combine as `-wb`; when short flags are clustered, the value-taking `-d` goes last (`-wbd <workspace>`).
- `--dir` takes one word only; quote paths with spaces, or use `--dir=path`.
- Arguments are validated before the session is touched: a missing directory or file is rejected and the current session is unaffected.
- `/new` with arguments is available only to the bound user; bare `/new` is unrestricted.
- If you do not know the path, use `/ls` to walk to the target directory, then follow the usage with `/new --dir`.

### `/plugins`

- Lists plugin packages in the registry; entries with a new version carry "→ New version" and an update link.
- `install` / `update` call the host reconcile immediately: install a new version; on update pick the latest compatible one and roll back to the old version on failure; packages with build scripts pause first for a "Continue install" button.
- `check` queries the registry for updatable plugins right away instead of waiting for the scheduled check; the receipt reports how many plugins were checked, how many can be updated, and how many lookups failed.
- `reload` replaces changed items by the on-disk identity of loaded modules and reports no changes when the disk has not changed.
- For a local tgz dev package, run `pnpm dev:reload` first to snapshot and install it into the dev profile, then send `/plugins reload`.
- Update checks run automatically once 2 minutes after startup and every 6 hours after that; `check` is a manual trigger of the same check. Only the bound user can run the command.

## Core modules

```
src/
├── index.ts                     # Cordis plugin entry: inject, command registration, event wiring
├── config.ts                    # Config schema
├── host/adapter.ts              # Host service adapter: required services and optional soft reads
├── setup/                       # Credential binding
│   ├── binding-service.ts       # QR binding state machine
│   ├── bind-routes.ts           # In-app binding page routes
│   └── persist.ts               # Credentials written back to the profile
├── client/                      # Browser half
│   ├── config-panel.ts          # Settings section (bind / change credentials / unbind / config editing)
│   └── bind-page.ts             # In-app QR page
├── gateway/                     # Gateway assembly
│   ├── bootstrap.ts             # Startup and reconnect
│   ├── gateway-session.ts       # Single connection lifecycle
│   └── middleware-setup.ts      # Middleware chain
├── transport/                   # Inbound and outbound
│   ├── inbound.ts               # Inbound messages
│   ├── outbound.ts              # Replies and pushes
│   ├── send.ts                  # Unified send path (split → enqueue → retry)
│   ├── outbox.ts                # Pending send queue
│   ├── chunker.ts               # Markdown-aware splitting
│   ├── deliverables.ts          # present deliverables
│   └── file-links.ts            # Local file link rewriting
├── session/                     # Sessions
│   ├── session-manager.ts       # Current session, acquired set, roster
│   ├── worktree.ts              # Worktree creation and recovery
│   └── session-id.ts            # Session ids and short ids
├── model/                       # Model / reasoning effort / preset
│   ├── model-resolver.ts        # Resolution order
│   ├── prefs-store.ts           # Preference persistence
│   └── settings-reader.ts       # settings.yaml read-only
├── features/                    # Interaction features
│   ├── question-channel.ts      # Question channel
│   ├── approval-channel.ts      # Approval channel
│   ├── retry-channel.ts         # Failed-turn retry
│   ├── command-panel.ts         # Command panel
│   └── command-menu.ts          # Custom menu
├── middleware/                  # Inbound middleware
│   ├── question-answer.ts       # Answer handling
│   ├── unknown-command.ts       # Misspelled command interception
│   ├── multiline-command.ts     # Multiline commands
│   └── attachment.ts            # Attachments
├── media/                       # Media sending and TTL cleanup
├── shared/                      # Shared utilities (paging, inline commands, data dir)
├── reload/                      # /plugins reload
├── plugins/                     # /plugins install and update
└── commands/                    # Slash commands
```

## Session routing

The chat session key is fixed at `qqterm:${appId}:chat`; it only decides which session is current, and there may be many acquired sessions. The current session mints a UUID session id the first time it is actually used and persists it to `model-prefs.json`; after a restart only the current session is restored from its persisted id, and no mapping means a brand-new session. `/new` and `/clear` only clear this mapping (and the current session); they never pre-mint a session that does not exist yet.

Resolution order: acquired record → in-process live agent → persisted restore → brand-new create (current session only; a failed `/sessions resume` never creates).

## Design principles

- **Pure Cordis plugin** — follows dsh's "Plugins, not loop changes" principle.
- **Declarative dependencies** — `inject` lists 14 required services: `agents`, `llm`, `agentDefaultModel`, `sessionProjections`, `sessionPersistence`, `sessionQuery`, `sessionTitle`, `permissionPresets`, `settings`, `commands`, `tools`, `attachments`, `workingDirectory`, `pluginManager`. Missing any one keeps the plugin inactive; there is no runtime probing or fallback.
- **Optional services, soft-read** — optional capabilities are not in `inject` and are looked up at the point of use; absence only narrows the capability surface, never changes semantics, and is not explained or announced.

| Optional service | If missing |
|---|---|
| `agentPresets` | `/preset` is not registered; new sessions use the host's default combination |
| `webServer` | The in-app binding page is not registered; QR goes through the terminal / browser only |
| `workspaceRegistry` | `/sessions` still groups by directory, but headers show only paths and there is no `📌` / archive entry; archive subcommands are unknown; `/new --dir` accepts absolute paths only |
| `worktrees` | `/new --worktree` is treated as an unknown argument; the session is created in place |
| `sessionController` | `/sessions` sorting degrades to creation time |

- **One current session + many acquired sessions** — any QQ window continues the same current session; sessions obtained through `/sessions resume` and `/to` stay alive and post their output back to QQ.
- **Thin layer** — model, preset, reasoning effort, permission, compaction, and workspace are forwarded to the host; the plugin keeps only the channel-specific layer: inbound parsing, splitting, attachments, reply targets, binding, multi-session addressing, and copy rendering.
- **Markdown output** — replies are sent as Markdown, with code-block and table-aware splitting.
- **Single-user private chat** — only `access.owner` is served; group messages are always rejected.

## Local development

```bash
# Install dependencies
pnpm install

# Type-check and bundle
pnpm build

# Run tests
pnpm test

# Type-check watch (rebuild the client manually after client changes)
pnpm dev
```

| Command | Purpose |
|---|---|
| `pnpm build` | Type-check and bundle; produces `lib/index.js` and `lib/client.js` |
| `pnpm build:client` | Rebuild the client only |
| `pnpm dev` | Type-check watch |
| `pnpm test` | Run tests (vitest) |
| `pnpm typecheck:client` | Client type check |
| `pnpm dev:reload` | Snapshot a local tgz and install it into the dev profile |
| `pnpm run lint` | No eslint config; not a gate |

Tests live in the top-level `tests/` directory, mirror `src/` by module, and never touch a real `~/.dsh`, real credentials, or the network.

## Further reading

- [Inbound / outbound paths](./docs/inbound-outbound-paths.md)
- [Multi-session design](./docs/multi-conversation-design.md)
- [Copy style](./docs/copy-style.md)
- [Changelog and known limitations](./CHANGELOG_EN.md)

## License

[MIT](./LICENSE)
