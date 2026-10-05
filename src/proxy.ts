// Proxy mode: listen on each service's fixed port and forward every TCP connection to that
// service in the selected worktree. TCP-level, so HTTP, WebSocket (Vite HMR, SignalR) and the
// Host header pass through unchanged. Switching closes open connections so the browser
// reconnects to the new worktree.
import net from "node:net";
import type { ServiceConfig } from "./config.js";
import { listWorktrees } from "./git.js";
import { discover, portOf, type Found } from "./discover.js";
import type { CtxWithConfig } from "./context.js";

const POLL_MS = 500;
const REDISCOVER_MS = 10_000;
const RETRY_BIND_MS = 5_000;

export interface ForwarderDeps {
  services: Record<string, ServiceConfig>;
  /** The selected worktree (re-read every poll), or null. */
  selected(): string | null;
  discover(): Promise<Found[]>;
  log(msg: string): void;
  hosts?: string[];
  retryBindMs?: number;
}

export class Forwarder {
  private readonly servers: net.Server[] = [];
  private readonly sockets = new Set<net.Socket>();
  private readonly timers: NodeJS.Timeout[] = [];
  private current: string | null = null;
  private found: Found[] = [];
  private pending: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: ForwarderDeps) {}

  async start(): Promise<void> {
    this.current = this.deps.selected();
    await this.refresh();
    await Promise.all(Object.entries(this.deps.services).map(([name, svc]) => this.bind(name, svc.port)));
    this.timers.push(setInterval(() => this.poll(), POLL_MS), setInterval(() => void this.refresh(), REDISCOVER_MS));
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.servers.forEach((s) => s.close());
    this.closeConnections();
  }

  /** Each service's port in `worktree` from the last discovery (null = not running there). */
  portsFor(worktree: string): Record<string, number | null> {
    const ports: Record<string, number | null> = {};
    for (const name of Object.keys(this.deps.services)) ports[name] = portOf(this.found, name, worktree);
    return ports;
  }

  /** Discover again now (e.g. right after a switch) and wait for it. */
  rediscover(): Promise<void> {
    return this.refresh();
  }

  /**
   * Take the fixed port on loopback, unless something already serves it. On Windows a bind to
   * 127.0.0.1 succeeds even while another program listens on [::] / 0.0.0.0 — and then silently
   * steals its traffic — so probe first and wait until the port is really free.
   */
  private async bind(name: string, port: number, warned = false): Promise<void> {
    if (this.stopped) return;
    if (await portAnswers(port)) {
      if (!warned) this.deps.log(`port ${port} (${name}) is in use by another program; waiting for it to be free`);
      setTimeout(() => void this.bind(name, port, true), this.deps.retryBindMs ?? RETRY_BIND_MS);
      return;
    }
    for (const host of this.deps.hosts ?? ["127.0.0.1", "::1"]) {
      const server = net.createServer((client) => void this.connect(name, client));
      server.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "EADDRNOTAVAIL" && e.code !== "EAFNOSUPPORT") this.deps.log(`proxy ${name} :${port} (${host}): ${e.message}`);
      });
      server.listen(port, host);
      this.servers.push(server);
    }
    if (warned) this.deps.log(`port ${port} (${name}) is free now; forwarding`);
  }

  private poll(): void {
    const sel = this.deps.selected();
    if (sel === this.current) return;
    this.current = sel;
    this.closeConnections();
    void this.refresh();
  }

  private refresh(): Promise<void> {
    if (!this.pending) {
      this.pending = this.deps
        .discover()
        .then((f) => void (this.found = f))
        .catch((e: Error) => this.deps.log(`discovery failed: ${e.message}`))
        .finally(() => (this.pending = null));
    }
    return this.pending;
  }

  private async connect(name: string, client: net.Socket): Promise<void> {
    this.track(client);
    client.pause();
    const worktree = this.current;
    let port = worktree ? portOf(this.found, name, worktree) : null;
    if (worktree && port === null) {
      await this.refresh(); // started after the last discovery?
      port = portOf(this.found, name, worktree);
    }
    if (port === null) return this.reject(name, worktree, client);

    const upstream = net.connect({ port, host: "localhost" });
    this.track(upstream);
    upstream.on("error", () => {
      client.destroy();
      void this.refresh(); // the server moved or stopped
    });
    client.on("error", () => upstream.destroy());
    client.pipe(upstream).pipe(client);
    client.resume();
  }

  /** No server to forward to: answer HTTP requests with a readable 502, close anything else. */
  private reject(name: string, worktree: string | null, client: net.Socket): void {
    const svc = this.deps.services[name];
    const range = svc.targets ? `${svc.targets.from}-${svc.targets.to}` : "";
    const msg = worktree
      ? `wts: ${worktree} has no '${name}' server running (expected a port in ${range}). Start it in that worktree.`
      : `wts: no worktree is selected for '${name}' (:${svc.port}). Run \`wts switch\` in the worktree you want to see.`;
    const timer = setTimeout(() => client.destroy(), 2000);
    client.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      if (/^[A-Z]+ \S+ HTTP\/1\.[01]\r\n/.test(chunk.toString("latin1", 0, 64))) {
        const body = `<!doctype html><title>wts: nothing to show</title><body style="font-family:system-ui;padding:2rem"><p>${escapeHtml(msg)}</p>`;
        client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      } else {
        client.destroy();
      }
    });
    client.resume();
  }

  private track(s: net.Socket): void {
    this.sockets.add(s);
    s.on("close", () => this.sockets.delete(s));
  }

  private closeConnections(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }
}

/** Does anything accept connections on this port (IPv4 or IPv6 loopback)? */
export function portAnswers(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(300, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then(([a, b]) => a || b);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A Forwarder for one repo: selection from the repo's state, worktrees re-listed on each discovery. */
export function repoForwarder(ctx: CtxWithConfig, log: (msg: string) => void): Forwarder {
  return new Forwarder({
    services: ctx.config.services,
    selected: () => {
      try {
        return ctx.store.readState()?.owner ?? null;
      } catch {
        return null;
      }
    },
    discover: () => discover(ctx.config.services, listWorktrees(ctx.current)),
    log,
  });
}
