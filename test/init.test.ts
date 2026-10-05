import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig } from "../src/config.js";
import { proposeInit } from "../src/init.js";
import { createServer } from "../src/mcp.js";

/** A repo shaped like InsightHub: Vite frontend, .NET API, plus an untracked copy and a portless tool. */
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wts-init-"));
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put("frontend/package.json", JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
  put("frontend/vite.config.ts", "export default { server: { port: 5173, proxy: { '/api': { target: 'http://localhost:5241' } } } }");
  put(
    "backend/Shop.Api/Properties/launchSettings.json",
    "﻿" + JSON.stringify({ profiles: { http: { commandName: "Project", applicationUrl: "http://localhost:5241" }, IIS: { commandName: "IISExpress" } } }),
  );
  put("tools/package.json", JSON.stringify({ scripts: { start: "node worker.js" } }));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  put("copy/frontend/package.json", JSON.stringify({ scripts: { dev: "vite --port 6000" } })); // untracked
  return dir;
}

test("detects a Vite frontend and a .NET API from tracked files only", () => {
  const dir = fixture();
  const p = proposeInit(dir, "proxy");
  const summary = p.services.map((s) => `${s.name}:${s.framework}:${s.dir}:${s.port}`).sort();
  assert.deepEqual(summary, ["backend:dotnet:backend/Shop.Api:5241", "frontend:vite:frontend:5173", "tools:node:tools:null"]);
  assert.ok(p.notes.some((n) => /proxies the API to localhost:5241/.test(n)));
  assert.ok(p.notes.some((n) => /no port found for tools/.test(n)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("builds valid configs for both modes", () => {
  const dir = fixture();
  const proxy = parseConfig(proposeInit(dir, "proxy").json, "wts.json");
  assert.equal(proxy.mode, "proxy");
  assert.deepEqual(proxy.services.frontend.targets, { from: 5174, to: 5199 });
  assert.deepEqual(proxy.services.backend.targets, { from: 5242, to: 5267 });
  assert.equal(proxy.services.tools, undefined, "a service without a port is left out");

  const run = parseConfig(proposeInit(dir, "run").json, "wts.json");
  assert.equal(run.mode, "run");
  assert.equal(run.services.frontend.cmd, "npm run dev -- --strictPort");
  assert.equal(run.services.backend.cmd, "dotnet run --launch-profile http");
  assert.equal(run.readyTimeoutSec, 180);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("MCP wts_init: proposes, writes on request, refuses to overwrite", async () => {
  const dir = fixture();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(dir).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const sc = (r: Awaited<ReturnType<typeof client.callTool>>) => r.structuredContent as { ok: boolean; written?: boolean; refused?: boolean };

  const proposal = await client.callTool({ name: "wts_init", arguments: { mode: "proxy" } });
  assert.equal(sc(proposal).written, false);
  assert.ok(!fs.existsSync(path.join(dir, "wts.json")), "a proposal writes nothing");

  const written = await client.callTool({ name: "wts_init", arguments: { mode: "proxy", write: true } });
  assert.equal(sc(written).written, true);
  assert.equal(parseConfig(fs.readFileSync(path.join(dir, "wts.json"), "utf8"), "wts.json").mode, "proxy");

  const again = await client.callTool({ name: "wts_init", arguments: { mode: "run", write: true } });
  assert.equal(sc(again).refused, true);
  assert.equal(parseConfig(fs.readFileSync(path.join(dir, "wts.json"), "utf8"), "wts.json").mode, "proxy", "unchanged");

  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
