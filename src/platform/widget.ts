// On-screen status for `wts watch`: a floating button (default) or a tray icon, each a
// PowerShell WinForms child process. watch → widget: state file (label, colour, menu).
// widget → watch: command file (menu clicks). The widget only displays and forwards clicks;
// watch executes everything.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WidgetKind = "float" | "tray";
export type WidgetColor = "green" | "yellow" | "red" | "gray";

export interface WidgetState {
  /** Short text on the floating button. */
  label: string;
  /** Full status line (hover). */
  tooltip: string;
  color: WidgetColor;
  locked: boolean;
  /** Menu: worktrees grouped by project; the current project first. */
  projects: MenuProject[];
  /** Auto: follow the worktree selected in Orca / wts focus. Manual: switch only on request. */
  auto: boolean;
  /** Menu lists every project (not only the current one). */
  showAll: boolean;
  /** What the restart button does here (run mode: restart; proxy mode: reconnect). */
  restartTip: string;
  /** Shown once as a popup; a new id shows a new popup. */
  notify?: { id: number; title: string; text: string };
}

export interface MenuProject {
  name: string;
  /** Main checkout path (header tooltip). */
  path: string;
  /** "run" / "proxy", shown in the header. */
  mode?: string;
  /** Route lines for the current project, e.g. ":5273 ──→ :5276  frontend". */
  routes?: string[];
  /** row: the item's text in aligned columns (name padded + ports), shown in a monospace font. */
  worktrees: { name: string; path: string; active: boolean; row?: string }[];
}

export type WidgetCommand =
  | { action: "switch"; path: string }
  | { action: "lock" | "unlock" | "stop" | "exit" | "restart" | "auto" | "manual" | "showall" | "showcurrent" };

/** NotifyIcon.Text throws above 63 characters on .NET Framework. */
export function fitTooltip(text: string): string {
  return text.length <= 63 ? text : text.slice(0, 62) + "…";
}

export class Widget {
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly cmdFile: string;
  private child: ChildProcess | null = null;
  private lastCmd = 0;

  constructor(private readonly kind: WidgetKind) {
    this.dir = path.join(os.homedir(), ".wts");
    fs.mkdirSync(this.dir, { recursive: true });
    removeStaleFiles(this.dir);
    this.stateFile = path.join(this.dir, `widget-${process.pid}-state.json`);
    this.cmdFile = path.join(this.dir, `widget-${process.pid}-cmd.json`);
  }

  start(initial: WidgetState): void {
    this.update(initial);
    const script = (COMMON_PS + (this.kind === "float" ? FLOAT_PS : TRAY_PS))
      .replace("__STATE__", psQuote(this.stateFile))
      .replace("__CMD__", psQuote(this.cmdFile))
      .replace("__POS__", psQuote(path.join(this.dir, "float-pos.json")))
      .replace("__PARENT__", String(process.pid));
    // The script is too long for a command line (-EncodedCommand hits Windows' 32K limit and the
    // spawn fails), so it runs from a file. UTF-8 with BOM: Windows PowerShell 5.1 reads it as UTF-8.
    const scriptFile = path.join(this.dir, `widget-${process.pid}.ps1`);
    fs.writeFileSync(scriptFile, "﻿" + script, "utf8");
    // Not detached: the widget dies with watch (and also exits when it sees watch is gone).
    try {
      this.child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
        { windowsHide: true, stdio: "ignore" },
      );
      this.child.on("error", (e) => console.error(`wts: the floating button could not start: ${e.message}`));
    } catch (e) {
      // watch keeps working without its button (switching, proxy, MCP are unaffected)
      console.error(`wts: the floating button could not start: ${(e as Error).message}`);
    }
    process.on("exit", () => {
      this.child?.kill();
      fs.rmSync(this.stateFile, { force: true });
      fs.rmSync(this.cmdFile, { force: true });
      fs.rmSync(scriptFile, { force: true });
    });
    for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(sig, () => process.exit(0));
  }

  update(state: WidgetState): void {
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, tooltip: fitTooltip(state.tooltip) }));
    fs.renameSync(tmp, this.stateFile);
  }

  /** The newest unread menu click, if any. */
  takeCommand(): WidgetCommand | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.cmdFile, "utf8").replace(/^﻿/, "");
    } catch {
      return null;
    }
    try {
      const cmd = JSON.parse(raw) as WidgetCommand & { time: number };
      if (!(cmd.time > this.lastCmd)) return null;
      this.lastCmd = cmd.time;
      return cmd;
    } catch {
      return null; // half-written; next tick
    }
  }
}

