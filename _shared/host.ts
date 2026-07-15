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
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

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

/** The harness spec file (`crewhaus.yaml`/`.yml`) at the harness root, or null.
 *  Its presence is what makes the interpreter launch (Path B) + settings view
 *  possible — a bare compiled bundle has no spec to re-read or edit. */
export function findSpecPath(harnessRoot: string): string | null {
  for (const f of ["crewhaus.yaml", "crewhaus.yml"]) {
    const p = join(harnessRoot, f);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Resolve a runnable `crewhaus` CLI for the interpreter launch (Path B):
 *  the harness's own `.bin/crewhaus` first (version-matched to its deps), then
 *  a global `crewhaus` on PATH. `bunx crewhaus` is the last-resort fallback the
 *  spawn uses when this returns null but a spec is present (see selectLaunch).
 *  null ⇒ no local/global CLI, so the host stays on the compiled bundle. */
export function resolveCrewhausBin(harnessRoot: string): string | null {
  const local = join(harnessRoot, "node_modules", ".bin", "crewhaus");
  if (existsSync(local)) return local;
  try {
    const w = Bun.which("crewhaus");
    if (w) return w;
  } catch {
    /* Bun.which unavailable — fall through */
  }
  return null;
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

// -- Settings: spec write-back + secrets + launch modes (Phase 4) -------------
//
// The settings view edits a harness's `crewhaus.yaml`. The host owns the write
// path: it dynamically imports `@crewhaus/spec` (`Spec`/`parseSpec`) and
// `@crewhaus/spec-patch` (`applySpecPatch`/`specHasPath`) resolved against the
// HARNESS's node_modules — version-matched to the running bundle — turns the
// form's field deltas into `SpecPatch`es, applies them (comment/key-order
// preserving, validated through `parseSpec`), and writes the YAML back. Secret
// VALUES never enter the spec or the browser: a `$VAR` ref goes in the spec and
// the real value is written to a `.env` the host loads. The helpers below are
// pure + dependency-injected so they unit-test without the packages installed.

/** A single field edit from the settings form. `remove` deletes the path;
 *  otherwise `value` is the new value. Because `@crewhaus/spec-patch` has no
 *  array-index paths, arrays it cannot index (permissions.rules, tools,
 *  mcp_servers, failure_taxonomy) are edited as a WHOLE-BLOCK `value` at the
 *  block path (a replace) — the same pattern the optimizer uses. */
export type SpecChange = { path: string[]; value?: unknown; remove?: boolean };

/** The `@crewhaus/spec-patch` `SpecPatch` record we build from a change. */
export type SpecPatch = {
  target: string;
  path: string[];
  op: "replace" | "add" | "remove";
  value?: unknown;
  rationale?: string;
};

/** Injected slice of `@crewhaus/spec` + `@crewhaus/spec-patch` (+ optional
 *  `zod-to-json-schema`) resolved from the harness. */
export type SpecTooling = {
  Spec: unknown;
  parseSpec: (yaml: string) => unknown;
  applySpecPatch: (yaml: string, patch: SpecPatch) => { yaml: string; spec?: unknown };
  specHasPath: (yaml: string, path: string[]) => boolean;
  zodToJsonSchema: ((schema: unknown, opts?: unknown) => unknown) | null;
};

/** Env var name accepted for a `$VAR` ref — the compiler's ENV_REF_RE charset
 *  (`lowerSecret`/`lowerCredential`), so a value we write round-trips as a ref. */
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Build the `SpecPatch` for one change: `remove` → remove; else add-vs-replace
 *  is decided by whether the path is already `present` in the document text
 *  (Zod-defaulted-but-unwritten fields are absent → `add`). Pure. */
export function buildSpecPatch(target: string, change: SpecChange, present: boolean): SpecPatch {
  if (!Array.isArray(change.path) || change.path.length === 0)
    throw new Error("spec change: a non-empty path is required");
  if (change.remove) return { target, path: [...change.path], op: "remove" };
  return {
    target,
    path: [...change.path],
    op: present ? "replace" : "add",
    value: change.value,
    rationale: "settings edit (crewhaus UI)",
  };
}

/**
 * Turn a batch of form changes into applied YAML. Each change's add-vs-replace
 * is decided against the CURRENT working YAML (via the injected `specHasPath`,
 * so a path added by an earlier change is seen by a later one) and applied with
 * the injected `applySpecPatch`, threading the YAML forward. `applySpecPatch`
 * re-validates through `parseSpec` on every step and THROWS on an invalid edit,
 * so one bad change rejects the whole batch and the caller writes nothing.
 * Pure + dependency-injected → unit-testable without the real packages.
 */
export function applySpecChanges(
  rawYaml: string,
  target: string,
  changes: readonly SpecChange[],
  deps: Pick<SpecTooling, "applySpecPatch" | "specHasPath">,
): { yaml: string; patches: SpecPatch[] } {
  let yaml = rawYaml;
  const patches: SpecPatch[] = [];
  for (const c of changes) {
    const present = c.remove ? true : deps.specHasPath(yaml, c.path);
    const patch = buildSpecPatch(target, c, present);
    const res = deps.applySpecPatch(yaml, patch);
    yaml = res.yaml;
    patches.push(patch);
  }
  return { yaml, patches };
}

/**
 * Resolve the target `.env` path for a secret write. Default (no `path`) is
 * `<harnessRoot>/.env` — the `harness/.env` beside `crewhaus.yaml` that
 * `loadEnvChain` reads. An explicit ABSOLUTE path is honoured as user-owned
 * (secrets may live in a shared/parent `.env` outside the repo). A RELATIVE
 * path is resolved under `harnessRoot` and MUST stay inside it (no traversal).
 * Returns null when the path is denied.
 */
export function resolveEnvPath(harnessRoot: string, path?: string | null): string | null {
  const root = resolve(harnessRoot);
  if (path == null || path === "") return join(root, ".env");
  if (typeof path !== "string" || path.includes("\0")) return null;
  if (isAbsolute(path)) return resolve(path);
  const full = resolve(root, path);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/** Encode a dotenv value: a plain token charset is written raw; anything with
 *  whitespace/`#`/quotes is double-quoted (so `parseEnvFile` strips it back). */
function encodeEnvValue(v: string): string {
  if (/^[A-Za-z0-9_\-.:/+=~@]*$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Upsert `KEY=value` into a dotenv file's text, preserving every other line
 * (comments, ordering, unrelated vars). Replaces an existing `KEY=` (or
 * `export KEY=`) line in place; otherwise appends. Pure. */
export function upsertEnvVar(existing: string, key: string, value: string): string {
  const line = `${key}=${encodeEnvValue(value)}`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(line);
  return `${lines.join("\n")}\n`;
}

/** Presence (NOT value) of each `$VAR` the spec references, so the settings
 *  view can badge a credential ref as set/unset. Names come from the spec the
 *  user already sees; no secret value is ever read or returned. */
export function envRefPresence(
  yaml: string,
  envChain: Record<string, string>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const re = /\$([A-Z_][A-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yaml))) {
    const k = m[1];
    out[k] = k in envChain || k in process.env;
  }
  return out;
}

/** Launch preference: config `launch` or `CREWHAUS_UI_LAUNCH` env, else auto. */
export function launchPreference(
  config: Record<string, unknown>,
  env: Record<string, string | undefined>,
): "auto" | "compiled" | "interpreter" {
  const raw = env.CREWHAUS_UI_LAUNCH ?? (typeof config.launch === "string" ? config.launch : "");
  return raw === "compiled" || raw === "interpreter" ? raw : "auto";
}

export type LaunchPlan = { mode: "interpreter" | "compiled"; argv: string[] };

/**
 * Choose how to spawn the harness (decision §10.1 — BOTH modes):
 *   • Path B (interpreter) when a spec is present AND a runnable `crewhaus` CLI
 *     exists: `crewhaus run <spec> [--resume <sessionId>]`, passed as an argv
 *     ARRAY (never one interpolated string). The interpreter re-reads the spec
 *     each start (free recompile) and resumes natively — the live-edit default.
 *   • Path A (compiled) otherwise: `bun <entry>`. The compiled bundle cannot
 *     resume (needs factory F3), so `--resume` is never added here.
 * `prefer` ("compiled"/"interpreter") overrides the auto choice; interpreter is
 * only honoured when it is actually available (spec + CLI), else it falls back
 * to compiled. The `--resume <sessionId>` is threaded in only for a valid
 * latched session id. Pure → unit-testable.
 */
export function selectLaunch(opts: {
  specPath: string | null;
  crewhausBin: string | null;
  entryPath: string | null;
  sessionId?: string | null;
  resume?: boolean;
  prefer?: "auto" | "compiled" | "interpreter";
}): LaunchPlan {
  const prefer = opts.prefer ?? "auto";
  const canInterpret = !!(opts.specPath && opts.crewhausBin);
  const useInterpreter = prefer === "compiled" ? false : canInterpret;
  if (useInterpreter) {
    const argv = [opts.crewhausBin as string, "run", opts.specPath as string];
    if (opts.resume && typeof opts.sessionId === "string" && /^sess_[0-9a-f]{16}$/.test(opts.sessionId)) {
      argv.push("--resume", opts.sessionId);
    }
    return { mode: "interpreter", argv };
  }
  return { mode: "compiled", argv: ["bun", opts.entryPath ?? ""] };
}

/** Dynamic import of `name` resolved as if imported from `fromDir` (the
 *  harness node_modules). Throws a clear, UI-surfaceable error if unresolved. */
async function importFromHarness(name: string, fromDir: string): Promise<Record<string, unknown>> {
  let resolved: string;
  try {
    resolved = Bun.resolveSync(name, resolve(fromDir));
  } catch {
    throw new Error(
      `${name} is not installed in the harness (node_modules) — it is required to read/edit the spec.`,
    );
  }
  return (await import(resolved)) as Record<string, unknown>;
}

/**
 * Load the spec tooling from the harness node_modules: `@crewhaus/spec` +
 * `@crewhaus/spec-patch` (required) and `zod-to-json-schema` (optional — the
 * form degrades to value-type inference without it). Throws a clear error if a
 * required package is missing or shaped unexpectedly.
 */
export async function loadSpecTooling(fromDir: string): Promise<SpecTooling> {
  const spec = await importFromHarness("@crewhaus/spec", fromDir);
  const patch = await importFromHarness("@crewhaus/spec-patch", fromDir);
  let zodToJsonSchema: SpecTooling["zodToJsonSchema"] = null;
  try {
    const z = await importFromHarness("zod-to-json-schema", fromDir);
    const cand = (z.zodToJsonSchema ?? (z.default as Record<string, unknown> | undefined)?.zodToJsonSchema ?? z.default) as unknown;
    if (typeof cand === "function") zodToJsonSchema = cand as SpecTooling["zodToJsonSchema"];
  } catch {
    /* optional — proceed without a JSON Schema */
  }
  if (typeof spec.parseSpec !== "function" || spec.Spec == null)
    throw new Error("@crewhaus/spec did not export { Spec, parseSpec }.");
  if (typeof patch.applySpecPatch !== "function" || typeof patch.specHasPath !== "function")
    throw new Error("@crewhaus/spec-patch did not export { applySpecPatch, specHasPath }.");
  return {
    Spec: spec.Spec,
    parseSpec: spec.parseSpec as SpecTooling["parseSpec"],
    applySpecPatch: patch.applySpecPatch as SpecTooling["applySpecPatch"],
    specHasPath: patch.specHasPath as SpecTooling["specHasPath"],
    zodToJsonSchema,
  };
}

/**
 * Best-effort install of the spec tooling into the harness, version-matched to
 * an already-installed `@crewhaus/*` (the compiled bundle's own deps) so the
 * schema matches the running bundle. Non-fatal: a failure surfaces as the
 * clear "not installed" error from {@link loadSpecTooling} on the retry.
 */
async function installSpecTooling(harnessDir: string, log: (l: string) => void): Promise<void> {
  let ver = "latest";
  const probe = join(harnessDir, "node_modules", "@crewhaus", "runtime-core", "package.json");
  try {
    if (existsSync(probe)) {
      const v = JSON.parse(readFileSync(probe, "utf8")).version;
      if (typeof v === "string" && v) ver = v;
    }
  } catch {
    /* fall back to latest */
  }
  const specs = [`@crewhaus/spec@${ver}`, `@crewhaus/spec-patch@${ver}`, "zod-to-json-schema"];
  log(`[settings] installing ${specs.join(", ")} for spec editing …`);
  const proc = spawn(["bun", "add", ...specs], {
    cwd: harnessDir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  await streamLines(proc.stdout, (l) => log(`[settings] ${l}`));
  await streamLines(proc.stderr, (l) => log(`[settings] ${l}`));
  await proc.exited;
}

// -- File upload (attach) -----------------------------------------------------
//
// The composer's attach control (paperclip + drag-drop) reads a file IN THE
// BROWSER and sends it here as base64. The host writes it to a LOCAL path the
// agent can read — default `<harnessRoot>/uploads/`, or a user-chosen dir — and
// returns the written path so the user can reference it in the next message
// ("Read ./uploads/data.csv"). This is a plain local write on the user's own
// machine: NOTHING is uploaded off the box, there is no shared/central store.
// It is traversal-guarded on BOTH the destination dir AND the filename,
// size-capped, written non-executable (0600), and the bytes are NEVER run.
// The helpers are pure/exported so they unit-test without a running server.

/** Hard cap on a single uploaded file (decoded bytes). Larger files should be
 *  referenced by path directly rather than round-tripped through the browser. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB

/** Default upload destination, relative to the harness root. */
export const UPLOAD_DEFAULT_DIR = "uploads";

/**
 * Reduce an arbitrary client-supplied filename to a SAFE basename: strip any
 * directory component (so `../../etc/passwd` → `passwd`), drop control chars +
 * NUL, forbid the reserved `.`/`..` names, and bound the length (preserving a
 * short extension). Returns null when nothing safe remains. Pure.
 */
export function sanitizeUploadName(name: string): string | null {
  if (typeof name !== "string") return null;
  // Basename only: everything after the last slash/backslash.
  let base = name.split(/[\\/]+/).pop() ?? "";
  base = base.replace(/[\x00-\x1f\x7f]/g, "").trim(); // strip NUL + control chars
  if (base === "" || base === "." || base === "..") return null;
  if (base.length > 200) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : "";
    base = base.slice(0, 200 - ext.length) + ext;
  }
  return base;
}

/**
 * Resolve the destination DIRECTORY for an upload, mirroring {@link
 * resolveEnvPath}: default (no `dir`) is `<harnessRoot>/uploads`; an explicit
 * ABSOLUTE path is honoured as user-owned (uploads may land anywhere the user
 * names on their own machine); a RELATIVE path is resolved under `harnessRoot`
 * and MUST stay inside it (no `..` traversal). Returns null when denied.
 */
export function resolveUploadDir(harnessRoot: string, dir?: string | null): string | null {
  const root = resolve(harnessRoot);
  if (dir == null || dir === "") return join(root, UPLOAD_DEFAULT_DIR);
  if (typeof dir !== "string" || dir.includes("\0")) return null;
  if (isAbsolute(dir)) return resolve(dir);
  const full = resolve(root, dir);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/** Cheap sanity check on a base64 payload BEFORE we allocate a decode buffer:
 *  non-empty, base64 charset only, and small enough that `len*3/4` stays within
 *  `maxBytes`. Guards against decoding a pathologically large or garbage body. */
export function isPlausibleBase64(s: string, maxBytes: number): boolean {
  if (typeof s !== "string") return false;
  const body = s.replace(/\s+/g, "");
  if (body.length === 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return false;
  if (Math.floor(body.length / 4) * 3 > maxBytes + 3) return false; // pre-decode size bound
  return true;
}

/** Display path for a written upload: `./uploads/x` when it lives inside the
 *  harness root (so the agent reads it with a relative path), else the absolute
 *  path (the user pointed the upload outside the repo). */
export function uploadDisplayPath(harnessRoot: string, full: string): string {
  const root = resolve(harnessRoot);
  if (full === root) return ".";
  if (full.startsWith(root + sep)) return "./" + full.slice(root.length + 1).split(sep).join("/");
  return full;
}

/** Non-clobbering path in `dir` for `name`: if `name` exists, insert ` (2)`,
 *  ` (3)`, … before the extension. Never overwrites existing user data. */
export function uniqueUploadPath(dir: string, name: string): string {
  const first = join(dir, name);
  if (!existsSync(first)) return first;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const cand = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(cand)) return cand;
  }
  return join(dir, `${stem}-${Date.now()}${ext}`);
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
    }
  // Settings view (Phase 4). `spec_get` → the host reads `crewhaus.yaml`, builds
  // `zodToJsonSchema(Spec)`, and broadcasts `{type:"spec_data", …}`. `spec_patch`
  // → apply the form's field deltas, validate, write back, then recompile/resume.
  // `secret_set` → write `KEY=value` to the chosen `.env` (never echoed) and,
  // when a `specPath` is given, ensure the spec's `$KEY` ref at that path.
  | { type: "spec_get" }
  | { type: "spec_patch"; changes: SpecChange[]; target?: string }
  | { type: "secret_set"; key: string; value: string; path?: string; specPath?: string[] }
  // File upload / attach (user-directed, LOCAL). The composer reads a file in
  // the browser and sends its bytes as base64; the host writes it to a local
  // path the agent can read (default `<harnessRoot>/uploads/`, or `dir`) and
  // replies with `{type:"attach_result", …, relPath}`. `id` correlates the
  // reply to the composer chip. Nothing leaves the machine.
  | { type: "attach"; name: string; contentBase64: string; dir?: string; id?: string };

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
  /** Spec tooling (@crewhaus/spec + spec-patch), resolved from the harness on
   *  first settings use and cached (import is idempotent per resolved path). */
  private specTooling: SpecTooling | null = null;
  /** Once a settings save has switched this run to the interpreter for live
   *  edits, keep using it so subsequent restarts resume the same session. */
  private liveEdit = false;
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
      case "spec_get":
        await this.handleSpecGet();
        break;
      case "spec_patch":
        await this.handleSpecPatch(msg);
        break;
      case "secret_set":
        await this.handleSecretSet(msg);
        break;
      case "attach":
        this.handleAttach(msg);
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

  /**
   * Write a user-attached file to a LOCAL path the agent can read (the attach
   * control in the composer). Default destination `<harnessRoot>/uploads/`, or a
   * user-chosen `dir`; traversal-guarded on BOTH the dir and the filename,
   * size-capped, written 0600 and NEVER executed. Broadcasts `attach_result`
   * with the written path (relative when inside the harness) so the browser can
   * reference it in the next message. The file stays on this machine — there is
   * no network destination and nothing is shared.
   */
  private handleAttach(msg: Extract<ClientMsg, { type: "attach" }>): void {
    const id = typeof msg.id === "string" ? msg.id : undefined;
    const fail = (error: string) =>
      this.broadcast({ type: "attach_result", ok: false, ...(id ? { id } : {}), error });

    const safeName = sanitizeUploadName(String(msg.name ?? ""));
    if (!safeName) return fail("Invalid file name.");

    const harnessRoot = findHarnessRoot(this.harnessDir);
    const dir = resolveUploadDir(harnessRoot, typeof msg.dir === "string" ? msg.dir : null);
    if (!dir) return fail("Denied upload directory (traversal outside the harness).");

    const cap = Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024));
    const b64 = typeof msg.contentBase64 === "string" ? msg.contentBase64 : "";
    if (!isPlausibleBase64(b64, UPLOAD_MAX_BYTES))
      return fail(`File is empty, malformed, or exceeds the ${cap} MB limit.`);

    const bytes = Buffer.from(b64.replace(/\s+/g, ""), "base64");
    if (bytes.byteLength === 0) return fail("File is empty.");
    if (bytes.byteLength > UPLOAD_MAX_BYTES) return fail(`File exceeds the ${cap} MB limit.`);

    let full: string;
    try {
      mkdirSync(dir, { recursive: true });
      full = uniqueUploadPath(dir, safeName);
      writeFileSync(full, bytes, { mode: 0o600 });
      chmodSync(full, 0o600); // non-executable even if the file somehow pre-existed
    } catch (e) {
      return fail(`Could not write the file: ${(e as Error).message}`);
    }
    const relPath = uploadDisplayPath(harnessRoot, full);
    this.log(`Saved attachment ${relPath} (${bytes.byteLength} bytes, local).`);
    this.broadcast({
      type: "attach_result",
      ok: true,
      ...(id ? { id } : {}),
      name: safeName,
      path: full,
      relPath,
      bytes: bytes.byteLength,
    });
  }

  // ── Settings: spec read / patch / secret (Phase 4) ───────────────────────

  /** Resolve the spec tooling from the harness node_modules, installing it
   *  (version-matched) on first use if absent. Cached after the first success. */
  private async getSpecTooling(): Promise<SpecTooling> {
    if (this.specTooling) return this.specTooling;
    try {
      this.specTooling = await loadSpecTooling(this.harnessDir);
      return this.specTooling;
    } catch {
      // Not resolvable yet — the compiled bundle doesn't import spec/spec-patch.
      // Install them version-matched to the bundle's own @crewhaus/* and retry.
      await installSpecTooling(this.harnessDir, (l) => this.log(l));
      this.specTooling = await loadSpecTooling(this.harnessDir); // throws a clear error if still missing
      return this.specTooling;
    }
  }

  /** Read `crewhaus.yaml`, build `zodToJsonSchema(Spec)`, and broadcast the
   *  form data. Never returns a secret VALUE — only `$VAR` ref presence. */
  private async handleSpecGet(): Promise<void> {
    const harnessRoot = findHarnessRoot(this.harnessDir);
    const specPath = findSpecPath(harnessRoot);
    if (!specPath) {
      this.broadcast({
        type: "spec_data",
        ok: false,
        error:
          "No crewhaus.yaml found for this harness. The settings view edits a harness spec; a compiled-only bundle has none to show.",
      });
      return;
    }
    let tooling: SpecTooling;
    try {
      tooling = await this.getSpecTooling();
    } catch (e) {
      this.broadcast({ type: "spec_data", ok: false, needsInstall: true, error: (e as Error).message });
      return;
    }
    try {
      const yaml = readFileSync(specPath, "utf8");
      const spec = tooling.parseSpec(yaml) as Record<string, unknown>; // effective (defaults); validates the file
      const target = typeof spec.target === "string" ? spec.target : "cli";
      // The as-written object (no defaults) lets the form distinguish user-set
      // fields from defaulted ones. Best-effort — `yaml` is a spec dep.
      let written: unknown = null;
      try {
        const y = await importFromHarness("yaml", this.harnessDir);
        if (typeof y.parse === "function") written = (y.parse as (s: string) => unknown)(yaml);
      } catch {
        /* no yaml lib — form falls back to the effective spec */
      }
      let schema: unknown = null;
      if (tooling.zodToJsonSchema) {
        try {
          schema = tooling.zodToJsonSchema(tooling.Spec, { $refStrategy: "none" });
        } catch {
          /* schema optional — form degrades to value-type inference */
        }
      }
      const crewhausBin = resolveCrewhausBin(harnessRoot);
      this.broadcast({
        type: "spec_data",
        ok: true,
        target,
        spec,
        written,
        schema,
        refs: envRefPresence(yaml, loadEnvChain(harnessRoot)),
        envPath: join(harnessRoot, ".env"),
        launch: { mode: crewhausBin ? "interpreter" : "compiled", canResume: !!crewhausBin },
      });
    } catch (e) {
      this.broadcast({ type: "spec_data", ok: false, error: `Could not read the spec: ${(e as Error).message}` });
    }
  }

  /** Apply the form's field deltas to `crewhaus.yaml`, validate, write back,
   *  then recompile + resume per the launch mode (decision §10.1). */
  private async handleSpecPatch(msg: Extract<ClientMsg, { type: "spec_patch" }>): Promise<void> {
    const harnessRoot = findHarnessRoot(this.harnessDir);
    const specPath = findSpecPath(harnessRoot);
    if (!specPath) {
      this.broadcast({ type: "spec_patch_result", ok: false, error: "No crewhaus.yaml to edit." });
      return;
    }
    const changes = Array.isArray(msg.changes) ? msg.changes : [];
    if (!changes.length) {
      this.broadcast({ type: "spec_patch_result", ok: false, error: "No changes to apply." });
      return;
    }
    let tooling: SpecTooling;
    try {
      tooling = await this.getSpecTooling();
    } catch (e) {
      this.broadcast({ type: "spec_patch_result", ok: false, error: (e as Error).message });
      return;
    }
    const raw = readFileSync(specPath, "utf8");
    let target = typeof msg.target === "string" ? msg.target : "";
    if (!target) {
      try {
        target = (tooling.parseSpec(raw) as { target?: string }).target ?? "cli";
      } catch {
        target = "cli";
      }
    }
    let applied: { yaml: string; patches: SpecPatch[] };
    try {
      applied = applySpecChanges(raw, target, changes, tooling);
    } catch (e) {
      // A rejected edit (parseSpec inside applySpecPatch) — surface it, write nothing.
      this.broadcast({ type: "spec_patch_result", ok: false, error: (e as Error).message });
      return;
    }
    // Final belt-and-braces validation before touching disk.
    try {
      tooling.parseSpec(applied.yaml);
    } catch (e) {
      this.broadcast({ type: "spec_patch_result", ok: false, error: (e as Error).message });
      return;
    }
    try {
      writeFileSync(specPath, applied.yaml);
    } catch (e) {
      this.broadcast({ type: "spec_patch_result", ok: false, error: `Could not write the spec: ${(e as Error).message}` });
      return;
    }
    await this.recompileAndResume(harnessRoot, applied.yaml, applied.patches.length);
  }

  /** After a spec save, restart the harness so the change takes effect and the
   *  session picks back up. Path B (interpreter + `--resume`) is seamless; the
   *  Path A fallback recompiles the bundle (no resume) or, absent a compiler,
   *  saves the spec with an honest "recompile needed" message. */
  private async recompileAndResume(harnessRoot: string, yaml: string, applied: number): Promise<void> {
    const interpretable =
      this.config.runClass === "stdio-interactive" || this.config.runClass === "stdio-oneshot";
    const crewhausBin = interpretable ? resolveCrewhausBin(harnessRoot) : null;
    if (interpretable && crewhausBin) {
      // Path B — the interpreter re-reads the spec (free recompile) and resumes
      // the same session natively. The latched sessionId drives `--resume`.
      this.liveEdit = true;
      this.broadcast({
        type: "spec_patch_result",
        ok: true,
        applied,
        recompile: "interpreter",
        resumed: !!this.sessionId,
        sessionId: this.sessionId,
      });
      if (this.proc) {
        this.stop();
        await this.start(undefined, { resume: true });
      }
      return;
    }
    // Path A — compiled fallback: try a programmatic recompile of the bundle.
    let recompiled = false;
    try {
      recompiled = await this.recompileBundle(harnessRoot, yaml);
    } catch (e) {
      this.log(`[settings] recompile unavailable: ${(e as Error).message}`);
    }
    if (recompiled) {
      this.broadcast({
        type: "spec_patch_result",
        ok: true,
        applied,
        recompile: "compiled",
        resumed: false,
        note: "Bundle recompiled; the session resets — compiled-bundle resume needs factory F3.",
      });
      if (this.proc) {
        this.stop();
        await this.start(); // no resume — compiled bundles can't resume yet (F3)
      }
      return;
    }
    this.broadcast({
      type: "spec_patch_result",
      ok: true,
      applied,
      recompile: "none",
      resumed: false,
      note:
        "Spec saved. This harness runs a compiled bundle with no crewhaus CLI or @crewhaus/compiler available, so it can't be live-recompiled or resumed in-host. Install the crewhaus CLI for live edit + resume, or re-drop a freshly compiled bundle.",
    });
  }

  /** Programmatically recompile the spec via `@crewhaus/compiler` and rewrite
   *  the bundle files in place. Returns false if the compiler is unavailable
   *  (the common Path A case) so the caller can fall back to a save-only note. */
  private async recompileBundle(harnessRoot: string, yaml: string): Promise<boolean> {
    let compiler: Record<string, unknown>;
    try {
      compiler = await importFromHarness("@crewhaus/compiler", this.harnessDir);
    } catch {
      return false;
    }
    if (typeof compiler.compile !== "function") return false;
    const bundle = (compiler.compile as (y: string, o?: unknown) => unknown)(yaml, {}) as {
      files?: { path: string; content: string }[];
    };
    if (!bundle || !Array.isArray(bundle.files)) return false;
    const h = detectHarness(this.harnessDir, this.config);
    const bundleDir = resolve(h.entry ? dirname(join(this.harnessDir, h.entry)) : this.harnessDir);
    for (const f of bundle.files) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
      const dest = resolve(bundleDir, f.path);
      if (dest !== bundleDir && !dest.startsWith(bundleDir + sep)) continue; // no traversal
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }
    return true;
  }

  /** Write a secret VALUE to the chosen `.env` (mode 0600) and, when a
   *  `specPath` is given, ensure the spec's `$KEY` ref at that path. The VALUE
   *  is never echoed back on any broadcast — only the key + env path + whether
   *  a ref was written. */
  private async handleSecretSet(msg: Extract<ClientMsg, { type: "secret_set" }>): Promise<void> {
    const key = String(msg.key ?? "");
    if (!ENV_KEY_RE.test(key)) {
      this.broadcast({ type: "secret_set_result", ok: false, key, error: "Invalid env key (use A–Z, 0–9, _)." });
      return;
    }
    const value = typeof msg.value === "string" ? msg.value : "";
    if (/[\r\n]/.test(value)) {
      this.broadcast({ type: "secret_set_result", ok: false, key, error: "A secret value must be a single line." });
      return;
    }
    const harnessRoot = findHarnessRoot(this.harnessDir);
    const envPath = resolveEnvPath(harnessRoot, typeof msg.path === "string" ? msg.path : null);
    if (!envPath) {
      this.broadcast({ type: "secret_set_result", ok: false, key, error: "Denied env path (traversal outside the harness)." });
      return;
    }
    try {
      const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
      writeFileSync(envPath, upsertEnvVar(existing, key, value), { mode: 0o600 });
      chmodSync(envPath, 0o600); // enforce 0600 even if the file pre-existed
    } catch (e) {
      this.broadcast({ type: "secret_set_result", ok: false, key, error: `Could not write .env: ${(e as Error).message}` });
      return;
    }
    // Ensure the spec references the secret as `$KEY` at the given path.
    let refWritten = false;
    if (Array.isArray(msg.specPath) && msg.specPath.length) {
      try {
        const specPath = findSpecPath(harnessRoot);
        const tooling = await this.getSpecTooling();
        if (specPath) {
          const raw = readFileSync(specPath, "utf8");
          const target = (tooling.parseSpec(raw) as { target?: string }).target ?? "cli";
          const { yaml } = applySpecChanges(raw, target, [{ path: msg.specPath, value: `$${key}` }], tooling);
          tooling.parseSpec(yaml);
          writeFileSync(specPath, yaml);
          refWritten = true;
        }
      } catch (e) {
        this.log(`[settings] secret value written, but the $${key} ref could not be set: ${(e as Error).message}`);
      }
    }
    this.broadcast({ type: "secret_set_result", ok: true, key, envPath, refWritten });
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

  /** Ensure deps (compiled path) then spawn the harness per the launch mode
   *  (decision §10.1). `opts.resume` requests native session resume (Path B). */
  async start(initialInput?: string, opts?: { resume?: boolean }) {
    if (this.config.runClass === "plugin") {
      this.log("Plugin shapes are inspected, not run.");
      return;
    }
    const h = detectHarness(this.harnessDir, this.config);

    // Run the agent FROM the harness root (where crewhaus.yaml lives), not the
    // bundle dir — otherwise spec-relative paths (MCP servers, data roots,
    // .crewhaus/, .env) resolve against the wrong directory and the agent
    // exits on boot. The entry bundle may itself live in a dist/ subdir.
    const harnessRoot = findHarnessRoot(this.harnessDir);
    const entryPath = h.entry ? join(this.harnessDir, h.entry) : null;

    // Launch mode (Path A/B, §10.1). Interpreter (Path B) applies only to the
    // stdio run classes; daemon-http/cf-worker keep their compiled entry. Path B
    // needs a spec + a runnable `crewhaus` CLI; otherwise `bun <entry>` (Path A).
    const interpretable =
      this.config.runClass === "stdio-interactive" || this.config.runClass === "stdio-oneshot";
    const specPath = interpretable ? findSpecPath(harnessRoot) : null;
    const crewhausBin = specPath ? resolveCrewhausBin(harnessRoot) : null;
    let prefer = launchPreference(this.config, process.env);
    if (this.liveEdit && interpretable) prefer = "interpreter"; // sticky after a live edit
    const plan = selectLaunch({
      specPath,
      crewhausBin,
      entryPath,
      sessionId: this.sessionId,
      resume: !!(opts && opts.resume),
      prefer,
    });

    if (plan.mode === "compiled") {
      if (!h.entry) {
        this.setState("error", "no entry file in harness/");
        this.log(`No entry file (${this.config.entry.join(" / ")}) found in harness/.`);
        return;
      }
      if (!h.depsInstalled) {
        const ok = await this.install();
        if (!ok) return;
      }
    }
    this.stop();
    this.setState("starting");

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

    const resuming = plan.mode === "interpreter" && !!(opts && opts.resume);
    this.log(
      `launch: ${plan.mode}${resuming ? " (resume)" : ""} — ${plan.argv.join(" ")}\n  cwd: ${harnessRoot}`,
      "stderr",
    );
    const proc = spawn(plan.argv, {
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
