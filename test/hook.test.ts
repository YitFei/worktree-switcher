import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommand, commandDir, decide } from "../src/hook.js";

test("dev-server commands and lock overrides are blocked", () => {
  const blocked = [
    "npm run dev",
    "npm run dev -- --strictPort",
    "cd frontend && npm run dev",
    "pnpm dev",
    "yarn dev",
    "npm start",
    "npm run start",
    "npx vite",
    "vite",
    "vite --port 5174",
    "next dev",
    "dotnet run --project InsightHub.API",
    "dotnet watch run",
    "wts switch --force",
    "wts unlock --force",
  ];
  for (const cmd of blocked) assert.ok(checkCommand(cmd), `should block: ${cmd}`);
});

test("builds, tests and normal wts use are allowed", () => {
  const allowed = [
    "npm test",
    "npm run build",
    "npm install",
    "vite build",
    "npx vite build",
    "cat vite.config.ts",
    "dotnet build",
    "dotnet test",
    "dotnet watch test",
    "wts switch",
    "wts status",
    "git commit -m 'npm run dev fix'".replace("npm run dev", "dev server"),
  ];
  for (const cmd of allowed) assert.equal(checkCommand(cmd), null, `should allow: ${cmd}`);
});

test("a leading cd decides which worktree is checked", () => {
  assert.equal(commandDir("cd frontend && npm run dev", "C:\\repo"), "C:\\repo\\frontend");
  assert.equal(commandDir('cd "C:\\other repo" ; npm run dev', "C:\\repo"), "C:\\other repo");
  assert.equal(commandDir("npm run dev", "C:\\repo"), "C:\\repo");
});

test("only Bash/PowerShell calls in a wts-managed worktree are blocked", () => {
  const managed = (dir: string) => dir.startsWith("C:\\managed");
  const run = (tool: string, cwd: string, command = "npm run dev") => decide({ tool_name: tool, cwd, tool_input: { command } }, managed);
  assert.equal(run("Bash", "C:\\managed\\wt").code, 2);
  assert.match(run("PowerShell", "C:\\managed\\wt").message!, /wts_switch/);
  assert.equal(run("Bash", "C:\\plain\\repo").code, 0);
  assert.equal(run("Read", "C:\\managed\\wt").code, 0);
  assert.equal(run("Bash", "C:\\managed\\wt", "npm test").code, 0);
  assert.equal(decide({ tool_name: "Bash" }, managed).code, 0);
});
