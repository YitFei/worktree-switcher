import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { WtsError } from "../src/errors.js";
import { parseWorktreeList } from "../src/git.js";
import { checkLock } from "../src/state.js";

test("parses a valid config with defaults", () => {
  const c = parseConfig(JSON.stringify({ services: { web: { port: 5173, cmd: "npm run dev" } } }), "wts.json");
  assert.deepEqual(c, { readyTimeoutSec: 120, services: { web: { dir: ".", port: 5173, cmd: "npm run dev" } } });
});

test("rejects bad configs", () => {
  const bad = [
    "not json",
    "[]",
    JSON.stringify({ services: {} }),
    JSON.stringify({ services: { web: { port: "5173", cmd: "x" } } }),
    JSON.stringify({ services: { web: { port: 70000, cmd: "x" } } }),
    JSON.stringify({ services: { web: { port: 1, cmd: "" } } }),
    JSON.stringify({ services: { a: { port: 1, cmd: "x" }, b: { port: 1, cmd: "y" } } }),
    JSON.stringify({ readyTimeoutSec: 0, services: { a: { port: 1, cmd: "x" } } }),
  ];
  for (const text of bad) assert.throws(() => parseConfig(text, "wts.json"), WtsError, text);
});

test("parses git worktree list --porcelain", () => {
  const out = "worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/wt/a\nHEAD def\ndetached\n";
  assert.equal(parseWorktreeList(out).length, 2);
});

test("lock: another worktree's lock refuses with exit 2 unless forced", () => {
  const lock = { worktree: "C:\\repo\\a", time: "t" };
  assert.throws(() => checkLock(lock, "C:\\repo\\b", false), (e: WtsError) => e.exitCode === 2);
  assert.doesNotThrow(() => checkLock(lock, "C:\\repo\\b", true));
  assert.doesNotThrow(() => checkLock(lock, "c:/repo/a", false));
  assert.doesNotThrow(() => checkLock(null, "C:\\repo\\b", false));
});
