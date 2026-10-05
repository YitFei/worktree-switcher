import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { attributeListeners, type Found } from "../src/discover.js";
import { Forwarder } from "../src/proxy.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** A backend that answers with its name and accepts WebSocket-style upgrades. */
async function backend(name: string): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((_, res) => res.end(name));
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.end(name);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

function get(port: number, agent?: http.Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      })
      .on("error", reject);
  });
}

test("forwards to the selected worktree, switches instantly, 502 when its server is missing", async () => {
  const a = await backend("worktree-a");
  const b = await backend("worktree-b");
  const port = await freePort();
  let selected: string | null = "C:\\wt\\a";
  const found: Found[] = [
    { service: "web", worktree: "C:\\wt\\a", port: a.port, pid: 1 },
    { service: "web", worktree: "C:\\wt\\b", port: b.port, pid: 2 },
  ];
  const fwd = new Forwarder({
    services: { web: { dir: ".", port, cmd: "", targets: { from: 1, to: 65535 } } },
    selected: () => selected,
    discover: async () => found,
    log: () => {},
    hosts: ["127.0.0.1"],
  });
  await fwd.start();
  await sleep(100);
  const agent = new http.Agent({ keepAlive: true });
  try {
    assert.deepEqual(await get(port, agent), { status: 200, body: "worktree-a" });

    selected = "C:\\wt\\b";
    await sleep(700);
    assert.deepEqual(await get(port, agent), { status: 200, body: "worktree-b" }, "keep-alive socket was closed on switch");

    // WebSocket-style upgrade passes through
    const up = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
      let data = "";
      s.on("data", (d) => (data += d)).on("close", () => resolve(data));
    });
    assert.match(up, /^HTTP\/1\.1 101/);
    assert.match(up, /worktree-b$/);

    b.close(); // the selected worktree's server stops; the cached discovery still lists it
    await sleep(200);
    const gone = await get(port, agent);
    assert.equal(gone.status, 502, "a stopped server gives the 502 page, not a dropped connection");

    selected = "C:\\wt\\c"; // no server there
    await sleep(700);
    const r = await get(port, agent);
    assert.equal(r.status, 502);
    assert.match(r.body, /has no 'web' server running/);
  } finally {
    agent.destroy();
    fwd.stop();
    a.close();
    b.close();
  }
});

test("never steals a port another program already serves; takes it once it is free", async () => {
  const port = await freePort();
  const other = http.createServer((_, res) => res.end("other program"));
  await new Promise<void>((r) => other.listen(port, "::", r)); // dual-stack wildcard, like Vite / node defaults
  const mine = await backend("worktree-a");
  const logs: string[] = [];
  const fwd = new Forwarder({
    services: { web: { dir: ".", port, cmd: "", targets: { from: 1, to: 65535 } } },
    selected: () => "C:\\wt\\a",
    discover: async () => [{ service: "web", worktree: "C:\\wt\\a", port: mine.port, pid: 1 }],
    log: (m) => logs.push(m),
    retryBindMs: 200,
  });
  try {
    await fwd.start();
    assert.equal((await get(port)).body, "other program", "the other program keeps its traffic");
    assert.match(logs.join(" | "), /held by another program/);
    await new Promise<void>((r) => other.close(() => r()));
    await sleep(600);
    assert.equal((await get(port)).body, "worktree-a", "proxy took over after the port was freed");
  } finally {
    fwd.stop();
    mine.close();
  }
});

test("a dev server started after the proxy cannot take the fixed port, however it binds", async () => {
  const port = await freePort();
  const fwd = new Forwarder({
    services: { web: { dir: ".", port, cmd: "", targets: { from: 1, to: 65535 } } },
    selected: () => null,
    discover: async () => [],
    log: () => {},
  });
  await fwd.start();
  try {
    for (const host of ["::", "0.0.0.0", "127.0.0.1", "::1", "localhost", undefined]) {
      const err = await new Promise<string>((resolve) => {
        const s = net.createServer();
        s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
        s.listen(port, host as string, () => s.close(() => resolve("bound")));
      });
      assert.equal(err, "EADDRINUSE", `listen(${port}, ${host ?? "default"}) must fail`);
    }
  } finally {
    fwd.stop();
  }
});

test("discovery attributes listeners by command line, then by current directory", () => {
  const services = {
    web: { dir: ".", port: 5173, cmd: "", targets: { from: 5174, to: 5199 } },
    api: { dir: ".", port: 5241, cmd: "", targets: { from: 5242, to: 5299 } },
  };
  const wts = ["C:\\repo", "C:\\wt\\red", "C:\\wt\\blue"];
  const found = attributeListeners(
    [
      { port: 5174, pid: 10, exe: "C:\\node.exe", cmd: "node C:\\wt\\red\\frontend\\node_modules\\vite\\bin\\vite.js", cwd: null },
      { port: 5175, pid: 11, exe: "C:\\node.exe", cmd: "node web.cjs", cwd: "C:\\wt\\blue\\examples\\demo\\" },
      { port: 5180, pid: 12, exe: "C:\\node.exe", cmd: "node web.cjs", cwd: "C:\\wt\\blue\\" }, // higher port, same worktree
      { port: 5243, pid: 13, exe: "C:\\wt\\red\\backend\\bin\\Api.exe", cmd: "Api.exe", cwd: null },
      { port: 5250, pid: 14, exe: "C:\\node.exe", cmd: "node x.js", cwd: "C:\\elsewhere\\" }, // not a worktree
      { port: 6000, pid: 15, exe: "C:\\wt\\red\\x.exe", cmd: "", cwd: null }, // outside every range
    ],
    services,
    wts,
  );
  const key = (f: Found) => `${f.service}@${f.worktree}:${f.port}`;
  assert.deepEqual(found.map(key).sort(), ["api@C:\\wt\\red:5243", "web@C:\\wt\\blue:5175", "web@C:\\wt\\red:5174"]);
});
