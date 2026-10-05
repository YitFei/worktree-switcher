import assert from "node:assert/strict";
import { test } from "node:test";
import { isWtsHook, withHook } from "../src/commands/setup.js";

const otherHook = { matcher: "*", hooks: [{ type: "command", command: "C:/orca/agent-hooks/claude-hook.cmd", timeout: 10 }] };
const settings = {
  permissions: { allow: ["Read"] },
  hooks: { PreToolUse: [otherHook], Stop: [otherHook] },
};
const CLI = "C:/tools/worktree-switcher/dist/src/cli.js";

test("adds the hook and keeps every other setting and hook", () => {
  const out = withHook(settings, CLI, false) as typeof settings;
  assert.deepEqual(out.permissions, settings.permissions);
  assert.deepEqual(out.hooks.Stop, [otherHook]);
  assert.equal(out.hooks.PreToolUse.length, 2);
  assert.deepEqual(out.hooks.PreToolUse[0], otherHook);
  assert.ok(isWtsHook(out.hooks.PreToolUse[1]));
});

test("running setup again does not add a second hook, and moves an old install path", () => {
  const old = withHook(settings, "C:/old/place/dist/src/cli.js", false);
  const again = withHook(old, CLI, false) as typeof settings;
  const ours = again.hooks.PreToolUse.filter(isWtsHook) as unknown as { hooks: { args: string[] }[] }[];
  assert.equal(ours.length, 1);
  assert.equal(ours[0].hooks[0].args[0], CLI);
});

test("uninstall removes only the wts hook", () => {
  const removed = withHook(withHook(settings, CLI, false), CLI, true) as typeof settings;
  assert.deepEqual(removed.hooks.PreToolUse, [otherHook]);
  assert.deepEqual(withHook({}, CLI, true), {}, "nothing to remove leaves no empty hooks object");
});

test("recognises older hook forms but not other tools' hooks", () => {
  assert.ok(isWtsHook({ hooks: [{ command: "wts hook" }] }));
  assert.ok(isWtsHook({ hooks: [{ command: "node", args: ["C:\\x\\dist\\src\\cli.js", "hook"] }] }));
  assert.equal(isWtsHook(otherHook), false);
  assert.equal(isWtsHook({ hooks: [{ command: "node", args: ["C:/x/other.js", "hook"] }] }), false);
});
