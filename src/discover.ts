// Proxy mode: find where each worktree runs each service, among the ports in the services'
// `targets` ranges. A listener belongs to a worktree when its exe / command line contains the
// worktree path (Vite, .NET), or else when its current directory is inside the worktree
// (`node server.js` started from a terminal there).
import { inRange, type ServiceConfig } from "./config.js";
import { matchWorktree, normPath } from "./owner.js";
import { rangeListeners, type RangeListener } from "./platform/win.js";

export interface Found {
  service: string;
  worktree: string;
  port: number;
  pid: number;
}

export function attributeListeners(listeners: RangeListener[], services: Record<string, ServiceConfig>, worktrees: string[]): Found[] {
  const best = new Map<string, Found>();
  for (const l of listeners) {
    const service = Object.entries(services).find(([, s]) => s.targets && inRange(l.port, s.targets))?.[0];
    if (!service) continue;
    const worktree = matchWorktree(`${l.exe ?? ""} ${l.cmd ?? ""}`, worktrees) ?? matchWorktree(l.cwd, worktrees);
    if (!worktree) continue;
    const key = `${service}\0${normPath(worktree)}`;
    const prev = best.get(key);
    if (!prev || l.port < prev.port) best.set(key, { service, worktree, port: l.port, pid: l.pid });
  }
  return [...best.values()];
}

export async function discover(services: Record<string, ServiceConfig>, worktrees: string[]): Promise<Found[]> {
  const ranges = Object.values(services).flatMap((s) => (s.targets ? [s.targets] : []));
  return attributeListeners(await rangeListeners(ranges), services, worktrees);
}

/** Port of `service` in `worktree`, or null. */
export function portOf(found: Found[], service: string, worktree: string): number | null {
  return found.find((f) => f.service === service && normPath(f.worktree) === normPath(worktree))?.port ?? null;
}
