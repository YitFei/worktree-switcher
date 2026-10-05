# How worktree-switcher works

This page is for people who maintain wts or want to port it. For the reasons behind the design,
see [why.md](why.md).

## Map of the source

```
src/
  cli.ts            argument parsing, one case per command
  config.ts         wts.json: parse and validate (mode, services, port ranges)
  context.ts        loadContext: current worktree, the repo's worktrees, the Store; remembers the repo
  git.ts            git rev-parse / worktree list
  state.ts          Store (<git-common-dir>/wts/): state.json, lock.json, logs; checkLock
  owner.ts          which worktree a process belongs to; describe what holds a port
  runner.ts         the detached process that runs one service command and writes its log
  discover.ts       proxy mode: find each worktree's servers inside the `targets` ranges
  ports.ts          proxy mode: stable assigned port per worktree and service (ports.json)
  proxy.ts          proxy mode: the TCP forwarder
  repos.ts          ~/.wts/repos.json: projects this machine has used (for the menu)
  init.ts           wts init / wts_init: detect frameworks and ports, propose wts.json
  hook.ts           Claude Code PreToolUse guard
  mcp.ts            MCP server: tools and instructions for agents
  commands/         status, switch (+restart), stop, logs, lock, focus, select (proxy), watch, setup
  focus/            focus sources for Auto mode: Orca's state DB, ~/.wts/focus.json
  platform/win.ts   Windows: listeners, process snapshot (exe, command line, cwd), kill tree
  platform/widget.ts  the floating button / tray icon (PowerShell + WinForms) and its IPC
```

Everything platform-specific lives in `src/platform/`. Everything else is plain Node and has
unit tests in `test/`.

## Context and state

Every command starts with `loadContext(cwd)`:

1. `git rev-parse --show-toplevel` gives the current worktree, and `--git-common-dir` gives the
   shared `.git` folder.
2. `git worktree list --porcelain` gives every worktree of the repo. Worktrees that Orca is still
   preparing (`.orca-preparing`) are skipped.
3. `wts.json` is read from the current worktree's root.

State is shared by every worktree of a repo through the common git dir, so no daemon is needed:

| file | content |
|---|---|
| `<git-common-dir>/wts/state.json` | run mode: the owner worktree and, per service, the root PID, its creation time and the port. Proxy mode: the selected worktree (`owner`). |
| `<git-common-dir>/wts/lock.json` | the worktree that holds the lock, plus a note and the time |
| `<git-common-dir>/wts/ports.json` | proxy mode: worktree → service → assigned port |
| `<git-common-dir>/wts/logs/<service>.log` | run mode: output of the service command |
| `~/.wts/repos.json` | projects with a wts.json that this machine has used |
| `~/.wts/watch.json` | `{auto, showAll}`: the button's remembered choices |
| `~/.wts/focus.json` | written by `wts focus <path>` |
| `~/.wts/float-pos.json` | the button's position |
| `~/.wts/widget-<pid>.ps1`, `-state.json`, `-cmd.json` | the button's script and IPC files (removed on exit; stale ones are cleaned up) |

## Who owns a process (`owner.ts`)

`platform/win.ts` takes a snapshot of the listening TCP ports (`Get-NetTCPConnection`) and of
the processes (`Win32_Process`: PID, parent PID, exe path, command line, creation time). A
process belongs to a worktree when, in this order:

1. **wts started it.** state.json records the root PID and its creation time. A process is ours
   when it is that root, or a descendant of it, and the root's creation time still matches.
   The time check stops a reused PID from being mistaken for ours.
2. **Its exe path or command line contains a worktree path.** This covers `…\wts-a\node_modules\.bin\vite`
   and `…\wts-a\bin\Debug\MyApp.exe`. The longest match wins, so a worktree nested inside another
   (`main\.claude\worktrees\x`) is not attributed to its parent.
3. **Its current directory is inside a worktree** (proxy-mode discovery only). This covers
   `node server.js` started from a terminal in that worktree. Windows does not expose another
   process's current directory, so a small C# helper reads it from the process's PEB. The helper
   is compiled once with `Add-Type` into `~/.wts/wts-cwd-v1.dll`.

Anything that does not match is never stopped. `describeHolder` turns such a process into
a message for the user:

- a wts-started process;
- a server of worktree X;
- a **leftover**: a server whose folder sits next to the repo's linked worktrees but is no longer
  a worktree, usually because the worktree was removed while its server kept running;
