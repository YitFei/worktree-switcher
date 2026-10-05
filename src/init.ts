// `wts init` / MCP `wts_init`: detect a repo's dev servers and propose a wts.json for the mode
// the user chose. Only git-tracked files are read, so untracked copies and node_modules are ignored.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, parseConfig, type Mode } from "./config.js";
import { WtsError } from "./errors.js";
import { commonDir, worktreeRoot } from "./git.js";
import { rememberRepo } from "./repos.js";

export interface Detected {
  name: string;
  framework: "vite" | "next" | "cra" | "node" | "dotnet";
  /** Folder relative to the worktree root ("." for the root). */
  dir: string;
  /** The app's usual port, null when it could not be found. */
  port: number | null;
  /** Start command for run mode. */
  runCmd: string;
  /** How to start it yourself in proxy mode. */
  proxyHint: string;
  /** File the port came from. */
  source: string;
}

export interface InitProposal {
  mode: Mode;
  root: string;
  file: string;
  exists: boolean;
  services: Detected[];
  config: Record<string, unknown> | null;
  json: string;
  notes: string[];
}

function trackedFiles(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  } catch {
    throw new WtsError(`not a git worktree: ${root}`);
  }
}

function readText(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8").replace(/^﻿/, "");
  } catch {
    return null;
  }
}

const dirOf = (rel: string) => path.posix.dirname(rel.replace(/\\/g, "/"));

