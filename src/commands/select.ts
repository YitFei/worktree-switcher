// Proxy mode versions of switch / stop / status: the user runs the servers, wts only chooses
// which worktree the fixed ports forward to. Nothing is started or stopped here.
import { planPorts, portOf, type Found } from "../discover.js";
import { frameworkFor } from "../init.js";
import { startHint } from "../ports.js";
import { describe, normPath } from "../owner.js";
import { snapshot } from "../platform/win.js";
import { repoForwarder } from "../proxy.js";
import { checkLock } from "../state.js";
import { label, ports, type CtxWithConfig } from "../context.js";
import { WtsError } from "../errors.js";

export interface SelectResult {
  mode: "proxy";
  selected: string;
  /** service → port in the selected worktree, null when not running there. */
  targets: Record<string, number | null>;
  missing: string[];
  /** service -> the port this worktree should run it on, and how to start it there. */
  assigned: Record<string, { port: number; startHint: string }>;
  proxyRunning: boolean;
}

/** This worktree's assigned port and start command per service. */
export function assignedWithHints(ctx: CtxWithConfig, mine: Record<string, number>): Record<string, { port: number; startHint: string }> {
  const out: Record<string, { port: number; startHint: string }> = {};
  for (const [name, svc] of Object.entries(ctx.config.services)) {
    const port = mine[name];
    if (port !== undefined) out[name] = { port, startHint: startHint(frameworkFor(ctx.current, svc.dir), svc.dir, port) };
  }
  return out;
}

const range = (ctx: CtxWithConfig, name: string) => {
  const t = ctx.config.services[name].targets!;
  return `${t.from}-${t.to}`;
};

/** Is a wts proxy (wts proxy / wts watch) listening on the fixed ports? Returns a hint otherwise. */
function proxyState(ctx: CtxWithConfig): { running: boolean; hint?: string } {
  const snap = snapshot(ports(ctx));
  for (const [name, svc] of Object.entries(ctx.config.services)) {
    const pid = snap.listeners.get(svc.port);
    if (pid === undefined) return { running: false, hint: "no proxy is running: start `wts proxy` (or `wts watch`) in a terminal" };
    const cmd = snap.procs.get(pid)?.cmd ?? "";
    if (!/\b(proxy|watch)\b/.test(cmd) || !/wts|cli\.js/i.test(cmd)) {
      return { running: false, hint: `${name} :${svc.port} is held by another program (${describe(pid, snap.procs)}); stop it so the proxy can take the port` };
    }
  }
  return { running: true };
}

export async function selectWorktree(ctx: CtxWithConfig, force: boolean): Promise<SelectResult> {
  checkLock(ctx.store.readLock(), ctx.current, force);
  const { found, mine } = await planPorts(ctx);
  const assigned = assignedWithHints(ctx, mine);
  ctx.store.writeState({ owner: ctx.current, startedAt: new Date().toISOString(), services: {} });

  const targets: Record<string, number | null> = {};
  console.log(`now forwarding to ${label(ctx.current, ctx.current)}`);
  for (const [name, svc] of Object.entries(ctx.config.services)) {
    const port = portOf(found, name, ctx.current);
    targets[name] = port;
    console.log(`  ${name.padEnd(10)} :${svc.port} → ${port ? `:${port}` : assigned[name] ? `not running here — start it on :${assigned[name].port}:  ${assigned[name].startHint}` : `not running here — no free port left in ${range(ctx, name)}`}`);
  }
  const proxy = proxyState(ctx);
  if (proxy.hint) console.log(proxy.hint);
  const missing = Object.keys(targets).filter((n) => targets[n] === null);
  return { mode: "proxy", selected: ctx.current, targets, missing, assigned, proxyRunning: proxy.running };
}

export function clearSelection(ctx: CtxWithConfig, force: boolean): void {
  checkLock(ctx.store.readLock(), ctx.current, force);
  ctx.store.clearState();
  console.log("selection cleared: the proxy answers 502 until the next `wts switch`. Your servers keep running.");
}

export async function proxyStatus(ctx: CtxWithConfig): Promise<void> {
  const selected = ctx.store.readState()?.owner ?? null;
  const lock = ctx.store.readLock();
  const { found, mine, map } = await planPorts(ctx);
  const assigned = assignedWithHints(ctx, mine);
  console.log(`worktree: ${label(ctx.current, ctx.current)}`);
  console.log(`mode:     proxy`);
  console.log(`lock:     ${lock ? `${label(lock.worktree, ctx.current)} since ${lock.time}${lock.note ? ` — ${lock.note}` : ""}` : "none"}`);
  console.log(`selected: ${selected ? label(selected, ctx.current) : "none"}`);
  console.log(`proxy:    ${proxyState(ctx).hint ?? "running"}`);
  for (const [name, svc] of Object.entries(ctx.config.services)) {
    console.log(`\n${name} :${svc.port}  (held by the proxy; worktrees run it on ${range(ctx, name)})`);
    if (assigned[name]) console.log(`  this worktree: :${assigned[name].port}  ->  ${assigned[name].startHint}`);
    const here = found.filter((f: Found) => f.service === name);
    if (here.length === 0) console.log("  no worktree runs it");
    for (const f of here) {
      const mark = selected && normPath(selected) === normPath(f.worktree) ? "●" : "○";
      const want = Object.entries(map).find(([wt]) => normPath(wt) === normPath(f.worktree))?.[1][name];
      const off = want !== undefined && want !== f.port ? `  (assigned :${want})` : "";
      console.log(`  ${mark} :${f.port}  ${label(f.worktree, ctx.current)}${off}`);
    }
    if (selected && portOf(found, name, selected) === null) console.log(`  ! the selected worktree does not run ${name}`);
  }
}

/** `wts proxy`: host the forwarder for this repo in the foreground. */
export async function runProxy(ctx: CtxWithConfig): Promise<void> {
  if (ctx.config.mode !== "proxy") throw new WtsError(`wts.json is in "${ctx.config.mode}" mode; \`wts proxy\` needs "mode": "proxy"`, 2);
  const fwd = repoForwarder(ctx, (m) => console.log(m));
  await fwd.start();
  const list = Object.entries(ctx.config.services).map(([n, s]) => `${n} :${s.port}`).join(", ");
  const sel = ctx.store.readState()?.owner;
  console.log(`forwarding ${list} → ${sel ? label(sel, ctx.current) : "(no worktree selected yet: run `wts switch`)"}; Ctrl+C to stop`);
}
