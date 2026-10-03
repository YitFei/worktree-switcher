// Windows tray icon for `wts watch`: a PowerShell WinForms NotifyIcon in a child process.
// watch → tray: state file (tooltip, colour, menu). tray → watch: command file (menu clicks).
// The tray only displays and forwards clicks; watch executes everything.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TrayColor = "green" | "yellow" | "red" | "gray";

export interface TrayState {
  tooltip: string;
  color: TrayColor;
  locked: boolean;
  worktrees: { name: string; path: string; active: boolean }[];
  /** Shown once as a balloon; a new id shows a new balloon. */
  notify?: { id: number; title: string; text: string };
}

export type TrayCommand =
  | { action: "switch"; path: string }
  | { action: "lock" | "unlock" | "stop" | "exit" };

/** NotifyIcon.Text throws above 63 characters on .NET Framework. */
export function fitTooltip(text: string): string {
  return text.length <= 63 ? text : text.slice(0, 62) + "…";
}

export class Tray {
  private readonly stateFile: string;
  private readonly cmdFile: string;
  private child: ChildProcess | null = null;
  private lastCmd = 0;

  constructor() {
    const dir = path.join(os.homedir(), ".wts");
    fs.mkdirSync(dir, { recursive: true });
    removeStaleFiles(dir);
    this.stateFile = path.join(dir, `tray-${process.pid}-state.json`);
    this.cmdFile = path.join(dir, `tray-${process.pid}-cmd.json`);
  }

  start(initial: TrayState): void {
    this.update(initial);
    const script = TRAY_PS
      .replace("__STATE__", psQuote(this.stateFile))
      .replace("__CMD__", psQuote(this.cmdFile))
      .replace("__PARENT__", String(process.pid));
    // Not detached: the tray dies with watch.
    this.child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, stdio: "ignore" },
    );
    this.child.on("error", () => {});
    const cleanup = () => {
      fs.rmSync(this.stateFile, { force: true });
      fs.rmSync(this.cmdFile, { force: true });
    };
    process.on("exit", () => {
      this.child?.kill();
      cleanup();
    });
    for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(sig, () => process.exit(0));
  }

  update(state: TrayState): void {
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, tooltip: fitTooltip(state.tooltip) }));
    fs.renameSync(tmp, this.stateFile);
  }

  /** The newest unread menu click, if any. */
  takeCommand(): TrayCommand | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.cmdFile, "utf8").replace(/^﻿/, "");
    } catch {
      return null;
    }
    try {
      const cmd = JSON.parse(raw) as TrayCommand & { time: number };
      if (!(cmd.time > this.lastCmd)) return null;
      this.lastCmd = cmd.time;
      return cmd;
    } catch {
      return null; // half-written; next tick
    }
  }
}

/** A watch that was killed (not stopped) cannot clean up its tray files; do it for it. */
function removeStaleFiles(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const m = /^tray-(\d+)-(state|cmd)\.json(\.tmp)?$/.exec(name);
    if (m && !isRunning(Number(m[1]))) fs.rmSync(path.join(dir, name), { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const TRAY_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$StateFile = __STATE__
$CmdFile = __CMD__
$ParentPid = __PARENT__

$colors = @{ green = '#2EA043'; yellow = '#D29922'; red = '#DA3633'; gray = '#8B949E' }
$icons = @{}
foreach ($k in $colors.Keys) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($colors[$k]))
  $g.FillEllipse($brush, 1, 1, 14, 14)
  $g.Dispose()
  $icons[$k] = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icons['gray']
$ni.Text = 'wts'
$ni.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$ni.ContextMenuStrip = $menu

function Send-Cmd($action, $path) {
  $o = @{ action = $action; time = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
  if ($path) { $o.path = $path }
  [System.IO.File]::WriteAllText($script:CmdFile, ($o | ConvertTo-Json -Compress))
}

$script:last = ''
$script:lastNotify = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.add_Tick({
  if (-not (Get-Process -Id $script:ParentPid -ErrorAction SilentlyContinue)) {
    $ni.Visible = $false
    [System.Windows.Forms.Application]::Exit()
    return
  }
  try { $raw = [System.IO.File]::ReadAllText($script:StateFile) } catch { return }
  if (-not $raw -or $raw -eq $script:last) { return }
  try { $s = $raw | ConvertFrom-Json } catch { return }
  $script:last = $raw

  $ni.Icon = $icons[$s.color]
  $ni.Text = $s.tooltip
  if ($s.notify -and $s.notify.id -ne $script:lastNotify) {
    $script:lastNotify = $s.notify.id
    $ni.ShowBalloonTip(4000, $s.notify.title, $s.notify.text, 'Info')
  }

  $menu.Items.Clear()
  foreach ($w in $s.worktrees) {
    $prefix = if ($w.active) { [char]0x25CF + ' ' } else { [char]0x25CB + ' ' }
    $item = $menu.Items.Add($prefix + $w.name)
    $item.ToolTipText = $w.path
    $item.Tag = $w.path
    if ($w.active) { $item.Font = New-Object System.Drawing.Font($item.Font, [System.Drawing.FontStyle]::Bold) }
    $item.add_Click({ param($sender) Send-Cmd 'switch' $sender.Tag })
  }
  if ($s.worktrees.Count -gt 0) { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) }
  if ($s.locked) { $menu.Items.Add('Unlock').add_Click({ Send-Cmd 'unlock' }) }
  else { $menu.Items.Add('Lock').add_Click({ Send-Cmd 'lock' }) }
  $menu.Items.Add('Stop').add_Click({ Send-Cmd 'stop' })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $menu.Items.Add('Exit wts watch').add_Click({ Send-Cmd 'exit' })
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
$ni.Dispose()
`;
