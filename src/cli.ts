#!/usr/bin/env node
import { parseArgs } from "node:util";
import { WtsError } from "./errors.js";
import { loadContext, loadContextWithConfig } from "./context.js";
import { status } from "./commands/status.js";
import { switchTo } from "./commands/switch.js";
import { stop } from "./commands/stop.js";
import { logs } from "./commands/logs.js";
import { lock, unlock } from "./commands/lock.js";
import { watch } from "./commands/watch.js";
import { focus } from "./commands/focus.js";
import { serveMcp } from "./mcp.js";

const USAGE = `wts — switch which git worktree owns the repo's dev-server ports

Usage (run inside any worktree that has a wts.json):
  wts status                     who owns each configured port
  wts switch [--force]           stop the current owner, start services from this worktree
  wts stop [--force]             stop services owned by worktrees of this repo
  wts logs [service] [-n 50] [-f]
  wts lock [--note "..."] [--force]
  wts unlock [--force]
  wts watch [--orca] [--delay 3] [--orca-db <file>] [--ui float|tray|none]
                                 follow the worktree you are looking at and switch to it;
                                 shows a floating button (hover = status, click = menu)
  wts focus [path]               tell a running \`wts watch\` which worktree you are on
  wts mcp                        MCP server (stdio) for coding agents

--force overrides a lock held by another worktree. Processes that cannot be attributed
to a worktree of this repo are never killed.`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      note: { type: "string" },
      n: { type: "string", short: "n", default: "50" },
      follow: { type: "boolean", short: "f", default: false },
      help: { type: "boolean", short: "h", default: false },
      orca: { type: "boolean", default: false },
      "orca-db": { type: "string" },
      delay: { type: "string", default: "3" },
      ui: { type: "string", default: "float" },
      "no-tray": { type: "boolean", default: false },
    },
  });
  const [command, arg] = positionals;
  const cwd = process.cwd();

  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "status":
      return status(loadContextWithConfig(cwd));
    case "switch":
    case "up":
      return switchTo(loadContextWithConfig(cwd), values.force);
    case "stop":
      return stop(loadContextWithConfig(cwd), values.force);
    case "logs": {
      const n = Number(values.n);
      if (!Number.isInteger(n) || n < 0) throw new WtsError("-n must be a non-negative integer", 2);
      return logs(loadContextWithConfig(cwd), arg, n, values.follow);
    }
    case "lock":
      return lock(loadContext(cwd), values.note, values.force);
    case "unlock":
      return unlock(loadContext(cwd), values.force);
    case "watch": {
      const delaySec = Number(values.delay);
      if (!Number.isFinite(delaySec) || delaySec < 0) throw new WtsError("--delay must be a non-negative number", 2);
      const ui = values["no-tray"] ? "none" : values.ui;
      if (ui !== "float" && ui !== "tray" && ui !== "none") throw new WtsError("--ui must be float, tray or none", 2);
      return watch({ orca: values.orca, orcaDb: values["orca-db"], delaySec, ui });
    }
    case "focus":
      return focus(arg ?? cwd);
    case "mcp":
      return serveMcp();
    default:
      throw new WtsError(`unknown command "${command}"\n\n${USAGE}`, 2);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof WtsError) {
    console.error(`wts: ${e.message}`);
    process.exit(e.exitCode);
  }
  if (e instanceof Error && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`wts: ${e.message}`);
    process.exit(2);
  }
  throw e;
});
