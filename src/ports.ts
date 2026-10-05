// Proxy mode: each worktree gets a stable port per service inside the service's `targets`,
// so agents and people know exactly where to start a server ("frontend → 5275") instead of
// guessing the next free port. Stored per repo in <git-common-dir>/wts/ports.json.
import fs from "node:fs";
import path from "node:path";
import type { ServiceConfig } from "./config.js";
import type { Found } from "./discover.js";
import { normPath } from "./owner.js";

/** worktree path → service → port */
export type PortMap = Record<string, Record<string, number>>;

export function portsFile(storeDir: string): string {
  return path.join(storeDir, "ports.json");
}

export function readPortMap(storeDir: string): PortMap {
  try {
    return JSON.parse(fs.readFileSync(portsFile(storeDir), "utf8")) as PortMap;
  } catch {
    return {};
  }
}

export function writePortMap(storeDir: string, map: PortMap): void {
  fs.writeFileSync(portsFile(storeDir), JSON.stringify(map, null, 2) + "\n");
}

/** This worktree's entry in the map (keys are paths; matched case- and slash-insensitively). */
export function portsOf(map: PortMap, worktree: string): Record<string, number> {
  const key = Object.keys(map).find((k) => normPath(k) === normPath(worktree));
  return key ? map[key] : {};
}

/**
 * Bring the map up to date and give `current` a port for every proxied service:
 * - entries of worktrees that no longer exist are dropped;
 * - a worktree already running a service inside the range keeps / adopts that port;
 * - otherwise the lowest port in the range that no worktree holds and nothing listens on.
 * Pure: returns the new map and whether it changed.
 */
export function assignPorts(
  map: PortMap,
  worktrees: string[],
  current: string,
  services: Record<string, ServiceConfig>,
  found: Found[],
  listening: Set<number>,
): { map: PortMap; mine: Record<string, number>; changed: boolean } {
  const alive = new Set(worktrees.map(normPath));
  const next: PortMap = {};
  for (const [wt, ports] of Object.entries(map)) if (alive.has(normPath(wt))) next[wt] = { ...ports };
  let changed = Object.keys(next).length !== Object.keys(map).length;

  const entry = (wt: string) => {
    const key = Object.keys(next).find((k) => normPath(k) === normPath(wt)) ?? wt;
    return (next[key] ??= {});
  };
  for (const f of found) {
    const e = entry(f.worktree);
    if (e[f.service] === undefined) {
      e[f.service] = f.port;
      changed = true;
    }
  }

  const mine = entry(current);
  for (const [name, svc] of Object.entries(services)) {
    const r = svc.targets;
    if (!r) continue;
    if (mine[name] !== undefined && mine[name] >= r.from && mine[name] <= r.to) continue;
    const taken = new Set(Object.entries(next).flatMap(([wt, p]) => (normPath(wt) === normPath(current) ? [] : Object.values(p))));
    for (let p = r.from; p <= r.to; p++) {
      if (!taken.has(p) && !listening.has(p)) {
        mine[name] = p;
        changed = true;
        break;
      }
    }
  }
  if (Object.keys(mine).length === 0) delete next[Object.keys(next).find((k) => normPath(k) === normPath(current)) ?? current];
  return { map: next, mine, changed };
}

/** How to start a service on its assigned port, by framework. */
export function startHint(framework: string | undefined, dir: string, port: number): string {
  const cd = dir === "." ? "" : `cd ${dir} && `;
  switch (framework) {
    case "vite":
      return `${cd}npm run dev -- --port ${port} --strictPort`;
    case "next":
      return `${cd}npm run dev -- -p ${port}`;
    case "cra":
      return `${cd}set PORT=${port}&& npm start`;
    case "dotnet":
      return `${cd}dotnet run --urls http://localhost:${port}`;
    default:
      return `${cd}start the server on port ${port} (e.g. npm run dev -- --port ${port})`;
  }
}
