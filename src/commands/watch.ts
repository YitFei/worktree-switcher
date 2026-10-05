import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE, loadConfig } from "../config.js";
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
import { portsOf, readPortMap } from "../ports.js";
import { listWorktreesDetailed } from "../git.js";
import { isUsableWorktree, knownRepos } from "../repos.js";
import type { MenuProject } from "../platform/widget.js";

const POLL_MS = 500;
const TRAY_REFRESH_MS = 10_000;

export interface WatchOptions {
  /** Follow Orca's selection. undefined = whenever Orca's state DB exists. */
  orca?: boolean;
  /** Auto-switch. undefined = the last choice (default Manual). */
  auto?: boolean;
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

const PREFS = () => path.join(os.homedir(), ".wts", "watch.json");

/** Auto / Manual, remembered across runs. Default Manual. */
interface Prefs {
  /** Auto-switch (default Manual). */
  auto?: boolean;
  /** Menu lists every project, not only the current one. */
  showAll?: boolean;
}

export function loadPrefs(): Prefs {
  try {
    return JSON.parse(fs.readFileSync(PREFS(), "utf8")) as Prefs;
  } catch {
    return {};
  }
}

export function savePrefs(change: Prefs): void {
  fs.mkdirSync(path.dirname(PREFS()), { recursive: true });
  fs.writeFileSync(PREFS(), JSON.stringify({ ...loadPrefs(), ...change }));
}

export function loadAuto(): boolean {
  return loadPrefs().auto === true;
}

export function saveAuto(auto: boolean): void {
  savePrefs({ auto });
}

/**
 * Show the floating button, run the proxy for proxy-mode repos, and — in Auto mode — switch the
 * dev servers to the worktree the user settles on. Manual mode (the default) only switches on
 * request: the button's menu, `wts switch`, or an agent.
 */
export async function watch(opts: WatchOptions): Promise<void> {
  stampConsole();
  const start = Date.now();
  const sources: Source[] = [
    { name: "wts focus", read: () => { const f = readFocus(); return f && f.time >= start ? f.worktree : null; } },
  ];
  const orcaDb = opts.orcaDb ?? defaultOrcaDb();
  if (opts.orca === true || (opts.orca === undefined && fs.existsSync(orcaDb))) {
    sources.push({ name: "orca", read: await orcaReader(orcaDb) });
  }
  if (opts.auto !== undefined) saveAuto(opts.auto);

  const w = new Watcher(opts.ui === "none" ? null : new Widget(opts.ui), opts.auto ?? loadAuto());
  console.log(`following ${sources.map((s) => s.name).join(" + ")}; ${w.auto ? "Auto" : "Manual"} mode${w.auto ? ` (switch after ${opts.delaySec}s on the same worktree)` : " (switch from the button, wts switch or an agent)"}; Ctrl+C to stop`);
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
    // Manual mode still tracks the selection, so turning Auto on follows the *next* worktree you settle on.
    if (ready && target && w.auto) await w.switchTo(target, false);
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

  constructor(
    private readonly widget: Widget | null,
    public auto: boolean,
    private showAll = loadPrefs().showAll === true,
  ) {
    try {
      this.repo = loadContextWithConfig(process.cwd());
    } catch {
      // started outside a configured worktree; the widget waits for the first focus
    }
  }

  async start(): Promise<void> {
    if (this.repo) await this.ensureProxy(this.repo);
    if (!this.widget) return;
    this.widget.start({ label: "starting…", tooltip: "wts: starting…", color: "gray", locked: false, projects: [], auto: this.auto, showAll: this.showAll, restartTip: "" });
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
    if (cmd.action === "showall" || cmd.action === "showcurrent") {
      this.showAll = cmd.action === "showall";
      savePrefs({ showAll: this.showAll });
      return this.refresh();
    }
    if (cmd.action === "auto" || cmd.action === "manual") {
      this.auto = cmd.action === "auto";
      saveAuto(this.auto);
      console.log(`${this.auto ? "Auto" : "Manual"} mode`);
      return this.refresh();
    }
    if (!this.repo) return;
    if (cmd.action === "restart") return this.restart(this.repo);
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

  /**
   * ↻. run mode: stop the running worktree's servers and start them again from wts.json.
   * proxy mode: wts did not start those servers, so it re-detects them and drops open connections
   * (the page reloads from them); restarting a server is done in its own terminal.
   */
  private async restart(repo: CtxWithConfig): Promise<void> {
    if (repo.config.mode === "proxy") {
      await this.proxies.get(repo.store.dir)?.reconnect();
      console.log("reconnected (proxy mode)");
      return this.refresh(undefined, undefined, {
        title: "wts: reconnected",
        text: "Proxy mode: servers re-detected, connections reset. To restart a server, restart it in its own terminal.",
      });
    }
    const where = this.owner ?? repo.current;
    let ctx: CtxWithConfig;
    try {
      ctx = loadContextWithConfig(where);
    } catch (e) {
      return this.refresh(undefined, undefined, { title: "wts: restart failed", text: (e as Error).message });
    }
    this.refresh("switching", `↻ ${path.basename(where)}…`);
    try {
      await switchTo(ctx, false, { restart: true });
      this.refresh();
    } catch (e) {
      console.log(`restart failed: ${(e as Error).message}`);
      this.refresh(undefined, undefined, { title: `wts: restart of ${path.basename(where)} failed`, text: (e as Error).message });
    }
  }

  private restartTip(repo: CtxWithConfig | null): string {
    if (!repo) return "Nothing to restart yet";
    if (repo.config.mode === "proxy") return "Proxy mode: re-detect servers and reconnect (restart a server in its own terminal)";
    return this.owner ? `Restart ${path.basename(this.owner)}'s servers` : "Restart: start this worktree's servers";
  }

  /** Recompute the widget from the real port owners (a PowerShell query, ~1 s). */
  private refresh(phase?: "switching", text?: string, notify?: { title: string; text: string }): void {
    this.lastRefresh = Date.now();
    if (!this.widget) return;
    const n = notify ? { id: ++this.notifyId, ...notify } : undefined;
    if (!this.repo) {
      this.widget.update({ label: "waiting", tooltip: "wts: waiting for a worktree with wts.json", color: "gray", locked: false, projects: this.projectsMenu(null, null), auto: this.auto, showAll: this.showAll, restartTip: this.restartTip(null), notify: n });
      return;
    }
    try {
      this.repo = loadContextWithConfig(this.repo.current); // pick up new / removed worktrees
    } catch {
      // keep the previous context
    }
    const s = this.state(this.repo, phase, text);
    this.widget.update({ ...s, auto: this.auto, showAll: this.showAll, restartTip: this.restartTip(this.repo), notify: n });
  }

  private state(repo: CtxWithConfig, phase?: "switching", text?: string): Omit<WidgetState, "auto" | "restartTip" | "showAll"> {
    if (repo.config.mode === "proxy") return this.proxyState(repo, phase, text);
    const portList = ports(repo).map((p) => `:${p}`).join(" ");
    const snap = snapshot(ports(repo));
    const statuses = inspect(repo, snap.listeners, snap.procs, repo.store.readState());
    const lockInfo = repo.store.readLock();
    const owners = [...new Set(statuses.flatMap((s) => (s.worktree ? [normPath(s.worktree)] : [])))];
    const unknown = statuses.filter((s) => s.pid !== null && s.worktree === null);
    const ownerPath = owners.length === 1 ? statuses.find((s) => s.worktree)!.worktree! : null;
    this.owner = ownerPath;

    const proj = projectName(repo);
    const locked = lockInfo ? ` · locked by ${path.basename(lockInfo.worktree)}` : "";

    const lockMark = lockInfo ? " 🔒" : "";
    const routes = alignRoutes(statuses.map((s) => [`:${s.port}`, "──", s.worktree ? path.basename(s.worktree) : s.pid !== null ? "another program" : "stopped", s.service]));
    const base = { locked: !!lockInfo, projects: this.projectsMenu(repo, ownerPath, { routes }) };
    if (phase === "switching") return { ...base, label: text ?? "switching…", tooltip: `wts: ${text}`, color: "yellow" };
    if (unknown.length > 0) {
      const busy = unknown.map((s) => `:${s.port}`).join(" ");
      return { ...base, label: `${busy} busy`, tooltip: `wts: ${busy} held by another program`, color: "red" };
    }
    if (owners.length === 0) return { ...base, label: `${proj} · stopped${lockMark}`, tooltip: `wts: ${proj} stopped${locked} · ${portList}`, color: "gray" };
    const complete = owners.length === 1 && statuses.every((s) => s.pid !== null);
    const name = owners.length === 1 ? path.basename(ownerPath!) : "mixed worktrees";
    return { ...base, label: `${proj} › ${name}${lockMark}`, tooltip: `wts: ${proj} › ${name}${locked} · ${portList}`, color: complete ? "green" : "red" };
  }

  /** Proxy mode: who the fixed ports forward to, from the forwarder's last discovery (no extra query). */
  private proxyState(repo: CtxWithConfig, phase?: "switching", text?: string): Omit<WidgetState, "auto" | "restartTip" | "showAll"> {
    const selected = repo.store.readState()?.owner ?? null;
    const lockInfo = repo.store.readLock();
    this.owner = selected;
    const proj = projectName(repo);
    const fwd = this.proxies.get(repo.store.dir);
    const blocked = fwd?.blocked() ?? new Map<number, string>();
    const found = fwd?.lastFound() ?? [];
    const assigned = readPortMap(repo.store.dir);
    const now = selected ? fwd?.portsFor(selected) ?? {} : {};
    const mine = selected ? portsOf(assigned, selected) : {};
    const routeLines = alignRoutes(
      Object.entries(repo.config.services).map(([s, svc]) => {
        if (blocked.has(svc.port)) return [`:${svc.port}`, "──✗", "held by another program", s];
        const to = !selected ? "(none selected)" : now[s] ? `:${now[s]}` : mine[s] ? `start on :${mine[s]}` : "not running";
        return [`:${svc.port}`, "──→", to, s];
      }),
    );
    const portsOfWorktree = (wt: string) => {
      const want = portsOf(assigned, wt);
      return Object.keys(repo.config.services)
        .map((s) => {
          const f = found.find((x) => x.service === s && normPath(x.worktree) === normPath(wt));
          return (f ? `:${f.port}` : want[s] ? `:${want[s]}?` : "-").padEnd(7);
        })
        .join(" ")
        .trimEnd();
    };
    const base = { locked: !!lockInfo, projects: this.projectsMenu(repo, selected, { routes: routeLines, ports: portsOfWorktree }) };
    const lockMark = lockInfo ? " 🔒" : "";
    const locked = lockInfo ? ` · locked by ${path.basename(lockInfo.worktree)}` : "";
    if (phase === "switching") return { ...base, label: text ?? "switching…", tooltip: `wts: ${text}`, color: "yellow" };
    if (blocked.size > 0) {
      const [[port, who]] = [...blocked];
      return { ...base, label: `${proj} · :${port} held`, tooltip: `wts: :${port} is held by ${who}; stop it so the proxy can take the port`, color: "red" };
    }
    if (!selected) return { ...base, label: `${proj} · none selected${lockMark}`, tooltip: `wts proxy: ${proj}, no worktree selected${locked}`, color: "gray" };
    const name = `${proj} › ${path.basename(selected)}`;
    const missing = Object.keys(now).filter((s) => now[s] === null);
    const routes = Object.entries(repo.config.services).map(([s, svc]) => `${s} ${svc.port}→${now[s] ?? "-"}`).join(", ");
    if (missing.length > 0) {
      const todo = missing.map((s) => (mine[s] ? `${s} on ${mine[s]}` : s)).join(", ");
      return { ...base, label: `${name}${lockMark}`, tooltip: `wts: ${name} - start ${todo}${locked}`, color: "red" };
    }
    return { ...base, label: `${name}${lockMark}`, tooltip: `wts: ${name} · ${routes}${locked}`, color: "green" };
  }

  /**
   * Menu groups: the current project, plus — with "Show all projects" — every other project wts
   * has used on this machine (~/.wts/repos.json). Only worktrees with a wts.json; Orca's temp folders
   * are skipped. The active mark of other projects comes from their saved state (no port query).
   */
  private projectsMenu(
    repo: CtxWithConfig | null,
    active: string | null,
    live: { routes?: string[]; ports?: (worktree: string) => string } = {},
  ): MenuProject[] {
    const groups: MenuProject[] = [];
    const seen = new Set<string>();
    const add = (cwd: string, commonDirPath: string, activePath: string | null, current: boolean) => {
      const key = normPath(commonDirPath);
      if (seen.has(key)) return;
      seen.add(key);
      let infos;
      try {
        infos = listWorktreesDetailed(cwd);
      } catch {
        return;
      }
      const main = infos.find((i) => i.main);
      const listed = infos.filter((i) => isUsableWorktree(i.path) && fs.existsSync(path.join(i.path, CONFIG_FILE)));
      if (listed.length === 0) return;
      const modes = listed.map((i) => {
        try {
          return loadConfig(i.path).mode as string;
        } catch {
          return "invalid";
        }
      });
      const names = listed.map((i) => (i.main ? `${i.branch ?? "main"} (main)` : path.basename(i.path)));
      const width = Math.max(...names.map((n) => n.length));
      const worktrees = listed.map((i, k) => ({
        name: names[k],
        path: i.path,
        active: !!activePath && normPath(i.path) === normPath(activePath),
        // name column padded, then this worktree's ports (current project, proxy mode)
        row: current && live.ports ? `${names[k].padEnd(width)}   ${live.ports(i.path)}`.trimEnd() : names[k],
      }));
      // The main checkout's mode; worktrees that differ (not merged yet) are named in the header.
      const mode = modes[0];
      const odd = listed.filter((_, i) => modes[i] !== mode).map((i, k) => `${path.basename(i.path)}: ${modes[listed.indexOf(i)]}`);
      const header = odd.length > 0 ? `${mode} (${odd.join(", ")}!)` : mode;
      groups.push({ name: path.basename(main?.path ?? cwd), path: main?.path ?? cwd, mode: header, ...(current ? { routes: live.routes } : {}), worktrees });
    };
    if (repo) add(repo.current, path.dirname(repo.store.dir), active, true);
    if (this.showAll || !repo) {
      const others = knownRepos().sort((a, b) => path.basename(a.worktree).localeCompare(path.basename(b.worktree)));
      for (const r of others) add(r.worktree, r.commonDir, savedOwner(r.commonDir), false);
    }
    return groups;
  }
}

/** Menu route lines in aligned columns (the menu shows them in a monospace font). */
export function alignRoutes(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => r[c].length))) ?? [];
  return rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join("  ").trimEnd());
}

/** The project's name: the main checkout's folder (falls back to the current worktree's). */
function projectName(repo: CtxWithConfig): string {
  const common = path.dirname(repo.store.dir);
  return path.basename(path.basename(common).toLowerCase() === ".git" ? path.dirname(common) : repo.current);
}

/** Who runs a project's servers / is selected, from its saved state (no port query). */
function savedOwner(commonDirPath: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(commonDirPath, "wts", "state.json"), "utf8")) as { owner?: string }).owner ?? null;
  } catch {
    return null;
  }
}

function stampConsole(): void {
  for (const k of ["log", "error"] as const) {
    const orig = console[k].bind(console);
    console[k] = (...args: unknown[]) => orig(new Date().toTimeString().slice(0, 8), ...args);
  }
}
