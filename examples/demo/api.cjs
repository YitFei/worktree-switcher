// Demo "backend": tells which worktree it was started from.
const http = require("node:http");
const path = require("node:path");

const worktree = path.resolve(__dirname, "..", "..");

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ worktree, pid: process.pid }));
});

/** Like Vite: the first free port from `port` upward (proxy mode keeps the fixed port busy). */
function listen(server, port, label) {
  server.once("error", (e) => (e.code === "EADDRINUSE" && port < 65535 ? listen(server, port + 1, label) : console.error(e.message)));
  server.listen(port, () => console.log(`${label} listening on http://localhost:${port} from`, worktree));
}

listen(server, 4241, "api");
