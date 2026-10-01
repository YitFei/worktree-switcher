import fs from "node:fs";
import path from "node:path";
import { WtsError } from "./errors.js";
import { samePath } from "./owner.js";

export interface ServiceState {
  /** PID of the shell wts spawned; its process tree is the service. */
  pid: number;
  /** Process creation time (ms since epoch) — guards against PID reuse. */
  created: number;
  port: number;
}

export interface State {
  owner: string;
  startedAt: string;
  services: Record<string, ServiceState>;
}

export interface Lock {
  worktree: string;
  note?: string;
  time: string;
}

/** Shared state for all worktrees of one repo, kept under <git-common-dir>/wts/. */
export class Store {
  readonly dir: string;

  constructor(gitCommonDir: string) {
    this.dir = path.join(gitCommonDir, "wts");
    fs.mkdirSync(path.join(this.dir, "logs"), { recursive: true });
  }

  logPath(service: string): string {
    return path.join(this.dir, "logs", `${service}.log`);
  }

  readState(): State | null {
    return this.read<State>("state.json");
  }
  writeState(state: State): void {
    this.write("state.json", state);
  }
  clearState(): void {
    fs.rmSync(path.join(this.dir, "state.json"), { force: true });
  }

  readLock(): Lock | null {
    return this.read<Lock>("lock.json");
  }
  writeLock(lock: Lock): void {
    this.write("lock.json", lock);
  }
  clearLock(): void {
    fs.rmSync(path.join(this.dir, "lock.json"), { force: true });
  }

  private read<T>(name: string): T | null {
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  }
  private write(name: string, value: unknown): void {
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(value, null, 2) + "\n");
  }
}

/** Throws (exit 2) when another worktree holds the lock and --force was not given. */
export function checkLock(lock: Lock | null, current: string, force: boolean): void {
  if (!lock || force || samePath(lock.worktree, current)) return;
  const note = lock.note ? ` ("${lock.note}")` : "";
  throw new WtsError(`locked by ${lock.worktree} since ${lock.time}${note}; use --force to override`, 2);
}
