import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, INSTRUCTIONS } from "../src/mcp.js";

async function connect(cwd: string): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(cwd).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

function tempRepo(withConfig: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wts-mcp-"));
  execFileSync("git", ["init", "-q", dir]);
  if (withConfig) {
    fs.writeFileSync(path.join(dir, "wts.json"), JSON.stringify({ services: { web: { port: 47173, cmd: "node web.js" } } }));
  }
  return dir;
}

test("lists the tools and hands agents the usage rules", async () => {
  const client = await connect(os.tmpdir());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["wts_init", "wts_logs", "wts_status", "wts_stop", "wts_switch"]);
  assert.equal(client.getInstructions(), INSTRUCTIONS);
  await client.close();
});

test("a worktree without wts.json answers 'not configured' instead of failing", async () => {
  const dir = tempRepo(false);
  const client = await connect(dir);
  const r = await client.callTool({ name: "wts_switch", arguments: {} });
  assert.equal((r.structuredContent as { configured: boolean }).configured, false);
  assert.ok(!r.isError);
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a lock held by another worktree is reported as refused and nothing starts", async () => {
  const dir = tempRepo(true);
  const store = path.join(dir, ".git", "wts");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "lock.json"), JSON.stringify({ worktree: "C:\\somewhere\\else", note: "user testing", time: "t" }));
  const client = await connect(dir);
  const r = await client.callTool({ name: "wts_switch", arguments: {} });
  const sc = r.structuredContent as { refused: boolean; reason: string };
  assert.equal(r.isError, true);
  assert.equal(sc.refused, true);
  assert.match(sc.reason, /locked by .*user testing.*Do not override/);
  assert.doesNotMatch(sc.reason, /--force/);
  assert.ok(!fs.existsSync(path.join(store, "state.json")), "no service was started");
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
