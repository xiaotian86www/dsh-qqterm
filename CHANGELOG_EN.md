# Changelog

> [简体中文](./CHANGELOG.md)

This file records product-level changes to QQ SuperTerm, focusing on user-visible behaviour.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **`/plugins`**: list, install, and update plugins from QQ, and take over the former `/bot-reload`: `/plugins reload` applies on-disk plugin changes. Registry packages take effect immediately (the host reconciles the profile, so no reload is needed); when build scripts are blocked the result offers a "continue" button, and a failed upgrade restores the previous version. Local tgz snapshots still use `pnpm dev:reload` + `/plugins reload`.
- **Background update check**: the registry is queried 2 minutes after startup and then every 6 hours; results are cached only, and `/plugins` marks rows with a newer version as `→ new version` — nothing is pushed and nothing installs itself.

### Changed

- **Reply entry points for other sessions moved to their own link row**: `回复` / `恢复` stay inline command links, but a blank line after the body puts them on their own line in a fixed position instead of trailing the last paragraph; labels are just two characters, and the source line still opens on its own line without an icon, so the footer stays quiet. Questions from other sessions without option buttons offer reply / resume links on the guidance line.
- **`/sessions` order matches the Web sidebar**: within a workspace, sessions are now sorted by the time of the latest human message (ties by session id) instead of creation time; the row time now shows that same activity time rather than the creation time; pinned sessions still lead and the workspace order is unchanged.
- **`/bot-reload` folded into `/plugins reload`**: hot reload is now a subcommand instead of a standalone command, so the help list and command panel have one fewer entry; `/bot-reload` is no longer answered.

- **Consolidated GUI entry**: binding, credential replacement, unbinding, and config editing now live only in the "QQ SuperTerm" settings section. The sidebar binding page, sidebar main panel, and plugin-detail entry are gone, and an unbound instance no longer opens a page automatically.
- **Defaults can change without a session**: switching `/model`, `/reasoning`, or `/permission` with no session now writes the deployment default, which new sessions pick up; the confirmation text matches the with-session case.

### Removed

- **`vision.timeoutMs`**: nothing ever read it — vision calls are only bounded by the host `exec.signal`; the config, its README row, and the test fixture are gone.
- **`debug` in the settings whitelist**: the panel never exposed the switch, so the whitelist entry only allowed a value that could not be set; `debug` stays configurable from the profile.
- **`processingTimeoutMs`**: the guard only covered the message hand-off, so the timeout neither aborted generation nor unblocked a stuck session; the config and the guard option are gone, and stale values in a profile or environment are ignored and can be deleted.
- **Extra private-chat system prompt**: removed the `directPrompt` config, its settings entry, and the per-turn injection; stale values left in a profile no longer take effect and can be deleted.
- **`sendFile.restrictPaths`**: there is no reason to turn the allowlist off, and turning it off let `qqbot_send_file` read any path; the switch is gone and the allowlist is always on, so a stale `false` in a profile is ignored.

### Fixed

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
