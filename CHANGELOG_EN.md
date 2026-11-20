# Changelog

> [简体中文](./CHANGELOG.md)

This file records product-level changes to QQ SuperTerm. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Combined short flags**: `/new` accepts `-wb` / `-bw` for `-w -b`; the value-taking `-d` must come last (`-wbd <workspace>`). Content after `--` and quoted words are never split.
- **Session list survives a restart**: sessions you opened are also recorded in a roster (the latest 20, kept in `model-prefs.json` under `held`). After a restart `/sessions` lists them as cold rows with their title, time, and workspace, minus the running / idle status; `/sessions resume` actually opens one. Archiving and `/clear all` remove entries from the roster, and ids the host no longer has drop out on their own.
- **Reply or archive straight from the session list**: every row in `/sessions` and `/sessions all` carries a Reply (`/to #short-id `) and an Archive (`/sessions archive #short-id`) action on the same line after the resume button. The current session gets no Reply — you are already talking to it — and every other row gets one regardless of whether it has been reopened since a restart (a session that is not open is reopened first); deployments without `workspaceRegistry` get no Archive.
- **Archive straight from a background session's message**: messages pushed by non-current sessions now carry an `Archive` action after Reply / Resume, running `/sessions archive #short-id` in one tap; deployments without `workspaceRegistry` do not show the entry point.
- **`/goal` long-running goals**: forwards to the host `/goal` (create, show, edit, pause, resume, clear) with arguments passed through verbatim; success follows the host result and the reply carries the host text, with a single unsupported notice when the deployment lacks the command.

### Changed

- **`/to` reaches sessions that are not open yet**: when the target is not in memory it is reopened by id first (the same path as `/sessions resume`) and the current session stays put afterwards; a session no longer on disk answers "no such session", one held by another client answers "in use elsewhere", and an archived session is not reopened — it answers "archived" with the unarchive entry. Lists and notices no longer distinguish whether a session is open.
- **New sessions stay in place; `/new --worktree` creates a worktree on request**: `/new` no longer creates a worktree by default; with `--worktree` (`-w`) the first message creates one on a `dsh-<short session id>` branch based at the HEAD of the current directory and the session runs there. The base is no longer the repository root's HEAD but the branch the current session is on, and uncommitted changes do not travel with the worktree. The intent lives in memory per chat and is dropped by `/to`, `/sessions resume`, `/clear`, and a bare `/new`, while a failed creation keeps it so resending retries. An unreadable HEAD or a failed creation means no session that round (never a silent fallback to the repository HEAD), with the reason and a next step; non-Git directories and a read-only sandbox create the session in place (a read-only sandbox is refused right at `/new`), and deployments without the worktree service treat `--worktree` as an unknown argument. `/status` gains a worktree line (branch and tree path; the workspace line stays the main checkout); archiving removes a clean worktree and keeps its branch, while a dirty one is retained.
- **Second confirmation for reset**: while a session is live, `/reset` (alias `/clear`) and `/clear all` first send a card with "✅ Confirm / ❌ Cancel" buttons; the action runs only after the confirm button is tapped within 5 minutes. If the card cannot be sent the action is dropped rather than executed unconfirmed, and switching sessions before the tap voids the confirmation. `/new` no longer confirms and runs immediately.
- **`/compact` no longer pre-checks the busy state**: the local `agent.status !== 'idle'` gate is gone — the host's compaction lock decides, so running sessions can be compacted too. Command execution is now a reusable `runHostCommand`, ready for `/goal` and other host commands.

### Fixed

- **A late service no longer hides archiving**: optional services such as `workspaceRegistry` are read at each use site instead of being snapshotted when the plugin is constructed; when a bundle registers the service after `apply`, the `/sessions` archive entry point, `/sessions archive`, and the message quick action keep working. The old code read it once, so a miss made the whole deployment behave as if archiving were unsupported.
- **Long messages from background sessions no longer repeat or flood**: re-splitting on "too long" now slices the raw body, so the source line and the action row are attached exactly once on the first / last piece. The old code re-split already-decorated pieces, duplicating the source line and resending the same body until the message count exploded — only a dsh restart stopped it.
- **`dirs` only records where the next session starts; `cd` no longer moves the workspace**: the `/new` target, the `/sessions` grouping, and the `/status` workspace all read the session's `header.cwd`; a runtime `cd` (or a created worktree) changes only the session's working directory, so the workspace and the next `/new` target stay put while `/get` and `/ls` follow the live directory. Worktree paths from older data are normalized to the main checkout on load.
- **The `/status` workspace line no longer shows the worktree directory**: a session running in a worktree reports the main checkout (the same source `/sessions` groups by) and the worktree line carries the tree path; resuming such a session also attaches it to the session directory instead of creating a workspace named after the tree.
- **Consistent archive view and receipts**: the archive view groups by workspace, and archive / unarchive receipts put their buttons on their own block, matching the list views.

## [0.0.1] - 2026-11-14

### Added

- **DeepSeek Harness inside a QQ private chat**: a message is one turn; slash commands cover sessions, models, reasoning effort, permission presets, directory browsing, file sending, and cost.
- **QR binding**: desktop and web finish binding by scanning in the settings page, with credentials written to the profile automatically; environments without the in-app page can use the terminal QR code or the browser fallback.
- **Multiple sessions**: one current session plus any number of acquired sessions; `/sessions` groups them by workspace, `/to` messages any of them, and background sessions keep posting output, questions, and approvals back to QQ.
- **Workspaces and titles**: the workspace follows the session, `/new <workspace|path>` switches directory in one step, and titles come from directory names; titles written by `/rename` or `/sessions rename` stay fixed.
- **Models, presets, reasoning effort, and permissions**: all reuse host core behaviour; `/model`, `/reasoning`, and `/permission` act on the current session when one is live and write the deployment default otherwise, while `/preset` applies to new sessions.
- **Rich media and attachments**: downloaded images and videos can be analysed by the model; images in assistant messages and `![alt](path)` are sent at their original position; `/get` sends any regular file, `/ls` browses and sends files inside the workspace, and `present` deliverables may live anywhere.
- **Questions and approvals**: `ask_user_question` renders inline buttons, `approval/request` uses allow/deny buttons, and both fall back to text when the keyboard cannot be sent.
- **Command panel and custom menu**: synced automatically when the bot is ready, skipping identical content.
- **Plugin management**: `/plugins` lists, installs, and updates plugins, and `/plugins reload` applies on-disk changes; a background check marks newer versions in the list only.
- **Single-user private chat**: only the bound user is served, group chats are unsupported, and one settings section covers binding, credential replacement, unbinding, and config editing.

### Known limitations

- Only host dsh 0.2.2-rc.1 is verified; after a major host upgrade the settings section and QR binding need re-verification.
- Group chat is not supported.
- When any service in `inject` is missing, the plugin stays inactive instead of degrading (`agentPresets` is optional: without it `/preset` is not registered at all and new sessions mount no preset; `webServer` is optional too: without it the in-app binding page is not registered and scanning uses the terminal only; `workspaceRegistry` is optional as well: without it `/sessions` still groups by directory, group headers show paths only, pins and archive actions are unavailable, archive subcommands are treated as unknown and `/new <name>` reports unsupported while its usage page, the `/status` workspace line and the reply show paths only (absolute paths still work); the activity time used to order `/sessions` is soft-read from the optional `sessionController.list()`, falling back to creation time; without hmr `/plugins reload` is treated as an unknown subcommand too).
