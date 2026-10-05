import { describe } from "../owner.js";
import { snapshot } from "../platform/win.js";
import { inspect, label, ports, type CtxWithConfig } from "../context.js";
import { proxyStatus } from "./select.js";

export async function status(ctx: CtxWithConfig): Promise<void> {
  if (ctx.config.mode === "proxy") return proxyStatus(ctx);
  const snap = snapshot(ports(ctx));
  const state = ctx.store.readState();
  const lock = ctx.store.readLock();

  console.log(`worktree: ${label(ctx.current, ctx.current)}`);
  console.log(`lock:     ${lock ? `${label(lock.worktree, ctx.current)} since ${lock.time}${lock.note ? ` — ${lock.note}` : ""}` : "none"}`);
  if (state) console.log(`started:  ${label(state.owner, ctx.current)} at ${state.startedAt}`);
  console.log("");

  for (const s of inspect(ctx, snap.listeners, snap.procs, state)) {
    const head = `${s.service.padEnd(12)} :${String(s.port).padEnd(6)}`;
    if (s.pid === null) {
      console.log(`${head} free`);
    } else if (s.worktree) {
      console.log(`${head} pid ${s.pid}  ${label(s.worktree, ctx.current)}${s.viaWts ? "  (wts)" : ""}`);
    } else {
      console.log(`${head} UNKNOWN ${describe(s.pid, snap.procs)}`);
    }
  }
}