export function detect(root: string, files = trackedFiles(root)): { services: Detected[]; notes: string[] } {
  const found: Omit<Detected, "name">[] = [];
  const notes: string[] = [];

  for (const rel of files.filter((f) => path.posix.basename(f) === "package.json" && !f.includes("node_modules/"))) {
    let scripts: Record<string, string>;
    try {
      scripts = (JSON.parse(readText(root, rel) ?? "") as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      continue;
    }
    const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
    if (!script) continue;
    const dir = dirOf(rel);
    const body = scripts[script];
    const flagPort = /(?:--port|-p)[\s=]+(\d+)/.exec(body)?.[1];
    if (/\bvite\b/.test(body)) {
      const cfg = files.find((f) => dirOf(f) === dir && /^vite\.config\.(ts|js|mjs|mts|cjs)$/.test(path.posix.basename(f)));
      const text = cfg ? readText(root, cfg) ?? "" : "";
      const cfgPort = /server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d+)/.exec(text)?.[1];
      const apiPort = /target\s*:\s*['"`]https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(text)?.[1];
      if (apiPort) notes.push(`${cfg} proxies the API to localhost:${apiPort}; keep that the API's fixed port.`);
      found.push({
        framework: "vite",
        dir,
        port: Number(flagPort ?? cfgPort ?? 5173),
        runCmd: `npm run ${script} -- --strictPort`,
        proxyHint: `npm run ${script} (no --strictPort: Vite moves to the next free port, inside the range)`,
        source: flagPort ? rel : cfgPort ? cfg! : `${rel} (Vite default)`,
      });
    } else if (/\bnext\s+dev\b/.test(body) || /react-scripts\s+start/.test(body)) {
      const next = /\bnext\s+dev\b/.test(body);
      found.push({
        framework: next ? "next" : "cra",
        dir,
        port: Number(flagPort ?? 3000),
        runCmd: `npm run ${script}`,
        proxyHint: next ? `npm run ${script} -- -p <a port in the range>` : `set PORT=<a port in the range>&& npm run ${script}`,
        source: flagPort ? rel : `${rel} (${next ? "Next.js" : "Create React App"} default)`,
      });
    } else {
      found.push({
        framework: "node",
        dir,
        port: flagPort ? Number(flagPort) : null,
        runCmd: `npm run ${script}`,
        proxyHint: `npm run ${script} on a port in the range`,
        source: rel,
      });
    }
  }

  for (const rel of files.filter((f) => /(^|\/)Properties\/launchSettings\.json$/.test(f))) {
    let profiles: Record<string, { commandName?: string; applicationUrl?: string }>;
    try {
      profiles = (JSON.parse(readText(root, rel) ?? "") as { profiles?: typeof profiles }).profiles ?? {};
    } catch {
      notes.push(`could not parse ${rel}`);
      continue;
    }
    const hit = Object.entries(profiles).find(([, p]) => p.commandName === "Project" && /http:\/\/(localhost|127\.0\.0\.1):\d+/.test(p.applicationUrl ?? ""));
    if (!hit) continue;
    const [profile, p] = hit;
    found.push({
      framework: "dotnet",
      dir: dirOf(dirOf(rel)),
      port: Number(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(p.applicationUrl!)![1]),
      runCmd: `dotnet run --launch-profile ${profile}`,
      proxyHint: `dotnet run --urls http://localhost:<a port in the range>`,
      source: `${rel} (profile "${profile}")`,
    });
  }

  // Names: the top folder (frontend, backend, …), else web / api; made unique with the project folder.
  const services: Detected[] = [];
  for (const f of found) {
    const top = f.dir === "." ? (f.framework === "dotnet" ? "api" : "web") : f.dir.split("/")[0].toLowerCase();
    let name = top;
    if (services.some((s) => s.name === name)) name = `${top}-${path.posix.basename(f.dir).toLowerCase()}`;
    services.push({ name, ...f });
  }
  for (const s of services.filter((x) => x.port === null)) notes.push(`no port found for ${s.name} (${s.dir}); add it by hand.`);
  return { services, notes };
}

/** The framework of the service that lives in `dir` (for start hints), if it can be detected. */
export function frameworkFor(root: string, dir: string): Detected["framework"] | undefined {
  try {
    const norm = dir.split(path.sep).join("/").replace(/\/$/, "") || ".";
    return detect(root).services.find((s) => s.dir === norm)?.framework;
  } catch {
    return undefined;
  }
}

export function buildConfig(mode: Mode, services: Detected[]): Record<string, unknown> | null {
  const usable = services.filter((s) => s.port !== null);
  if (usable.length === 0) return null;
  const out: Record<string, Record<string, unknown>> = {};
  const ranges: [number, number][] = [];
  const fixed = usable.map((s) => s.port!);
  for (const s of usable) {
    if (mode === "run") {
      out[s.name] = { dir: s.dir, port: s.port, cmd: s.runCmd };
      continue;
    }
    let from = s.port! + 1;
    const clash = (a: number) => ranges.some(([f, t]) => a <= t && f <= a + 25) || fixed.some((p) => p >= a && p <= a + 25);
    while (clash(from)) from += 100;
    ranges.push([from, from + 25]);
    out[s.name] = { dir: s.dir, port: s.port, targets: `${from}-${from + 25}` };
  }
  const config: Record<string, unknown> = mode === "proxy" ? { mode: "proxy", services: out } : { readyTimeoutSec: usable.some((s) => s.framework === "dotnet") ? 180 : 60, services: out };
  parseConfig(JSON.stringify(config), CONFIG_FILE); // throws if we built something invalid
  return config;
}

/** JSON with one line per service, like the hand-written examples. */
export function formatConfig(config: Record<string, unknown>): string {
  const { services, ...top } = config as { services: Record<string, unknown> } & Record<string, unknown>;
  const lines = Object.entries(top).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const inline = (o: Record<string, unknown>) => `{ ${Object.entries(o).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(", ")} }`;
  const svc = Object.entries(services).map(([k, v], i, all) => `    ${JSON.stringify(k)}: ${inline(v as Record<string, unknown>)}${i < all.length - 1 ? "," : ""}`);
  return ["{", ...lines, '  "services": {', ...svc, "  }", "}", ""].join("\n");
}

export function proposeInit(cwd: string, mode: Mode): InitProposal {
  const root = worktreeRoot(cwd);
  const file = path.join(root, CONFIG_FILE);
  const { services, notes } = detect(root);
  const config = buildConfig(mode, services);
  if (!config) notes.push("no dev servers detected (looked for package.json dev/start scripts and .NET launchSettings.json); write wts.json by hand.");
  if (mode === "proxy") {
    for (const s of services.filter((x) => x.port !== null)) notes.push(`proxy mode, ${s.name}: start it yourself in ${s.dir} with: ${s.proxyHint}`);
    notes.push("then run `wts watch` (or `wts proxy`) once; it holds the fixed ports and forwards them to the selected worktree.");
  }
  return { mode, root, file, exists: fs.existsSync(file), services, config, json: config ? formatConfig(config) : "", notes };
}

export function writeInit(p: InitProposal, overwrite: boolean): void {
  if (!p.config) throw new WtsError("nothing to write: no dev servers detected", 2);
  if (p.exists && !overwrite) throw new WtsError(`${p.file} already exists; pass overwrite to replace it`, 2);
  fs.writeFileSync(p.file, p.json);
  rememberRepo(commonDir(p.root), p.root);
}