- or simply "name, pid".

## Run mode: `wts switch`

```
check the lock ─▶ snapshot ports + processes ─▶ attribute each port's listener
   │
   ├─ any listener not attributable? ──▶ refuse (exit 2), name it, kill nothing
   ├─ already served by this worktree? ─▶ done (unless restart)
   └─ stop the previous owner's process trees (taskkill /T), wait until the ports are free
        ─▶ start each service via the runner ─▶ write state.json ─▶ wait until every port listens
```

**Starting a service.** wts spawns `node runner.js <log> <cmd>` *detached*, in the service's
`dir`. The runner then spawns the shell for the command, *not* detached, with stdout and stderr
going to the log file. Two Windows details force this shape:

- A detached `cmd.exe` has no console, and output from the programs it starts is lost.
- Node puts non-detached children into a kill-on-close job object. If wts itself started the
  shell non-detached, the servers would die when `wts switch` exits. The runner is detached, so
  it survives; its own children stay in *its* job, so the whole tree dies if the runner is killed.

`wts restart` is `switch` with `restart: true`: it stops this worktree's servers and starts them
again even though they already serve the ports.

`wts stop` stops only attributable process trees. `readyTimeoutSec` bounds the readiness wait;
when it runs out, the last lines of the log are shown.

## Proxy mode

### Discovery and assigned ports

Each service has a `targets` range. `discover()` lists the listeners in all ranges
(`rangeListeners`, which includes the current directory) and attributes them to worktrees as
above. When a worktree has several candidates, the one on its assigned port wins.

`assignPorts()` is a pure function, so it is easy to test. It keeps ports.json up to date:

- it drops entries for worktrees that no longer exist;
- a worktree already running a service inside the range keeps (or adopts) that port;
- otherwise it gives the lowest port in the range that no worktree holds and nothing listens on.

`startHint()` turns an assigned port into a start command for the detected framework, e.g.
`npm run dev -- --port 5175 --strictPort`. `wts port`, `wts status` and `wts_status` show it.

### The forwarder (`proxy.ts`)

`Forwarder` listens on every service's fixed port and pipes each TCP connection to that service's
port in the selected worktree. It works at the TCP level, so HTTP, WebSockets (Vite HMR, SignalR)
and the `Host` header pass through unchanged.

- **Binding.** It first checks that nobody serves the port. On Windows a specific-address bind and
  a wildcard bind of the same port can coexist across programs, so a busy port might not fail the
  bind. If the port is free, it binds `127.0.0.1`, `::1`, `0.0.0.0` and `::`. Holding all four
  keeps another program from taking part of the traffic. Connections from other machines are
  closed. If a port is busy, it reports the holder (`describeBlocker`) and retries every 5 s; it
  never takes the port over.
- **Routing.** The selection (state.json `owner`) is re-read every 500 ms. On a change, open
  connections are closed so the browser reconnects to the new worktree.
- **Missing server.** A connection first dials the last known port. If that fails, the forwarder
  rediscovers and dials again. If there is still no server, it answers with a small HTTP 502 page
  that names the worktree and the port to start the service on.
- Discovery also runs every 10 s in the background, and immediately on ↻.

`wts watch` runs one forwarder per proxy-mode repo it knows about. `wts proxy` runs just one,
without the button.

## `wts watch`

`watch.ts` runs a 500 ms loop:

1. **Focus sources.** Orca's state DB (`focus/orca.ts`) and `~/.wts/focus.json` (`wts focus`).
   - The Orca reader opens `%APPDATA%\orca\profiles\local-default\profile-state.db` read-only,
     reads the `workspaceSession` row, and parses `activeWorktreeId`. This is Orca's internal
     format; any error just returns null.
   - In Auto mode a `Debouncer` waits until the focused worktree has been stable for `--delay`
     seconds and differs from the last focus it acted on. Then it calls `switchTo` (run mode) or
     selects the worktree (proxy mode). Because it acts only on a *change* of focus, a manual
     switch is never undone.
2. **Proxies.** It starts or stops a `Forwarder` for each known proxy-mode repo.
3. **Widget state.** It builds the label, the colour, a tooltip and the menu: projects (the
   current one, or all of them with *Show all projects*), worktrees, routes with their colour
   (working / broken / idle) and each worktree's ports. Route rows are padded into columns
   (`alignRoutes`) and drawn in a monospace font.

### The floating button (`platform/widget.ts`)