/** A watch that was killed (not stopped) cannot clean up its files; do it for it. */
function removeStaleFiles(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const m = /^(?:tray|widget)-(\d+)(?:-(?:state|cmd)\.json(?:\.tmp)?|\.ps1)$/.exec(name);
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

/** Shared by both widgets: state polling, menu, command sending. Each widget defines Apply-State. */
const COMMON_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$StateFile = __STATE__
$CmdFile = __CMD__
$PosFile = __POS__
$ParentPid = __PARENT__
$colors = @{ green = '#2EA043'; yellow = '#D29922'; red = '#DA3633'; gray = '#8B949E' }
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:auto = $false

function Send-Cmd($action, $path) {
  $o = @{ action = $action; time = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
  if ($path) { $o.path = $path }
  [System.IO.File]::WriteAllText($script:CmdFile, ($o | ConvertTo-Json -Compress))
}

function Build-Menu($s) {
  $menu.Items.Clear()
  foreach ($p in $s.projects) {
    $title = if ($p.mode) { $p.name + '  ' + [char]0x00B7 + ' ' + $p.mode } else { $p.name }
    $h = New-Object System.Windows.Forms.ToolStripLabel $title
    $h.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
    $h.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
    $h.ToolTipText = $p.path
    [void]$menu.Items.Add($h)
    foreach ($line in @($p.routes)) {
      if (-not $line) { continue }
      $l = New-Object System.Windows.Forms.ToolStripLabel ('   ' + $line)
      $l.Font = New-Object System.Drawing.Font('Consolas', 9.5)
      $l.ForeColor = [System.Drawing.Color]::FromArgb(70, 110, 160)
      [void]$menu.Items.Add($l)
    }
    foreach ($w in $p.worktrees) {
      $prefix = if ($w.active) { [char]0x25CF + ' ' } else { [char]0x25CB + ' ' }
      $text = if ($w.row) { $w.row } else { $w.name }
      $item = $menu.Items.Add(' ' + $prefix + $text)
      $item.ToolTipText = $w.path
      $item.Tag = $w.path
      # Monospace so names and ports line up in columns (bold has the same width in Consolas).
      $style = if ($w.active) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
      $item.Font = New-Object System.Drawing.Font('Consolas', 9.5, $style)
      $item.add_Click({ param($sender) Send-Cmd 'switch' $sender.Tag })
    }
  }
  if (@($s.projects).Count -gt 0) { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) }
  $r = $menu.Items.Add([string][char]0x21BB + ' Restart')
  $r.ToolTipText = $s.restartTip
  $r.add_Click({ Send-Cmd 'restart' })
  $a = New-Object System.Windows.Forms.ToolStripMenuItem 'Auto-switch (follow Orca)'
  $a.Checked = [bool]$s.auto
  $a.add_Click({ if ($script:auto) { Send-Cmd 'manual' } else { Send-Cmd 'auto' } })
  [void]$menu.Items.Add($a)
  $all = New-Object System.Windows.Forms.ToolStripMenuItem 'Show all projects'
  $all.Checked = [bool]$s.showAll
  $script:showAll = [bool]$s.showAll
  $all.add_Click({ if ($script:showAll) { Send-Cmd 'showcurrent' } else { Send-Cmd 'showall' } })
  [void]$menu.Items.Add($all)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  if ($s.locked) { [void]$menu.Items.Add('Unlock').add_Click({ Send-Cmd 'unlock' }) }
  else { [void]$menu.Items.Add('Lock').add_Click({ Send-Cmd 'lock' }) }
  [void]$menu.Items.Add('Stop').add_Click({ Send-Cmd 'stop' })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add('Exit wts watch').add_Click({ Send-Cmd 'exit' })
}

$script:last = ''
$script:lastNotify = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.add_Tick({
  if (-not (Get-Process -Id $script:ParentPid -ErrorAction SilentlyContinue)) {
    Close-Widget
    [System.Windows.Forms.Application]::Exit()
    return
  }
  try { $raw = [System.IO.File]::ReadAllText($script:StateFile) } catch { return }
  if (-not $raw -or $raw -eq $script:last) { return }
  try { $s = $raw | ConvertFrom-Json } catch { return }
  $script:last = $raw
  Apply-State $s
  Build-Menu $s
  if ($s.notify -and $s.notify.id -ne $script:lastNotify) {
    $script:lastNotify = $s.notify.id
    Show-Notice $s.notify.title $s.notify.text
  }
})
`;

const TRAY_PS = String.raw`
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
$ni.ContextMenuStrip = $menu

function Apply-State($s) { $script:auto = [bool]$s.auto; $ni.Icon = $icons[$s.color]; $ni.Text = $s.tooltip }
function Show-Notice($title, $text) { $ni.ShowBalloonTip(4000, $title, $text, 'Info') }
function Close-Widget { $ni.Visible = $false }

$timer.Start()
[System.Windows.Forms.Application]::Run()
$ni.Dispose()
`;

const FLOAT_PS = String.raw`
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

// Always-on-top pill that never takes focus:  ( ● name │ ↻ │ Manual )
// Segments: 0 = name (menu), 1 = restart, 2 = Auto/Manual toggle. Drag anywhere to move.
public class WtsPill : Form {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    /** Call before creating the form: draw at physical pixels (crisp text on scaled screens). */
    public static float EnableDpi() {
        SetProcessDPIAware();
        using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) return g.DpiX / 96f;
    }

    public float K = 1f;
    public event EventHandler Clicked;
    public event EventHandler RestartClicked;
    public event EventHandler ModeClicked;
    public event EventHandler Moved;
    Color dot = Color.Gray;
    string text = "wts";
    bool auto;
    string tipMain = "", tipRestart = "", tipMode = "";
    Rectangle rMain, rRestart, rMode;
    int hover = -1;
    readonly ToolTip tip = new ToolTip();
    Font small, glyph;
    Point down;
    bool pressed, dragging;

    public WtsPill(float k) {
        K = k;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(36, 37, 41);
        ForeColor = Color.FromArgb(240, 240, 240);
        Font = new Font("Segoe UI", 10f, FontStyle.Regular);
        small = new Font("Segoe UI", 8.5f, FontStyle.Regular);
        glyph = new Font("Segoe UI Symbol", 11f, FontStyle.Regular);
        Opacity = 0.94;
        DoubleBuffered = true;
        Cursor = Cursors.Hand;
        Height = S(32);
        tip.ShowAlways = true;
        SetState(Color.Gray, "wts", false);
    }

    public int S(int px) { return (int)Math.Round(px * K); }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008; // NOACTIVATE | TOOLWINDOW | TOPMOST
            return cp;
        }
    }

    public void SetTips(string main, string restart, string mode) {
        tipMain = main; tipRestart = restart; tipMode = mode;
        UpdateTip();
    }

    public void SetState(Color c, string t, bool a) {
        dot = c; text = t; auto = a;
        int wMain = S(32) + TextRenderer.MeasureText(t, Font).Width + S(8);
        int wRestart = S(30);
        int wMode = TextRenderer.MeasureText("Manual", small).Width + S(18);
        rMain = new Rectangle(0, 0, wMain, Height);
        rRestart = new Rectangle(wMain, 0, wRestart, Height);
        rMode = new Rectangle(wMain + wRestart, 0, wMode, Height);
        int w = wMain + wRestart + wMode + S(4);
        Rectangle area = Screen.FromPoint(Location).WorkingArea;
        int right = Left + Width;
        Width = w;
        // Grow/shrink towards the left when docked on the right half of the screen.
        if (right > area.Left + area.Width / 2) Left = right - w;
        ClampToScreen();
        GraphicsPath p = new GraphicsPath();
        int r = Height;
        p.AddArc(0, 0, r, r, 90, 180);
        p.AddArc(Width - r, 0, r, r, 270, 180);
        p.CloseFigure();
        Region = new Region(p);
        Invalidate();
    }

    public void ClampToScreen() {
        Rectangle a = Screen.FromPoint(new Point(Left + Width / 2, Top + Height / 2)).WorkingArea;
        Left = Math.Max(a.Left, Math.Min(Left, a.Right - Width));
        Top = Math.Max(a.Top, Math.Min(Top, a.Bottom - Height));
    }

    int Seg(Point pt) {
        if (rRestart.Contains(pt)) return 1;
        if (pt.X >= rMode.Left) return 2;
        return 0;
    }

    void UpdateTip() {
        tip.SetToolTip(this, hover == 1 ? tipRestart : hover == 2 ? tipMode : tipMain);
    }

    protected override void OnPaint(PaintEventArgs e) {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        if (hover >= 0) {
            Rectangle h = hover == 0 ? rMain : hover == 1 ? rRestart : new Rectangle(rMode.Left, 0, Width - rMode.Left, Height);
            using (SolidBrush hb = new SolidBrush(Color.FromArgb(58, 60, 66))) g.FillRectangle(hb, h);
        }
        using (SolidBrush b = new SolidBrush(dot)) g.FillEllipse(b, S(12), (Height - S(12)) / 2, S(12), S(12));
        Size s = TextRenderer.MeasureText(text, Font);
        TextRenderer.DrawText(g, text, Font, new Point(S(32), (Height - s.Height) / 2), ForeColor);
        using (Pen sep = new Pen(Color.FromArgb(78, 80, 86), 1)) {
            g.DrawLine(sep, rRestart.Left, S(8), rRestart.Left, Height - S(8));
            g.DrawLine(sep, rMode.Left, S(8), rMode.Left, Height - S(8));
        }
        TextRenderer.DrawText(g, "↻", glyph, rRestart, ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        Color mc = auto ? Color.FromArgb(87, 199, 110) : Color.FromArgb(170, 174, 180);
        TextRenderer.DrawText(g, auto ? "Auto" : "Manual", small, rMode, mc, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }

    protected override void OnMouseDown(MouseEventArgs e) { down = e.Location; pressed = true; dragging = false; }

    protected override void OnMouseMove(MouseEventArgs e) {
        if (pressed) {
            if (!dragging && (Math.Abs(e.X - down.X) > S(3) || Math.Abs(e.Y - down.Y) > S(3))) dragging = true;
            if (dragging) Location = new Point(Left + e.X - down.X, Top + e.Y - down.Y);
            return;
        }
        int s = Seg(e.Location);
        if (s != hover) { hover = s; UpdateTip(); Invalidate(); }
    }

    protected override void OnMouseLeave(EventArgs e) { hover = -1; Invalidate(); }

    protected override void OnMouseUp(MouseEventArgs e) {
        pressed = false;
        if (dragging) { dragging = false; ClampToScreen(); if (Moved != null) Moved(this, EventArgs.Empty); return; }
        int s = e.Button == MouseButtons.Right ? 0 : Seg(e.Location);
        EventHandler h = s == 1 ? RestartClicked : s == 2 ? ModeClicked : Clicked;
        if (h != null) h(this, EventArgs.Empty);
    }
}
'@

$k = [WtsPill]::EnableDpi()
$form = New-Object WtsPill $k
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - $form.S(24)), ($area.Bottom - $form.Height - $form.S(56)))
try {
  $pos = [System.IO.File]::ReadAllText($PosFile) | ConvertFrom-Json
  $form.Location = New-Object System.Drawing.Point([int]$pos.x, [int]$pos.y)
} catch {}
$form.ClampToScreen()

