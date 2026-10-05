// `wts hook`: Claude Code PreToolUse guard. Agents in a wts-managed worktree may not start dev
// servers themselves or override a lock; they are pointed at wts_switch instead.
// Exit 2 + stderr blocks the tool call (Claude Code shows stderr to the agent); exit 0 allows.
// Any problem inside the guard allows: it must never break an agent's unrelated work.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE } from "./config.js";
import { worktreeRoot } from "./git.js";

const DEV_SERVERS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/i,
  /(^|[\s;&|(])(npx\s+|pnpm\s+exec\s+)?vite(?!\S)(?!\s+(build|preview|optimize)\b)/i,
  /\bnext\s+dev\b/i,
  /\bdotnet\s+run\b/i,
  /\bdotnet\s+watch\b(?!\s+(test|build)\b)/i,
];
const FORCE = /\bwts\b[^;&|]*\s--force\b/i;

/**
 * The parts of a shell command that run as commands: heredoc bodies and quoted strings are
 * removed, so text that only mentions a dev server (a prompt, a commit message, a file being
 * written) is not mistaken for running one. `bash -c "npm run dev"` slips through; accepted.
 */
export function executableText(cmd: string): string {
  return cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/** Why this command must not be run by an agent in a wts-managed worktree, or null. */
export function checkCommand(raw: string): string | null {
  const cmd = executableText(raw);
  if (FORCE.test(cmd)) {
    return "agents may not override a wts lock (--force). The user locked the dev servers on purpose: tell them instead.";
  }
  if (DEV_SERVERS.some((re) => re.test(cmd))) {
    return "this repo's dev servers are managed by wts (wts.json). Do not start them yourself: call the wts_switch MCP tool (or run `wts switch`) to run them from your worktree, and wts_status / wts_logs to inspect. If wts refuses, tell the user.";
  }
  return null;
}

/** The directory a command runs in: a leading `cd <dir> &&` / `cd <dir>;` overrides the session cwd. */
export function commandDir(cmd: string, cwd: string): string {
  const m = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(&&|;)/.exec(cmd);
  return m ? path.resolve(cwd, m[1].replace(/^["']|["']$/g, "")) : cwd;
}

function isManaged(dir: string): boolean {
  try {
    return fs.existsSync(path.join(worktreeRoot(dir), CONFIG_FILE));
  } catch {
    return false;
  }
}

interface HookInput {
  tool_name?: string;
  tool_input?: { command?: unknown };
  cwd?: string;
}

/** Decision for one PreToolUse event: exit code + message. */
export function decide(input: HookInput, managed: (dir: string) => boolean = isManaged): { code: 0 | 2; message?: string } {
  if (input.tool_name !== "Bash" && input.tool_name !== "PowerShell") return { code: 0 };
  const cmd = input.tool_input?.command;
  if (typeof cmd !== "string") return { code: 0 };
  const reason = checkCommand(cmd);
  if (!reason || !managed(commandDir(cmd, input.cwd ?? process.cwd()))) return { code: 0 };
  return { code: 2, message: `Blocked by wts: ${reason}` };
}

export async function runHook(): Promise<number> {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const { code, message } = decide(JSON.parse(raw) as HookInput);
    if (message) process.stderr.write(message + "\n");
    return code;
  } catch {
    return 0;
  }
}
