// Demo "backend": tells which worktree it was started from.
const http = require("node:http");
const path = require("node:path");

const worktree = path.resolve(__dirname, "..", "..");

http
  .createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ worktree, pid: process.pid }));
  })
  .listen(4241, () => console.log("api listening on http://localhost:4241 from", worktree));
