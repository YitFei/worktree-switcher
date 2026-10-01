import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute, isAlive, isDescendant, matchWorktree, type ProcInfo, type Procs } from "../src/owner.js";
import type { State } from "../src/state.js";

// Real worktree layout from the InsightHub repo, including a worktree nested inside main.
const MAIN = "C:\\Users\\YitFei\\projects\\InsightHub";
const NESTED = "C:\\Users\\YitFei\\projects\\InsightHub\\.claude\\worktrees\\superset-brand-color";
const ORCA = "C:\\Users\\YitFei\\orca\\workspaces\\InsightHub\\Bandwidth-Assign";
const WORKTREES = [MAIN, ORCA, NESTED];

function procs(...list: Partial<ProcInfo>[]): Procs {
  return new Map(list.map((p) => [p.pid!, { ppid: 0, name: "x", exe: null, cmd: null, created: 1000, ...p } as ProcInfo]));
}

test("matches the Vite node command line to its worktree", () => {
  const cmd = `"node"   "C:\\Users\\YitFei\\projects\\InsightHub\\frontend\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js"`;
  assert.equal(matchWorktree(cmd, WORKTREES), MAIN);
});

test("nested worktree wins over its parent (longest match)", () => {
  const exe = `${NESTED}\\backend\\InsightHub.API\\bin\\Debug\\net9.0\\InsightHub.API.exe`;
  assert.equal(matchWorktree(exe, WORKTREES), NESTED);
});

test("matching is case- and slash-insensitive", () => {
  assert.equal(matchWorktree("c:/users/yitfei/orca/workspaces/insighthub/bandwidth-assign/frontend/x.js", WORKTREES), ORCA);
});

test("a sibling directory sharing a prefix does not match", () => {
  assert.equal(matchWorktree("C:\\Users\\YitFei\\projects\\InsightHub-old\\frontend\\x.js", WORKTREES), null);
});

test("unrelated process is not attributed", () => {
  assert.equal(matchWorktree("python -m http.server 5173", WORKTREES), null);
  assert.equal(matchWorktree(null, WORKTREES), null);
});

test("descendant walk follows parents and stops at PID reuse", () => {
  const p = procs(
    { pid: 10, ppid: 1, created: 1000 }, // cmd.exe spawned by wts
    { pid: 11, ppid: 10, created: 1100 }, // dotnet run
    { pid: 12, ppid: 11, created: 1200 }, // API exe
    { pid: 20, ppid: 10, created: 500 }, // claims parent 10 but is older → reused PID
  );
  assert.equal(isDescendant(12, 10, p), true);
  assert.equal(isDescendant(10, 10, p), true);
  assert.equal(isDescendant(20, 10, p), false);
  assert.equal(isDescendant(99, 10, p), false);
});

test("isAlive rejects a reused PID", () => {
  const p = procs({ pid: 10, created: 50_000 });
  assert.equal(isAlive({ pid: 10, created: 50_500 }, p), true);
  assert.equal(isAlive({ pid: 10, created: 1000 }, p), false);
  assert.equal(isAlive({ pid: 11, created: 50_000 }, p), false);
});

test("attribute: process in a wts-started tree belongs to the state owner", () => {
  const p = procs({ pid: 10, ppid: 1, created: 1000 }, { pid: 12, ppid: 10, created: 1200, name: "python.exe", cmd: "python app.py" });
  const state: State = { owner: ORCA, startedAt: "", services: { api: { pid: 10, created: 1000, port: 8000 } } };
  assert.deepEqual(attribute(12, p, WORKTREES, state), { worktree: ORCA, viaWts: true });
  assert.deepEqual(attribute(12, p, WORKTREES, null), { worktree: null, viaWts: false });
});

test("attribute: falls back to the process's own exe path", () => {
  const p = procs({ pid: 30, exe: `${ORCA}\\backend\\InsightHub.API\\bin\\Debug\\net9.0\\InsightHub.API.exe` });
  assert.deepEqual(attribute(30, p, WORKTREES, null), { worktree: ORCA, viaWts: false });
});
