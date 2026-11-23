<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_SuperTerm-blue?style=for-the-badge" alt="QQ SuperTerm" />

**DeepSeek Harness inside a QQ private chat: sessions, models, permissions, files, and approvals, all from the chat window.**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](https://nodejs.org/)

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

The menu has seven fixed entries: Session status, Session list, Reset session, Compact session, Long-term goal, Permission preset, Reasoning effort. Permission and reasoning open submenus; the rest point straight at their command. The menu is a bot-wide whole-table overwrite, not per user.

## Sessions, workspaces, and interaction

### One current session, many acquired sessions

Across the bot there is exactly one current session: ordinary messages continue it, and its key is fixed at `qqterm:${appId}:chat`.

Any number of background sessions may exist: agents obtained through ordinary messages, `/sessions resume`, or `/to` join the acquired set, and their output, questions, and approvals all return to QQ. Replies from the current session are sent as-is; replies from other sessions start with a separate line `> #short-id · title`, followed by the body and a blank line carrying Reply and Resume links (plus Stop while generating, and Archive when archiving is available).

The acquired set is runtime-only; the session roster (the latest 20) is written to `model-prefs.json`, so the list still appears after a restart and `/sessions resume` is what actually opens a session. The current session is still restored automatically at startup.

Switching away does not release: `/sessions resume` changes which session is current and the old one keeps running; the next resume continues its full history.

Queueing happens only inside a single session: messages to the same session run in arrival order, while different sessions do not block each other. Sessions are not reclaimed for idleness; as long as the process lives and the agent is not unloaded, they stay available.

### Workspaces

Workspaces are the host's `workspaceRegistry` concept; dsh-qqterm keeps no directory list of its own.

- There is no `cwd` setting. A new session lands in the host's default workspace (`Documents/deepseek-harness/default-workspace`), or the dsh launch directory when the host cannot read it.
- A workspace follows its session: `/sessions resume` runs in the session's own workspace, with no directory switch first; resuming across workspaces works the same way.
- Changing workspace is only possible through `/new --dir <workspace>`, which decides where the next message lands; bare `/new` stays in the current workspace.
- Matching order: workspace title → directory name (case-insensitive, unique prefix) → absolute path. Without `workspaceRegistry` only absolute paths are accepted.
- The title defaults to the last path segment and can be changed in the web sidebar; a manually edited title is never overwritten automatically.
- Worktrees: `/new --worktree` makes the next message create a tree from the current directory's HEAD first, then opens the session in that tree, on branch `dsh-<short session id>`. Uncommitted changes do not travel into the tree. If HEAD cannot be read or tree creation fails, no session is created that round; the reply gives the reason and next step, the intent is kept, and resending retries. A directory that is not a Git repository opens the session in place with a notice; a read-only sandbox is refused at `/new` on the spot. When a session is archived, the host removes a clean worktree and keeps the branch, and keeps the tree if there are uncommitted changes.
- Run directory and workspace are two different things: a runtime `cd` only changes the run directory (the base for relative paths in `/get` and `/ls`); workspace grouping, the workspace line in `/status`, and the landing point of the next `/new` still use the session's `header.cwd` at creation. For a worktree session, the workspace is the main repository root and the tree is only the run directory.

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
| `/new` | New session; `--dir` (`-d`) picks the workspace, `--worktree` (`-w`) makes the first message create a worktree first, `--background` (`-b`) opens another session in the background without touching the current one; the remaining text is sent immediately as the prompt; the old session keeps running |
| `/clear` (alias `/reset`) | Stop the current session; the next message opens a new one in the original workspace; `/clear all` stops every acquired session; a 5-minute confirmation card comes first |
| `/compact` | Compact session history (summaries replace older records); the reply includes the host command's result |
| `/goal` | Set or view the current session's long-term goal; `/goal <goal>` sets it, `edit` / `pause` / `resume` / `clear` manage it |
| `/sessions` (alias `/session`) | Session management: by default lists sessions held by QQ (including cold sessions not yet opened after a restart), `all` shows everything, `archived` shows archived sessions |
| `/rename` | Rename the current session; `/sessions rename <id> <title>` renames an opened session |
| `/to` | Send a message to a given session; submits an answer when that session is waiting for one; a not-yet-open session is resumed first |
| `/ls` | List subdirectories and files in a directory; click a directory to enter, a file to send |
| `/get` | Send a file to the current chat (images / videos / voice by type); any path |
| `/model` | View or switch the current session's model |
| `/reasoning` (alias `/think`) | View or switch the current session's reasoning effort |
| `/preset` | View or switch the current agent preset (only affects new sessions) |
| `/permission` | View or switch the current session's permission preset (bound user only) |
| `/cost` | View the current session's token usage |
| `/status` | View session status: session, state, workspace, worktree, model, reasoning effort, preset, permission, context |
| `/stop` | Abort the current generation; `/stop <id>` stops a given acquired session; `/stop all` stops everything |
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

### `/sessions` usage

| Form | Effect |
|---|---|
| `/sessions` | List sessions held by QQ (including cold sessions not yet opened after a restart), grouped by workspace |
| `/sessions <page>` | Page through (10 per page) |
| `/sessions all` | List every session, including other projects |
| `/sessions resume <id>` | Open a given session (an archived one is unarchived first); failure never creates a session |
| `/sessions rename <id> <title>` | Rename an opened session; a cold session gets a "resume first" prompt |
| `/sessions archive` | List sessions that can be archived; `<page>` pages through |
| `/sessions archive <id>[,<id>...]` | Archive one or more (comma-separated, at most 10) |
| `/sessions archived` | List archived sessions |
| `/sessions unarchive <id>[,<id>...]` | Unarchive |

Notes:

- Session ids are always 8-character short ids and are never numbered in rows; a target may carry `#`, and a prefix must be at least 4 characters and unique.
- 10 rows per page; the footer is `Previous · Page 1/2 · Next`, omitting whichever side is missing.
- State (generating / idle) is shown only in the default list; other views mark only `📌`.
- Available only in C2C private chat and when the sender equals `access.owner`.
- Archiving changes host state only and never deletes session records; if the current session is archived, its pointer is cleared and the next message lands in a new session. Without `workspaceRegistry`, archive subcommands are treated as unknown.
- When several active sessions produce output at once, every reply starts with `> #short-id · title` and ends with Reply and Resume links; switching away does not release, and queueing happens only inside one session.
- Sorting is by most recent human message, descending, with ties by id ascending; the current session is not pinned and is marked only by `✅` at the end of its row.
- Resuming across workspaces runs in the session's own directory.

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
- **Image forwarding** — image content blocks in assistant messages are sent as QQ images at their position, and text is split into two messages around each image.
- **Deliverables** — files declared via `present` are sent to the user at the end of the turn (enabled by default, any path).
- **Questions** — `ask_user_question` is supported; single-choice renders inline buttons (picking one greys out the rest), multi-select replies with numbers, questions advance one at a time, with a per-question timeout.
- **Approvals** — `approval/request` is supported; sensitive actions ask the user to confirm with Allow / Deny buttons.
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

## License

[MIT](./LICENSE)
