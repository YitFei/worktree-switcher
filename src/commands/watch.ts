import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE } from "../config.js";
import { inspect, label, loadContext, loadContextWithConfig, ports, sleep, type CtxWithConfig } from "../context.js";
import { readFocus } from "../focus/file.js";
import { defaultOrcaDb, orcaReader } from "../focus/orca.js";
import { normPath } from "../owner.js";
import { snapshot } from "../platform/win.js";
import { Tray, type TrayCommand, type TrayState } from "../platform/tray.js";
import { lock, unlock } from "./lock.js";
import { stop } from "./stop.js";
import { switchTo } from "./switch.js";

const POLL_MS = 500;
const TRAY_REFRESH_MS = 10_000;

export interface WatchOptions {
  orca: boolean;
  orcaDb?: string;
  delaySec: number;
  tray: boolean;
}

interface Source {
  name: string;
  read: () => string | null;
}

/** Emits a value once it has stayed the same for `delayMs`, and only once per settle. */
export class Debouncer {
  private value: string | null = null;
  private since = 0;
  private emitted: string | null = null;

  constructor(private readonly delayMs: number) {}

  update(value: string | null, now: number): string | null {
    if (value !== this.value) {
      this.value = value;
      this.since = now;
      return null;
    }
    if (value === null || value === this.emitted || now - this.since < this.delayMs) return null;
    this.emitted = value;
    return value;
  }
}

/** Follow the worktree the user is looking at and switch the dev servers to it. */
export async function watch(opts: WatchOptions): Promise<void> {
  stampConsole();
  const start = Date.now();
  const sources: Source[] = [
    { name: "wts focus", read: () => { const f = readFocus(); return f && f.time >= start ? f.worktree : null; } },
  ];
  if (opts.orca) sources.push({ name: "orca", read: await orcaReader(opts.orcaDb ?? defaultOrcaDb()) });
  console.log(`watching ${sources.map((s) => s.name).join(" + ")}; switch after ${opts.delaySec}s on the same worktree; Ctrl+C to stop`);

  const w = new Watcher(opts.tray ? new Tray() : null);
  w.startTray();

  const last = new Map<string, string | null>();
  const debouncer = new Debouncer(opts.delaySec * 1000);
  let target: string | null = null;

  for (;;) {
    for (const s of sources) {
      let value: string | null;
      try {
        value = s.read();
      } catch {
        continue; // e.g. Orca DB busy; try again next tick
      }
      if (last.has(s.name) && last.get(s.name) === value) continue;
      last.set(s.name, value);
      if (value) target = value;
    }
    const ready = debouncer.update(target ? normPath(target) : null, Date.now());
    if (ready && target) await w.switchTo(target, false);
    await w.tick();
    await sleep(POLL_MS);
  }
}

/** Executes switches and tray commands one at a time and keeps the tray up to date. */
class Watcher {
  /** Last repo (worktree with wts.json) the user focused; drives the tray menu. */
  private repo: CtxWithConfig | null = null;
  private readonly ignored = new Set<string>();
  private lastRefresh = 0;
  private notifyId = 0;
  private owner: string | null = null;

  constructor(private readonly tray: Tray | null) {
    try {
      this.repo = loadContextWithConfig(process.cwd());
    } catch {
      // started outside a configured worktree; the tray waits for the first focus
    }
  }

  startTray(): void {
    if (!this.tray) return;
    this.tray.start({ tooltip: "wts: starting…", color: "gray", locked: false, worktrees: [] });
    this.refresh();
  }

  /** Called every poll: handle tray clicks, refresh the tray now and then. */
  async tick(): Promise<void> {
    const cmd = this.tray?.takeCommand();
    if (cmd) await this.run(cmd);
    if (Date.now() - this.lastRefresh > TRAY_REFRESH_MS) this.refresh();
  }

  async switchTo(worktree: string, fromTray: boolean): Promise<void> {
    let ctx: CtxWithConfig;
    try {
      ctx = loadContextWithConfig(worktree);
    } catch (e) {
      const key = normPath(worktree);
      if (fromTray || !this.ignored.has(key)) console.log(`ignoring ${worktree}: ${(e as Error).message}`);
      this.ignored.add(key);
      return;
    }
    this.repo = ctx;
    console.log(`focus on ${label(ctx.current, ctx.current)}`);
    this.refresh("switching", `switching to ${path.basename(ctx.current)}…`);
    try {
      await switchTo(ctx, false);
      this.refresh();
    } catch (e) {
      console.log(`not switched: ${(e as Error).message}`);
      this.refresh(undefined, undefined, { title: `wts: not switched to ${path.basename(ctx.current)}`, text: (e as Error).message });
    }
  }

