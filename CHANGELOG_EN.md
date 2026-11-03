# Changelog

> [简体中文](./CHANGELOG.md)

This file records significant dsh-qqbot updates from a product perspective, focusing on user-visible changes.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Fixed

- **`ask_user_question` prompts were not pushed to QQ**: the question channel wrapped `userQuestions.ask` once during plugin apply — when the service had not activated yet (or mounted later), installation was silently skipped and never retried, so the channel worked only intermittently and prompts fell through to the Web client. It now listens on the official `user-questions/request` waterfall (the same seam the approval channel uses, with no service probing) and claims requests before the Web answerer; only a failed QQ delivery falls back to the host answerer, so a delivered question is never shown twice.

- **Option buttons never appeared in private chats, leaving number replies as the only way to answer**: the keyboard carried `group_id`, which the QQ v2 message API rejects in c2c with `40011021 请求参数 rows.buttons.group_id 无效`; the whole button message was refused and the channel fell back to plain text. Neither the question nor the approval keyboard sends that field any more — exclusivity is enforced by the state machine anyway (the first answer settles, later clicks are ignored) — so c2c now shows clickable options and the allow/deny approval buttons.

- **Session-open failures now reach stderr**: the host logger is not visible in a headless profile, so the user only saw "processing failed" with no way to diagnose it, for example a `SessionAlreadyOwnedError` from a session another process holds; the keyboard fallback logs its original error the same way.

### Added

- **New `/sessions` session-management command**: list the agent workspace's sessions (same source as the Web sidebar, so sessions created in the Web UI are visible too), resume the current chat into a session by index or id prefix, and archive or restore one.
- **`/sessions archive` / `/sessions unarchive` / `/sessions archived`**: archiving goes through the host `workspaceRegistry.archiveSession` — the session leaves this list and the Web sidebar, the on-disk log is kept, and it can be restored at any time. Archiving first disposes the session's agent in this process and repoints the chat to a new session, because the host rejects every step of an archived session. Restoring a session by index or id prefix reopens it; resuming an archived session unarchives it on the way. Both directions accept comma-separated target lists (up to 10 per command) and run each target independently, so one failure does not abort the rest. Private chat + allowlist only.
- **`/sessions all`**: list every session grouped by the host's workspace (pinned first inside a group, then accounting order) so cross-project sessions can be found without changing directory; group headers carry the path and flag a missing directory with ⚠️.
- **New `/workspace`, and `/new` can take a workspace directly**: `/workspace` shows the current workspace, and `/new <workspace|path>` starts a new session in another workspace in one step (equivalent to `/new` followed by `/workspace`). A session's `cwd` is written into its header at creation and the host exposes no API to change it, so switching only takes effect before a session is persisted; once a session exists `/workspace` refuses and points at `/new <workspace>`. Targets are matched by workspace title, directory name (case-insensitive, unique prefix), or absolute path; `/new <path>` validates the target *before* touching the session, so a typo never costs the current one. Private chat + allowlist only — a plain `/new` stays unrestricted.

### Changed

- **`/sessions` lists now show a short id, and an index only belongs to the current page**: previously the list showed no id while every usage asked for `<index|id>`, so the only way to act was clicking a button — and `/sessions all` numbered rows per group, which cannot match the command's resolution order (typing "1" on that page archived row 1 of the current workspace instead). Every row now shows an 8-char short id (`#3f2a9b1c`, the `#` is optional, and an all-digit short id is no longer mistaken for an index), so any view can be acted on by typing; indexes only mean rows of the `/sessions` page, and `/sessions all` / `/sessions archived` no longer show them. Buttons fill the short id instead of a 44-character uuid.
- **Leaner list output**: the footer shrank from 3 lines to 1, an unknown subcommand or a missing argument answers with a single line instead of a 7-line usage block, and the heading states "newest first" because the host header stores no last-used time; `/sessions` and `/sessions archived` can be paged (`/sessions 2`), so sessions past the tenth are no longer counted-but-unreachable.
- **Fixed titles and grouping in `/sessions all`**: titles used to be read for the newest 10 sessions globally, so with several workspaces the later groups all showed "untitled session"; titles are now read for the rows that will actually be displayed (up to 10 per group, capped at 40 overall). A workspace whose sessions are all archived no longer disappears from the page.
- **Removed the physical session deletion**: `/sessions delete` is gone, along with the disk-layout scanning it needed. The host has no deletion API, so deleting meant removing the JSONL session directory by hand — irreversible and easily blocked by file locks on Windows. Archiving covers the "get it out of my list" need and is reversible.
- **Removed the `cwd` config; the workspace now follows the session**: the plugin no longer pins an agent working directory. New sessions land in the host's default workspace (falling back to the dsh launch directory), `/sessions resume` moves the chat into the target session's directory, a later `/new` and a restart stay in the same workspace, and the `/sessions` scope follows the current workspace. The file-send allowlist now roots at the session's working directory.
- **Workspace titles now come from directory names**: the plugin no longer names workspaces `QQBot`; the host derives the title from the last path segment, and legacy `QQBot` titles are migrated on the next attach (titles the user changed are left alone).

