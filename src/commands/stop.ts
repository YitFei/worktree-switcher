import { WtsError } from "../errors.js";
import { describe, isAlive, type Procs } from "../owner.js";
import { killTree, listeners, snapshot } from "../platform/win.js";
import { checkLock, type State } from "../state.js";
import { inspect, label, ports, sleep, type CtxWithConfig, type PortStatus } from "../context.js";

const FREE_TIMEOUT_MS = 15_000;

/**
 * Kill the service trees wts started plus any listener attributable to a worktree of this repo,
 * then wait until those ports are free. Unknown processes are never touched.
 */
export async function stopOwned(ctx: CtxWithConfig, statuses: PortStatus[], procs: Procs, state: State | null): Promise<void> {
  for (const svc of Object.values(state?.services ?? {})) {
    if (isAlive(svc, procs)) killTree(svc.pid);
  }
  const owned = statuses.filter((s) => s.pid !== null && s.worktree !== null);
  for (const s of owned) killTree(s.pid!);
  ctx.store.clearState();

  const deadline = Date.now() + FREE_TIMEOUT_MS;
  for (;;) {
    const busy = listeners(owned.map((s) => s.port));
    if (busy.size === 0) return;
    if (Date.now() > deadline) {
      throw new WtsError(`ports still in use after stop: ${[...busy.keys()].join(", ")}`);
    }
    await sleep(500);
  }
}

export async function stop(ctx: CtxWithConfig, force: boolean): Promise<void> {
  checkLock(ctx.store.readLock(), ctx.current, force);
  const snap = snapshot(ports(ctx));
  const state = ctx.store.readState();
  const statuses = inspect(ctx, snap.listeners, snap.procs, state);

  for (const s of statuses) {
    if (s.pid === null) continue;
    if (s.worktree) console.log(`stopping ${s.service} :${s.port} — ${label(s.worktree, ctx.current)}`);
    else console.log(`leaving ${s.service} :${s.port} alone — not a worktree of this repo: ${describe(s.pid, snap.procs)}`);
  }
  await stopOwned(ctx, statuses, snap.procs, state);
  console.log("stopped");
}
