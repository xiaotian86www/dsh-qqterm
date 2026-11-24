# Changelog

> [简体中文](./CHANGELOG.md)

User-visible changes to QQ SuperTerm (`dsh-qqterm`). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- `/run`: run a local command in the current directory, with `--timeout <seconds>` (120 s by default, 600 s max); oversized output is trimmed to its tail. The plugin spawns the process itself and does not go through the host's shell capability: the working directory is the host process's current directory (independent of the session workspace or the run directory), the shell is the OS one (`exec.shell` / `exec.shellArgs`), The command is user-initiated, so its consequences are the user's; `/run` takes exactly one command, whole-command quoted when it contains spaces; an extra word is rejected as a malformed argument, and the command string goes to the shell verbatim, with `&&` and pipes interpreted by the shell.

### Changed

- `/ls` and `/get` now resolve relative paths against the host process's current directory (`process.cwd()`) instead of the run directory; absolute paths still work as before.
- The reply link at the bottom of messages from other sessions now reads `/to #short-id -- `: everything after `--` is the message body, so the user only adds the text; the form without `--` keeps working.
- `exec.shell` and `exec.shellArgs` now default to the platform's values in the config (the actual `cmd.exe` path and `["/d","/s","/c"]` on Windows, `/bin/sh` and `["-c"]` otherwise) instead of being derived only at runtime, so they are visible and editable; both are used literally at runtime, clearing one means empty (`/run` reports "no shell configured"), and nothing is re-defaulted or rewritten for the chosen shell.

## [0.0.2] - 2026-11-24

### Fixed

- Screenshots, further reading, and the repository entry on the package page work again: 0.0.1 was published from a commit before the repository address was fixed, so `repository` still pointed at the non-existent `dsh-qqbot` and npm rewrote the README's relative paths against it, leaving broken images, 404 doc links, and a dead repository entry; from this version on the metadata points at `xiaotian86www/dsh-qqterm`.

## [0.0.1] - 2026-11-23

The first release: DeepSeek Harness inside a QQ private chat.

### Added

**Channel and binding**

- One QQ private-chat message is one turn; slash commands cover sessions, models, reasoning effort, permission presets, directory browsing, file sending, and cost.
- QR binding: desktop and web scan inside the settings section and credentials are written to the profile automatically; environments without the in-app page use the terminal QR code, and a browser that cannot open can switch to the system browser; `appId` and `appSecret` can also come from environment variables.
- Single-user private chat: only `access.owner` is served and group messages are always rejected; button clicks (question / approval / retry / confirm) re-check who tapped.

**Sessions**

- One current session plus any number of acquired sessions: ordinary messages continue the current session, while background sessions post their output, questions, and approvals back to QQ. A non-current reply starts with a `> #short-id · title` line and ends with Reply and Resume (plus Stop while generating, and Archive when archiving is available).
- `/sessions` groups sessions by workspace and includes cold sessions not yet opened after a restart (the roster keeps the latest 20 in `model-prefs.json`); 10 rows per page, with Reply / Stop / Archive on the row itself; sessions are addressed by 8-character short id or unique prefix, and archiving or unarchiving takes at most 10 at a time.
- `/to` messages any session and reopens one that is not open yet; an archived session is not reopened — it answers "archived" with an unarchive entry. `/stop` stops the current session, a named one, or all of them; `/steer` changes a queued prompt into steering.
- Quoted messages follow `/new` and `/to`: the quoted content uses the same format as ordinary messages, is placed ahead of the command text, and is submitted as one user message; with a quote `/new` opens the session immediately and a quote alone is enough; `/to` leaves the quote out while the target is awaiting an answer (that text is the answer); when the quote cannot be resolved nothing happens and neither session nor pointer moves.
- While a session is generating, a further prompt follows the host's `ui-conversation.busyEnter`: by default it queues until the turn ends (receipt `✅ Queued`, with a steer action), and when the host steers it is consumed at the next step (receipt `✅ Steered`).
- `/clear` (alias `/reset`) and `/clear all` send a 5-minute confirmation card first, and drop the action if the card cannot be sent; `/new` clears the pointer, does not stop the old session, and opens the new one in place by default.
- Archiving changes the host's archive state only and never deletes records; archiving the current session clears the pointer so the next message lands in a new session; the archive view groups by workspace.

