# wts — worktree dev-server switcher

Every git worktree of a repo uses the same fixed dev ports (the browser, OAuth redirects and the
frontend's API proxy all point at them), so only one worktree can be "the app" at a time.
wts decides which one, in one of two modes chosen in `wts.json`:

- **run** — `wts switch` stops the worktree that runs now and starts this worktree's servers on the
  fixed ports. One worktree runs at a time; wts starts and stops the servers.
- **proxy** — you start each worktree's dev server yourself (e.g. `npm run dev`, left open with hot
  reload) on its own port; wts holds the fixed ports and forwards them to the selected worktree.
  Switching is instant and stops nothing; every worktree's servers keep running.

Windows only (MVP).

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

### Proxy mode

```json
{
  "mode": "proxy",
  "services": {
    "api": { "port": 5241, "targets": "5242-5299" },
    "web": { "port": 5173, "targets": "5174-5199" }
  }
}
```

`port` is the fixed port the proxy holds; `targets` is where each worktree runs that service.
Start the forwarder with `wts proxy` (or `wts watch`, which runs it too), then start your servers
in each worktree on a port inside the range:

- Vite: plain `npm run dev` (no `--strictPort`). 5173 is held by the proxy, so Vite takes the next
  free port. The proxy holds the fixed port on 127.0.0.1, ::1, [::] and 0.0.0.0, so a server
  started later cannot grab it whichever way it binds (the proxy only serves local connections).
- .NET: `dotnet run --urls http://localhost:5243` (any port in the range).

wts finds each worktree's server among the listeners in the range, by its command line / exe
path or by its working directory. `wts switch` selects the worktree (lock respected) and reports
services that are not running there; the browser keeps using the fixed ports; open connections
are closed on a switch so the page reconnects to the new worktree. A selected worktree without a
running server gets a 502 page that says what to start. Because the frontend's `/api` proxy
targets the fixed API port, it reaches the selected worktree's backend too, with no code change.

## Commands

| Command | |
|---|---|
| `wts status` | Owner of each configured port: worktree, pid, started by wts or not, lock |
| `wts switch [--force]` | run: stop the current owner, start this worktree's services, wait until ready · proxy: forward the fixed ports here |
| `wts stop [--force]` | run: stop the repo's services · proxy: clear the selection (servers keep running) |
| `wts proxy` | proxy mode: run the forwarder (also run by `wts watch`) |
| `wts logs [service] [-n 50] [-f]` | Show / follow service logs |
| `wts lock [--note "..."]` / `wts unlock` | Block other worktrees (agents) from `switch`/`stop` |
| `wts watch [--orca] [--delay 3] [--ui float\|tray\|none]` | Follow the worktree you are looking at and switch to it (see below) |
| `wts focus [path]` | Tell a running `wts watch` which worktree you are on (for editor integrations) |
| `wts mcp` | MCP server for coding agents (see below) |
| `wts hook` | Claude Code PreToolUse guard for agents (see below) |

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

### Enforce it: `wts hook`

`wts mcp` makes agents prefer wts; `wts hook` makes it a rule. It is a Claude Code PreToolUse
hook: in a run-mode worktree it blocks `npm|pnpm|yarn|bun dev|start|serve`, `vite`,
`next dev`, `dotnet run`, `dotnet watch` and `wts … --force`, and tells the agent to use
`wts_switch` (in proxy mode starting your own servers is the point, so only `--force` is blocked). Elsewhere it allows everything; on any internal error it allows (never breaks an
agent). Your own terminal is not affected. Add to `~/.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ {
  "matcher": "Bash|PowerShell",
  "hooks": [ { "type": "command", "command": "node",
               "args": ["C:/path/to/wts/dist/src/cli.js", "hook"], "timeout": 10 } ]
} ] } }
```

It matches command text with quoted strings and heredoc bodies removed, so a commit message or a
prompt that mentions `npm run dev` is fine. Limitation: a command hidden inside quotes
(`bash -c "npm run dev"`) is not caught.

## Demo

[`examples/demo`](examples/demo/README.md): a one-button page + a tiny API, configured by this
repo's own `wts.json` — make two worktrees, give each a colour, switch between them.

## Safety rules

- A process on a port is only stopped if it can be tied to a worktree of this repo: either it
  was started by wts (process tree + creation time recorded), or its own exe path / command
  line contains a worktree path. Anything else is reported and left running.
- Docker and other shared infrastructure are never touched.
- State, lock and logs live in `<git-common-dir>/wts/`, shared by all worktrees of the repo.
