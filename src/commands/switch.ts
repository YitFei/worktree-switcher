import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WtsError } from "../errors.js";
import { attribute, describe, isAlive, samePath } from "../owner.js";
import { snapshot } from "../platform/win.js";
import { checkLock, type ServiceState, type State } from "../state.js";
import { inspect, label, ports, sleep, type CtxWithConfig } from "../context.js";
import { tail } from "./logs.js";
import { stopOwned } from "./stop.js";
import { selectWorktree, type SelectResult } from "./select.js";

const RUNNER = fileURLToPath(new URL("../runner.js", import.meta.url));
const POLL_MS = 1000;
const TAIL_LINES = 40;

/**
 * Run the dev servers from `ctx.current`. With `restart`, servers already running from this
 * worktree are stopped and started again (the ↻ button) instead of being left alone.
 */
export async function switchTo(ctx: CtxWithConfig, force: boolean, opts: { restart?: boolean } = {}): Promise<SelectResult | void> {
  if (ctx.config.mode === "proxy") return selectWorktree(ctx, force);
  checkLock(ctx.store.readLock(), ctx.current, force);

  const snap = snapshot(ports(ctx));
  const state = ctx.store.readState();
  const statuses = inspect(ctx, snap.listeners, snap.procs, state);

  const unknown = statuses.filter((s) => s.pid !== null && s.worktree === null);
  if (unknown.length > 0) {
    const lines = unknown.map((s) => `  ${s.service} :${s.port} — ${describe(s.pid!, snap.procs)}`);
    throw new WtsError(`port held by a process that is not a worktree of this repo; not killing it:\n${lines.join("\n")}`, 2);
  }
  if (!opts.restart && statuses.every((s) => s.worktree !== null && samePath(s.worktree, ctx.current))) {
    console.log(`already running from ${label(ctx.current, ctx.current)}`);
    return;
  }

  const previous = [...new Set(statuses.flatMap((s) => (s.worktree ? [s.worktree] : [])))];
  if (previous.length === 0) {
    console.log("ports are free");
  } else {
    for (const wt of previous) console.log(`${opts.restart && samePath(wt, ctx.current) ? "restarting" : "previous owner"}: ${label(wt, ctx.current)}`);
    await stopOwned(ctx, statuses, snap.procs, state);
    console.log("stopped");
  }

  const started = start(ctx);
  await waitReady(ctx, started);
  console.log(`now serving from ${label(ctx.current, ctx.current)}`);
}

function start(ctx: CtxWithConfig): State {
  const services: Record<string, ServiceState> = {};
  for (const [name, svc] of Object.entries(ctx.config.services)) {
    const cwd = path.join(ctx.current, svc.dir);
    if (!fs.existsSync(cwd)) throw new WtsError(`services.${name}.dir does not exist: ${cwd}`);

    const log = ctx.store.logPath(name);
    fs.writeFileSync(log, `# wts ${new Date().toISOString()} ${cwd}> ${svc.cmd}\n`);
    const child = spawn(process.execPath, [RUNNER, log, svc.cmd], { cwd, detached: true, windowsHide: true, stdio: "ignore" });
    child.on("error", () => {}); // surfaced by the readiness check instead
    child.unref();
    if (!child.pid) throw new WtsError(`failed to start ${name}: ${svc.cmd}`);
    console.log(`started ${name}: ${svc.cmd} (pid ${child.pid}, log ${log})`);
    services[name] = { pid: child.pid, created: 0, port: svc.port };
  }

  // Record creation times so a reused PID is never mistaken for our process later.
  const { procs } = snapshot(ports(ctx));
  for (const svc of Object.values(services)) svc.created = procs.get(svc.pid)?.created ?? 0;

  // Written before readiness so `wts stop` / `wts logs` work even if startup fails.
  const state: State = { owner: ctx.current, startedAt: new Date().toISOString(), services };
  ctx.store.writeState(state);
  return state;
}

async function waitReady(ctx: CtxWithConfig, state: State): Promise<void> {
  const begin = Date.now();
  const deadline = begin + ctx.config.readyTimeoutSec * 1000;
  const pending = new Set(Object.keys(state.services));

  while (pending.size > 0) {
    const snap = snapshot(ports(ctx));
    for (const name of [...pending]) {
      const svc = state.services[name];
      const pid = snap.listeners.get(svc.port);
      const owner = pid ? attribute(pid, snap.procs, ctx.worktrees, state).worktree : null;
      if (owner && samePath(owner, ctx.current)) {
        console.log(`ready ${name} :${svc.port} (pid ${pid}, ${((Date.now() - begin) / 1000).toFixed(1)}s)`);
        pending.delete(name);
      } else if (!isAlive(svc, snap.procs)) {
        fail(ctx, name, "exited before listening");
      }
    }
    if (pending.size === 0) break;
    if (Date.now() > deadline) fail(ctx, [...pending].join(", "), `not listening after ${ctx.config.readyTimeoutSec}s`);
    await sleep(POLL_MS);
  }
}

function fail(ctx: CtxWithConfig, names: string, reason: string): never {
  for (const name of names.split(", ")) {
    console.error(`--- ${name}: last ${TAIL_LINES} log lines (${ctx.store.logPath(name)}) ---`);
    for (const line of tail(ctx.store.logPath(name), TAIL_LINES)) console.error(line);
  }
  throw new WtsError(`${names} ${reason}; other services keep running — use \`wts stop\` to clean up`);
}
