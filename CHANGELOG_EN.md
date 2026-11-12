# Changelog

> [简体中文](./CHANGELOG.md)

This file records product-level changes to QQ SuperTerm, focusing on user-visible behaviour.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **`/plugins`**: list, install, and update plugins from QQ, and take over the former `/bot-reload`: `/plugins reload` applies on-disk plugin changes. Registry packages take effect immediately (the host reconciles the profile, so no reload is needed); when build scripts are blocked the result offers a "continue" button, and a failed upgrade restores the previous version. Local tgz snapshots still use `pnpm dev:reload` + `/plugins reload`.
- **Background update check**: the registry is queried 2 minutes after startup and then every 6 hours; results are cached only, and `/plugins` marks rows with a newer version as `→ new version` — nothing is pushed and nothing installs itself.
- **Assistant image forwarding**: image content blocks in assistant messages are now sent to QQ as images (after the text) instead of staying in the model context only.
- **`/get` and local file links**: `/get <path>` sends a file from this machine into the chat (images, videos, and voice use their own channel, any path allowed); local file links in assistant text are rewritten to `/get <absolute path>` command links before sending, so one click delivers the file. Links inside fenced or inline code are left alone, only existing regular files are rewritten, and relative paths resolve against the session's working directory.

### Changed

- **`/bot-help` renamed to `/help`**: back to the prefixless form, and the unknown-command hint points at `/help`; the command panel and help listing pick it up automatically.
- **File sending no longer restricts directories**: `/get` and `present` deliverables can send files from any path, as long as they exist and are regular files; `sendFile.extraRoots` is removed with the allowlist. The plugin serves only the single bound `access.owner`, so files can only go back to that user's private chat — the allowlist blocked no outside access, it only kept the QQ side from reaching files outside the workspace.
- **`/compact` no longer goes through the Web plugins**: both the availability check and the execution use the host command registry (`find` tells whether the preset mounted the compaction group, `execute` forwards the host `/compact`, which resolves its engine inside the preset's own scope), so the plugin no longer touches the preset service; a preset without the compaction group is still refused locally.
- **Chat working directory is persisted**: the in-memory variable is still the single source of truth, and the current directory is also written to `dirs` in `model-prefs.json`; on startup the saved value is loaded first (falling back to the host default workspace only when that directory is gone). New chats start in the host's default workspace; switching / resuming sessions, `/new <workspace|path>`, and a runtime `cd` all override it, and `/status` plus `/sessions` grouping follow along.

- **Reply entry points for other sessions moved to their own link row**: `回复` / `恢复` stay inline command links, but a blank line after the body puts them on their own line in a fixed position instead of trailing the last paragraph; labels are just two characters, and the source line still opens on its own line without an icon, so the footer stays quiet. Questions from other sessions without option buttons offer reply / resume links on the guidance line.
- **`/sessions` order matches the Web sidebar**: within a workspace, sessions are now sorted by the time of the latest human message (ties by session id) instead of creation time; the row time now shows that same activity time rather than the creation time; pinned sessions still lead and the workspace order is unchanged.
- **`/bot-reload` folded into `/plugins reload`**: hot reload is now a subcommand instead of a standalone command, so the help list and command panel have one fewer entry; `/bot-reload` is no longer answered.

- **Consolidated GUI entry**: binding, credential replacement, unbinding, and config editing now live only in the "QQ SuperTerm" settings section. The sidebar binding page, sidebar main panel, and plugin-detail entry are gone, and an unbound instance no longer opens a page automatically.
- **Defaults can change without a session**: switching `/model`, `/reasoning`, or `/permission` with no session now writes the deployment default, which new sessions pick up; the confirmation text matches the with-session case.

### Removed

- **`/bot-ping`, `/bot-version`, `/bot-me`, `/bot-status`**: four `bot-`-prefixed utility commands are gone, so no `bot-` names remain in the command table; `/bot-status`'s "last reload / last plugin operation" lines moved into `/status`, its other fields already duplicated `/status`, and the OpenID is visible after QR binding and in settings.
- **`/bot-sync` (alias `/bot-refresh`)**: the command panel and custom menu sync automatically when the bot is ready and their contents are fixed in code, so no command needs to trigger them; the menu sync now replaces the whole menu and keeps no buttons beyond this plugin's own entries.
- **`qqbot_send_file` and `qqbot_describe_image`**: both tools are no longer registered, and the `vision` config (enabled / provider / model / defaultPrompt / maxBytes / maxTokens) is gone; the README follows. Stale `vision` entries in a profile are ignored and can be deleted. Deliverables still go through `present`, and inbound images are still downloaded locally for the model to analyse.
- **`vision.timeoutMs`**: nothing ever read it — vision calls are only bounded by the host `exec.signal`; the config, its README row, and the test fixture are gone.
- **`debug` in the settings whitelist**: the panel never exposed the switch, so the whitelist entry only allowed a value that could not be set; `debug` stays configurable from the profile.
- **`processingTimeoutMs`**: the guard only covered the message hand-off, so the timeout neither aborted generation nor unblocked a stuck session; the config and the guard option are gone, and stale values in a profile or environment are ignored and can be deleted.
- **Extra private-chat system prompt**: removed the `directPrompt` config, its settings entry, and the per-turn injection; stale values left in a profile no longer take effect and can be deleted.
- **`sendFile.restrictPaths`**: there is no reason to turn the allowlist off, and turning it off let `qqbot_send_file` read any path; the switch is gone and the allowlist is always on, so a stale `false` in a profile is ignored.

### Fixed

- **Media sends lost their file argument**: the passive-reply decorator also wrapped `sendMedia`, but the SDK's `sendImage` / `sendVideo` / `sendFile` all delegate to `this.sendMedia`, so the first argument was re-resolved as a target and the source was dropped, surfacing as `uploadMedia: one of url/fileData/buffer/localPath is required`. `/get`, `present` deliverables and assistant image forwarding were all affected; credentials are now resolved in one place (`sendMedia`, whose target lives inside the options object); the convenience methods no longer resolve on their own, so one send records one usage.
- **`/status` shows model / reasoning effort / preset / permission without a session**: it reports the deployment defaults that a new session will use, without labelling them as defaults, and now includes the permission preset too. Message count, context, and tokens still appear only once a session exists.
- **`/permission` lists only deployment defaults without a session**: the list now comes from the host's `defaultOptions`, so session-only values such as `auto` no longer appear, and anything outside the list is rejected as an unknown preset. Storing `auto` as the deployment default used to make the host unable to read the default preset — the `/status` permission row disappeared and new sessions failed afterwards. The permission row is always kept (`—` when unreadable), and a corrupted default is restored to a configured preset.
- **Old media files no longer pile up when rich-media download is off**: expiry cleanup is decoupled from the download switch, so `media.enabled: false` still cleans `~/.dsh-qqterm/media` per `media.ttlHours`.
- **`askTimeoutMs: 0` no longer means "reject immediately"**: it now matches the other timeout settings, where 0 disables the timeout.

### Fixed

- **Session names in `/sessions all`**: only the first 10 sessions of each workspace had their titles read, so sessions further down (for example on page 4) showed "未命名会话"; titles are now read for the current page only, and `/sessions archived`, the archive picker, and `/to` are fixed the same way.

## [0.0.1] - 2026-11-08

### Added

- **First release**: DeepSeek Harness inside a QQ private chat. A message is one turn; slash commands cover sessions, models, reasoning effort, permission presets, directory browsing, and cost.
- **QR binding**: desktop and web finish binding by scanning in the settings page, with credentials written to the profile automatically; environments without the in-app page can use the terminal QR code or the browser fallback.
- **Multiple sessions**: one current session plus any number of acquired sessions. `/sessions` groups them by workspace, `/to` messages any of them, and background sessions keep posting output, questions, and approvals back to QQ.
- **Workspaces and titles**: the workspace follows the session, `/new <workspace|path>` switches directory in one step, and workspace titles come from directory names.
- **Rich media and attachments**: downloaded images and videos can be analysed by the vision tool, and `qqbot_send_file` plus deliverable sending honour a path allowlist.
- **Questions and approvals**: `ask_user_question` renders inline buttons, `approval/request` uses allow/deny buttons, and both fall back to text when the keyboard cannot be sent.
- **Command panel and custom menu**: synced automatically when the bot is ready, with `/bot-sync` to re-push on demand.
- **Panels and entries**: a "QQ SuperTerm" settings section, a sidebar binding page, and a sidebar main panel — binding, credential replacement, unbinding, and config editing all work from the GUI.
- **Single-user private chat**: only the bound user is served; group chats are unsupported. `/bot-me` shows your OpenID.

### Known limitations

- No group chat for now.
- When any service in `inject` is missing, the plugin stays inactive instead of degrading.
