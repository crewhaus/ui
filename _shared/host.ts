#!/usr/bin/env bun
/**
 * CrewHaus Shape UI — universal host.
 *
 * One config-driven Bun server that powers every shape UI under `ui/`.
 * A shape directory ships an `index.html`, an `app.js`, and a `config.json`;
 * its `serve.ts` is a one-liner that calls `serve(import.meta.dir)`.
 *
 * The user drops the files emitted by `crewhaus compile -o <dir>` into the
 * shape's `harness/` folder. The host then:
 *   - detects the entry file (daemon.ts > agent.ts > worker.js, per config),
 *   - installs the bundle's dependencies on first run (scans imports),
 *   - runs the harness in the way its shape demands:
 *       stdio  -> spawn `bun <entry>`, bridge stdin/stdout to the browser,
 *       daemon -> spawn `bun daemon.ts` on an internal PORT, reverse-proxy it,
 *       worker -> import the Cloudflare `worker.js` and call its `fetch`,
 *       plugin -> parse the bundle manifest (nothing to run),
 *   - extracts CrewHaus `TraceEvent` JSON from stdout and streams it, plus
 *     raw assistant text and logs, to the browser over a WebSocket.
 *
 * Requires Bun (already a CrewHaus dependency). No build step.
 */

import { spawn } from "bun";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// -- Types --------------------------------------------------------------------

type RunClass = "stdio-interactive" | "stdio-oneshot" | "daemon-http" | "cf-worker" | "plugin";

type ShapeConfig = {
  shape: string;
  title: string;
  tagline: string;
  runClass: RunClass;
  /** Candidate entry files in preference order; first existing one wins. */
  entry: string[];
  /** Internal port for daemon-http shapes (assigned to the child via PORT). */
  port?: number;
  /** How the harness receives a user turn. */
  input: "interactive" | "oneshot" | "none";
  /** Extra env passed to the child process. */
  env?: Record<string, string>;
  /** Feature flags that drive which panels the frontend shows. */
  features?: string[];
  accent?: string;
  [k: string]: unknown;
};

// -- Paths --------------------------------------------------------------------

const SHARED_DIR = import.meta.dir;

function readConfig(dir: string): ShapeConfig {
  const p = join(dir, "config.json");
  if (!existsSync(p)) throw new Error(`config.json not found in ${dir}`);
  return JSON.parse(readFileSync(p, "utf8")) as ShapeConfig;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

// -- Env files ----------------------------------------------------------------
//
// Secrets (provider keys, channel tokens, RPC URLs, …) are supplied via `.env`
// files that are NEVER committed. They are loaded, in increasing precedence,
// from the repo root, the shape dir, then the shape's `harness/`, and merged
// UNDER the real process env (an exported var always wins). cf-worker shapes
// additionally read `harness/.dev.vars` (Cloudflare's native format).

/** Parse a dotenv-style KEY=VALUE file. Blank lines and `#` comments ignored. */
function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

/** Merge .env files for a shape: repo-root < shape < harness (later wins). */
function loadEnvChain(shapeDir: string): Record<string, string> {
  return {
    ...parseEnvFile(join(shapeDir, "..", ".env")),
    ...parseEnvFile(join(shapeDir, ".env")),
    ...parseEnvFile(join(shapeDir, "harness", ".env")),
  };
}

// -- Harness detection --------------------------------------------------------

type HarnessState = {
  present: boolean;
  files: string[];
  entry: string | null;
  depsInstalled: boolean;
  manifest?: unknown; // for plugin shapes
};

function listHarnessFiles(harnessDir: string): string[] {
  if (!existsSync(harnessDir)) return [];
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d)) {
      const keepDotted = name === ".claude-plugin" || name === ".mcp.json" || name === ".dev.vars";
      if (name === "node_modules") continue;
      if (name.startsWith(".") && !keepDotted) continue;
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(harnessDir, "");
  return out.sort();
}

function detectHarness(dir: string, config: ShapeConfig): HarnessState {
  const harnessDir = join(dir, "harness");
  const files = listHarnessFiles(harnessDir);
  const present = files.filter((f) => !/README|DROP_/i.test(f)).length > 0;
  let entry: string | null = null;
  for (const cand of config.entry) {
    if (files.includes(cand)) {
      entry = cand;
      break;
    }
  }
  const depsInstalled = existsSync(join(harnessDir, "node_modules"));
  const state: HarnessState = { present, files, entry, depsInstalled };
  if (config.runClass === "plugin") {
    state.manifest = readPluginManifest(harnessDir, files);
  }
  return state;
}

