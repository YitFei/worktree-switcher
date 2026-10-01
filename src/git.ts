import { execFileSync } from "node:child_process";
import path from "node:path";
import { WtsError } from "./errors.js";

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new WtsError(`not inside a git worktree (git ${args.join(" ")} failed in ${cwd})`);
  }
}

/** Root of the worktree containing `cwd`. */
export function worktreeRoot(cwd: string): string {
  return path.resolve(git(["rev-parse", "--show-toplevel"], cwd));
}

/** The .git directory shared by every worktree of the repo. */
export function commonDir(cwd: string): string {
  return path.resolve(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd));
}

/** Paths of all worktrees of the repo (main checkout included). */
export function listWorktrees(cwd: string): string[] {
  return parseWorktreeList(git(["worktree", "list", "--porcelain"], cwd));
}

export function parseWorktreeList(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
}
