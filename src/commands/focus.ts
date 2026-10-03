import path from "node:path";
import { worktreeRoot } from "../git.js";
import { focusFile, writeFocus } from "../focus/file.js";

/** Tell a running `wts watch` which worktree the user is looking at. */
export function focus(target: string): void {
  let worktree: string;
  try {
    worktree = worktreeRoot(target);
  } catch {
    worktree = path.resolve(target); // watch reports it as ignored
  }
  writeFocus(worktree);
  console.log(`focus → ${worktree} (${focusFile()})`);
}
