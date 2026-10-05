import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describeHolder } from "../src/owner.js";

test("names who holds a fixed port", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wts-holder-"));
  const main = path.join(root, "projects", "app");
  const ws = path.join(root, "workspaces", "app");
  for (const d of [main, path.join(ws, "demo1-2"), path.join(ws, "demo1"), path.join(root, "projects", "other")]) fs.mkdirSync(d, { recursive: true });
  const worktrees = [main, path.join(ws, "demo1-2")];
  const at = (cwd: string | null, cmd: string, exe = path.join("C:", "node.exe")) => describeHolder({ port: 5273, pid: 42, exe, cmd, cwd }, worktrees);

  assert.equal(at(null, `"node" ${path.join("C:", "x", "cli.js")} watch`).isWts, true, "the wts proxy");
  const own = at(path.join(ws, "demo1-2", "frontend"), `node ${path.join(ws, "demo1-2", "frontend", "node_modules", "vite", "bin", "vite.js")}`);
  assert.equal(own.text, "demo1-2's Vite (pid 42)");

  const left = at(path.join(ws, "demo1", "api"), "node server.js --port 5341"); // folder still on disk, no longer a worktree
  assert.match(left.text, /left over from .*demo1, which is no longer a worktree/);
  const gone = at(path.join(ws, "demo9", "api"), "node server.js");
  assert.match(gone.text, /demo9, which no longer exists/);

  const unrelated = at(path.join(root, "projects", "other"), "node server.js");
  assert.equal(unrelated.deleted, null, "another project next to the main checkout is not a leftover");
  assert.match(unrelated.text, /^pid 42 node\.exe/);
  fs.rmSync(root, { recursive: true, force: true });
});