## [0.5.5] - 2026-10-30

### Fixed

- **Fixed the broken QR code in the in-app binding flow**: qrcode is now loaded via `createRequire`, bypassing the missing-API issue caused by the host's ESM interop. When the QR cannot be produced, the page falls back to a notice offering to restart the app, open the link in a browser, or enter credentials manually.

## [0.5.4] - 2026-10-28

### New Features

- **New `/bot-me` command**: shows the sender's OpenIDs (user openid in DMs; group-member openid and group openid in groups) as a self-service entry for allowlist onboarding — users hand the IDs to an admin to be added to the lists.
- **Admin command authorization**: `/preset` and `/model` work in both DMs and groups, but only allowlisted users may switch the preset or model (a group switch affects that group's session); each command's DM/group availability is shown in `/bot-help`. (#5)

### ⚠️ Behavior Changes (secure defaults)

- **Access control tightened by default**: DMs default to allowlist with an empty list rejecting everyone (previously empty lists silently allowed everyone); groups default to open (guarded by group membership and the @-mention gate). On QR binding, DMs switch to allowlist with the list reset to the scanning user (rebinding swaps the owner) — binding grants access.
- **Isolated default workspace**: the agent working directory now defaults to `~/.dsh-qqbot/workspace` instead of following the DSH process directory; set `cwd` explicitly to override.
- **Approval buttons check permissions**: in allowlist mode, approval buttons only take effect for allowlisted users — clicks by non-authorized members and forwarded DM cards clicked by others are ignored.

### Fixed

- **Saving configuration no longer clobbers other plugins**: binding, saving settings, and unbinding only touch this plugin's own entry; other plugins' content and comments are preserved. (#53)
- **Long prompts can be saved**: the settings-save request body limit is raised from 4KB to 512KB. (#69)
- **Vision-path hazard fixed**: the `qqbot_describe_image` message source now uses the current session format, so future image injection into the main conversation will not fail. (#77)
- **Hardened session ids**: unified `session-` prefix (#81) — community plugins no longer misjudge QQ sessions, multi-process concurrency produces no duplicate ids, and existing sessions keep their original ids.
- **Fixed model switching**: both the `/model` crash and the "history failed to load" error after restarting post-switch are fixed, with conversation history fully preserved.
- **Fixed session-event reads**: `/tokens` showing 0, `/export` producing empty output, and approval buttons not echoing the gated command — all fixed.
- **Fixed compaction**: `/compact` wrongly reporting the service as unavailable or "no active session" — fixed; in the latter case the session is revived from disk before compacting.
- **Fixed config save failure with link installs**: saving from the settings UI kept reporting "profile directory not found" when installed via `dsh plugin add link:` — fixed. With multiple profiles sharing the same source, writes target the profile of the current process. Remaining failures point at manually editing `cordis.patch.yml`. (#78)
- **Fixed allowlist default bypass**: omitting `access` entirely still fell back to open DMs (the outer schema default was not updated with the field defaults) — now aligned to allowlist and pinned by tests. (#94)
- **Approval cards bound to their request and hardened**: buttons now carry the pending approval's unique nonce, so stale cards no longer settle; in allowlist mode a missing clicker identity is rejected too. (#94)
- **File-send path allowlist resolves symlinks**: paths are judged by their real locations; a symlink inside an allowed root pointing outside is rejected. (#94)
- **Image attachments named by their real format**: the QQ gateway labels all images `image/png` (most are actually GIF/JPEG), so saved files carried wrong extensions and extension-based image decoding failed; extensions are now corrected from the file header (magic bytes) — bytes unchanged, no transcoding, unknown formats keep the original behavior. (#76)
- **Unified workspace path resolution**: introduced a single source of truth for the plugin data directory (`~/.dsh-qqbot`), from which the workspace, media, and model-preference paths are uniformly derived; without an explicit `cwd` the host process directory is no longer wrongly used (previously causing workspace file sends to be denied). Missing files now report "file not found" instead of a misleading path denial.
- **Vision config auto-patch no longer clobbers settings.yaml**: the startup fix-up that declares `input` for the vision model now uses fidelity-preserving document editing (comments, anchors, and other settings kept as-is) with atomic writes and conflict-aware retry; the previous full re-serialization wiped all comments and formatting from the file.
- **Concurrent-safe preference file**: `model-prefs.json` (the session-id mapping shared by multi-bot and multi-profile setups) now writes atomically and merges other writers' entries before overwriting, so coexisting bots/profiles no longer clobber each other's mappings; deletions carry tombstones so concurrent writes cannot resurrect them; load/write failures surface as visible warnings (previously debug-only or silent — a lost mapping showed up as "lost context in QQ" with nothing to trace).
- **Fixed an unopenable session list**: when resuming a session fails, a new one is created only after confirming the session is genuinely absent on disk; corrupt logs and backend failures no longer recreate the same session id (which used to write one id into several directories, after which the host refused to load the whole session list). Such failures now fail loudly with a log entry, and the original history is still there once the fault clears.
- **Fixed concurrent messages landing on the wrong session**: the legacy session id derived from the user identity is now only used to migrate existing sessions, never to create new ones; concurrent requests for the same session (a slash command arriving alongside a normal message) are coalesced into one resume/create, so two mutually overwriting, never-reclaimed session instances are no longer produced.
- **Vision config patch keeps numeric precision**: integers are preserved verbatim when the `input` declaration is added, so large integers in the user's `settings.yaml` (install ids, timestamps) are no longer truncated.

### Internal

- Added a host-API adapter layer that uniformly supports both old and new host interface shapes.

## [0.5.3] - 2026-10-27

### Added

- **Streaming replies**: replies stream to QQ in segments while the model generates, and an automatic LLM retry rewrites the same streamed message instead of appending a duplicate. Streaming had never actually worked; it does now.
- **Delivered files reach the chat**: files the model declares as deliverables are automatically sent to the current QQ conversation right after the turn's reply, with a text notice when a file cannot be sent; can be disabled or capped in configuration.

### Fixed

- **Action confirmation restored**: confirmation requests never arrived — sensitive operations kept failing with "no approval channel is available". Fixed. (#51, thanks to [@IrisuM](https://github.com/IrisuM))
- **Settings panel input and copy**: allowlist textareas accept newlines, normalized on save; option labels such as open/disabled read more plainly.

### Metadata

- **Plugin metadata completed**: ships a plugin icon and a bilingual description; the plugin list shows “QQ 机器人 (dsh-qqbot)” / “QQ Bot (dsh-qqbot)” by interface language.
- **Entries and icon**: the sidebar and the plugin detail page gain management-panel entries; the settings panel icon becomes a vector logo.

### Documentation

- README: Desktop installation instructions — add from the Plugins page, connect by scanning in Settings, no command line involved.

## [0.5.2] - 2026-10-12

### Fixed

- **Fixed clean installs failing to activate**: 0.5.1 shipped with the old SDK range (`^1.0.4`), so clean installs resolved 1.0.4 and the disconnect logging feature crashed at startup (`TypeError`), failing plugin activation. The range is now `^1.0.5`.
- **Graceful degradation on stale SDKs**: environments that still carry an older SDK now skip the disconnect listener with an upgrade hint instead of failing activation.

## [0.5.1] - 2026-10-12

### Added

- **In-app QR binding**: bind your bot entirely from the DSH Desktop / Web settings page — scan with your phone's QQ or enter the AppID / AppSecret manually, with live binding status; the sidebar opens a guided page automatically while unbound. Credential rotation and unbinding are one click away.
- **In-app config panel**: no more hand-editing files — c2c/group access control (open, allowlist, disabled), mention-required in groups, streaming, tool-result display, model overrides and extra prompts, all applied automatically on save.

### Improved

- **Upgraded the QQ Bot SDK to 1.0.5**: disconnects are now logged with the reason and whether the bot will recover on its own, and a connection that can never be established fails fast with a clear reason instead of waiting forever.

## [0.5.0] - 2026-09-08

### Added

- **Image understanding**: send images to the bot and it will automatically understand their content (screenshots, photos, charts, etc.), and can analyze them together with text instructions.
- **File sending**: the bot can send local files (documents, images, etc.) directly to you, no longer limited to plain-text replies.
- **Proactive questions**: when the bot encounters uncertain information, it proactively asks you questions, letting you pick an answer with a single tap for smoother interaction.
- **Action confirmation**: before performing sensitive or critical operations, the bot requests confirmation, which you approve or block via "Allow/Deny" buttons.
- **Session compaction**: new `/compact` command to compress the current session history in one step, preserving context while freeing space — ideal for very long conversations.
- **Preset switching**: new `/preset` command to view or switch the bot's persona/behavior preset.
- **Network latency test**: upgraded `/bot-ping` to return network transport time and plugin processing time, making it easier to diagnose connection latency.

### Improved

- Long-task execution timeout extended to 30 minutes, so complex tasks are no longer interrupted mid-way.
- Direct and group chats now receive more context-appropriate system prompts.
- Failed proactive message pushes automatically fall back to passive replies, reducing "the bot didn't respond" situations.
- Media files such as images are automatically cleaned up after use, avoiding long-term disk usage.

### Fixed

- Fixed the `/stop` command not actually aborting in-progress generation (it was previously a no-op).
- Fixed the registration order of the approval channel, ensuring confirmation requests are captured and handled correctly.

### Documentation

- README updated with the new `/preset` and `/compact` commands, plus QR-code upgrade guidance.

## [0.4.0] - 2026-08-16

### Added

- **QR link**: when the QR code renders incorrectly, you can click the link printed in the terminal to complete scanning in a browser.

### Improved

- Supports auto-saving QR credentials on Windows (previously failed due to path issues).
- When auto-saving credentials fails, it now clearly guides manual configuration instead of silently dropping existing config.

### Documentation

- Added QR-code screenshots and upgrade guidance.

## [0.3.0] - 2026-08-15

### Added

- **File understanding**: send a file to the bot and it will automatically download and understand its contents, supporting extract, read, analyze, and more.
- **Streaming replies**: replies are displayed incrementally in real time, no need to wait for full generation — a smoother, more natural experience.
- **Visible progress**: when the bot runs tasks (running commands, reading/writing files), you can see what it is doing — no longer a "black box".
- **Error feedback**: when a task ends abnormally, the bot clearly explains the reason, no more "half replies" or "no response at all".

### Improved

- Correctly displays the speaker's nickname in group chats instead of an unreadable string.
- Automatically clears group chat history after replying to avoid cross-conversation interference.
- Voice messages are recognized and kept as text only, without extra invalid links.
- The bot now "actually gets things done": for requests like "download, extract, install", it executes real tool actions instead of just restating the steps.

### Fixed

- Fixed the bot being unable to read/write files (the working directory was misconfigured).
- Fixed duplicate content and too-few chunks in streaming replies.

## [0.1.0] - 2026-08-14

### Added

- **First release**: QQ bot integrated with an AI assistant, supporting direct and group chats.
- **Model switching**: supports switching between different AI models.
- **Common commands**: built-in help, status query, session management, and more.
- **QR binding**: bind the bot by scanning a QR code on first use, with simple setup.

### Fixed

- Fixed config parsing issues.
