// Proxy mode versions of switch / stop / status: the user runs the servers, wts only chooses
// which worktree the fixed ports forward to. Nothing is started or stopped here.
import { planPorts, portOf, type Found } from "../discover.js";
import { frameworkFor } from "../init.js";
import { startHint } from "../ports.js";
import { describeHolder, normPath, type Holder } from "../owner.js";
import { rangeListeners } from "../platform/win.js";
import { loadConfig } from "../config.js";
import path from "node:path";
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

const NL = String.fromCharCode(10);

const range = (ctx: CtxWithConfig, name: string) => {
  const t = ctx.config.services[name].targets!;
  return `${t.from}-${t.to}`;
};

export interface PortHolder {
  service: string;
  port: number;
  /** null = nothing listens. */
  holder: Holder | null;
}

/** Who listens on each fixed port (the wts proxy, a worktree's server, a leftover, or another program). */
export async function fixedPortHolders(ctx: CtxWithConfig): Promise<PortHolder[]> {
  const services = Object.entries(ctx.config.services);
  const listeners = await rangeListeners(services.map(([, s]) => ({ from: s.port, to: s.port })));
  return services.map(([service, svc]) => {
    const l = listeners.find((x) => x.port === svc.port);
    return { service, port: svc.port, holder: l ? describeHolder(l, ctx.worktrees) : null };
  });
}

/** What to do about a fixed port that is not held by the wts proxy, for people and agents. */
export function holderAdvice(h: PortHolder): string {
  if (!h.holder) return `${h.service} :${h.port} is free: no proxy is running. Start \`wts watch\` (or \`wts proxy\`) in a terminal.`;
  const what = `${h.service} :${h.port} is held by ${h.holder.text}`;
  if (h.holder.deleted) return `${what}. Ask the user to stop it (pid ${h.holder.text.match(/pid (\d+)/)?.[1]}) so the wts proxy can take the port.`;
  if (h.holder.worktree) {
    return `${what}, started on the fixed port instead of behind the proxy. Ask the user to stop it and start it again on that worktree's assigned port (wts port in ${path.basename(h.holder.worktree)}).`;
  }
  return `${what}. Ask the user to stop it so the wts proxy can take the port.`;
}

/** Is the wts proxy holding every fixed port? Returns advice otherwise. */
async function proxyState(ctx: CtxWithConfig): Promise<{ running: boolean; hints: string[] }> {
  const hints = (await fixedPortHolders(ctx)).filter((h) => !h.holder?.isWts).map(holderAdvice);
  return { running: hints.length === 0, hints };
}

/** Worktrees whose wts.json is in another mode than the main checkout's (e.g. not merged yet). */
export function mixedModes(ctx: CtxWithConfig): string[] {
  const modes = ctx.worktrees.flatMap((wt) => {
    try {
      return [{ wt, mode: loadConfig(wt).mode }];
    } catch {
      return [];
    }
  });
  const main = modes[0]?.mode ?? ctx.config.mode;
  return modes
    .filter((m) => m.mode !== main)
    .map((m) => `${path.basename(m.wt)}'s wts.json is in ${m.mode} mode, the others ${main}: merge the main branch there`);
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
  const proxy = await proxyState(ctx);
  for (const h of proxy.hints) console.log(h);
  for (const m of mixedModes(ctx)) console.log(`warning: ${m}`);
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
  const proxy = await proxyState(ctx);
  console.log(`proxy:    ${proxy.running ? "running" : proxy.hints.join(NL + "          ")}`);
  for (const m of mixedModes(ctx)) console.log(`warning:  ${m}`);
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
