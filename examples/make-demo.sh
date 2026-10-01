#!/usr/bin/env bash
# Creates a demo repo with two worktrees that serve the same ports:
#   <target>/main  (main checkout)   <target>/red  (red button)   <target>/blue  (blue button)
# Services: web :4173 (page) and api :4241 (JSON). No npm install needed.
# Usage: examples/make-demo.sh <target-dir>
set -euo pipefail
target="${1:?usage: make-demo.sh <target-dir>}"
[ -e "$target" ] && { echo "$target already exists" >&2; exit 1; }
mkdir -p "$target/main" && cd "$target/main"
git init -q -b main
git config user.name wts-demo && git config user.email wts-demo@example.invalid

cat > api.js <<'EOF'
// "Backend": reports which worktree it was started from.
const http = require("node:http");
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ worktree: __dirname, pid: process.pid }));
}).listen(4241, () => console.log("api listening on :4241 from", __dirname));
EOF

cat > web.js <<'EOF'
// "Frontend": a page with one button; it also asks the api which worktree it runs from.
const http = require("node:http");
const COLOR = "gray";
http.createServer(async (req, res) => {
  let api = "api not reachable";
  try { api = (await (await fetch("http://localhost:4241/")).json()).worktree; } catch {}
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>wts demo</title>
<body style="font-family:sans-serif;display:grid;place-items:center;height:90vh">
<div style="text-align:center">
  <button style="background:${COLOR};color:white;font-size:2rem;padding:1rem 3rem;border:0;border-radius:8px">${COLOR} button</button>
  <p>web from: <code>${__dirname}</code></p>
  <p>api from: <code>${api}</code></p>
</div>`);
}).listen(4173, () => console.log("web listening on :4173 from", __dirname));
EOF

cat > wts.json <<'EOF'
{
  "readyTimeoutSec": 30,
  "services": {
    "api": { "dir": ".", "port": 4241, "cmd": "node api.js" },
    "web": { "dir": ".", "port": 4173, "cmd": "node web.js" }
  }
}
EOF
git add -A && git commit -q -m "demo base (gray button)"

for color in red blue; do
  git worktree add -q -b "$color" "../$color"
  sed -i "s/const COLOR = \"gray\"/const COLOR = \"$color\"/" "../$color/web.js"
  git -C "../$color" commit -q -am "$color button"
done
git worktree list
