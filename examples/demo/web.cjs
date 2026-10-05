// Demo "frontend": a page with one button. Each worktree gets its own colour from its folder
// name, so after `wts switch` you see at a glance whose code runs on http://localhost:4173.
const http = require("node:http");
const path = require("node:path");

// Empty = colour picked from the worktree name. Set a colour (e.g. "red") to simulate a code change.
const COLOR = "";

const worktree = path.resolve(__dirname, "..", "..");
const name = path.basename(worktree);
const PALETTE = ["#d73a49", "#0366d6", "#28a745", "#6f42c1", "#e36209", "#0598bc", "#d03592", "#735c0f", "#22863a", "#5a32a3"];
const color = COLOR || PALETTE[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];

http
  .createServer(async (req, res) => {
    let api = "not reachable";
    try {
      api = (await (await fetch("http://localhost:4241/")).json()).worktree;
    } catch {}
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>wts demo · ${name}</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0">
<div style="text-align:center">
  <button style="background:${color};color:white;font-size:2rem;padding:1rem 3rem;border:0;border-radius:8px">${name}</button>
  <p>web from <code>${worktree}</code></p>
  <p>api from <code>${api}</code></p>
</div>`);
  })
  .listen(4173, () => console.log("web listening on http://localhost:4173 from", worktree));