$notice = New-Object System.Windows.Forms.ToolTip
$notice.ShowAlways = $true
$notice.IsBalloon = $true
$notice.ToolTipIcon = 'Info'

# The pill never takes focus, so Windows never tells the menu to close. Close it ourselves when
# the mouse is pressed outside the menu and the pill.
$menuWatch = New-Object System.Windows.Forms.Timer
$menuWatch.Interval = 50
$menuWatch.add_Tick({
  if (-not $menu.Visible) { $menuWatch.Stop(); return }
  if ([System.Windows.Forms.Control]::MouseButtons -ne [System.Windows.Forms.MouseButtons]::None) {
    $p = [System.Windows.Forms.Cursor]::Position
    if (-not $menu.Bounds.Contains($p) -and -not $form.Bounds.Contains($p)) { $menu.Close() }
  }
})

$form.add_Clicked({ $menu.Show($form, (New-Object System.Drawing.Point(0, 0)), 'AboveRight'); $menuWatch.Start() })
$form.add_RestartClicked({ Send-Cmd 'restart' })
$form.add_ModeClicked({ if ($script:auto) { Send-Cmd 'manual' } else { Send-Cmd 'auto' } })
$form.add_Moved({
  [System.IO.File]::WriteAllText($script:PosFile, (@{ x = $form.Left; y = $form.Top } | ConvertTo-Json -Compress))
})

function Apply-State($s) {
  $script:auto = [bool]$s.auto
  $form.SetState([System.Drawing.ColorTranslator]::FromHtml($colors[$s.color]), $s.label, $script:auto)
  $modeTip = if ($script:auto) { 'Auto: follows the worktree you select in Orca. Click to switch to Manual.' } else { 'Manual: switch from this menu, wts switch or an agent. Click to switch to Auto.' }
  $form.SetTips($s.tooltip, $s.restartTip, $modeTip)
}
function Show-Notice($title, $text) {
  $notice.ToolTipTitle = $title
  $notice.Show($text, $form, 0, -$form.S(70), 6000)
}
function Close-Widget { $form.Hide() }

$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;
