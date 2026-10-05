# wts demo: one button, several worktrees

This repo is its own demo. Two tiny servers live in `examples/demo` (no dependencies, Node only):

| service | fixed port | shows |
|---|---|---|
| `web` (`web.cjs`) | 4173 | a button in the worktree's own colour, named after the worktree |
| `api` (`api.cjs`) | 4241 | JSON with the worktree it was started from |

A git worktree is a copy of the whole repo, so every worktree of this repo is a demo worktree.
Each one picks its button colour from its folder name, so two worktrees look different with no
setup. Like Vite, each server takes the first free port from its fixed port upward.

## Quick start (proxy mode: you run the servers, wts forwards)

The root `wts.json` is in proxy mode:

```json
{
  "mode": "proxy",
  "services": {
    "api": { "port": 4241, "targets": "4242-4299" },
    "web": { "port": 4173, "targets": "4174-4199" }
  }
}
```

```sh
git clone <this repo> wts && cd wts
npm install && npm run build && npm link     # makes `wts` available
git worktree add ../wts-a
git worktree add ../wts-b

wts proxy                                    # terminal 1: holds 4173 / 4241, keep it open

cd ../wts-a/examples/demo && node web.cjs    # terminal 2: takes 4174 (4173 is held by the proxy)
cd ../wts-a/examples/demo && node api.cjs    # terminal 3: takes 4242
cd ../wts-b/examples/demo && node web.cjs    # terminal 4: 4175
cd ../wts-b/examples/demo && node api.cjs    # terminal 5: 4243

cd ../wts-a && wts switch    # http://localhost:4173 shows wts-a, instantly, nothing stopped
cd ../wts-b && wts switch    # refresh: wts-b; wts-a's servers keep running
wts status                   # every worktree's ports, and which one is selected
```

Stop wts-b's `web.cjs` and refresh: the proxy shows a page saying which server to start.

## Simulate real work

In one worktree, change the code: set `const COLOR = "red";` in `examples/demo/web.cjs` (or ask an
agent to), restart that worktree's `web.cjs`, and refresh: the page shows that worktree's change,
the other worktree keeps its own code.

## Run mode: wts starts and stops the servers

Replace the root `wts.json` with

```json
{
  "readyTimeoutSec": 30,
  "services": {
    "api": { "dir": "examples/demo", "port": 4241, "cmd": "node api.cjs" },
    "web": { "dir": "examples/demo", "port": 4173, "cmd": "node web.cjs" }
  }
}
```

and just run `wts switch` in a worktree: it stops the other worktree's servers and starts this
one's on 4173 / 4241. Only one worktree runs at a time.

## Then

- **Auto-switch**: `wts watch` (add `--orca` in Orca) follows the worktree you are looking at,
  runs the proxy for proxy-mode repos, and shows a floating button with the selected worktree.
- **Lock**: `wts lock` in the worktree you are testing; `wts switch` elsewhere is refused.
- **Agents**: register `wts mcp` and the `wts hook` guard (see the root README); then ask an agent
  in one worktree to "run the app".
