import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { attributeListeners } from "../src/discover.js";
import { createServer } from "../src/mcp.js";
import { assignPorts, startHint } from "../src/ports.js";

const services = {
  web: { dir: "frontend", port: 5273, cmd: "", targets: { from: 5274, to: 5299 } },
  api: { dir: "api", port: 5341, cmd: "", targets: { from: 5342, to: 5367 } },
};
const A = "C:\\wt\\demo1";
const B = "C:\\wt\\demo2";
const C = "C:\\wt\\demo3";

test("each worktree gets its own stable ports; running servers are adopted", () => {
  // demo1 already runs web on 5274; 5342 is used by some other program
  const found = [{ service: "web", worktree: A, port: 5274, pid: 1 }];
  const r1 = assignPorts({}, [A, B, C], B, services, found, new Set([5274, 5342]));
  assert.deepEqual(r1.mine, { web: 5275, api: 5343 }, "skips demo1's port and the busy 5342");
  assert.equal(r1.map[A].web, 5274, "demo1 adopted the port it already runs on");

  const r2 = assignPorts(r1.map, [A, B, C], B, services, [], new Set());
  assert.deepEqual(r2.mine, { web: 5275, api: 5343 }, "stable on the next ask");
  assert.equal(r2.changed, false);

  const r3 = assignPorts(r2.map, [A, C], C, services, [], new Set());
  assert.equal(r3.map[B], undefined, "a removed worktree loses its ports");
  assert.deepEqual(r3.mine, { web: 5275, api: 5342 }, "freed ports can be reused");
});

test("discovery prefers the worktree's assigned port over a lower one", () => {
  const listeners = [
    { port: 5274, pid: 1, exe: null, cmd: "node x", cwd: "C:\\wt\\demo2\\frontend\\" },
    { port: 5276, pid: 2, exe: null, cmd: "node x", cwd: "C:\\wt\\demo2\\frontend\\" },
  ];
  const plain = attributeListeners(listeners, services, [A, B]);
  assert.equal(plain[0].port, 5274);
  const preferred = attributeListeners(listeners, services, [A, B], { [B]: { web: 5276 } });
  assert.equal(preferred[0].port, 5276);
});

test("start hints follow the framework", () => {
  assert.equal(startHint("vite", "frontend", 5275), "cd frontend && npm run dev -- --port 5275 --strictPort");
  assert.equal(startHint("dotnet", "backend/Api", 5343), "cd backend/Api && dotnet run --urls http://localhost:5343");
  assert.match(startHint(undefined, ".", 5343), /port 5343/);
});

test("MCP: a worktree without wts.json is told another worktree has one", async () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), "wts-else-"));
  execFileSync("git", ["init", "-q", main]);
  execFileSync("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const other = `${main}-wt`;
  execFileSync("git", ["-C", main, "worktree", "add", "-q", other]);
  fs.writeFileSync(path.join(main, "wts.json"), JSON.stringify({ mode: "proxy", services: { web: { port: 5273, targets: "5274-5299" } } }));

  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(other).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const r = await client.callTool({ name: "wts_status", arguments: {} });
  const sc = r.structuredContent as { configured: boolean; reason: string; configuredElsewhere: string[] };
  assert.equal(sc.configured, false);
  assert.equal(sc.configuredElsewhere.length, 1);
  assert.match(sc.reason, /not committed or not merged/);
  await client.close();
  execFileSync("git", ["-C", main, "worktree", "remove", "--force", other]);
  fs.rmSync(main, { recursive: true, force: true });
});
