// Demo "frontend": a page with one button. Change COLOR in each worktree, then `wts switch`
// there — the page on http://localhost:4173 shows whose code is running.
const http = require("node:http");
const path = require("node:path");

const COLOR = "gray";
const worktree = path.resolve(__dirname, "..", "..");

http
  .createServer(async (req, res) => {
    let api = "not reachable";
    try {
      api = (await (await fetch("http://localhost:4241/")).json()).worktree;
    } catch {}
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>wts demo</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0">
<div style="text-align:center">
  <button style="background:${COLOR};color:white;font-size:2rem;padding:1rem 3rem;border:0;border-radius:8px">${COLOR} button</button>
  <p>web from <code>${worktree}</code></p>
  <p>api from <code>${api}</code></p>
</div>`);
  })
  .listen(4173, () => console.log("web listening on http://localhost:4173 from", worktree));
