import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export interface RangeListener {
  port: number;
  pid: number;
  exe: string | null;
  cmd: string | null;
  /** Current directory of the process (null when it cannot be read). */
  cwd: string | null;
}

// Reads a process's current directory from its PEB (x64 layout). Compiled once into ~/.wts.
const CWD_SRC = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class WtsCwd {
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr s, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static byte[] Read(IntPtr h, IntPtr a, int n) { var b = new byte[n]; IntPtr r; return ReadProcessMemory(h, a, b, (IntPtr)n, out r) ? b : null; }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var p = new PBI(); int r;
      if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(p), out r) != 0) return null;
      var pp = Read(h, p.Peb + 0x20, 8); if (pp == null) return null;
      var us = Read(h, (IntPtr)BitConverter.ToInt64(pp, 0) + 0x38, 16); if (us == null) return null;
      var s = Read(h, (IntPtr)BitConverter.ToInt64(us, 8), BitConverter.ToUInt16(us, 0)); if (s == null) return null;
      return Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}`;

function powershellAsync(script: string): Promise<string> {
  const full = `$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(full, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(new WtsError(`powershell query failed: ${err.message}`)) : resolve(stdout)),
    );
  });
}

/** Listeners on ports inside the given ranges, with exe, command line and current directory. */
export async function rangeListeners(ranges: { from: number; to: number }[]): Promise<RangeListener[]> {
  if (ranges.length === 0) return [];
  const dir = path.join(os.homedir(), ".wts");
  fs.mkdirSync(dir, { recursive: true });
  const dll = path.join(dir, "wts-cwd-v1.dll").replace(/'/g, "''");
  const cond = ranges.map((r) => `($_.LocalPort -ge ${r.from} -and $_.LocalPort -le ${r.to})`).join(" -or ");
  const out = await powershellAsync(`
    $l = @(Get-NetTCPConnection -State Listen | Where-Object { ${cond} } | Where-Object { $_.OwningProcess -gt 4 } | Select-Object LocalPort,OwningProcess -Unique)
    if ($l.Count -eq 0) { '[]'; return }
    if (-not ('WtsCwd' -as [type])) {
      if (-not (Test-Path '${dll}')) { try { Add-Type -TypeDefinition @'
${CWD_SRC}
'@ -OutputAssembly '${dll}' } catch {} }
      if (Test-Path '${dll}') { Add-Type -Path '${dll}' } else { Add-Type -TypeDefinition @'
${CWD_SRC}
'@ }
    }
    $pids = @($l | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
    $procs = @{}
    Get-CimInstance Win32_Process -Filter (($pids | ForEach-Object { "ProcessId=$_" }) -join ' or ') | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
    $rows = @($l | ForEach-Object {
      $p = $procs[[int]$_.OwningProcess]
      [pscustomobject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; exe = $p.ExecutablePath; cmd = $p.CommandLine; cwd = [WtsCwd]::Get([int]$_.OwningProcess) }
    })
    ConvertTo-Json -Compress -Depth 3 -InputObject $rows
  `);
  const text = out.trim();
  return text ? toArray(JSON.parse(text) as RangeListener | RangeListener[]) : [];
}

/** Kill a process and all its descendants. Ignores processes that are already gone. */
export function killTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
  } catch {
    // already exited
  }
}
