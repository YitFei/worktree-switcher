# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-05

The first public release. Windows only, Node 22+.

### Added
- `wts switch`, `restart`, `stop`, `status`, `logs`, `lock` / `unlock`: decide which git worktree
  serves a repo's fixed dev ports.
- **Run mode**: stops the previous worktree's process trees and starts this worktree's services
  through a detached runner that writes per-service logs. It waits until the ports listen.
- **Proxy mode**: a TCP forwarder holds the fixed ports and forwards them to the selected
  worktree's own servers. Each worktree gets a stable assigned port per service (`wts port`). A
  502 page names the server to start when one is missing.
- **Process attribution**: by recorded process tree plus creation time, by exe path or command
  line, or by current directory. Processes that cannot be attributed are reported and never
  killed. Servers left over from removed worktrees are recognised.
- `wts watch`:
  - a floating button that never takes focus, with a menu grouped by project (route lines
    coloured by health, aligned port columns), ↻ restart, and a Manual / Auto toggle;
  - Auto follows the workspace selected in Orca or set with `wts focus`;
  - "Show all projects" and Auto are remembered;
  - `--ui tray|none` for a tray icon or no UI.
- MCP server `worktree-switcher` (`wts mcp`) with `wts_status`, `wts_switch`, `wts_restart`,
  `wts_stop`, `wts_logs`, `wts_port`, `wts_init`, and instructions for each mode.
- Claude Code PreToolUse hook (`wts hook`). It blocks dev-server commands in run-mode worktrees
  and any `wts --force`.
- `wts init`: detects Vite, Next.js, Create React App, plain Node and .NET services and proposes a `wts.json`.
- `wts setup`: registers the MCP server and the hook in Claude Code (with `--uninstall`,
  `--dry-run`, `--no-mcp`, `--no-hook`) and prints the Codex snippet.
- A demo in `examples/demo`: a Node.js frontend and a Node.js backend, with no dependencies.

[Unreleased]: https://github.com/YitFei/worktree-switcher/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YitFei/worktree-switcher/releases/tag/v0.1.0