The UI is a PowerShell script (`COMMON_PS` + `FLOAT_PS` or `TRAY_PS`). It is written to
`~/.wts/widget-<pid>.ps1` (UTF-8 with BOM, so Windows PowerShell 5.1 reads the Unicode
correctly) and started with `powershell -ExecutionPolicy Bypass -File`. Passing it inline
(`-EncodedCommand`) exceeds the Windows command-line limit.

- The button is a C# `Form` subclass (`WtsPill`) compiled with `Add-Type`. It is borderless,
  topmost, DPI-aware, and never activates (`WS_EX_NOACTIVATE`), so clicking it does not steal
  focus from the editor. It has three segments: name, ↻, and Manual/Auto.
- **IPC uses two JSON files**:
  - node writes `widget-<pid>-state.json` (atomic rename) and the script polls it;
  - the script writes `widget-<pid>-cmd.json` (`switch <path>`, `restart`, `auto`, `manual`,
    `lock`, `stop`, `exit`, …) and node polls and deletes it.
- The menu is a `ContextMenuStrip`. Because the form never activates, the menu does not close by
  itself on an outside click, so the script polls the mouse while the menu is open.
- If the script cannot start, `wts watch` keeps running without a button.

## Agents

### MCP server (`mcp.ts`)

`wts mcp` is a stdio MCP server built on `@modelcontextprotocol/sdk`. Each tool resolves the
agent's worktree from the server's working directory, or from an optional `cwd` argument, and
calls the same functions the CLI uses:

- `wts_status`: in proxy mode it adds `fixedPortHolders` and `warnings`.
- `wts_switch`, `wts_restart`, `wts_stop`, `wts_logs`, `wts_port`.
- `wts_init`: `proposeInit` / `writeInit`.

Refusals come back as tool errors with the reason, so the agent can report them.

The server's `instructions` text is the main way to steer agents:

- **run mode**: use wts_switch and wts_restart; never start, kill or restart servers by hand;
- **proxy mode**: start your own server on the assigned port; never point the app's own proxy
  settings at an assigned port; report what holds a fixed port;
- **wts_init**: ask the user run or proxy first;
- **locks**: never override one; tell the user.

When the agent's worktree has no wts.json, the server lists other worktrees that do
(`configuredElsewhere`). The usual cause is a wts.json that has not been merged yet.

### Hook (`hook.ts`)

Claude Code runs `wts hook` before every Bash or PowerShell tool call and passes the event on
stdin. `decide()` works like this:

1. Find the directory the command runs in: the event's `cwd`, or a leading `cd <dir> &&`.
2. Find that directory's worktree and its wts.json mode. If it is not a wts worktree, allow.
3. Strip quoted strings and heredoc bodies (`executableText`), so text that only *mentions* a
   command is not matched.
4. Always block `wts … --force`. In run mode, also block dev-server commands
   (`npm|pnpm|yarn|bun (run) dev|start|serve`, `vite`, `next dev`, `dotnet run`,
   `dotnet watch`).
5. To block, exit with code 2 and a message on stderr that points to the MCP tools. Claude Code
   shows that message to the agent.

On any internal error the hook allows the command: a broken guard must not stop work.

### `wts setup` (`commands/setup.ts`)

- Runs `claude mcp remove` (for the current and old names), then
  `claude mcp add --scope user worktree-switcher -- node <this install's cli.js> mcp`.
- Merges one PreToolUse entry (`matcher: "Bash|PowerShell"`, `node <cli.js> hook`) into
  `~/.claude/settings.json`:
  - it backs the file up to `settings.json.wts-backup` first;
  - it replaces an existing wts entry wherever it points;
  - it keeps every other setting and hook.
- `--uninstall` reverses both.

## Porting to macOS / Linux

What would need replacing:

- `platform/win.ts`:
  - listeners: `lsof -iTCP -sTCP:LISTEN` or `ss -ltnp`;
  - process snapshot: `ps -o pid,ppid,lstart,command`;
  - current directory: `/proc/<pid>/cwd` or `lsof -d cwd`;
  - kill tree: process groups and `kill -TERM -<pgid>`.
- `runner.ts`: the job-object reasoning is Windows-specific; use `setsid` / process groups.
- `platform/widget.ts`: a different UI (a menu-bar app, or the tray only), speaking the same
  state and command files.
- `focus/orca.ts`: the DB path differs per OS.

The forwarder, port assignment, config, state, MCP server and hook logic are platform-neutral.
