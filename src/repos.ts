// Projects (repos with a wts.json) this machine's wts has used, so the floating button can list
// them all, grouped. Remembered in ~/.wts/repos.json whenever a configured worktree is loaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normPath } from "./owner.js";

export interface KnownRepo {
  /** The repo's shared .git directory. */
  commonDir: string;
  /** A worktree to run git in (the main checkout when it exists). */
  worktree: string;
}

const FILE = () => path.join(os.homedir(), ".wts", "repos.json");

function read(): KnownRepo[] {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8")) as KnownRepo[];
  } catch {
    return [];
  }
}

/** Remember a configured repo (cheap: writes only when it is new). */
export function rememberRepo(commonDir: string, worktree: string): void {
  try {
    const repos = read();
    if (repos.some((r) => normPath(r.commonDir) === normPath(commonDir))) return;
    // The main checkout is the folder that holds .git; prefer it as the stable entry point.
    const main = path.basename(commonDir).toLowerCase() === ".git" ? path.dirname(commonDir) : worktree;
    repos.push({ commonDir, worktree: fs.existsSync(main) ? main : worktree });
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(repos, null, 2));
  } catch {
    // remembering is a convenience; never fail a command over it
  }
}

/** Remembered repos that still exist. */
export function knownRepos(): KnownRepo[] {
  return read().filter((r) => fs.existsSync(r.commonDir) && fs.existsSync(r.worktree));
}

/** Orca's half-created workspaces and folders that were deleted are not worktrees to offer. */
export function isUsableWorktree(p: string): boolean {
  return !/[\\/]\.orca-preparing[\\/]/i.test(p) && fs.existsSync(p);
}