  private async run(cmd: TrayCommand): Promise<void> {
    console.log(`tray: ${cmd.action}${cmd.action === "switch" ? ` ${cmd.path}` : ""}`);
    if (cmd.action === "exit") process.exit(0);
    if (cmd.action === "switch") return this.switchTo(cmd.path, true);
    if (!this.repo) return;
    // Act as the running worktree, so its own lock never blocks Lock/Stop from the tray.
    const where = this.owner ?? this.repo.current;
    try {
      if (cmd.action === "lock") lock(loadContext(where), "locked from tray", false);
      if (cmd.action === "unlock") unlock(loadContext(where), true);
      if (cmd.action === "stop") await stop(loadContextWithConfig(where), false);
      this.refresh();
    } catch (e) {
      console.log(`tray ${cmd.action} failed: ${(e as Error).message}`);
      this.refresh(undefined, undefined, { title: `wts: ${cmd.action} failed`, text: (e as Error).message });
    }
  }

  /** Recompute the tray from the real port owners (a PowerShell query, ~1 s). */
  private refresh(phase?: "switching", text?: string, notify?: { title: string; text: string }): void {
    this.lastRefresh = Date.now();
    if (!this.tray) return;
    const n = notify ? { id: ++this.notifyId, ...notify } : undefined;
    if (!this.repo) {
      this.tray.update({ tooltip: "wts: waiting for a worktree with wts.json", color: "gray", locked: false, worktrees: [], notify: n });
      return;
    }
    try {
      this.repo = loadContextWithConfig(this.repo.current); // pick up new / removed worktrees
    } catch {
      // keep the previous context
    }
    this.tray.update({ ...this.state(this.repo, phase, text), notify: n });
  }

  private state(repo: CtxWithConfig, phase?: "switching", text?: string): TrayState {
    const portList = ports(repo).map((p) => `:${p}`).join(" ");
    const snap = snapshot(ports(repo));
    const statuses = inspect(repo, snap.listeners, snap.procs, repo.store.readState());
    const lockInfo = repo.store.readLock();
    const owners = [...new Set(statuses.flatMap((s) => (s.worktree ? [normPath(s.worktree)] : [])))];
    const unknown = statuses.filter((s) => s.pid !== null && s.worktree === null);
    const ownerPath = owners.length === 1 ? statuses.find((s) => s.worktree)!.worktree! : null;
    this.owner = ownerPath;

    const worktrees = repo.worktrees
      .filter((wt) => fs.existsSync(path.join(wt, CONFIG_FILE)))
      .map((wt) => ({ name: path.basename(wt), path: wt, active: !!ownerPath && normPath(wt) === normPath(ownerPath) }));
    const locked = lockInfo ? ` · locked by ${path.basename(lockInfo.worktree)}` : "";

    if (phase === "switching") return { tooltip: `wts: ${text}`, color: "yellow", locked: !!lockInfo, worktrees };
    if (unknown.length > 0) {
      return { tooltip: `wts: ${unknown.map((s) => `:${s.port}`).join(" ")} held by another program`, color: "red", locked: !!lockInfo, worktrees };
    }
    if (owners.length === 0) return { tooltip: `wts: stopped${locked} · ${portList}`, color: "gray", locked: !!lockInfo, worktrees };
    const complete = owners.length === 1 && statuses.every((s) => s.pid !== null);
    const name = owners.length === 1 ? path.basename(ownerPath!) : "mixed worktrees";
    return { tooltip: `wts: ${name}${locked} · ${portList}`, color: complete ? "green" : "red", locked: !!lockInfo, worktrees };
  }
}

function stampConsole(): void {
  for (const k of ["log", "error"] as const) {
    const orig = console[k].bind(console);
    console[k] = (...args: unknown[]) => orig(new Date().toTimeString().slice(0, 8), ...args);
  }
}
