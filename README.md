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

`--force` only overrides another worktree's lock. Exit codes: `0` ok, `1` failure, `2` refused.

## Safety rules

- A process on a port is only stopped if it can be tied to a worktree of this repo: either it
  was started by wts (process tree + creation time recorded), or its own exe path / command
  line contains a worktree path. Anything else is reported and left running.
- Docker and other shared infrastructure are never touched.
- State, lock and logs live in `<git-common-dir>/wts/`, shared by all worktrees of the repo.
