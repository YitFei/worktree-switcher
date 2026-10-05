import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Debouncer } from "../src/commands/watch.js";
import { parseOrcaActive } from "../src/focus/orca.js";

test("parseOrcaActive extracts the worktree path", () => {
  const payload = JSON.stringify({
    activeWorktreeId: "eee120f2-55de-49e4-ba78-0430ba1a79da::C:/Users/YitFei/orca/workspaces/wts-demo/demo1",
    activeTabId: "x",
  });
  assert.equal(parseOrcaActive(payload), path.resolve("C:/Users/YitFei/orca/workspaces/wts-demo/demo1"));
});

test("parseOrcaActive ignores non-worktree views and bad data", () => {
  assert.equal(parseOrcaActive(JSON.stringify({ activeWorktreeId: "folder:6b37cf1d-3be3-4dcf-b7e9-16b5228c0278" })), null);
  assert.equal(parseOrcaActive(JSON.stringify({ activeWorktreeId: null })), null);
  assert.equal(parseOrcaActive(JSON.stringify({ activeWorktreeId: "abc::" })), null);
  assert.equal(parseOrcaActive("not json"), null);
  assert.equal(parseOrcaActive("null"), null);
});

test("Debouncer emits only after the value is stable for the delay, once", () => {
  const d = new Debouncer(3000);
  assert.equal(d.update("a", 0), null);
  assert.equal(d.update("a", 2999), null);
  assert.equal(d.update("a", 3000), "a");
  assert.equal(d.update("a", 9000), null); // already emitted
});

test("Debouncer: clicking through quickly only emits the last value", () => {
  const d = new Debouncer(3000);
  d.update("a", 0);
  d.update("b", 1000);
  assert.equal(d.update("b", 3500), null); // b only stable for 2.5s
  assert.equal(d.update("b", 4000), "b");
  d.update("a", 5000);
  assert.equal(d.update("a", 8000), "a"); // back to a is a new settle
  assert.equal(d.update(null, 9000), null);
});

test("widget tooltip is cut to the 63-character NotifyIcon limit", async () => {
  const { fitTooltip } = await import("../src/platform/widget.js");
  assert.equal(fitTooltip("wts: demo1 · :4173 :4241"), "wts: demo1 · :4173 :4241");
  const long = fitTooltip("x".repeat(100));
  assert.equal(long.length, 63);
  assert.ok(long.endsWith("…"));
});

test("Auto/Manual is remembered; Manual is the default", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadAuto, saveAuto } = await import("../src/commands/watch.js");
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wts-home-"));
  process.env.USERPROFILE = tmp;
  process.env.HOME = tmp;
  try {
    assert.equal(loadAuto(), false, "default Manual");
    saveAuto(true);
    assert.equal(loadAuto(), true);
    saveAuto(false);
    assert.equal(loadAuto(), false);
  } finally {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("route lines are aligned in columns", async () => {
  const { alignRoutes } = await import("../src/commands/watch.js");
  const lines = alignRoutes([
    [":5341", "──→", ":5344", "api"],
    [":5273", "──→", "start on :5276", "frontend"],
    [":80", "──✗", "held by another program", "web"],
  ]);
  for (const l of lines) console.log(`    |${l}|`);
  const col = (l: string, s: string) => l.indexOf(s);
  assert.equal(new Set(lines.map((l) => col(l, "──"))).size, 1, "arrows line up");
  assert.equal(new Set([col(lines[0], "api"), col(lines[1], "frontend"), col(lines[2], "web")]).size, 1, "service names line up");
});
