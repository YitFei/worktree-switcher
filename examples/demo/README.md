# wts demo: one button, several worktrees

This repo is its own demo. The root `wts.json` runs two tiny servers from `examples/demo`
(no dependencies, Node only):

| service | port | shows |
|---|---|---|
| `web` (`web.cjs`) | 4173 | a page with one button, plus which worktree serves it |
| `api` (`api.cjs`) | 4241 | JSON with the worktree it was started from |

A git worktree is a copy of the whole repo, so every worktree of this repo is a demo worktree.

## Try it

```sh
git clone <this repo> wts && cd wts
npm install && npm run build && npm link       # makes `wts` available

git worktree add ../wts-red
git worktree add ../wts-blue
# edit examples/demo/web.cjs in each: const COLOR = "red";  /  const COLOR = "blue";

cd ../wts-red  && wts switch    # open http://localhost:4173 → red button, "web from …wts-red"
cd ../wts-blue && wts switch    # refresh → blue; wts-red's servers were stopped first
wts status                      # who runs each port
wts stop                        # free both ports
```

## Then

- **Auto-switch**: `wts watch` (add `--orca` in Orca) follows the worktree you are looking at;
  the floating button shows which one runs.
- **Lock**: `wts lock` in the worktree you are testing; `wts switch` elsewhere is refused.
- **Agents**: register `wts mcp` and the `wts hook` guard (see the root README); then ask an agent
  in one worktree to "run the app" — it uses `wts_switch` instead of starting servers itself.
