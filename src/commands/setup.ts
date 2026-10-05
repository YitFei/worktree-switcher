// `wts setup`: register wts with Claude Code — the MCP server (user scope) and the PreToolUse
// hook — pointing at this installation's cli.js. Re-running fixes paths after an upgrade or a move;
// `--uninstall` removes both. Codex is not edited; its config snippet is printed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WtsError } from "../errors.js";

export const MCP_NAME = "worktree-switcher";
/** Names this server was registered under before (removed on setup). */
const OLD_MCP_NAMES = ["wts"];

export interface SetupOptions {
  mcp: boolean;
  hook: boolean;
  uninstall: boolean;
  dryRun: boolean;
}

/** Absolute path of this installation's cli.js (what the MCP server and the hook run). */
export function cliPath(): string {
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

export function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

interface HookCommand {
  type?: string;
  command?: string;
  args?: string[];
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

/** Our hook entry, whichever installation path it points at (`node <…>/cli.js hook` or `wts hook`). */
export function isWtsHook(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some(
    (h) =>
      (h.command === "node" && h.args?.[1] === "hook" && /[\\/]cli\.js$/i.test(h.args?.[0] ?? "")) ||
      /(^|[\\/\s"])wts(\.cmd)?"?\s+hook\b/.test(h.command ?? ""),
  );
}

/** Settings with our PreToolUse hook added (or removed); every other setting and hook is kept. */
export function withHook(settings: Record<string, unknown>, cli: string, remove: boolean): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, unknown>) ?? {}) };
  const pre = ((hooks.PreToolUse as HookEntry[]) ?? []).filter((e) => !isWtsHook(e));
  if (!remove) {
    pre.push({ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: "node", args: [cli, "hook"], timeout: 10 } as HookCommand] });
  }
  if (pre.length > 0) hooks.PreToolUse = pre;
  else delete hooks.PreToolUse;
  const out = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete (out as Record<string, unknown>).hooks;
  return out;
}

function updateHook(remove: boolean, dryRun: boolean): void {
  const file = settingsPath();
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new WtsError(`${file} is not valid JSON (${(e as Error).message}); not touching it. Fix it, or pass --no-hook.`);
    }
  }
  const next = withHook(settings, cliPath(), remove);
  const verb = remove ? "remove the wts hook from" : "add the wts PreToolUse hook to";
  if (dryRun) {
    console.log(`would ${verb} ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.wts-backup`);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  console.log(`${remove ? "removed the wts hook from" : "hook: added to"} ${file}${fs.existsSync(`${file}.wts-backup`) ? " (backup: settings.json.wts-backup)" : ""}`);
}

/** Run a `claude` CLI command (claude may be a .cmd shim, hence the shell). */
function claude(args: string, dryRun: boolean, quiet = false): boolean {
  if (dryRun) {
    console.log(`would run: claude ${args}`);
    return true;
  }
  const r = spawnSync(`claude ${args}`, { shell: true, encoding: "utf8", windowsHide: true });
  if (r.status !== 0 && !quiet) console.log(`claude ${args} failed: ${(r.stderr || r.stdout || "").trim().split(/\r?\n/).pop()}`);
  return r.status === 0;
}

function hasClaude(): boolean {
  return spawnSync("claude --version", { shell: true, encoding: "utf8", windowsHide: true }).status === 0;
}

function updateMcp(remove: boolean, dryRun: boolean): void {
  const add = `mcp add --scope user ${MCP_NAME} -- node "${cliPath()}" mcp`;
  if (!dryRun && !hasClaude()) {
    console.log(`Claude Code's \`claude\` command was not found. Register the MCP server yourself:\n  claude ${add}`);
    return;
  }
  for (const name of [MCP_NAME, ...OLD_MCP_NAMES]) claude(`mcp remove ${name} -s user`, dryRun, true);
  if (remove) {
    console.log(`mcp: removed ${MCP_NAME} from Claude Code`);
    return;
  }
  if (claude(add, dryRun) && !dryRun) console.log(`mcp: registered ${MCP_NAME} in Claude Code (user scope) -> ${cliPath()}`);
}

export function setup(opts: SetupOptions): void {
  if (opts.mcp) updateMcp(opts.uninstall, opts.dryRun);
  if (opts.hook) updateHook(opts.uninstall, opts.dryRun);
  if (opts.uninstall) return;
  const cli = cliPath().replace(/\\/g, "/");
  console.log(`
Codex: add to ~/.codex/config.toml
  [mcp_servers.${MCP_NAME}]
  command = "node"
  args = ["${cli}", "mcp"]

Start a new agent session (or reconnect via /mcp) so it picks up the tools.
Then, in a project: ask your agent to "set up wts" (or run \`wts init --mode run|proxy\`).`);
}
