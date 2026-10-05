import path from "node:path";
import { loadConfig, type Config } from "./config.js";
import { commonDir, listWorktrees, worktreeRoot } from "./git.js";
import { attribute, samePath, type Procs } from "./owner.js";
import { Store, type State } from "./state.js";
import { isUsableWorktree, rememberRepo } from "./repos.js";

export interface Ctx {
  /** Worktree wts was run from. */
  current: string;
  worktrees: string[];
  store: Store;
}

export interface CtxWithConfig extends Ctx {
  config: Config;
}

export function loadContext(cwd: string): Ctx {
  return { current: worktreeRoot(cwd), worktrees: listWorktrees(cwd).filter(isUsableWorktree), store: new Store(commonDir(cwd)) };
}

export function loadContextWithConfig(cwd: string): CtxWithConfig {
  const ctx = loadContext(cwd);
  const config = loadConfig(ctx.current);
  rememberRepo(path.dirname(ctx.store.dir), ctx.current); // for the floating button's project list
  return { ...ctx, config };
}

export function ports(ctx: CtxWithConfig): number[] {
  return Object.values(ctx.config.services).map((s) => s.port);
}

export interface PortStatus {
  service: string;
  port: number;
  pid: number | null;
  worktree: string | null;
  viaWts: boolean;
}

export function inspect(ctx: CtxWithConfig, listeners: Map<number, number>, procs: Procs, state: State | null): PortStatus[] {
  return Object.entries(ctx.config.services).map(([service, svc]) => {
    const pid = listeners.get(svc.port) ?? null;
    if (pid === null) return { service, port: svc.port, pid, worktree: null, viaWts: false };
    return { service, port: svc.port, pid, ...attribute(pid, procs, ctx.worktrees, state) };
  });
}

/** "Bandwidth-Assign (C:\...\Bandwidth-Assign)", with " [current]" for the worktree wts runs in. */
export function label(worktree: string, current: string): string {
  return `${path.basename(worktree)} (${worktree})${samePath(worktree, current) ? " [current]" : ""}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
