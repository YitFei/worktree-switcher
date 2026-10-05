# wts demo: one button, several worktrees

This repo is its own demo. The root `wts.json` runs two tiny servers from `examples/demo`
(no dependencies, Node only):

| service | port | shows |
|---|---|---|
| `web` (`web.cjs`) | 4173 | a button in the worktree's own colour, named after the worktree |
| `api` (`api.cjs`) | 4241 | JSON with the worktree it was started from |

A git worktree is a copy of the whole repo, so every worktree of this repo is a demo worktree.
Each one picks its button colour from its folder name — two worktrees look different with no
setup.

## Quick start

```sh
git clone <this repo> wts && cd wts
npm install && npm run build && npm link       # makes `wts` available

git worktree add ../wts-a
git worktree add ../wts-b

cd ../wts-a && wts switch    # open http://localhost:4173 → a button labelled "wts-a"
cd ../wts-b && wts switch    # refresh → "wts-b" in another colour; wts-a was stopped first
wts status                   # who runs each port
wts stop                     # free both ports
```

## Simulate real work

In one worktree, change the code — set `const COLOR = "red";` in `examples/demo/web.cjs`, or
ask an agent to do it — then `wts switch` there: the page shows that worktree's change, the
other worktree keeps its own code.

## Proxy mode: you run the servers, wts forwards

In each worktree set `wts.json` to

```json
{
  "mode": "proxy",
  "services": {
    "api": { "port": 4241, "targets": "4242-4299" },
    "web": { "port": 4173, "targets": "4174-4199" }
  }
}
```

then:

```sh
wts proxy                                   # one terminal: holds 4173 / 4241

cd ../wts-a/examples/demo && node web.cjs   # takes 4174 (4173 is busy), like Vite would
cd ../wts-a/examples/demo && node api.cjs   # takes 4242
cd ../wts-b/examples/demo && node web.cjs   # 4175
cd ../wts-b/examples/demo && node api.cjs   # 4243

cd ../wts-a && wts switch    # http://localhost:4173 shows wts-a, instantly, nothing stopped
cd ../wts-b && wts switch    # refresh: wts-b; wts-a's servers keep running
wts status                   # every worktree's ports, and which one is selected
```

Stop wts-b's `web.cjs` and refresh: the proxy shows a page saying which server to start.

## Then

- **Auto-switch**: `wts watch` (add `--orca` in Orca) follows the worktree you are looking at;
  the floating button shows which one runs.
- **Lock**: `wts lock` in the worktree you are testing; `wts switch` elsewhere is refused.
- **Agents**: register `wts mcp` and the `wts hook` guard (see the root README); then ask an agent
  in one worktree to "run the app" — it uses `wts_switch` instead of starting servers itself.
