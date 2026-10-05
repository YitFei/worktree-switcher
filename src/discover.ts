// Proxy mode: find where each worktree runs each service, among the ports in the services'
// `targets` ranges. A listener belongs to a worktree when its exe / command line contains the
// worktree path (Vite, .NET), or else when its current directory is inside the worktree
// (`node server.js` started from a terminal there).
import { inRange, type ServiceConfig } from "./config.js";
import { matchWorktree, normPath } from "./owner.js";
import { rangeListeners, type RangeListener } from "./platform/win.js";
import { assignPorts, portsOf, readPortMap, writePortMap, type PortMap } from "./ports.js";
import type { CtxWithConfig } from "./context.js";

export interface Found {
  service: string;
  worktree: string;
  port: number;
  pid: number;
}

/** One server per (service, worktree): its assigned port when it listens there, else the lowest. */
export function attributeListeners(listeners: RangeListener[], services: Record<string, ServiceConfig>, worktrees: string[], assigned: PortMap = {}): Found[] {
  const best = new Map<string, Found>();
  for (const l of listeners) {
    const service = Object.entries(services).find(([, s]) => s.targets && inRange(l.port, s.targets))?.[0];
    if (!service) continue;
    const worktree = matchWorktree(`${l.exe ?? ""} ${l.cmd ?? ""}`, worktrees) ?? matchWorktree(l.cwd, worktrees);
    if (!worktree) continue;
    const key = `${service}\0${normPath(worktree)}`;
    const prev = best.get(key);
    const want = portsOf(assigned, worktree)[service];
    const better = !prev || (l.port === want ? true : prev.port !== want && l.port < prev.port);
    if (better) best.set(key, { service, worktree, port: l.port, pid: l.pid });
  }
  return [...best.values()];
}

export async function discover(services: Record<string, ServiceConfig>, worktrees: string[], assigned: PortMap = {}): Promise<Found[]> {
  const ranges = Object.values(services).flatMap((s) => (s.targets ? [s.targets] : []));
  return attributeListeners(await rangeListeners(ranges), services, worktrees, assigned);
}

export interface PortPlan {
  found: Found[];
  /** This worktree's assigned port per service. */
  mine: Record<string, number>;
  map: PortMap;
}

/** Discover running servers and make sure the current worktree has assigned ports (one query). */
export async function planPorts(ctx: CtxWithConfig): Promise<PortPlan> {
  const ranges = Object.values(ctx.config.services).flatMap((s) => (s.targets ? [s.targets] : []));
  const listeners = await rangeListeners(ranges);
  const before = readPortMap(ctx.store.dir);
  const found = attributeListeners(listeners, ctx.config.services, ctx.worktrees, before);
  const { map, mine, changed } = assignPorts(before, ctx.worktrees, ctx.current, ctx.config.services, found, new Set(listeners.map((l) => l.port)));
  if (changed) writePortMap(ctx.store.dir, map);
  return { found, mine, map };
}

/** Port of `service` in `worktree`, or null. */
export function portOf(found: Found[], service: string, worktree: string): number | null {
  return found.find((f) => f.service === service && normPath(f.worktree) === normPath(worktree))?.port ?? null;
}
