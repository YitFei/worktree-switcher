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

export const INSTRUCTIONS = `wts manages the dev servers of repos that have a wts.json: the ports are fixed and only one
worktree of a repo runs them at a time. In such a repo:
- Never start dev servers yourself (npm run dev, vite, dotnet run/watch, ...) and never kill processes on their ports.
- To run or preview the app from your worktree, call wts_switch. It stops the worktree that runs now, starts yours
  and returns when the ports listen. Check first with wts_status: the user may be looking at another worktree.
- If a tool result says refused (locked by another worktree, or a port held by a program wts does not manage),
  stop and tell the user the reason. Do not work around it.
- After a failed start, read wts_logs to find the cause.
- Tools answer "not configured" in a repo without wts.json; then start servers the usual way.`;

const pathArg = { path: z.string().optional().describe("Worktree path; defaults to the agent's working directory") };

type Result = { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };

export function createServer(cwd = process.cwd()): McpServer {
  const server = new McpServer({ name: "wts", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const where = (p?: string) => p ?? cwd;

  server.registerTool(
    "wts_status",
    {
      description: "Which worktree runs the dev servers on each configured port, whether that is your worktree, and the lock. Call before wts_switch.",
      inputSchema: pathArg,
    },
    ({ path }) =>
      run(where(path), async (ctx) => {
        const snap = snapshot(ports(ctx));
        const statuses = inspect(ctx, snap.listeners, snap.procs, ctx.store.readState());
        status(ctx);
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
        await switchTo(ctx, false);
        return { worktree: ctx.current, ports: ports(ctx) };
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
      const reason = (e as Error).message;
      return {
        content: [{ type: "text", text: `wts is not configured here: ${reason}` }],
        structuredContent: { ok: false, configured: false, reason },
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

export async function serveMcp(): Promise<void> {
  // Anything printed outside a tool call must not reach stdout either.
  console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  await createServer().connect(new StdioServerTransport());
}