**Workspaces and worktrees**

- A workspace follows its session and the plugin has no `cwd`; `/new --dir` decides where the next message lands, matching workspace title → directory name → absolute path, and the short flags `-d` / `-w` / `-b` combine.
- `/new --worktree` makes the first message create a worktree from the current directory's HEAD (branch `dsh-<short session id>`); a failure keeps the intent so resending retries, and archiving cleans up a clean worktree while keeping its branch.
- Run directory and workspace stay separate: a runtime `cd` only changes the run directory, while grouping, the `/status` workspace line, and the next `/new` target still read the session's `header.cwd` from creation.

**Models and permissions**

- `/model` and `/reasoning` write into the session when one is active (taking effect next turn) and also write the deployment default, while no session writes only the default; `/preset` affects new sessions only; `/permission` takes effect immediately in an active session. Inspection views show the current value with `✅`.
- `/goal` forwards the host's long-term goal command (set / show / edit / pause / resume / clear); `/compact` is decided by the host's compaction lock, so running sessions can be compacted too; `/cost` and `/status` report token usage and session state.

**Rich media and files**

- Inbound images and videos are downloaded per `media` and handed to tools for analysis; the cache lives in `~/.dsh-qqterm/media` and is cleaned up by TTL.
- Images in assistant messages are sent as QQ images at their position; deliverables declared via `present` are sent at the end of the turn (enabled by default, at most 4 per turn).
- `/get` sends a regular file from any path (directories are rejected) and `/ls` browses and picks inside the workspace; local file links in assistant text are rewritten to `/get` so opening one sends the file; both go only to `access.owner`.

**Questions and approvals**

- `ask_user_question` renders inline buttons for single choice and numbered replies for multi-select, advancing one question at a time with a per-question timeout; `approval/request` confirms with Allow / Deny buttons; both fall back to plain text when the buttons cannot be sent.
- A failed turn asks with a "Resend / Give up" card by default, and `/retry` resends the previous user message once the card expires.

**Command panel and plugins**

- The command panel and the six-entry custom menu (session status, session list, reset session, compact session, permission preset, reasoning effort) sync once the bot is ready, skipping identical content; the long-term goal takes no menu slot, and `/goal` itself is unchanged.
- `/plugins` lists, installs, and updates plugins, `check` queries updatable items immediately, and `reload` applies on-disk changes; an automatic check runs 2 minutes after startup and every 6 hours after that.

**Message delivery**

- Outbound messages share one send path: split (code-block and table aware) → enqueue → halve and re-split when too long → retry → sign.
- One quote-block format: ordinary messages and quoted commands share one assembler, `[Current message]` marks where the body starts, quoted bodies are cut at 2000 characters with a trailing `…`, and a line equal to an envelope marker gets a backslash so it cannot forge a boundary.
- A message that only replies with an image or file and no text is no longer dropped as empty: the quote is resolved first, and a quote alone is delivered. Inline command tags stay within the platform's 100-character attribute limit, cuts never land inside a tag, and an unclosed tag degrades to a copyable command line; the over-long notice appears only after halving reaches its floor, the risk-control block has its own notice, and both state only the facts without assuming a fallback channel.

### Known limitations

- Only QQ private chat (C2C) is supported; group messages are rejected at the ingress layer.
- Only one user, `access.owner`, is served; an empty allow-list rejects every private chat.
- Host dsh 0.2.2-rc.1 and 0.2.2-rc.3 are verified (see `dsh.compatibility` in `package.json`); after a major host upgrade the settings section and QR binding need re-verification.
- If any required service in `inject` is missing, the plugin stays inactive rather than degrading.
- A missing optional service only narrows the capability surface: without `agentPresets` `/preset` is not registered; without `webServer` the in-app binding page is not registered and scanning uses the terminal or browser; without `workspaceRegistry` there are no archive entries, `/new --dir` accepts absolute paths only, and group headers show paths only; without `worktrees` `--worktree` is treated as an unknown argument; without `sessionController` `/sessions` sorting falls back to creation time.
- The main profile should install a published release or a frozen tgz snapshot, never a directory that keeps rebuilding.
