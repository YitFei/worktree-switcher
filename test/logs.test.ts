import assert from "node:assert/strict";
import { test } from "node:test";
import { logWindowCommand } from "../src/commands/logs.js";

test("Logs opens a console window that follows every service log", () => {
  const cmd = logWindowCommand("wts logs - MyApp", "C:\\Program Files\\nodejs\\node.exe", "C:\\tools\\wts\\dist\\src\\cli.js");
  assert.equal(cmd, 'start "wts logs - MyApp" "C:\\Program Files\\nodejs\\node.exe" "C:\\tools\\wts\\dist\\src\\cli.js" logs -f');
});

test("quotes and cmd metacharacters never leave the window title", () => {
  const cmd = logWindowCommand('wts logs - My"App & co|x%PATH%', "node.exe", "cli.js");
  assert.equal(cmd, 'start "wts logs - MyApp  coxPATH" "node.exe" "cli.js" logs -f');
});
