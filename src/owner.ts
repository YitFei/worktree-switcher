import path from "node:path";
import type { ServiceState, State } from "./state.js";

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  exe: string | null;
  cmd: string | null;
  /** Creation time, ms since epoch (0 if unknown). */
  created: number;
}

export type Procs = Map<number, ProcInfo>;

export function normPath(p: string): string {
  return path.resolve(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/**
 * Worktree whose path appears in `text` (an exe path or command line).
 * Longest match wins, so a worktree nested inside another (e.g. main/.claude/worktrees/x)
 * is not mistaken for its parent.
 */
export function matchWorktree(text: string | null, worktrees: string[]): string | null {
  if (!text) return null;
  const hay = text.replace(/\//g, "\\").toLowerCase();
  let best: string | null = null;
  let bestLen = -1;
  for (const wt of worktrees) {
    const needle = normPath(wt);
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
      const next = hay[i + needle.length];
      if (next === undefined || next === "\\" || next === '"' || next === "'" || next === " ") {
        if (needle.length > bestLen) {
          best = wt;
          bestLen = needle.length;
        }
        break;
      }
    }
  }
  return best;
}

/** True if the recorded service root is still the same running process (not a reused PID). */
export function isAlive(svc: Pick<ServiceState, "pid" | "created">, procs: Procs): boolean {
  const p = procs.get(svc.pid);
  return !!p && Math.abs(p.created - svc.created) < 2000;
}

/** True if `pid` is `rootPid` or one of its descendants. */
export function isDescendant(pid: number, rootPid: number, procs: Procs): boolean {
  const seen = new Set<number>();
  let cur = procs.get(pid);
  while (cur && !seen.has(cur.pid)) {
    if (cur.pid === rootPid) return true;
    seen.add(cur.pid);
    const parent = procs.get(cur.ppid);
    // A parent created after its child means the PPID was reused by an unrelated process.
    if (!parent || parent.created > cur.created) return false;
    cur = parent;
  }
  return false;
}

export interface Attribution {
  worktree: string | null;
  /** Started by wts (descendant of a recorded service root). */
  viaWts: boolean;
}

/**
 * Which worktree a process belongs to. Only two kinds of evidence count:
 * the process is in a tree wts started, or its own exe/command line contains a worktree path.
 * Parents are deliberately not inspected — a shell opened in a worktree can launch anything.
 */
export function attribute(pid: number, procs: Procs, worktrees: string[], state: State | null): Attribution {
  if (state) {
    for (const svc of Object.values(state.services)) {
      if (isAlive(svc, procs) && isDescendant(pid, svc.pid, procs)) {
        return { worktree: state.owner, viaWts: true };
      }
    }
  }
  const p = procs.get(pid);
  const worktree = p ? matchWorktree(`${p.exe ?? ""} ${p.cmd ?? ""}`, worktrees) : null;
  return { worktree, viaWts: false };
}

export function describe(pid: number, procs: Procs): string {
  const p = procs.get(pid);
  if (!p) return `pid ${pid}`;
  return `pid ${pid} ${p.name}${p.cmd ? `: ${p.cmd}` : ""}`;
}
