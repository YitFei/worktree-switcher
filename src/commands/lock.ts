import { checkLock } from "../state.js";
import { label, type Ctx } from "../context.js";

export function lock(ctx: Ctx, note: string | undefined, force: boolean): void {
  checkLock(ctx.store.readLock(), ctx.current, force);
  ctx.store.writeLock({ worktree: ctx.current, note, time: new Date().toISOString() });
  console.log(`locked by ${label(ctx.current, ctx.current)}${note ? ` — ${note}` : ""}`);
}

export function unlock(ctx: Ctx, force: boolean): void {
  const existing = ctx.store.readLock();
  if (!existing) {
    console.log("not locked");
    return;
  }
  checkLock(existing, ctx.current, force);
  ctx.store.clearLock();
  console.log(`unlocked (was ${label(existing.worktree, ctx.current)})`);
}
