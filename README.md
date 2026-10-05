# worktree-switcher (`wts`)

**Run many git worktrees of the same app on one machine, all wanting the same fixed dev ports, and
choose which worktree the browser sees.** Built for parallel, agent-driven development (Orca,
Claude Code, Codex) on Windows.

```
                             ┌─▶ worktree feat/login   (agent A)
http://localhost:5173  ──────┼─▶ worktree fix/upload   (agent B)   ← you pick which one; wts does the rest
                             └─▶ worktree main
```

- **`wts switch`** makes *this* worktree the one serving the app's fixed ports.
- **Two modes.** In *run* mode wts stops the old worktree's servers and starts this one's. In
  *proxy* mode every worktree runs its own servers (hot reload stays on) and wts forwards the fixed
  ports to the selected one, so switching is instant.
- **A floating button** always shows which worktree you are looking at. Its menu lets you switch,
  restart and lock. An optional *Auto* mode follows the workspace you select in Orca.
- **Built for agents.** An MCP server (`worktree-switcher`) gives coding agents tools to run,
  preview and restart the app the right way. A Claude Code hook stops them from starting dev
  servers behind your back.
- **Safe by default.** wts only stops processes it can prove belong to a worktree of the repo.
  Anything else on a port is reported, never killed.

> Why this exists, in detail: [docs/why.md](docs/why.md). How it works inside:
> [docs/how-it-works.md](docs/how-it-works.md).

---

