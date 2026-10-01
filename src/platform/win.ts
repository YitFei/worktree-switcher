import { execFileSync } from "node:child_process";
import { WtsError } from "../errors.js";
import type { ProcInfo, Procs } from "../owner.js";

export interface Snapshot {
  /** port → PID listening on it. */
  listeners: Map<number, number>;
  procs: Procs;
}

function powershell(script: string): string {
  const full = `$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`;
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(full, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    throw new WtsError(`powershell query failed: ${(e as Error).message}`);
  }
}

function toArray<T>(v: T | T[] | null | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

const LISTENERS = (ports: number[]) =>
  `@(Get-NetTCPConnection -State Listen -LocalPort ${ports.join(",")} | Select-Object LocalPort,OwningProcess)`;

function parseListeners(raw: unknown): Map<number, number> {
  const map = new Map<number, number>();
  for (const l of toArray(raw as { LocalPort: number; OwningProcess: number }[])) {
    if (!map.has(l.LocalPort) && l.OwningProcess > 4) map.set(l.LocalPort, l.OwningProcess);
  }
  return map;
}

/** Listening PIDs only — cheap enough to poll. */
export function listeners(ports: number[]): Map<number, number> {
  const out = powershell(`ConvertTo-Json -Compress -InputObject ${LISTENERS(ports)}`).trim();
  return parseListeners(out ? JSON.parse(out) : []);
}

/** Listening PIDs plus every process (needed for attribution and tree walks). */
export function snapshot(ports: number[]): Snapshot {
  const out = powershell(`
    $l = ${LISTENERS(ports)}
    $p = @(Get-CimInstance Win32_Process | ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name
        exe = $_.ExecutablePath; cmd = $_.CommandLine
        created = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 })
      }
    })
    ConvertTo-Json -Compress -Depth 3 -InputObject @{ listeners = $l; procs = $p }
  `);
  const raw = JSON.parse(out) as { listeners: unknown; procs: ProcInfo | ProcInfo[] };
  const procs: Procs = new Map();
  for (const p of toArray(raw.procs)) procs.set(p.pid, p);
  return { listeners: parseListeners(raw.listeners), procs };
}

/** Kill a process and all its descendants. Ignores processes that are already gone. */
export function killTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
  } catch {
    // already exited
  }
}
