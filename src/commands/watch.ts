import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE } from "../config.js";
import { inspect, label, loadContext, loadContextWithConfig, ports, sleep, type CtxWithConfig } from "../context.js";
import { readFocus } from "../focus/file.js";
import { defaultOrcaDb, orcaReader } from "../focus/orca.js";
import { normPath } from "../owner.js";
import { snapshot } from "../platform/win.js";
import { Widget, type WidgetCommand, type WidgetKind, type WidgetState } from "../platform/widget.js";
import { lock, unlock } from "./lock.js";
import { stop } from "./stop.js";
import { switchTo } from "./switch.js";
import { repoForwarder, type Forwarder } from "../proxy.js";

const POLL_MS = 500;
const TRAY_REFRESH_MS = 10_000;

export interface WatchOptions {
  orca: boolean;
  orcaDb?: string;
  delaySec: number;
  /** On-screen status: floating button, tray icon, or nothing. */
  ui: WidgetKind | "none";
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

  const w = new Watcher(opts.ui === "none" ? null : new Widget(opts.ui));
  await w.start();

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

/** Executes switches and widget commands one at a time and keeps the widget up to date. */
class Watcher {
  /** Last repo (worktree with wts.json) the user focused; drives the widget menu. */
  private repo: CtxWithConfig | null = null;
  private readonly ignored = new Set<string>();
  private lastRefresh = 0;
  private notifyId = 0;
  private owner: string | null = null;
  /** Proxy-mode repos: one forwarder each, keyed by the repo's state dir. */
  private readonly proxies = new Map<string, Forwarder>();

  constructor(private readonly widget: Widget | null) {
    try {
      this.repo = loadContextWithConfig(process.cwd());
    } catch {
      // started outside a configured worktree; the widget waits for the first focus
    }
  }

  async start(): Promise<void> {
    if (this.repo) await this.ensureProxy(this.repo);
    if (!this.widget) return;
    this.widget.start({ label: "starting…", tooltip: "wts: starting…", color: "gray", locked: false, worktrees: [] });
    this.refresh();
  }

  /** Proxy mode: make sure this watch forwards the repo's fixed ports. */
  private async ensureProxy(ctx: CtxWithConfig): Promise<void> {
    if (ctx.config.mode !== "proxy" || this.proxies.has(ctx.store.dir)) return;
    const fwd = repoForwarder(ctx, (m) => console.log(`proxy: ${m}`));
    this.proxies.set(ctx.store.dir, fwd);
    await fwd.start();
    const list = Object.entries(ctx.config.services).map(([n, s]) => `${n} :${s.port}`).join(", ");
    console.log(`proxy: forwarding ${list} for ${path.basename(ctx.current)}'s repo`);
  }

  /** Called every poll: handle widget clicks, refresh the widget now and then. */
  async tick(): Promise<void> {
    const cmd = this.widget?.takeCommand();
    if (cmd) await this.run(cmd);
    if (Date.now() - this.lastRefresh > TRAY_REFRESH_MS) this.refresh();
  }

  async switchTo(worktree: string, fromWidget: boolean): Promise<void> {
    let ctx: CtxWithConfig;
    try {
      ctx = loadContextWithConfig(worktree);
    } catch (e) {
      const key = normPath(worktree);
      if (fromWidget || !this.ignored.has(key)) console.log(`ignoring ${worktree}: ${(e as Error).message}`);
      this.ignored.add(key);
      return;
    }
    this.repo = ctx;
    console.log(`focus on ${label(ctx.current, ctx.current)}`);
    await this.ensureProxy(ctx);
    this.refresh("switching", `→ ${path.basename(ctx.current)}…`);
    try {
      await switchTo(ctx, false);
      await this.proxies.get(ctx.store.dir)?.rediscover();
      this.refresh();
    } catch (e) {
      console.log(`not switched: ${(e as Error).message}`);
      this.refresh(undefined, undefined, { title: `wts: not switched to ${path.basename(ctx.current)}`, text: (e as Error).message });
    }
  }

