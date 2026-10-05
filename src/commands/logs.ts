import fs from "node:fs";
import { WtsError } from "../errors.js";
import { sleep, type CtxWithConfig } from "../context.js";

const TAIL_BYTES = 256 * 1024;

/** Last `n` lines of a file (reads at most the final 256 KB). */
export function tail(file: string, n: number): string[] {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

/**
 * The `cmd /s /c` command line that opens a new console window following every service log:
 * `start "<title>" "<node>" "<cli.js>" logs -f`. Quotes and cmd metacharacters in the title are
 * dropped (it is display text only).
 */
export function logWindowCommand(title: string, node: string, cli: string): string {
  const safe = title.replace(/["^&|<>%]/g, "");
  return `start "${safe}" "${node}" "${cli}" logs -f`;
}

export async function logs(ctx: CtxWithConfig, service: string | undefined, n: number, follow: boolean): Promise<void> {
  const names = service ? [service] : Object.keys(ctx.config.services);
  for (const name of names) {
    if (!ctx.config.services[name]) throw new WtsError(`unknown service "${name}"`, 2);
  }
  const prefix = (name: string) => (names.length > 1 ? `[${name}] ` : "");

  const offsets = new Map<string, number>();
  for (const name of names) {
    const file = ctx.store.logPath(name);
    if (names.length > 1) console.log(`==> ${name} (${file}) <==`);
    for (const line of tail(file, n)) console.log(prefix(name) + line);
    offsets.set(name, fs.existsSync(file) ? fs.statSync(file).size : 0);
  }
  if (!follow) return;

  const partial = new Map<string, string>();
  for (;;) {
    await sleep(500);
    for (const name of names) {
      const file = ctx.store.logPath(name);
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      let offset = offsets.get(name)!;
      if (size < offset) offset = 0; // truncated by a new start
      if (size === offset) continue;
      const buf = Buffer.alloc(size - offset);
      const fd = fs.openSync(file, "r");
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offsets.set(name, size);
      const lines = ((partial.get(name) ?? "") + buf.toString("utf8")).split(/\r?\n/);
      partial.set(name, lines.pop()!);
      for (const line of lines) console.log(prefix(name) + line);
    }
  }
}
