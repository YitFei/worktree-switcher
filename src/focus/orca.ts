// Reads which workspace is selected in Orca. This is Orca's internal state DB, not a public API:
// Orca's plugin API has no "worktree activated" event, so this is the only automatic signal.
// Verified against Orca on 2026-10-01; if Orca changes the format, readers just return null.
import path from "node:path";
import { WtsError } from "../errors.js";

export function defaultOrcaDb(): string {
  return path.join(process.env.APPDATA ?? "", "orca", "profiles", "local-default", "profile-state.db");
}

/** `{"activeWorktreeId":"<uuid>::C:/…/worktree", …}` → worktree path (null for non-worktree views). */
export function parseOrcaActive(payload: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  const id = (obj as { activeWorktreeId?: unknown } | null)?.activeWorktreeId;
  if (typeof id !== "string") return null;
  const i = id.indexOf("::");
  if (i < 0 || i + 2 >= id.length) return null;
  return path.resolve(id.slice(i + 2));
}

/** Returns a function that reads Orca's currently selected worktree path. */
export async function orcaReader(dbPath: string): Promise<() => string | null> {
  const { DatabaseSync } = await importSqlite();
  const read = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("select payload from profile_state_documents where domain = 'workspaceSession' order by updated_at desc limit 1")
        .get() as { payload?: string } | undefined;
      return row?.payload ? parseOrcaActive(row.payload) : null;
    } finally {
      db.close();
    }
  };
  try {
    read();
  } catch (e) {
    throw new WtsError(`cannot read Orca state from ${dbPath}: ${(e as Error).message}`);
  }
  return read;
}

/** node:sqlite prints an ExperimentalWarning on Node 22; keep the watch output clean. */
async function importSqlite(): Promise<typeof import("node:sqlite")> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite")) return;
    (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  return import("node:sqlite");
}