function readPluginManifest(harnessDir: string, files: string[]): unknown {
  const read = (rel: string) => {
    const p = join(harnessDir, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const safeJson = (s: string | null) => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  return {
    plugin: safeJson(read(".claude-plugin/plugin.json")),
    mcp: safeJson(read(".mcp.json")),
    readme: read("README.md"),
    notes: read("CLAUDE_PLUGIN_NOTES.md"),
    files,
  };
}

// -- Dependency install -------------------------------------------------------

const BARE_IMPORT_RE = /(?:from|import|require)\s*\(?\s*["']([^."'][^"']*)["']/g;

/** Top-level package name from a specifier (handles @scope/name/sub). */
function packageOf(spec: string): string | null {
  if (spec.startsWith("node:") || spec.startsWith("bun:")) return null;
  const parts = spec.split("/");
  if (spec.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

function scanDeps(harnessDir: string, files: string[]): Set<string> {
  const deps = new Set<string>();
  for (const rel of files) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(rel)) continue;
    const src = readFileSync(join(harnessDir, rel), "utf8");
    let m: RegExpExecArray | null;
    BARE_IMPORT_RE.lastIndex = 0;
    while ((m = BARE_IMPORT_RE.exec(src))) {
      const pkg = packageOf(m[1]);
      if (pkg) deps.add(pkg);
    }
  }
  return deps;
}

async function ensureDeps(
  harnessDir: string,
  files: string[],
  log: (line: string) => void,
): Promise<boolean> {
  const hasPkg = existsSync(join(harnessDir, "package.json"));
  if (!hasPkg) {
    // Generate a package.json from the bundle's imports so `bun install`
    // can pull in @crewhaus/* (all public on npm) plus any other deps.
    const deps = scanDeps(harnessDir, files);
    const dependencies: Record<string, string> = {};
    for (const d of deps) dependencies[d] = "latest";
    writeFileSync(
      join(harnessDir, "package.json"),
      `${JSON.stringify(
        { name: "crewhaus-harness", private: true, type: "module", dependencies },
        null,
        2,
      )}\n`,
    );
    log(`[deps] generated package.json with ${deps.size} dependency(ies)`);
  }
  log("[deps] running bun install ...");
  const proc = spawn(["bun", "install"], {
    cwd: harnessDir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  void streamLines(proc.stdout, (l) => log(`[deps] ${l}`));
  void streamLines(proc.stderr, (l) => log(`[deps] ${l}`));
  const code = await proc.exited;
  if (code === 0) log("[deps] install complete");
  else log(`[deps] bun install exited with code ${code}`);
  return code === 0;
}

async function streamLines(
  stream: ReadableStream<Uint8Array> | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) onLine(buf);
}

// -- TraceEvent extraction ----------------------------------------------------
//
// A CrewHaus bundle run with CREWHAUS_TRACE=json writes structured TraceEvent
// JSON Lines to stdout, but the assistant's answer text (and banners/logs) is
// also written to stdout with no guaranteed framing. model_stream_token events
// carry no text, so we keep BOTH: JSON objects -> structured events, the bytes
// in between -> assistant text / logs. This splitter pulls embedded JSON events
// out of the raw stream without ever stalling on prose that contains braces.

function looksLikeEvent(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.kind === "string" && (typeof r.runId === "string" || typeof r.timestamp === "string")
  );
}

/** Find the index of the matching `}` for the `{` at `start`, respecting
 *  strings/escapes. Returns -1 if the object is not yet complete. */
function scanBalanced(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type Drained = { text: string; events: Record<string, unknown>[]; rest: string };

/** Pull complete events + flushed text out of an accumulated buffer. */
function drain(buf: string): Drained {
  let text = "";
  const events: Record<string, unknown>[] = [];
  let i = 0;
  let textStart = 0;
  while (i < buf.length) {
    if (buf[i] === "{") {
      const end = scanBalanced(buf, i);
      if (end === -1) {
        // Possibly an in-flight event OR prose with an unbalanced brace.
        const peek = buf.slice(i, i + 12);
        if (/^\{\s*"(runId|kind|sessionId|timestamp)"/.test(peek)) {
          text += buf.slice(textStart, i);
          return { text, events, rest: buf.slice(i) };
        }
        i++;
        continue;
      }
      const candidate = buf.slice(i, end + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        parsed = undefined;
      }
      if (looksLikeEvent(parsed)) {
        text += buf.slice(textStart, i);
        events.push(parsed);
        i = end + 1;
        textStart = i;
        continue;
      }
      i++;
    } else {
      i++;
    }
  }
  text += buf.slice(textStart);
  return { text, events, rest: "" };
}

// -- Process supervisor -------------------------------------------------------

type ClientMsg =
  | { type: "submit"; text: string }
  | { type: "input"; text: string }
  | { type: "start"; text?: string }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "install" };

type Broadcast = (msg: unknown) => void;

class Supervisor {
  private proc: ReturnType<typeof spawn> | null = null;
  private buf = "";
  private state: "idle" | "installing" | "starting" | "running" | "exited" | "error" = "idle";
  daemonPort: number | null = null;

  constructor(
    private dir: string,
    private config: ShapeConfig,
    private broadcast: Broadcast,
  ) {}

  get harnessDir(): string {
    return join(this.dir, "harness");
  }

  snapshot() {
    return {
      state: this.state,
      running: this.proc !== null,
      daemonPort: this.daemonPort,
      harness: detectHarness(this.dir, this.config),
    };
  }

  private setState(s: Supervisor["state"], detail?: string) {
    this.state = s;
    this.broadcast({ type: "status", state: s, detail: detail ?? null });
  }

  private log(line: string, stream: "stdout" | "stderr" | "system" = "system") {
    this.broadcast({ type: stream === "system" ? "log" : stream, line });
  }

  async handle(msg: ClientMsg) {
    switch (msg.type) {
      case "install":
        await this.install();
        break;
      case "start":
        await this.start(msg.text);
        break;
      case "submit":
        await this.start(msg.text);
        break;
      case "input":
        this.writeStdin(msg.text);
        break;
      case "stop":
        this.stop();
        break;
      case "restart":
        this.stop();
        await this.start();
        break;
    }
  }

  private async install(): Promise<boolean> {
    const h = detectHarness(this.dir, this.config);
    if (!h.present) {
      this.log("No compiled harness found in harness/. Drop your files there first.");
      return false;
    }
    this.setState("installing");
    const ok = await ensureDeps(this.harnessDir, h.files, (l) => this.log(l));
    this.setState(ok ? "idle" : "error", ok ? undefined : "dependency install failed");
    this.broadcast({ type: "state", ...this.snapshot() });
    return ok;
  }

  /** Ensure deps then spawn the child appropriate to the run class. */
  async start(initialInput?: string) {
    if (this.config.runClass === "plugin") {
      this.log("Plugin shapes are inspected, not run.");
      return;
    }
    const h = detectHarness(this.dir, this.config);
    if (!h.entry) {
      this.setState("error", "no entry file in harness/");
      this.log(`No entry file (${this.config.entry.join(" / ")}) found in harness/.`);
      return;
    }
    if (!h.depsInstalled) {
      const ok = await this.install();
      if (!ok) return;
    }
    this.stop();
    this.setState("starting");

    const env: Record<string, string> = {
      ...loadEnvChain(this.dir),
      ...process.env,
      CREWHAUS_TRACE: "json",
      CREWHAUS_COST_TRACKING: "1",
      ...(this.config.env ?? {}),
    };

    if (this.config.runClass === "daemon-http") {
      this.daemonPort = await freePort(this.config.port ?? 3000);
      env.PORT = String(this.daemonPort);
    }

    const entryPath = join(this.harnessDir, h.entry);
    const proc = spawn(["bun", entryPath], {
      cwd: this.harnessDir,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.buf = "";
    this.setState("running");
    this.broadcast({ type: "state", ...this.snapshot() });

    void this.pumpStdout(proc.stdout);
    void streamLines(proc.stderr, (l) => this.log(l, "stderr"));

    // Single-shot: feed the prompt then close stdin so the bundle runs to EOF.
    if (this.config.input === "oneshot") {
      if (initialInput !== undefined) proc.stdin?.write(`${initialInput}\n`);
      proc.stdin?.end();
    } else if (this.config.input === "interactive" && initialInput) {
      this.writeStdin(initialInput);
    }

    void proc.exited.then((code) => {
      if (this.proc === proc) {
        this.flushText();
        this.setState("exited", `exit code ${code}`);
        this.proc = null;
        this.daemonPort = null;
        this.broadcast({ type: "state", ...this.snapshot() });
      }
    });
  }

  writeStdin(text: string) {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
    this.proc.stdin.flush?.();
    this.broadcast({ type: "user", text });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already gone */
      }
      this.proc = null;
      this.daemonPort = null;
    }
  }

  private async pumpStdout(stream: ReadableStream<Uint8Array> | undefined) {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buf += dec.decode(value, { stream: true });
      const { text, events, rest } = drain(this.buf);
      this.buf = rest;
      if (text) this.broadcast({ type: "stdout", text });
      for (const ev of events) this.broadcast({ type: "event", event: ev });
    }
  }

  private flushText() {
    if (this.buf) {
      const { text, events } = drain(`${this.buf}\n`);
      if (text) this.broadcast({ type: "stdout", text });
      for (const ev of events) this.broadcast({ type: "event", event: ev });
      this.buf = "";
    }
  }
}

async function freePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) {
    try {
      const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
      s.stop();
      return p;
    } catch {
      /* taken */
    }
  }
  return preferred;
}

// -- Cloudflare worker runner (cf-worker shapes) ------------------------------

async function runWorker(
  harnessDir: string,
  req: Request,
  pathAfter: string,
): Promise<Response> {
  const workerPath = join(harnessDir, "worker.js");
  if (!existsSync(workerPath)) return new Response("worker.js not found", { status: 404 });
  const mod = await import(`${workerPath}?t=${Date.now()}`);
  const handler = mod.default;
  if (!handler?.fetch) return new Response("worker has no default fetch export", { status: 500 });
  // Worker env: .env chain (root/shape/harness) < process.env < .dev.vars
  // (.dev.vars is Cloudflare's native local-secrets file and wins).
  const env: Record<string, string> = {
    ...loadEnvChain(dirname(harnessDir)),
    ...(process.env as Record<string, string>),
    ...parseEnvFile(join(harnessDir, ".dev.vars")),
  };
  const url = new URL(req.url);
  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const forwarded = new Request(`http://worker.local/${pathAfter}${url.search}`, {
    method: req.method,
    headers: req.headers,
    body,
  });
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return handler.fetch(forwarded, env, ctx);
}

// -- Server -------------------------------------------------------------------

const WS_CLIENTS = new Set<{ send: (s: string) => void }>();

export function serve(dir: string): void {
  const config = readConfig(dir);
  const uiPort = Number(process.env.CREWHAUS_UI_PORT ?? 0) || 4100;

  const broadcast: Broadcast = (msg) => {
    const s = JSON.stringify(msg);
    for (const c of WS_CLIENTS) {
      try {
        c.send(s);
      } catch {
        /* dropped */
      }
    }
  };

  const sup = new Supervisor(dir, config, broadcast);

  const staticFile = (path: string): Response | null => {
    if (!existsSync(path) || statSync(path).isDirectory()) return null;
    return new Response(Bun.file(path), { headers: { "content-type": mimeFor(path) } });
  };

  const server = Bun.serve({
    port: uiPort,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);

      if (path === "/ws") {
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response("websocket upgrade failed", { status: 400 });
      }

      if (path === "/api/state") return Response.json({ config, ...sup.snapshot() });
      if (path === "/api/config") return Response.json(config);
      if (path === "/api/harness") return Response.json(detectHarness(dir, config));

      // Reverse-proxy to the daemon (daemon-http shapes).
      if (path.startsWith("/proxy/")) {
        if (!sup.daemonPort) return new Response("daemon not running", { status: 503 });
        const target = `http://localhost:${sup.daemonPort}/${path.slice("/proxy/".length)}${url.search}`;
        try {
          const resp = await fetch(target, {
            method: req.method,
            headers: req.headers,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
            // @ts-expect-error Bun streaming bodies need duplex
            duplex: "half",
          });
          return new Response(resp.body, { status: resp.status, headers: resp.headers });
        } catch (e) {
          return new Response(`proxy error: ${(e as Error).message}`, { status: 502 });
        }
      }

      // Invoke the Cloudflare worker directly (cf-worker shapes).
      if (path.startsWith("/worker/")) {
        return runWorker(join(dir, "harness"), req, path.slice("/worker/".length));
      }

      // Static: shape files, then shared files.
      if (path === "/" || path === "/index.html") {
        const r = staticFile(join(dir, "index.html"));
        if (r) return r;
      }
      if (path.startsWith("/_shared/")) {
        const r = staticFile(join(SHARED_DIR, path.slice("/_shared/".length)));
        if (r) return r;
      }
      {
        const r = staticFile(join(dir, path.replace(/^\//, "")));
        if (r) return r;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        WS_CLIENTS.add(ws);
        ws.send(JSON.stringify({ type: "state", config, ...sup.snapshot() }));
      },
      close(ws) {
        WS_CLIENTS.delete(ws);
      },
      async message(_ws, raw) {
        try {
          await sup.handle(JSON.parse(String(raw)) as ClientMsg);
        } catch (e) {
          broadcast({ type: "log", line: `[host] ${(e as Error).message}` });
        }
      },
    },
  });

  const ready =
    `\n  CrewHaus | ${config.title} UI\n` +
    `  > http://localhost:${server.port}\n` +
    `  > drop a compiled ${config.shape} bundle into ${join(dir, "harness")}\n`;
  process.stdout.write(ready);
}

// Allow `bun host.ts <shapeDir>` for ad-hoc use.
if (import.meta.main) {
  const target = process.argv[2] ? resolve(process.argv[2]) : dirname(SHARED_DIR);
  serve(target);
}
