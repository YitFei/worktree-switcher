import fs from "node:fs";
import path from "node:path";
import { WtsError } from "./errors.js";

export const CONFIG_FILE = "wts.json";

export interface ServiceConfig {
  /** Working directory, relative to the worktree root. */
  dir: string;
  port: number;
  cmd: string;
}

export interface Config {
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

  const readyTimeoutSec = obj.readyTimeoutSec ?? 120;
  if (typeof readyTimeoutSec !== "number" || readyTimeoutSec <= 0) fail("readyTimeoutSec must be a positive number");

  if (!isObject(obj.services) || Object.keys(obj.services).length === 0) fail("services must be a non-empty object");
  const services: Record<string, ServiceConfig> = {};
  const ports = new Set<number>();
  for (const [name, svc] of Object.entries(obj.services as Record<string, unknown>)) {
    if (!isObject(svc)) fail(`services.${name} must be an object`);
    const { dir = ".", port, cmd } = svc as Record<string, unknown>;
    if (typeof dir !== "string") fail(`services.${name}.dir must be a string`);
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      fail(`services.${name}.port must be an integer 1-65535`);
    }
    if (typeof cmd !== "string" || cmd.trim() === "") fail(`services.${name}.cmd must be a non-empty string`);
    if (ports.has(port as number)) fail(`port ${port} is used by more than one service`);
    ports.add(port as number);
    services[name] = { dir: dir as string, port: port as number, cmd: cmd as string };
  }
  return { readyTimeoutSec: readyTimeoutSec as number, services };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
