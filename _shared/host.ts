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
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
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
  // `.crewhaus/` memory surfaces are broadcast as raw text for the browser to
  // parse against the known continuity/wiki/dream grammars (Phase 3).
  ".md": "text/markdown; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
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

/** Merge .env files: cwd < harness-parent < harness (later wins). Covers both
 *  the in-repo layout (harness lives under the shape dir) and the npm-package
 *  layout (harness is the user's project dir). */
function loadEnvChain(harnessDir: string): Record<string, string> {
  return {
    ...parseEnvFile(join(process.cwd(), ".env")),
    ...parseEnvFile(join(harnessDir, "..", ".env")),
    ...parseEnvFile(join(harnessDir, ".env")),
  };
}

/**
 * The harness ROOT is the directory whose spec the compiled bundle's relative
 * paths resolve against — MCP server commands (`bun thredz-mcp/server.ts`),
 * `retrieve` data roots, the `.crewhaus/` session store, `.env`, etc. That is
 * the directory holding `crewhaus.yaml`, which is what a standalone harness is
 * always meant to run FROM.
 *
 * The compiled bundle often lives in a `dist/`/`build/` SUBDIR of that root
 * (e.g. `crewhaus compile crewhaus.yaml -o dist`), and the scaffolded runner
 * points `harnessDir` at that subdir. Running the agent with cwd = the bundle
 * dir then breaks every spec-relative path (the MCP servers fail to spawn and
 * the agent exits). So the runtime cwd must be this root, NOT the bundle dir.
 * Walk up from the given dir to find it; fall back to the dir itself.
 */
function findHarnessRoot(harnessDir: string): string {
  let d = resolve(harnessDir);
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(d, "crewhaus.yaml")) || existsSync(join(d, "daemon.yaml"))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return resolve(harnessDir);
}

/**
 * The spec NAME that keys the harness's `.crewhaus/state/<spec>/`,
 * `.crewhaus/wiki/<spec>/`, and `.crewhaus/dream/<spec>/` subtrees. The trace
 * envelope carries the live `sessionId` but not the spec name, so we derive it
 * — no `@crewhaus/*` import, staying zero-dependency:
 *   1. the top-level `name:` of the spec yaml at the harness root, else
 *   2. the sole directory under `.crewhaus/state/` (authoritative for whatever
 *      the running bundle actually wrote), else null.
 */
