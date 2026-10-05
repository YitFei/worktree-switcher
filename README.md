# wts — worktree dev-server switcher

Every git worktree of a repo uses the same fixed dev ports, so only one can run at a time.
`wts switch` makes the current worktree the one that runs: it stops the services of whichever
worktree holds the ports, starts the services from here in the background, and waits until
they listen. Windows only (MVP).

## Install

```sh
npm install && npm run build && npm link
```

## Config — `wts.json` at the worktree root

```json
{
  "readyTimeoutSec": 180,
  "services": {
    "backend":  { "dir": "backend",  "port": 5241, "cmd": "dotnet run --project InsightHub.API --launch-profile http" },
    "frontend": { "dir": "frontend", "port": 5173, "cmd": "npm run dev -- --strictPort" }
  }
}
```

`dir` is relative to the worktree root (default `.`). Use `--strictPort` (Vite) or the
equivalent so a busy port fails instead of silently moving.

## Commands

| Command | |
|---|---|
| `wts status` | Owner of each configured port: worktree, pid, started by wts or not, lock |
| `wts switch [--force]` | Stop the current owner, start this worktree's services, wait until ready |
| `wts stop [--force]` | Stop services that belong to worktrees of this repo |
| `wts logs [service] [-n 50] [-f]` | Show / follow service logs |
| `wts lock [--note "..."]` / `wts unlock` | Block other worktrees (agents) from `switch`/`stop` |
| `wts watch [--orca] [--delay 3] [--ui float\|tray\|none]` | Follow the worktree you are looking at and switch to it (see below) |
| `wts focus [path]` | Tell a running `wts watch` which worktree you are on (for editor integrations) |
| `wts mcp` | MCP server for coding agents (see below) |

`--force` only overrides another worktree's lock. Exit codes: `0` ok, `1` failure, `2` refused.

## Auto-switch: `wts watch`

`wts watch` switches the dev servers to the worktree you are looking at, once you stay on it for
`--delay` seconds (default 3). Worktrees without `wts.json` are ignored; locks are respected.

Focus sources:
- `wts focus <path>` — generic; a VS Code extension or any script can call it.
- `--orca` — the workspace selected in Orca, read from Orca's local state DB
  (`%APPDATA%\orca\profiles\local-default\profile-state.db`). This is Orca's internal format,
  not a public API, and may break with an Orca update.

Floating button (Windows, default `--ui float`): a small always-on-top pill, `● demo1 🔒`.
Dot colour: green = running, yellow = switching, red = port held by another program or error,
gray = stopped. Hover shows the full status; click opens the menu (the repo's worktrees — click
to switch —, Lock/Unlock, Stop, Exit). Drag it anywhere; the position is remembered
(`~/.wts/float-pos.json`). It never takes keyboard focus. `--ui tray` shows a tray icon with the
same menu instead; `--ui none` shows nothing.

## Agents: `wts mcp`

`wts mcp` is an MCP server (stdio) for coding agents. The agent's CLI starts it in the agent's
worktree; the agent sees the tools and the usage rules (server instructions: never start dev
servers yourself, use `wts_switch`, stop and tell the user when refused).

| Tool | |
|---|---|
| `wts_status` | Who runs each port, whether it is the agent's worktree, the lock |
| `wts_switch` | Run the dev servers from the agent's worktree; waits until ready |
| `wts_logs` | Last lines of the service logs |
| `wts_stop` | Stop the repo's dev servers |

No tool can override a lock: `wts lock` while you test, and agents get `refused` instead of
switching your page away. In a repo without `wts.json` the tools answer "not configured", so the
server can be registered for all projects.

Register (Windows: call node with the absolute path to `dist/src/cli.js`, not the `wts.cmd` shim):

```sh
claude mcp add --scope user wts -- node C:\path\to\wts\dist\src\cli.js mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.wts]
command = "node"
args = ["C:/path/to/wts/dist/src/cli.js", "mcp"]
```

`wts_switch` waits up to `readyTimeoutSec` (e.g. 180 s for a .NET backend); raise the client's
tool timeout if needed (Claude Code: `MCP_TOOL_TIMEOUT` in ms).

## Safety rules

- A process on a port is only stopped if it can be tied to a worktree of this repo: either it
  was started by wts (process tree + creation time recorded), or its own exe path / command
  line contains a worktree path. Anything else is reported and left running.
- Docker and other shared infrastructure are never touched.
- State, lock and logs live in `<git-common-dir>/wts/`, shared by all worktrees of the repo.
