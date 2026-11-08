# Changelog

> [简体中文](./CHANGELOG.md)

This file records product-level changes to QQ SuperTerm, focusing on user-visible behaviour.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
