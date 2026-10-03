// The generic focus signal: any tool (VS Code extension, script, Orca plugin) runs
// `wts focus <path>`, which writes this file; `wts watch` picks it up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Focus {
  worktree: string;
  /** ms since epoch */
  time: number;
}

export function focusFile(): string {
  return path.join(os.homedir(), ".wts", "focus.json");
}

export function writeFocus(worktree: string): void {
  const file = focusFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ worktree, time: Date.now() } satisfies Focus) + "\n");
}

export function readFocus(): Focus | null {
  try {
    return JSON.parse(fs.readFileSync(focusFile(), "utf8")) as Focus;
  } catch {
    return null;
  }
}
