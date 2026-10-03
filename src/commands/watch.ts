import { loadContextWithConfig, label, sleep } from "../context.js";
import { readFocus } from "../focus/file.js";
import { defaultOrcaDb, orcaReader } from "../focus/orca.js";
import { normPath } from "../owner.js";
import { switchTo } from "./switch.js";

const POLL_MS = 500;

export interface WatchOptions {
  orca: boolean;
  orcaDb?: string;
  delaySec: number;
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

  const last = new Map<string, string | null>();
  const debouncer = new Debouncer(opts.delaySec * 1000);
  const ignored = new Set<string>();
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
    if (ready && target) await handle(target, ignored);
    await sleep(POLL_MS);
  }
}

async function handle(worktree: string, ignored: Set<string>): Promise<void> {
  let ctx;
  try {
    ctx = loadContextWithConfig(worktree);
  } catch (e) {
    const key = normPath(worktree);
    if (!ignored.has(key)) console.log(`ignoring ${worktree}: ${(e as Error).message}`);
    ignored.add(key);
    return;
  }
  console.log(`focus on ${label(ctx.current, ctx.current)}`);
  try {
    await switchTo(ctx, false);
  } catch (e) {
    console.log(`not switched: ${(e as Error).message}`);
  }
}

function stampConsole(): void {
  for (const k of ["log", "error"] as const) {
    const orig = console[k].bind(console);
    console[k] = (...args: unknown[]) => orig(new Date().toTimeString().slice(0, 8), ...args);
  }
}
