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
import { runHook } from "./hook.js";
import { assignedWithHints, runProxy } from "./commands/select.js";
import { planPorts } from "./discover.js";
import { proposeInit, writeInit } from "./init.js";

const USAGE = `wts — switch which git worktree owns the repo's dev-server ports

Usage (run inside any worktree that has a wts.json):
  wts status                     who owns each configured port
  wts switch [--force]           run mode: stop the current owner, start this worktree's services
                                 proxy mode: forward the fixed ports to this worktree
  wts proxy                      proxy mode: run the forwarder (wts watch also runs it)
  wts port [service]             proxy mode: the port this worktree runs a service on (and how to start it)
  wts stop [--force]             stop services owned by worktrees of this repo
  wts logs [service] [-n 50] [-f]
  wts lock [--note "..."] [--force]
  wts unlock [--force]
  wts watch [--auto|--manual] [--delay 3] [--no-orca] [--ui float|tray|none]
                                 floating button (status, menu, restart, Auto/Manual) and the
                                 proxy for proxy-mode repos; Auto follows the worktree you select
                                 in Orca, Manual (default, remembered) switches only on request
  wts restart [--force]          run mode: restart this worktree's servers
  wts focus [path]               tell a running \`wts watch\` which worktree you are on
  wts init --mode run|proxy [--write] [--overwrite]
                                 detect the dev servers and propose (or write) a wts.json
  wts mcp                        MCP server (stdio) for coding agents
  wts hook                       Claude Code PreToolUse guard (reads the event on stdin)

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
      orca: { type: "boolean" },
      "no-orca": { type: "boolean", default: false },
      auto: { type: "boolean", default: false },
      manual: { type: "boolean", default: false },
      "orca-db": { type: "string" },
      delay: { type: "string", default: "3" },
      ui: { type: "string", default: "float" },
      "no-tray": { type: "boolean", default: false },
      mode: { type: "string" },
      write: { type: "boolean", default: false },
      overwrite: { type: "boolean", default: false },
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
      await switchTo(loadContextWithConfig(cwd), values.force);
      return;
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
      if (values.auto && values.manual) throw new WtsError("--auto and --manual are exclusive", 2);
      const orca = values["no-orca"] ? false : values.orca ? true : undefined;
      const auto = values.auto ? true : values.manual ? false : undefined;
      return watch({ orca, auto, orcaDb: values["orca-db"], delaySec, ui });
    }
    case "focus":
      return focus(arg ?? cwd);
    case "proxy":
      return runProxy(loadContextWithConfig(cwd));
    case "restart": {
      const ctx = loadContextWithConfig(cwd);
      if (ctx.config.mode === "proxy") {
        console.log("proxy mode: wts does not run your servers. Restart the server in its own terminal; the proxy picks it up by itself.");
        return;
      }
      await switchTo(ctx, values.force, { restart: true });
      return;
    }
    case "port": {
      const ctx = loadContextWithConfig(cwd);
      if (ctx.config.mode !== "proxy") throw new WtsError("`wts port` is for proxy mode; in run mode wts starts the servers on the fixed ports", 2);
      const assigned = assignedWithHints(ctx, (await planPorts(ctx)).mine);
      if (arg) {
        if (!assigned[arg]) throw new WtsError(`unknown service "${arg}" (or no free port left in its range)`, 2);
        console.log(String(assigned[arg].port)); // bare number, for scripts
      } else {
        for (const [s, a] of Object.entries(assigned)) console.log(`${s}: ${a.port}  ->  ${a.startHint}`);
      }
      return;
    }
    case "init": {
      if (values.mode !== "run" && values.mode !== "proxy") throw new WtsError("--mode run or --mode proxy is required (your choice: see README)", 2);
      const p = proposeInit(cwd, values.mode);
      for (const s of p.services) console.log(`${s.name}: ${s.framework} in ${s.dir}, port ${s.port ?? "?"} (from ${s.source})`);
      console.log("");
      if (p.json) console.log(p.json);
      for (const n of p.notes) console.log(`note: ${n}`);
      if (values.write) {
        writeInit(p, values.overwrite);
        console.log(`wrote ${p.file}`);
      } else if (p.json) {
        console.log(p.exists ? `(${p.file} exists; --write --overwrite to replace it)` : "(not written; add --write)");
      }
      return;
    }
    case "mcp":
      return serveMcp();
    case "hook":
      process.exitCode = await runHook();
      return;
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
