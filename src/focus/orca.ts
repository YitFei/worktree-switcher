// Reads which workspace is selected in Orca. This is Orca's internal state DB, not a public API:
// Orca's plugin API has no "worktree activated" event, so this is the only automatic signal.
// Verified against Orca on 2026-10-01; if Orca changes the format, readers just return null.
import path from "node:path";
import { WtsError } from "../errors.js";
import { normPath } from "../owner.js";

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

/** `<uuid>::C:/…/worktree[::workspace:…]` → normalized worktree path. */
function worktreeOfId(id: string): string | null {
  const i = id.indexOf("::");
  if (i < 0) return null;
  const rest = id.slice(i + 2);
  const j = rest.indexOf("::");
  const p = j < 0 ? rest : rest.slice(0, j);
  return p ? normPath(p) : null;
}

/**
 * Worktrees Orca has put to sleep (grey dot in its sidebar): known to Orca (`worktreeMeta`) but not
 * awake (`activeWorktreeIdsOnShutdown`, which Orca keeps current while it runs). Normalized paths;
 * null when the data is missing or unreadable, so callers hide nothing.
 */
export function parseOrcaSleeping(metaPayload: string, sessionPayload: string): Set<string> | null {
  let meta: unknown, session: unknown;
  try {
    meta = JSON.parse(metaPayload);
    session = JSON.parse(sessionPayload);
  } catch {
    return null;
  }
  const awakeIds = (session as { activeWorktreeIdsOnShutdown?: unknown } | null)?.activeWorktreeIdsOnShutdown;
  if (!meta || typeof meta !== "object" || !Array.isArray(awakeIds)) return null;
  const awake = new Set(awakeIds.flatMap((id) => (typeof id === "string" ? [worktreeOfId(id)] : [])));
  const sleeping = new Set<string>();
  for (const id of Object.keys(meta)) {
    const p = worktreeOfId(id);
    if (p && !awake.has(p)) sleeping.add(p);
  }
  return sleeping;
}

function payloadOf(db: import("node:sqlite").DatabaseSync, domain: string): string | undefined {
  const row = db
    .prepare("select payload from profile_state_documents where domain = ? order by updated_at desc limit 1")
    .get(domain) as { payload?: string } | undefined;
  return row?.payload;
}

/** Returns a function that reads Orca's sleeping worktrees (see parseOrcaSleeping). */
export async function orcaSleepingReader(dbPath: string): Promise<() => Set<string> | null> {
  const { DatabaseSync } = await importSqlite();
  return () => {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const meta = payloadOf(db, "worktreeMeta");
        const session = payloadOf(db, "workspaceSession");
        return meta && session ? parseOrcaSleeping(meta, session) : null;
      } finally {
        db.close();
      }
    } catch {
      return null; // DB busy or format changed: hide nothing
    }
  };
}

/** Returns a function that reads Orca's currently selected worktree path. */
export async function orcaReader(dbPath: string): Promise<() => string | null> {
  const { DatabaseSync } = await importSqlite();
  const read = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const payload = payloadOf(db, "workspaceSession");
      return payload ? parseOrcaActive(payload) : null;
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