  private async run(cmd: WidgetCommand): Promise<void> {
    console.log(`widget: ${cmd.action}${cmd.action === "switch" ? ` ${cmd.path}` : ""}`);
    if (cmd.action === "exit") process.exit(0);
    if (cmd.action === "switch") return this.switchTo(cmd.path, true);
    if (!this.repo) return;
    // Act as the running worktree, so its own lock never blocks Lock/Stop from the widget.
    const where = this.owner ?? this.repo.current;
    try {
      if (cmd.action === "lock") lock(loadContext(where), "locked from wts watch", false);
      if (cmd.action === "unlock") unlock(loadContext(where), true);
      if (cmd.action === "stop") await stop(loadContextWithConfig(where), false);
      this.refresh();
    } catch (e) {
      console.log(`widget ${cmd.action} failed: ${(e as Error).message}`);
      this.refresh(undefined, undefined, { title: `wts: ${cmd.action} failed`, text: (e as Error).message });
    }
  }

  /** Recompute the widget from the real port owners (a PowerShell query, ~1 s). */
  private refresh(phase?: "switching", text?: string, notify?: { title: string; text: string }): void {
    this.lastRefresh = Date.now();
    if (!this.widget) return;
    const n = notify ? { id: ++this.notifyId, ...notify } : undefined;
    if (!this.repo) {
      this.widget.update({ label: "waiting", tooltip: "wts: waiting for a worktree with wts.json", color: "gray", locked: false, worktrees: [], notify: n });
      return;
    }
    try {
      this.repo = loadContextWithConfig(this.repo.current); // pick up new / removed worktrees
    } catch {
      // keep the previous context
    }
    this.widget.update({ ...this.state(this.repo, phase, text), notify: n });
  }

  private state(repo: CtxWithConfig, phase?: "switching", text?: string): WidgetState {
    if (repo.config.mode === "proxy") return this.proxyState(repo, phase, text);
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

    const lockMark = lockInfo ? " 🔒" : "";
    const base = { locked: !!lockInfo, worktrees };
    if (phase === "switching") return { ...base, label: text ?? "switching…", tooltip: `wts: ${text}`, color: "yellow" };
    if (unknown.length > 0) {
      const busy = unknown.map((s) => `:${s.port}`).join(" ");
      return { ...base, label: `${busy} busy`, tooltip: `wts: ${busy} held by another program`, color: "red" };
    }
    if (owners.length === 0) return { ...base, label: `stopped${lockMark}`, tooltip: `wts: stopped${locked} · ${portList}`, color: "gray" };
    const complete = owners.length === 1 && statuses.every((s) => s.pid !== null);
    const name = owners.length === 1 ? path.basename(ownerPath!) : "mixed worktrees";
    return { ...base, label: `${name}${lockMark}`, tooltip: `wts: ${name}${locked} · ${portList}`, color: complete ? "green" : "red" };
  }

  /** Proxy mode: who the fixed ports forward to, from the forwarder's last discovery (no extra query). */
  private proxyState(repo: CtxWithConfig, phase?: "switching", text?: string): WidgetState {
    const selected = repo.store.readState()?.owner ?? null;
    const lockInfo = repo.store.readLock();
    this.owner = selected;
    const worktrees = repo.worktrees
      .filter((wt) => fs.existsSync(path.join(wt, CONFIG_FILE)))
      .map((wt) => ({ name: path.basename(wt), path: wt, active: !!selected && normPath(wt) === normPath(selected) }));
    const base = { locked: !!lockInfo, worktrees };
    const lockMark = lockInfo ? " 🔒" : "";
    const locked = lockInfo ? ` · locked by ${path.basename(lockInfo.worktree)}` : "";
    if (phase === "switching") return { ...base, label: text ?? "switching…", tooltip: `wts: ${text}`, color: "yellow" };
    if (!selected) return { ...base, label: `none selected${lockMark}`, tooltip: `wts proxy: no worktree selected${locked}`, color: "gray" };
    const name = path.basename(selected);
    const ports = this.proxies.get(repo.store.dir)?.portsFor(selected) ?? {};
    const missing = Object.keys(ports).filter((s) => ports[s] === null);
    const routes = Object.entries(repo.config.services).map(([s, svc]) => `${s} ${svc.port}→${ports[s] ?? "-"}`).join(", ");
    if (missing.length > 0) {
      return { ...base, label: `${name}${lockMark}`, tooltip: `wts: ${name} not running ${missing.join(", ")}${locked}`, color: "red" };
    }
    return { ...base, label: `${name}${lockMark}`, tooltip: `wts: ${name} · ${routes}${locked}`, color: "green" };
  }
}

function stampConsole(): void {
  for (const k of ["log", "error"] as const) {
    const orig = console[k].bind(console);
    console[k] = (...args: unknown[]) => orig(new Date().toTimeString().slice(0, 8), ...args);
  }
}
