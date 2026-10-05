import fs from "node:fs";
import path from "node:path";
import { WtsError } from "./errors.js";

export const CONFIG_FILE = "wts.json";

/**
 * run: wts starts and stops each worktree's servers on the fixed ports (`cmd` required).
 * proxy: you start each worktree's servers yourself on a port in `targets`; wts forwards the
 * fixed `port` to the selected worktree.
 */
export type Mode = "run" | "proxy";

export interface PortRange {
  from: number;
  to: number;
}

export interface ServiceConfig {
  /** Working directory, relative to the worktree root. */
  dir: string;
  /** The fixed port: the server's port in run mode, the proxy's port in proxy mode. */
  port: number;
  /** Start command (run mode). Empty in proxy mode. */
  cmd: string;
  /** Proxy mode: where each worktree runs this service. */
  targets?: PortRange;
}

export interface Config {
  mode: Mode;
  readyTimeoutSec: number;
  services: Record<string, ServiceConfig>;
}

export function loadConfig(worktree: string): Config {
  const file = path.join(worktree, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    throw new WtsError(`no ${CONFIG_FILE} in ${worktree}`);
  }
  return parseConfig(fs.readFileSync(file, "utf8"), file);
}

export function inRange(port: number, r: PortRange): boolean {
  return port >= r.from && port <= r.to;
}

export function parseConfig(text: string, source: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new WtsError(`${source}: invalid JSON (${(e as Error).message})`);
  }
  const fail = (msg: string): never => {
    throw new WtsError(`${source}: ${msg}`);
  };
  if (!isObject(raw)) fail("must be a JSON object");
  const obj = raw as Record<string, unknown>;

  const mode = obj.mode ?? "run";
  if (mode !== "run" && mode !== "proxy") fail(`mode must be "run" or "proxy"`);

  const readyTimeoutSec = obj.readyTimeoutSec ?? 120;
  if (typeof readyTimeoutSec !== "number" || readyTimeoutSec <= 0) fail("readyTimeoutSec must be a positive number");

  if (!isObject(obj.services) || Object.keys(obj.services).length === 0) fail("services must be a non-empty object");
  const services: Record<string, ServiceConfig> = {};
  const ports = new Set<number>();
  const ranges: [string, PortRange][] = [];
  for (const [name, svc] of Object.entries(obj.services as Record<string, unknown>)) {
    if (!isObject(svc)) fail(`services.${name} must be an object`);
    const { dir = ".", port, cmd = "", targets } = svc as Record<string, unknown>;
    if (typeof dir !== "string") fail(`services.${name}.dir must be a string`);
    if (!isPort(port)) fail(`services.${name}.port must be an integer 1-65535`);
    if (ports.has(port as number)) fail(`port ${port} is used by more than one service`);
    ports.add(port as number);
    if (typeof cmd !== "string") fail(`services.${name}.cmd must be a string`);

    let range: PortRange | undefined;
    if (mode === "run") {
      if ((cmd as string).trim() === "") fail(`services.${name}.cmd must be a non-empty string`);
    } else {
      range = parseRange(targets) ?? fail(`services.${name}.targets must be a port range like "5174-5199"`);
      if (inRange(port as number, range)) fail(`services.${name}.targets must not contain its port ${port}`);
      for (const [other, r] of ranges) {
        if (range.from <= r.to && r.from <= range.to) fail(`services.${name}.targets overlaps services.${other}.targets`);
      }
      ranges.push([name, range]);
    }
    services[name] = { dir: dir as string, port: port as number, cmd: cmd as string, ...(range ? { targets: range } : {}) };
  }
  for (const [name, r] of ranges) {
    for (const p of ports) if (inRange(p, r)) fail(`services.${name}.targets contains the fixed port ${p} of another service`);
  }
  return { mode: mode as Mode, readyTimeoutSec: readyTimeoutSec as number, services };
}

function parseRange(v: unknown): PortRange | null {
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(v);
  if (!m) return null;
  const from = Number(m[1]), to = Number(m[2]);
  return isPort(from) && isPort(to) && from <= to ? { from, to } : null;
}

function isPort(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
