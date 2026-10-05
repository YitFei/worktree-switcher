# Demo: one button, several worktrees

This repository is its own demo. Two tiny servers live in `examples/demo` — Node only, no
dependencies:

| service | fixed port | shows |
|---|---|---|
| `web` (`web.cjs`) | 4173 | a button in the worktree's own colour, labelled with the worktree's name |
| `api` (`api.cjs`) | 4241 | JSON with the worktree it was started from |

A git worktree is a full copy of the repository, so **every worktree of this repo is a demo
worktree**. Each one picks its button colour from its folder name, so two worktrees look
different without any setup. Like Vite, each server takes the first free port from its fixed port
upward, so the same files work in both modes.

## Run mode (the root `wts.json`) — wts starts and stops the servers

```sh
git clone https://github.com/YitFei/worktree-switcher.git wts && cd wts
npm install && npm run build && npm link      # makes `wts` available

git worktree add ../wts-a
git worktree add ../wts-b

cd ../wts-a && wts switch    # open http://localhost:4173 — a button labelled "wts-a"
cd ../wts-b && wts switch    # refresh — "wts-b" in another colour; wts-a's servers were stopped
wts status                   # who runs each port
wts restart                  # stop and start wts-b's servers again
wts stop                     # free both ports
```

## Proxy mode — you run the servers, wts forwards

Replace the root `wts.json` in each worktree with:

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
wts watch                                    # terminal 1: the floating button + the proxy on 4173 / 4241

cd ../wts-a && wts port                      # which ports wts-a should use, and the commands
cd ../wts-a/examples/demo && node web.cjs    # takes 4174 (4173 is held by the proxy)
cd ../wts-a/examples/demo && node api.cjs    # takes 4242
cd ../wts-b/examples/demo && node web.cjs    # 4175
cd ../wts-b/examples/demo && node api.cjs    # 4243

cd ../wts-a && wts switch    # http://localhost:4173 shows wts-a — instantly, nothing stopped
cd ../wts-b && wts switch    # refresh: wts-b; wts-a's servers keep running
wts status                   # every worktree's ports and which one is selected
```

Stop wts-b's `web.cjs` and refresh: the proxy answers with a page saying which server to start.

## Simulate real work

In one worktree change the code — set `const COLOR = "red";` in `examples/demo/web.cjs`, or ask
an agent to — then `wts restart` (run mode) or restart that worktree's `web.cjs` (proxy mode).
The page shows that worktree's change; the other worktree keeps its own code.