## Contents
- [Requirements](#requirements) · [Install](#install) · [Quick start](#quick-start)
- [Run mode vs proxy mode](#run-mode-vs-proxy-mode) · [wts.json](#wtsjson)
- [Commands](#commands) · [The floating button (`wts watch`)](#the-floating-button-wts-watch)
- [Coding agents (MCP + hook)](#coding-agents-mcp--hook) · [Orca](#orca)
- [Safety rules](#safety-rules) · [Limitations](#limitations) · [Troubleshooting](#troubleshooting)
- [Contributing](#contributing) · [License](#license)

## Requirements

- **Windows 10 / 11.** Process and port handling use Windows APIs; macOS and Linux are not supported yet.
- **Node.js 22+**
- **git**, with worktrees
- **Windows PowerShell 5.1** (built into Windows), used for port/process queries and the floating button

## Install

From npm (once published):

```sh
npm install -g worktree-switcher
wts setup        # register the MCP server and the agent hook in Claude Code
```

From source:

```sh
git clone https://github.com/YitFei/worktree-switcher.git
cd worktree-switcher
npm install && npm run build && npm link
wts setup
```

`wts setup` does two things:

- registers the MCP server `worktree-switcher` in Claude Code (user scope);
- adds the PreToolUse hook to `~/.claude/settings.json`. It backs the file up first and changes
  nothing else in it.

It also prints the config snippet for Codex.

Re-run `wts setup` after upgrading or moving the install. `wts setup --uninstall` removes both.
Options: `--dry-run`, `--no-mcp`, `--no-hook`.

## Quick start

This repository is its own demo ([examples/demo](examples/demo/README.md)). It has two tiny Node.js
servers with no dependencies:

- a **frontend** (`web.cjs`, port 4173): a page with one button, coloured and labelled by worktree;
- a **backend** (`api.cjs`, port 4241): JSON saying which worktree it runs from.

The page asks the backend and shows both answers, so you can see that the frontend and the
backend come from the same worktree:

```
        ┌──────────────────────┐
        │       [ wts-b ]      │   ← button colour and label come from the worktree's folder name
        └──────────────────────┘
   web from C:\src\wts-b
   api from C:\src\wts-b
```

The repo's own `wts.json` runs them (run mode):

```json
{
  "readyTimeoutSec": 30,
  "services": {
    "api": { "dir": "examples/demo", "port": 4241, "cmd": "node api.cjs" },
    "web": { "dir": "examples/demo", "port": 4173, "cmd": "node web.cjs" }
  }
}
```

Try it:

```sh
git worktree add ../wts-a
git worktree add ../wts-b

cd ../wts-a && wts switch      # http://localhost:4173 shows a button labelled "wts-a"
cd ../wts-b && wts switch      # refresh: "wts-b" (wts-a's servers were stopped first)
wts status
wts watch                      # the floating button
```

To simulate real work, set `const COLOR = "red";` in one worktree's `examples/demo/web.cjs` and
run `wts restart` there; the other worktree keeps its own code. The demo README also shows the
same demo in proxy mode.

In your own project, you have two options:

- Ask your agent to **"set up wts"**. It will ask you which mode you want.
- Or run it yourself:

  ```sh
  wts init --mode run            # detects your dev servers and prints a proposed wts.json
  wts init --mode run --write    # writes it
  ```

  Commit `wts.json` to your main branch so every worktree has it.

## Run mode vs proxy mode

| | **run** (default) | **proxy** |
|---|---|---|
| Who starts the servers | wts, using `cmd` from wts.json | you (or your agent), e.g. `npm run dev` |
| Worktrees running at once | one | all of them, each on its own port |
| What a switch does | stops the old worktree's process tree, starts this one's, waits until the ports listen | changes where the fixed ports forward to; instant, nothing stops |
| Hot reload | yes, for the running worktree | yes, in every worktree |
| Memory | low | one set of servers per worktree |
| What your backend must do | nothing | accept a different port (e.g. `--port`, or read it from `PORT`) |

```
run:    browser ──:5173──▶ [ worktree B's Vite ]          (A's servers were stopped)

proxy:  browser ──:5173──▶ [ wts proxy ] ──▶ :5175  worktree B's Vite
                                         ╲─  :5174  worktree A's Vite  (still running)
```

Which one to pick, and why local development needs fixed ports at all (OAuth redirects, webhooks,
CORS, other services): see [the detailed comparison](docs/why.md#two-modes-because-both-habits-are-valid).

In proxy mode, the frontend's own API proxy keeps pointing at the fixed API port (for example
Vite's `/api → localhost:3000`). The wts proxy forwards that port to the *same* worktree, so
frontend and backend always stay paired. No app code changes.

## wts.json

`wts.json` goes at the root of the repository. Commit it, so every worktree has it.

**Run mode**

```json
{
  "readyTimeoutSec": 180,
  "services": {
    "api": { "dir": "backend",  "port": 3000, "cmd": "npm run dev" },
    "web": { "dir": "frontend", "port": 5173, "cmd": "npm run dev -- --strictPort" }
  }
}
```

**Proxy mode**

```json
{
  "mode": "proxy",
  "services": {
    "api": { "dir": "backend",  "port": 3000, "targets": "3001-3099" },
    "web": { "dir": "frontend", "port": 5173, "targets": "5174-5199" }
  }
}
```

| key | meaning | required |
|---|---|---|
| `mode` | `"run"` (default) or `"proxy"` | no |
| `readyTimeoutSec` | run mode: how long to wait for the ports to listen (default 120) | no |
| `services.<name>.dir` | folder to run in, relative to the worktree root (default `.`) | no |
| `services.<name>.port` | the fixed port the browser or app uses | yes |
| `services.<name>.cmd` | run mode: the start command, run as-is in `dir` | run mode |
| `services.<name>.targets` | proxy mode: the port range where each worktree runs this service | proxy mode |

Tips:

- With Vite in run mode, use `--strictPort`. A busy port then fails instead of silently moving
  Vite to the next one.
- For .NET hot reload in run mode, use `dotnet watch run` and set
  `DOTNET_WATCH_RESTART_ON_RUDE_EDIT=true` so it never waits for a keypress.

In proxy mode each worktree gets a stable **assigned port** per service, inside `targets`.
`wts port` shows that port and the command to start the service on it.

## Commands

| command | what it does |
|---|---|
| `wts status` | Who serves each port (worktree, pid, whether wts started it) and the lock. In proxy mode it also shows the selected worktree, every worktree's ports, and what holds each fixed port. |
| `wts switch [--force]` | Run mode: stops the current owner, starts this worktree's services and waits until they are ready. Proxy mode: forwards the fixed ports here. |
| `wts restart [--force]` | Run mode: restarts this worktree's services. |
| `wts stop [--force]` | Run mode: stops the repo's services. Proxy mode: clears the selection; your servers keep running. |
| `wts logs [service] [-n 50] [-f]` | Run mode: shows service logs (`-f` to follow). |
| `wts lock [--note "..."]` / `wts unlock` | Blocks other worktrees (and agents) from switching or stopping. |
| `wts port [service]` | Proxy mode: this worktree's assigned port(s) and start command. With a service name it prints just the number. |
| `wts watch [--auto\|--manual] [--delay 3] [--no-orca] [--ui float\|tray\|none]` | Shows the floating button, runs the proxy, and optionally auto-switches. |
| `wts proxy` | Proxy mode: runs only the forwarder, without the button. |
| `wts focus [path]` | Tells a running `wts watch` which worktree you are on (for editor integrations). |
| `wts init --mode run\|proxy [--write] [--overwrite]` | Detects the dev servers and proposes (or writes) a wts.json. |
| `wts setup [--uninstall] [--dry-run] [--no-mcp] [--no-hook]` | Registers the MCP server and the hook in Claude Code. |
| `wts mcp` / `wts hook` | The MCP server (stdio) and the Claude Code PreToolUse hook. Your agent starts these, not you. |

`--force` only overrides another worktree's lock. Exit codes: `0` ok, `1` failure, `2` refused.

## The floating button (`wts watch`)

```
( ● my-app › feat-login │ ↻ │ Manual )
```

- **Dot colour:**
  - green: serving;
  - yellow: switching;
  - red: a server is missing, or something else holds a fixed port;
  - gray: stopped, or nothing selected.
- **Name.** Click it (or right-click anywhere on the button) to open the menu:
  - The project's worktrees; click one to switch to it.
  - The routes, for example `:5173 ──→ :5175  web`: green when the route works, red when it does not.
  - Each worktree's ports. `:5176?` means the port is assigned but nothing is running on it.
  - ↻ Restart, Auto-switch, Show all projects, Lock / Unlock, Stop, Exit.
- **↻**
  - Run mode: restarts the running worktree's servers.
  - Proxy mode: re-detects the servers and resets connections. To restart your own server, use its terminal.
- **Manual / Auto**
  - *Manual* (the default): wts switches only when you ask (from the menu, `wts switch`, or an agent).
  - *Auto*: wts follows the worktree you select in Orca (or via `wts focus`) once you stay on it
    for `--delay` seconds. Auto only reacts when the selection *changes*, so it never undoes a
    manual switch.

More about the button:

- Drag it anywhere; it remembers its position.
- It never takes keyboard focus.
- Your choices (Auto, Show all projects) are saved in `~/.wts/watch.json`.
- `--ui tray` shows a tray icon with the same menu instead; `--ui none` shows nothing.
- One `wts watch` serves every project.

## Coding agents (MCP + hook)

After `wts setup`, every new Claude Code session has the `worktree-switcher` MCP server:

| tool | what it does |
|---|---|
| `wts_status` | Who serves the ports, whether that is the agent's worktree, and the lock. In proxy mode also: assigned ports, start hints, what holds each fixed port, and warnings. |
| `wts_switch` | Runs or selects the agent's worktree. Refused when another worktree holds the lock. |
| `wts_restart` | Run mode: restarts the agent's servers, instead of the agent killing and restarting them by hand. |
| `wts_stop` | Run mode: stops the servers. Proxy mode: clears the selection. |
| `wts_logs` | The last lines of the service logs. |
| `wts_port` | Proxy mode: the agent's assigned ports and start commands. |
| `wts_init` | Detects the dev servers and proposes or writes a wts.json. The agent must ask you run or proxy first. |

The server's instructions tell agents to:

- never start dev servers or kill processes on their ports themselves (run mode);
- use `wts_restart` to restart;
- in proxy mode, start their own servers on the assigned port, and never point the app's own
  proxy settings at an assigned port;
- never override a lock;
- report refusals to you instead of working around them.

**The hook** (`wts hook`, a Claude Code PreToolUse hook) enforces the run-mode rule. In a run-mode
worktree it blocks these commands and points the agent at `wts_switch`:

- `npm`, `pnpm`, `yarn` or `bun` with `dev`, `start` or `serve`;
- `vite`, `next dev`, `dotnet run` and `dotnet watch`;
- any `wts … --force`.

Limits of the hook:

- It ignores quoted text and heredocs, so a commit message that mentions `npm run dev` is fine.
- For the same reason it does not catch `bash -c "npm run dev"`.
- It never blocks anything outside wts-managed worktrees, and it allows everything if it hits an
  internal error.

For Codex, `wts setup` prints the `~/.codex/config.toml` snippet. For other MCP clients, run
`node <install>/dist/src/cli.js mcp` over stdio.

## Orca

[Orca](https://www.onorca.dev) creates one git worktree per task or agent, but it does not manage
dev servers or ports for local worktrees. wts fills that gap:

- For Auto mode, `wts watch` reads which workspace is selected in Orca from Orca's local state
  database; no plugin is needed. That database is Orca's internal format, not a public API. If an
  Orca update changes it, Auto stops following Orca, and everything else keeps working.
- Commit `wts.json` to the branch Orca creates workspaces from, so new workspaces have it.
- Orca's `worktree.sharedDirectories` setting (in orca.yaml) can share `node_modules` between worktrees.

## Safety rules

- wts only stops a process on a port if it belongs to a worktree of this repo. That means one of:
  - wts started it. wts records the process tree and the creation time, so a reused PID is never
    mistaken for it.
  - Its executable or command line contains a worktree path.

  Anything else is reported and left running.
- The proxy never takes a port that another program already serves; it waits until the port is
  free. It only accepts connections from this machine.
- Locks (`wts lock`) stop other worktrees and agents from switching away from what you are testing.
- Docker and other shared infrastructure are never touched.
- State lives in two places:
  - `<git-common-dir>/wts/`, shared by all worktrees of a repo: state, lock, assigned ports, logs.
  - `~/.wts/`: button preferences and position, remembered projects.

## Limitations

- Windows only for now.
- Auto mode depends on Orca's internal state database.
- Proxy mode needs every backend to accept a port other than its fixed one.
- The hook matches command text, so commands hidden inside quotes (`bash -c "…"`) are not caught.
- So far it has been tested on only a few machines. Please report issues.

## Troubleshooting

| symptom | what to do |
|---|---|
| `wts switch` is refused: the port is held by a process that is not a worktree of this repo | `wts status` names the process. Stop it yourself; wts never kills unknown processes. |
| The button is red and says ":5173 held" | Something started on the fixed port outside the proxy, often a server left over from a removed worktree. The tooltip and `wts status` name it. |
| The page says "wts: … has no 'web' server running" | Proxy mode: the selected worktree has no server. Start it on the port `wts port` shows, or select another worktree. |
| A worktree is missing from the menu | It has no wts.json yet. Merge the branch that contains it. |
| The agent cannot see the tools | Start a new agent session (or reconnect via `/mcp`), and check `claude mcp list`. |
| The button does not appear | Run `wts watch` in a terminal and read its output. |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the project
layout, how to test safely, and the release steps.

## License

[MIT](LICENSE) © 2026 Yif