export function deriveSpecName(harnessRoot: string): string | null {
  for (const f of ["crewhaus.yaml", "crewhaus.yml"]) {
    const p = join(harnessRoot, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(
      /^\s*name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*(?:#.*)?$/m,
    );
    if (m) return m[1];
  }
  const stateDir = join(harnessRoot, ".crewhaus", "state");
  if (existsSync(stateDir)) {
    try {
      const dirs = readdirSync(stateDir).filter(
        (n) => !n.startsWith(".") && statSync(join(stateDir, n)).isDirectory(),
      );
      if (dirs.length === 1) return dirs[0];
    } catch {
      /* torn/racing dir read — fall through */
    }
  }
  return null;
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

function detectHarness(harnessDir: string, config: ShapeConfig): HarnessState {
  const files = listHarnessFiles(harnessDir);
  const present = files.filter((f) => !/README|DROP_/i.test(f)).length > 0;
  // The bundle may sit directly in harnessDir or in a dist/ / build/ subdir
  // (the standard `crewhaus compile -o dist` output). Accept either.
  let entry: string | null = null;
  outer: for (const cand of config.entry) {
    for (const prefix of ["", "dist/", "build/"]) {
      if (files.includes(prefix + cand)) {
        entry = prefix + cand;
        break outer;
      }
    }
  }
  const depsInstalled =
    existsSync(join(harnessDir, "node_modules")) ||
    existsSync(join(harnessDir, "dist", "node_modules")) ||
    existsSync(join(harnessDir, "build", "node_modules"));
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

// Crew orchestration events are streamed by the crew daemon without a runId or
// timestamp (they carry {kind, role|from|to, ...}). They are still structured
// events the crew UI wants on the event channel, and no other shape emits these
// kinds, so recognizing them here is safe and shape-agnostic.
const RUNIDLESS_EVENT_KINDS = new Set([
  "role_start",
  "role_end",
  "handoff",
  "crew_done",
  "a2a_message",
]);

function looksLikeEvent(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  if (typeof r.kind !== "string") return false;
  return (
    typeof r.runId === "string" ||
    typeof r.timestamp === "string" ||
    RUNIDLESS_EVENT_KINDS.has(r.kind)
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

// -- Exit-status context (v0.3.0 honest failure messaging) ---------------------
//
// When the child dies, the bare `{ state:"exited", detail:"exit code N" }`
// broadcast is all a frontend used to get — the WHY was buried in the closed
// raw-output drawer. The supervisor now remembers the run's last `run_failed`
// trace event and a rolling tail of stderr, and attaches whichever exists to
// the exit broadcast so every shape can render a real failure explanation
// even when the process died before/without a structured event.

/** Max trace events retained per run for reconnect replay (memory bound). */
export const EVENT_RING_MAX = 500;

/** How many trailing stderr lines ride along on a crash broadcast. */
export const STDERR_TAIL_LINES = 8;
/** Per-line cap so a pathological stderr line cannot bloat the broadcast. */
export const STDERR_TAIL_MAX_CHARS = 400;

/** Rolling capture of the last few meaningful (non-blank) stderr lines. */
export function pushStderrTail(tail: string[], line: string): void {
  const trimmed = line.trimEnd();
  if (!trimmed.trim()) return;
  tail.push(
    trimmed.length > STDERR_TAIL_MAX_CHARS ? `${trimmed.slice(0, STDERR_TAIL_MAX_CHARS)} …` : trimmed,
  );
  if (tail.length > STDERR_TAIL_LINES) tail.shift();
}

/**
 * Extra fields for the `state:"exited"` status broadcast:
 *   exitCode   — always (structured twin of the human `detail` string)
 *   failure    — the run's last `run_failed` trace event, when one was seen
 *   stderrTail — last stderr lines, only on a NONZERO exit with no structured
 *                event (clean exits keep today's behavior; a `run_failed`
 *                is strictly better than a raw tail, so it wins)
 */
export function exitStatusExtra(
  code: number,
  lastRunFailed: Record<string, unknown> | null,
  stderrTail: readonly string[],
): Record<string, unknown> {
  const extra: Record<string, unknown> = { exitCode: code };
  if (lastRunFailed) extra.failure = lastRunFailed;
  else if (code !== 0 && stderrTail.length > 0) extra.stderrTail = [...stderrTail];
  return extra;
}

// -- Process supervisor -------------------------------------------------------

type ClientMsg =
  | { type: "submit"; text: string }
  | { type: "input"; text: string; silent?: boolean }
  | { type: "start"; text?: string }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "install" }
  // A human rating on an assistant turn. Persisted to the harness's
  // .crewhaus/feedback/feedback.jsonl (read by `crewhaus distill`) — never
  // written to the child's stdin, since a rating is not a conversation turn.
  | {
      type: "feedback";
      sessionId?: string;
      turnNumber?: number;
      thumbs?: "up" | "down";
      stars?: number;
      score?: number;
      comment?: string;
      correction?: string;
    };

type Broadcast = (msg: unknown) => void;

/** Exported for the host-level tests (test/host.test.ts) and embedders. */
export class Supervisor {
  private proc: ReturnType<typeof spawn> | null = null;
  private buf = "";
  private state: "idle" | "installing" | "starting" | "running" | "exited" | "error" = "idle";
  /** Detail of the last state transition, kept so `snapshot()` (state
   *  broadcasts, /api/state, WS reconnects) doesn't wipe it off the pill. */
  private lastDetail: string | null = null;
  /** Last `run_failed` trace event seen this run (reset on every start). */
  private lastRunFailed: Record<string, unknown> | null = null;
  /** Rolling tail of the child's stderr (reset on every start). */
  private stderrTail: string[] = [];
  /** Live sessionId latched from trace envelopes (reset on every start). */
  private sessionId: string | null = null;
  /** Spec name keying `.crewhaus/<state|wiki|dream>/<spec>/` (derived, cached). */
  private specName: string | null = null;
  /**
   * Bounded ring of this run's trace events, replayed to a newly-connected WS
   * client so a reload/settings-restart rebuilds the feed + stats instead of
   * blanking. Reset on every start; capped by count to stay memory-bounded.
   */
  private eventRing: Record<string, unknown>[] = [];
  daemonPort: number | null = null;

  constructor(
    readonly harnessDir: string,
    private config: ShapeConfig,
    private broadcast: Broadcast,
  ) {}

  snapshot() {
    return {
      state: this.state,
      detail: this.lastDetail,
      running: this.proc !== null,
      daemonPort: this.daemonPort,
      identity: this.identity(),
      harness: detectHarness(this.harnessDir, this.config),
    };
  }

  /**
   * The run's identity: the live `sessionId` (latched from trace envelopes) and
   * the `specName` keying its `.crewhaus/` subtrees. Exposed in state/status
   * broadcasts so the memory panels know which `.crewhaus/<spec>/` to read and a
   * future settings-restart can re-attach the same session. specName is derived
   * once and cached (it is static for a harness).
   */
  identity(): { sessionId: string | null; specName: string | null } {
    if (!this.specName) {
      const derived = deriveSpecName(findHarnessRoot(this.harnessDir));
      if (derived) this.specName = derived;
    }
    return { sessionId: this.sessionId, specName: this.specName ?? null };
  }

  /** This run's buffered trace events, for replay to a late WS subscriber. */
  recentEvents(): Record<string, unknown>[] {
    return this.eventRing;
  }

  private setState(s: Supervisor["state"], detail?: string, extra?: Record<string, unknown>) {
    this.state = s;
    this.lastDetail = detail ?? null;
    this.broadcast({
      type: "status",
      state: s,
      detail: detail ?? null,
      identity: this.identity(),
      ...(extra ?? {}),
    });
  }

  /**
   * Broadcast a drained TraceEvent, latching the run's identity, remembering
   * the last `run_failed`, and buffering it for reconnect replay.
   */
  private emitEvent(ev: Record<string, unknown>) {
    if (typeof ev.sessionId === "string" && ev.sessionId) this.sessionId = ev.sessionId;
    if (ev.kind === "run_failed") this.lastRunFailed = ev;
    this.eventRing.push(ev);
    if (this.eventRing.length > EVENT_RING_MAX) this.eventRing.shift();
    this.broadcast({ type: "event", event: ev });
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
        this.writeStdin(msg.text, msg.silent);
        break;
      case "feedback":
        this.writeFeedback(msg);
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

  /**
   * Persist a UI rating as a modality-flexible FeedbackRecord line in the
   * harness's `.crewhaus/feedback/feedback.jsonl`. Written under `harnessDir`
   * (not the server cwd) so it lands with the harness's own session data for
   * both in-repo and npm-package layouts, and NEVER to the child's stdin.
   */
  private writeFeedback(msg: Extract<ClientMsg, { type: "feedback" }>) {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    if (!/^sess_[0-9a-f]{16}$/.test(sessionId)) {
      // The record keys to a session; without one it could not be distilled.
      this.log("Ignored a rating with no session id (start a conversation first).");
      return;
    }
    const rating: Record<string, unknown> = {};
    let modality: "binary" | "stars" | "scale" | "comment" | undefined;
    if (msg.thumbs === "up" || msg.thumbs === "down") {
      rating.thumbs = msg.thumbs;
      modality = "binary";
    }
    if (typeof msg.stars === "number" && msg.stars >= 1 && msg.stars <= 5) {
      rating.stars = Math.round(msg.stars);
      modality = "stars";
    }
    if (typeof msg.score === "number" && msg.score >= 0 && msg.score <= 1) {
      rating.scale = { value: msg.score, min: 0, max: 1 };
      modality = "scale";
    }
    // Untrusted free text flows into the distilled dataset + optimizer
    // meta-prompt: strip control chars (keep tab/newline/CR) and bound length.
    const clip = (s: string): string => {
      let out = "";
      for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0;
        if (c === 9 || c === 10 || c === 13 || (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f))) {
          out += ch;
        }
        if (out.length >= 8192) break;
      }
      return out;
    };
    const comment = typeof msg.comment === "string" && msg.comment.trim() !== "" ? clip(msg.comment) : undefined;
    const correction =
      typeof msg.correction === "string" && msg.correction.trim() !== "" ? clip(msg.correction) : undefined;
    if (modality === undefined) {
      if (comment === undefined && correction === undefined) {
        this.log("Ignored a rating with no thumbs / stars / comment.");
        return;
      }
      modality = "comment";
    }
    const turnNumber =
      typeof msg.turnNumber === "number" && Number.isFinite(msg.turnNumber) && msg.turnNumber >= 0
        ? Math.floor(msg.turnNumber)
        : 0;
    const record = {
      schemaVersion: 1,
      id: `fb_${randomBytes(6).toString("hex")}`,
      sessionId,
      turnNumber,
      modality,
      rating,
      ...(comment !== undefined ? { comment } : {}),
      ...(correction !== undefined ? { correction } : {}),
      source: "ui",
      ts: new Date().toISOString(),
    };
    try {
      const dir = join(this.harnessDir, ".crewhaus", "feedback");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "feedback.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      this.log(`Recorded ${modality} feedback on turn ${turnNumber}.`);
    } catch (err) {
      this.log(`Failed to record feedback: ${(err as Error).message}`);
    }
  }

  private async install(): Promise<boolean> {
    const h = detectHarness(this.harnessDir, this.config);
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
    const h = detectHarness(this.harnessDir, this.config);
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

    // Run the agent FROM the harness root (where crewhaus.yaml lives), not the
    // bundle dir — otherwise spec-relative paths (MCP servers, data roots,
    // .crewhaus/, .env) resolve against the wrong directory and the agent
    // exits on boot. The entry bundle may itself live in a dist/ subdir.
    const harnessRoot = findHarnessRoot(this.harnessDir);

    const env: Record<string, string> = {
      ...loadEnvChain(harnessRoot),
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
    if (harnessRoot !== resolve(this.harnessDir)) {
      this.log(`running ${entryPath}\n  cwd: ${harnessRoot} (harness root)`, "stderr");
    }
    const proc = spawn(["bun", entryPath], {
      cwd: harnessRoot,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.buf = "";
    this.lastRunFailed = null;
    this.stderrTail = [];
    this.sessionId = null;
    this.eventRing = [];
    this.setState("running");
    this.broadcast({ type: "state", ...this.snapshot() });

    const pipesDone = Promise.allSettled([
      this.pumpStdout(proc.stdout),
      streamLines(proc.stderr, (l) => {
        pushStderrTail(this.stderrTail, l);
        this.log(l, "stderr");
      }),
    ]);

    // Single-shot: feed the prompt then close stdin so the bundle runs to EOF.
    if (this.config.input === "oneshot") {
      if (initialInput !== undefined) proc.stdin?.write(`${initialInput}\n`);
      proc.stdin?.end();
    } else if (this.config.input === "interactive" && initialInput) {
      this.writeStdin(initialInput);
    }

    void proc.exited.then(async (code) => {
      if (this.proc !== proc) return;
      // Let both stdio pumps drain first so a run_failed event / stderr
      // tail still in the pipe lands BEFORE (and on) the exit broadcast.
      await pipesDone;
      // stop()/restart may have superseded this child while we drained.
      if (this.proc !== proc) return;
      this.flushText();
      this.setState(
        "exited",
        `exit code ${code}`,
        exitStatusExtra(code, this.lastRunFailed, this.stderrTail),
      );
      this.proc = null;
      this.daemonPort = null;
      this.broadcast({ type: "state", ...this.snapshot() });
    });
  }

  writeStdin(text: string, silent?: boolean) {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
    this.proc.stdin.flush?.();
    if (!silent) this.broadcast({ type: "user", text });
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
      for (const ev of events) this.emitEvent(ev);
    }
  }

  private flushText() {
    if (this.buf) {
      const { text, events } = drain(`${this.buf}\n`);
      if (text) this.broadcast({ type: "stdout", text });
      for (const ev of events) this.emitEvent(ev);
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

// -- .crewhaus/ memory bridge (Phase 1) ---------------------------------------
//
// The host reads RAW `.crewhaus/` files and broadcasts them; the browser parses
// and renders (Phase 3). No `@crewhaus/*` package import — JSON files parse
// trivially and markdown/yaml is served as text against the known grammars.
//
// SECURITY: only the four safe subtrees below are ever reachable. `secrets`,
// `audit`, `feedback`, `retention.json`, `.env`, and everything else under
// `.crewhaus/` are NOT served. `..` traversal is rejected and the resolved
// path is confirmed to stay inside the requested subtree.

/** The ONLY `.crewhaus/` subtrees the read route + watcher expose. */
export const CREWHAUS_READ_SUBTREES = ["state", "wiki", "dream", "sessions"] as const;
const CREWHAUS_SUBTREE_SET = new Set<string>(CREWHAUS_READ_SUBTREES);

/**
 * Resolve `/crewhaus/<subpath>` to a safe absolute path under
 * `<harnessRoot>/.crewhaus/`, or null if the request is denied (traversal,
 * a non-allowlisted top-level segment, or a dotfile). The first path segment
 * MUST be one of {@link CREWHAUS_READ_SUBTREES}.
 */
export function resolveCrewhausPath(harnessRoot: string, subpath: string): string | null {
  if (!subpath || subpath.includes("..") || subpath.includes("\0")) return null;
  const segs = subpath.split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return null;
  if (!CREWHAUS_SUBTREE_SET.has(segs[0])) return null;
  // No dotfile anywhere on the path (blocks stray `.env`/`.lock`/hidden files).
  if (segs.some((s) => s.startsWith("."))) return null;
  const base = join(resolve(harnessRoot), ".crewhaus");
  const subtreeRoot = join(base, segs[0]);
  const full = resolve(base, ...segs);
  if (full !== subtreeRoot && !full.startsWith(subtreeRoot + "/")) return null;
  return full;
}

type CrewhausEntry = { name: string; dir: boolean; size: number };

/** JSON listing for a `.crewhaus/` directory (wiki articles/versions, plans). */
export function crewhausListing(base: string, full: string): {
  type: "dir";
  path: string;
  entries: CrewhausEntry[];
} {
  const rel = full.slice(base.length + 1).split(/[\\/]+/).filter(Boolean).join("/");
  const entries: CrewhausEntry[] = [];
  for (const name of readdirSync(full).sort()) {
    if (name.startsWith(".")) continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(full, name));
    } catch {
      continue;
    }
    entries.push({ name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size });
  }
  return { type: "dir", path: rel, entries };
}

/**
 * Serve a `/crewhaus/<subpath>` request: a file (raw bytes with a text-ish
 * MIME) or, when the subpath resolves to a directory, a JSON listing. Denied
 * paths get 403; missing paths 404. Rooted at the harness ROOT (not the bundle
 * dir) so `.crewhaus/` — which lives beside `crewhaus.yaml` — is reachable.
 */
export function crewhausResponse(harnessRoot: string, subpath: string): Response {
  const full = resolveCrewhausPath(harnessRoot, subpath);
  if (!full) return new Response("forbidden", { status: 403 });
  if (!existsSync(full)) return new Response("not found", { status: 404 });
  const base = join(resolve(harnessRoot), ".crewhaus");
  if (statSync(full).isDirectory()) {
    return Response.json(crewhausListing(base, full));
  }
  return new Response(Bun.file(full), { headers: { "content-type": mimeFor(full) } });
}

/** Debounce window: coalesce a burst of writes to the same file into one msg. */
export const MEMORY_DEBOUNCE_MS = 120;

/** Map a `.crewhaus/` relative path to the panel surface it feeds. */
export function memorySurfaceOf(segs: string[]): string {
  const [top, ...rest] = segs;
  if (top === "state") {
    const last = rest[rest.length - 1] ?? "";
    if (rest.includes("plans") || /^plan-/.test(last)) return "plan";
    if (last === "goals.yaml") return "goals";
    if (last === "handoff.md") return "handoff";
    return "focus"; // focus.md and any other state file → the focus surface
  }
  if (top === "wiki") return "wiki";
  if (top === "dream") return "dream";
  if (top === "sessions") return "session";
  return top;
}

/**
 * Watches the four allowlisted `.crewhaus/` subtrees (via `fs.watch`, no new
 * dependency) and broadcasts `{type:"memory", surface, path, changed:true}` on
 * change so panels refetch. Rapid writes to one file are debounced. `.crewhaus/`
 * is created lazily by the running agent, so a watch on the harness root picks
 * up its creation and (re)establishes the recursive watch.
 */
export class MemoryWatcher {
  private watchers: ReturnType<typeof watch>[] = [];
  private baseWatched = false;
  /** Allowlisted subtrees currently under a recursive watch. */
  private subtreeWatched = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private harnessRoot: string,
    private broadcast: Broadcast,
  ) {}

  start(): void {
    this.stop();
    // Catch `.crewhaus/` being created after boot (first run of a fresh repo).
    try {
      this.watchers.push(
        watch(this.harnessRoot, { persistent: false }, (_evt, name) => {
          if (name === ".crewhaus") this.attachCrewhaus();
        }),
      );
    } catch {
      /* root not watchable — attachCrewhaus below still covers the common case */
    }
    this.attachCrewhaus();
  }

  /**
   * Watch each allowlisted subtree ROOT (state/wiki/dream/sessions) separately
   * rather than `.crewhaus/` recursively: a per-subtree recursive watch reports
   * the precise path relative to the subtree (e.g. `demo/focus.md`), whereas
   * watching the base also surfaces coarse `state` directory-rename events that
   * can't be attributed to a file. A non-recursive watch on `.crewhaus/` itself
   * catches a subtree dir being created lazily by the running agent.
   */
  private attachCrewhaus(): void {
    const base = join(this.harnessRoot, ".crewhaus");
    if (!existsSync(base)) return;
    if (!this.baseWatched) {
      try {
        this.watchers.push(
          watch(base, { persistent: false }, (_evt, name) => {
            if (typeof name === "string" && CREWHAUS_SUBTREE_SET.has(name)) this.attachSubtree(name);
          }),
        );
        this.baseWatched = true;
      } catch {
        /* base not watchable — subtrees present at boot are still covered */
      }
    }
    for (const sub of CREWHAUS_READ_SUBTREES) this.attachSubtree(sub);
  }

  private attachSubtree(sub: string): void {
    if (this.subtreeWatched.has(sub)) return;
    const dir = join(this.harnessRoot, ".crewhaus", sub);
    if (!existsSync(dir)) return;
    const onName = (name: string) => this.onChange(`${sub}/${name}`);
    try {
      this.watchers.push(
        watch(dir, { persistent: false, recursive: true }, (_evt, name) => {
          if (typeof name === "string") onName(name);
        }),
      );
      this.subtreeWatched.add(sub);
    } catch {
      // Recursive watch unsupported on this platform: non-recursive best effort.
      try {
        this.watchers.push(
          watch(dir, { persistent: false }, (_evt, name) => {
            if (typeof name === "string") onName(name);
          }),
        );
        this.subtreeWatched.add(sub);
      } catch {
        /* skip this subtree */
      }
    }
  }

  private onChange(relFromBase: string): void {
    const segs = relFromBase.split(/[\\/]+/).filter(Boolean);
    if (segs.length === 0 || !CREWHAUS_SUBTREE_SET.has(segs[0])) return; // ignore secrets/audit/feedback
    const norm = segs.join("/");
    const surface = memorySurfaceOf(segs);
    const prev = this.timers.get(norm);
    if (prev) clearTimeout(prev);
    this.timers.set(
      norm,
      setTimeout(() => {
        this.timers.delete(norm);
        this.broadcast({ type: "memory", surface, path: norm, changed: true });
      }, MEMORY_DEBOUNCE_MS),
    );
  }

  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers = [];
    this.baseWatched = false;
    this.subtreeWatched.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

// -- Server -------------------------------------------------------------------

const WS_CLIENTS = new Set<{ send: (s: string) => void }>();

/** Package root = the dir that holds `_shared/` and every `<shape>/`. */
const PKG_ROOT = dirname(SHARED_DIR);

export type ServeOptions = {
  /** Shape name (e.g. "cli"). UI assets resolve to `<pkg>/<shape>`. */
  shape?: string;
  /** UI assets dir (config.json/index.html/app.js). Default: `<pkg>/<shape>`. */
  uiDir?: string;
  /** Where the user's compiled bundle lives. Default: `process.cwd()`. */
  harnessDir?: string;
  /** Override the `_shared` assets dir. Default: this package's `_shared`. */
  sharedDir?: string;
  /** Listen port. Default: `CREWHAUS_UI_PORT` env, else 4100. */
  port?: number;
};

function resolveServe(opts: string | ServeOptions): {
  uiDir: string;
  harnessDir: string;
  sharedDir: string;
  port: number;
} {
  const envPort = Number(process.env.CREWHAUS_UI_PORT ?? 0) || 4100;
  // Legacy / in-repo form: serve("<shapeDir>") with harness/ inside it.
  if (typeof opts === "string") {
    return {
      uiDir: resolve(opts),
      harnessDir: join(resolve(opts), "harness"),
      sharedDir: SHARED_DIR,
      port: envPort,
    };
  }
  // Package form: serve({ shape, harnessDir }).
  const uiDir = opts.uiDir ?? (opts.shape ? join(PKG_ROOT, opts.shape) : undefined);
  if (!uiDir) throw new Error("serve(): pass a shape dir string, or { shape } / { uiDir }");
  return {
    uiDir: resolve(uiDir),
    harnessDir: resolve(opts.harnessDir ?? process.cwd()),
    sharedDir: opts.sharedDir ?? SHARED_DIR,
    port: opts.port ?? envPort,
  };
}

/**
 * Serve a shape UI. Two forms:
 *   serve("/abs/path/to/ui/cli")                    // in-repo (harness/ inside)
 *   serve({ shape: "cli", harnessDir: "./build" })  // npm-package consumers
 */
export function serve(opts: string | ServeOptions): void {
  const { uiDir, harnessDir, sharedDir, port } = resolveServe(opts);
  const config = readConfig(uiDir);

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

  const sup = new Supervisor(harnessDir, config, broadcast);

  // `.crewhaus/` lives at the harness ROOT (beside crewhaus.yaml), not the
  // bundle dir — root the read route + watcher there (the rooting fix).
  const harnessRoot = findHarnessRoot(harnessDir);
  const memoryWatcher = new MemoryWatcher(harnessRoot, broadcast);
  memoryWatcher.start();

  const staticFile = (path: string): Response | null => {
    if (!existsSync(path) || statSync(path).isDirectory()) return null;
    return new Response(Bun.file(path), { headers: { "content-type": mimeFor(path) } });
  };

  const server = Bun.serve({
    port,
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
      if (path === "/api/harness") return Response.json(detectHarness(harnessDir, config));

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
        return runWorker(harnessDir, req, path.slice("/worker/".length));
      }

      // Read-only `.crewhaus/` memory surfaces (focus/plans/goals/handoff, wiki
      // articles+versions, dream state, session logs), rooted at the harness
      // ROOT. Allowlisted to state|wiki|dream|sessions; secrets/audit/feedback/
      // .env are never reachable, `..` is rejected. A directory resolves to a
      // JSON listing (wiki articles/versions, plans); a file to its raw bytes.
      if (path.startsWith("/crewhaus/")) {
        return crewhausResponse(harnessRoot, path.slice("/crewhaus/".length));
      }

      // Read-only files from the user's harness dir (e.g. wrangler.toml,
      // package.json for the cf-worker manifest panel). Secrets are never served.
      if (path.startsWith("/harness/")) {
        const rest = path.slice("/harness/".length);
        if (rest.includes("..") || /(^|\/)\.(env|dev\.vars)/.test(rest))
          return new Response("forbidden", { status: 403 });
        const r = staticFile(join(harnessDir, rest));
        if (r) return r;
        return new Response("not found", { status: 404 });
      }

      // Static: shape assets, then shared assets.
      if (path === "/" || path === "/index.html") {
        const r = staticFile(join(uiDir, "index.html"));
        if (r) return r;
      }
      if (path.startsWith("/_shared/")) {
        const r = staticFile(join(sharedDir, path.slice("/_shared/".length)));
        if (r) return r;
      }
      {
        const r = staticFile(join(uiDir, path.replace(/^\//, "")));
        if (r) return r;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        WS_CLIENTS.add(ws);
        ws.send(JSON.stringify({ type: "state", config, ...sup.snapshot() }));
        // Replay this run's buffered trace events so a reload / settings-restart
        // rebuilds the feed + stats instead of blanking. Marked `replay:true`
        // (frontends accrue/render them exactly like live events).
        for (const event of sup.recentEvents()) {
          ws.send(JSON.stringify({ type: "event", event, replay: true }));
        }
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
    `  > harness: ${harnessDir}\n`;
  process.stdout.write(ready);
}

// Allow `bun host.ts <shapeDir>` for ad-hoc use.
if (import.meta.main) {
  const target = process.argv[2] ? resolve(process.argv[2]) : dirname(SHARED_DIR);
  serve(target);
}
