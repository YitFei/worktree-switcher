// `wts mcp`: stdio MCP server so coding agents use wts instead of starting dev servers themselves.
// The agent's CLI starts it with cwd = the agent's worktree. stdout is the MCP channel, so every
// tool runs with console output captured into its result.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { inspect, loadContextWithConfig, ports, type CtxWithConfig } from "./context.js";
import { WtsError } from "./errors.js";
import { describe, samePath } from "./owner.js";
import { snapshot } from "./platform/win.js";
import { status } from "./commands/status.js";
import { switchTo } from "./commands/switch.js";
import { stop } from "./commands/stop.js";
import { tail } from "./commands/logs.js";
import { planPorts, portOf } from "./discover.js";
import { assignedWithHints, fixedPortHolders, holderAdvice, mixedModes } from "./commands/select.js";
import { CONFIG_FILE } from "./config.js";
import { listWorktrees } from "./git.js";
import fs from "node:fs";
import nodePath from "node:path";
import { proposeInit, writeInit } from "./init.js";

export const INSTRUCTIONS = `wts manages the dev servers of repos that have a wts.json: the ports are fixed and only one
worktree of a repo runs them at a time. In such a repo:
- Never start dev servers yourself (npm run dev, vite, dotnet run/watch, ...) and never kill processes on their ports.
- To run or preview the app from your worktree, call wts_switch. It stops the worktree that runs now, starts yours
  and returns when the ports listen. Check first with wts_status: the user may be looking at another worktree.
- If a tool result says refused (locked by another worktree, or a port held by a program wts does not manage),
  stop and tell the user the reason. Do not work around it.
- After a failed start, read wts_logs to find the cause.
- Run mode (the default; wts_status shows no "mode: proxy"): wts owns the server processes. When they need a restart
  (config or dependency changes the dev server does not hot-reload, a crash, a hung server), call wts_restart. Do not
  stop or kill the processes on the ports and do not start them again yourself: wts_restart stops this worktree's
  process tree, starts it from wts.json and waits until it is ready. To stop them, use wts_stop.
- Tools answer "not configured" in a repo without wts.json; then start servers the usual way, unless the user
  asks to set up wts: then use wts_init. Before calling it, ASK the user which mode they want and never guess:
  run = wts starts/stops the servers, one worktree at a time, less memory, switching restarts servers;
  proxy = they start every worktree's servers themselves (dev server left open with hot reload), wts forwards the
  fixed ports, switching is instant, all worktrees' servers keep running. Show the proposal, write only after
  the user confirms. Then suggest committing wts.json to the main branch: worktrees created later get it, existing
  ones after merging it.
Proxy mode (wts_status / wts_port say "mode: proxy"): here you DO start your worktree's dev servers yourself.
- The fixed ports (e.g. 5173) are held by the wts proxy. That is expected: do not treat them as taken by someone
  else, do not pick another port by trial and error, do not write temporary configs to move them.
- Your worktree has an assigned port per service: call wts_port (or wts_status) and start each server with the
  startHint it gives (e.g. npm run dev -- --port 5175 --strictPort), from your worktree.
- Then call wts_switch: it points the fixed ports at your worktree, stops nothing, and reports services that are
  not running yet. The user opens the usual URL (the fixed port).
- Never change the app's own proxy or URL settings (e.g. Vite's /api target, .env API URLs) to point at your assigned
  ports. The fixed API port forwards to the same worktree as the fixed frontend port, so frontend and API stay paired.
  Assigned ports sit behind the proxy; they are not for the user to open.
- If wts_status reports a fixed port held by something other than the wts proxy (fixedPortHolders), tell the user what
  holds it and how to free it (its advice). Do not kill it yourself and do not work around it.
- If wts_status reports warnings (e.g. a worktree whose wts.json is in another mode), pass them on to the user.`;

const NL = String.fromCharCode(10);

const pathArg = { path: z.string().optional().describe("Worktree path; defaults to the agent's working directory") };

type Result = { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };

export function createServer(cwd = process.cwd()): McpServer {
  const server = new McpServer({ name: "worktree-switcher", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const where = (p?: string) => p ?? cwd;

  server.registerTool(
    "wts_status",
    {
      description: "Which worktree runs the dev servers on each configured port, whether that is your worktree, and the lock. Call before wts_switch.",
      inputSchema: pathArg,
    },
    ({ path }) =>
      run(where(path), async (ctx) => {
        if (ctx.config.mode === "proxy") {
          const selected = ctx.store.readState()?.owner ?? null;
          const { found, mine } = await planPorts(ctx);
          const assigned = assignedWithHints(ctx, mine);
          const services = Object.entries(ctx.config.services).map(([service, svc]) => ({
            service,
            fixedPort: svc.port,
            fixedPortHeldByProxy: true,
            targets: `${svc.targets!.from}-${svc.targets!.to}`,
            assignedPort: assigned[service]?.port ?? null,
            startHint: assigned[service]?.startHint ?? null,
            runningOn: portOf(found, service, ctx.current),
            otherWorktrees: found.filter((f) => f.service === service && !samePath(f.worktree, ctx.current)).map((f) => ({ worktree: f.worktree, port: f.port })),
          }));
          const holders = (await fixedPortHolders(ctx)).filter((h) => !h.holder?.isWts);
          const warnings = mixedModes(ctx);
          console.log(`mode: proxy; selected: ${selected ?? "none"}${selected && samePath(selected, ctx.current) ? " (you)" : ""}`);
          for (const h of holders) console.log(`PROBLEM: ${holderAdvice(h)}`);
          for (const w of warnings) console.log(`warning: ${w}`);
          for (const s of services) {
            console.log(`${s.service}: fixed :${s.fixedPort} (held by the wts proxy), yours :${s.assignedPort} - ${s.runningOn ? `running on :${s.runningOn}` : `not running; start: ${s.startHint}`}`);
          }
          return {
            mode: "proxy",
            worktree: ctx.current,
            selected,
            selectedIsYou: !!selected && samePath(selected, ctx.current),
            lock: ctx.store.readLock(),
            services,
            fixedPortHolders: holders.map((h) => ({ service: h.service, port: h.port, heldBy: h.holder?.text ?? null, advice: holderAdvice(h) })),
            warnings,
          };
        }
        const snap = snapshot(ports(ctx));
        const statuses = inspect(ctx, snap.listeners, snap.procs, ctx.store.readState());
        await status(ctx);
        return {
          worktree: ctx.current,
          lock: ctx.store.readLock(),
          services: statuses.map((s) => ({
            service: s.service,
            port: s.port,
            pid: s.pid,
            worktree: s.worktree,
            isYourWorktree: !!s.worktree && samePath(s.worktree, ctx.current),
            otherProgram: s.pid !== null && !s.worktree ? describe(s.pid, snap.procs) : null,
          })),
        };
      }),
  );

  server.registerTool(
    "wts_switch",
    {
      description: "Run the dev servers from your worktree: stops the worktree that runs them now, starts yours, waits until the ports listen. Refused when another worktree holds the lock.",
      inputSchema: pathArg,
    },
    ({ path }) =>
      run(where(path), async (ctx) => {
        const result = await switchTo(ctx, false);
        return { worktree: ctx.current, ports: ports(ctx), ...(result ?? {}) };
      }),
  );

  server.registerTool(
    "wts_logs",
    {
      description: "Last lines of the dev server logs (all services, or one).",
      inputSchema: { ...pathArg, service: z.string().optional(), lines: z.number().int().positive().max(1000).default(80) },
    },
    ({ path, service, lines }) =>
      run(where(path), async (ctx) => {
        const names = service ? [service] : Object.keys(ctx.config.services);
        for (const name of names) {
          if (!ctx.config.services[name]) throw new WtsError(`unknown service "${name}"`, 2);
          console.log(`==> ${name} (${ctx.store.logPath(name)}) <==`);
          for (const line of tail(ctx.store.logPath(name), lines)) console.log(line);
        }
        return { services: names };
      }),
  );

  server.registerTool(
    "wts_stop",
    {
      description: "Stop the dev servers of this repo's worktrees. Refused when another worktree holds the lock.",
      inputSchema: pathArg,
    },
    ({ path }) =>
      run(where(path), async (ctx) => {
        await stop(ctx, false);
        return {};
      }),
  );

  server.registerTool(
    "wts_restart",
    {
      description: "Run mode: restart your worktree's dev servers (stop and start them again from wts.json), e.g. after changing config the dev server does not hot-reload. Refused when another worktree holds the lock. In proxy mode it only explains: restart your own server process.",
      inputSchema: pathArg,
    },
    ({ path }) =>
      run(where(path), async (ctx) => {
        if (ctx.config.mode === "proxy") {
          console.log("proxy mode: wts does not run the servers. Restart your server process yourself (it keeps its assigned port); the proxy picks it up.");
          return { mode: "proxy", restarted: false };
        }
        await switchTo(ctx, false, { restart: true });
        return { mode: "run", restarted: true, worktree: ctx.current };
      }),
  );

  server.registerTool(
    "wts_port",
    {
      description:
        "Proxy mode: the port your worktree must run each service on, and the command to start it there. The fixed ports are held by the wts proxy on purpose; use these ports instead.",
      inputSchema: pathArg,
    },
    ({ path }) =>
      run(where(path), async (ctx) => {
        if (ctx.config.mode !== "proxy") {
          console.log("run mode: wts starts the servers itself on the fixed ports; call wts_switch, do not start them yourself.");
          return { mode: "run" };
        }
        const { mine } = await planPorts(ctx);
        const assigned = assignedWithHints(ctx, mine);
        for (const [s, a] of Object.entries(assigned)) console.log(`${s}: port ${a.port}  ->  ${a.startHint}`);
        return { mode: "proxy", worktree: ctx.current, assigned };
      }),
  );

  server.registerTool(
    "wts_init",
    {
      description:
        "Set up wts in a repo: detects the dev servers (package.json dev/start scripts, Vite config, .NET launchSettings) and proposes a wts.json for the mode the USER chose (ask them first: run or proxy). write:false (default) only shows the proposal; write:true writes wts.json after the user confirmed.",
      inputSchema: {
        ...pathArg,
        mode: z.enum(["run", "proxy"]).describe("The mode the user chose. Ask; do not guess."),
        write: z.boolean().default(false),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ path, mode, write, overwrite }) => {
      try {
        const p = proposeInit(where(path), mode);
        if (write) writeInit(p, overwrite);
        const lines = [
          write ? `wrote ${p.file}` : p.exists ? `proposal (${p.file} already exists; overwrite:true to replace it)` : `proposal for ${p.file} (not written yet)`,
          ...p.services.map((s) => `  ${s.name}: ${s.framework} in ${s.dir}, port ${s.port ?? "?"} (from ${s.source})`),
          "",
          p.json || "(no config: nothing detected)",
          ...p.notes.map((n) => `note: ${n}`),
        ];
        return {
          content: [{ type: "text" as const, text: lines.join(NL) }],
          structuredContent: { ok: true, written: write, file: p.file, exists: p.exists, mode, services: p.services, config: p.config, notes: p.notes },
        };
      } catch (e) {
        const refused = e instanceof WtsError && e.exitCode === 2;
        return {
          content: [{ type: "text" as const, text: `${refused ? "REFUSED" : "FAILED"}: ${(e as Error).message}` }],
          structuredContent: { ok: false, refused, reason: (e as Error).message },
          isError: true,
        };
      }
    },
  );

  return server;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs one tool call at a time (console capture is global; switches must not overlap). */
function run(worktree: string, fn: (ctx: CtxWithConfig) => Promise<Record<string, unknown>>): Promise<Result> {
  const next = queue.then(() => capture(worktree, fn));
  queue = next.catch(() => {});
  return next;
}

async function capture(worktree: string, fn: (ctx: CtxWithConfig) => Promise<Record<string, unknown>>): Promise<Result> {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  const text = (extra?: string) => [...lines, ...(extra ? [extra] : [])].join("\n") || "ok";
  try {
    let ctx: CtxWithConfig;
    try {
      ctx = loadContextWithConfig(worktree);
    } catch (e) {
      let reason = (e as Error).message;
      const elsewhere = configuredElsewhere(worktree);
      if (elsewhere.length > 0) {
        reason += `. But ${elsewhere.join(", ")} has a ${CONFIG_FILE}: it was not committed or not merged into this worktree yet. Tell the user; once it is committed (e.g. on the main branch) and merged here, wts works in this worktree.`;
      }
      return {
        content: [{ type: "text", text: `wts is not configured here: ${reason}` }],
        structuredContent: { ok: false, configured: false, reason, configuredElsewhere: elsewhere },
      };
    }
    const data = await fn(ctx);
    return { content: [{ type: "text", text: text() }], structuredContent: { ok: true, configured: true, refused: false, ...data } };
  } catch (e) {
    const refused = e instanceof WtsError && e.exitCode === 2;
    // The CLI hint "use --force" is for humans; an agent must not override.
    const reason = refused
      ? (e as Error).message.replace(/; use --force to override$/, "") + ". Do not override this; tell the user."
      : (e as Error).message;
    return {
      content: [{ type: "text", text: text(`${refused ? "REFUSED" : "FAILED"}: ${reason}`) }],
      structuredContent: { ok: false, configured: true, refused, reason },
      isError: true,
    };
  } finally {
    Object.assign(console, saved);
  }
}

/** Other worktrees of the same repo that have a wts.json (e.g. written but not committed / merged). */
function configuredElsewhere(worktree: string): string[] {
  try {
    return listWorktrees(worktree).filter((wt) => !samePath(wt, worktree) && fs.existsSync(nodePath.join(wt, CONFIG_FILE)));
  } catch {
    return [];
  }
}

export async function serveMcp(): Promise<void> {
  // Anything printed outside a tool call must not reach stdout either.
  console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  await createServer().connect(new StdioServerTransport());
}
