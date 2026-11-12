/**
 * Host-level tests for the v0.3.0 exit-status broadcast: the supervisor
 * attaches the run's last `run_failed` trace event — or a rolling stderr
 * tail — to the `state:"exited"` status message so frontends can explain
 * a crash even when the process died before emitting anything structured.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  crewhausResponse,
  deriveSpecName,
  drain,
  exitStatusExtra,
  looksLikeEvent,
  MemoryWatcher,
  memorySurfaceOf,
  pushStderrTail,
  resolveCrewhausPath,
  STDERR_TAIL_LINES,
  STDERR_TAIL_MAX_CHARS,
  Supervisor,
} from "../_shared/host.ts";

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("pushStderrTail", () => {
  test("keeps only the last N non-blank lines", () => {
    const tail: string[] = [];
    for (let i = 0; i < STDERR_TAIL_LINES + 5; i++) pushStderrTail(tail, `line ${i}`);
    expect(tail.length).toBe(STDERR_TAIL_LINES);
    expect(tail[0]).toBe("line 5");
    expect(tail[tail.length - 1]).toBe(`line ${STDERR_TAIL_LINES + 4}`);
  });

  test("skips blank lines and trims trailing whitespace", () => {
    const tail: string[] = [];
    pushStderrTail(tail, "   ");
    pushStderrTail(tail, "");
    pushStderrTail(tail, "real line   ");
    expect(tail).toEqual(["real line"]);
  });

  test("caps pathological line length", () => {
    const tail: string[] = [];
    pushStderrTail(tail, "x".repeat(STDERR_TAIL_MAX_CHARS * 2));
    expect(tail[0].length).toBeLessThanOrEqual(STDERR_TAIL_MAX_CHARS + 2);
    expect(tail[0].endsWith("…")).toBe(true);
  });
});

describe("exitStatusExtra", () => {
  const runFailed = {
    kind: "run_failed",
    class: "billing",
    message: 'provider account out of funding: Anthropic said: "Your credit balance is too low."',
    remediation: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
    exitCode: 31,
  };

  test("always carries the structured exit code", () => {
    expect(exitStatusExtra(0, null, [])).toEqual({ exitCode: 0 });
    expect(exitStatusExtra(5, null, [])).toEqual({ exitCode: 5 });
  });

  test("prefers the run_failed event over the stderr tail", () => {
    const extra = exitStatusExtra(31, runFailed, ["some stack line"]);
    expect(extra.exitCode).toBe(31);
    expect(extra.failure).toEqual(runFailed);
    expect(extra.stderrTail).toBeUndefined();
  });

  test("falls back to the stderr tail on an unstructured crash", () => {
    const extra = exitStatusExtra(1, null, ["RuntimeError: boom", "  at agent.ts:1"]);
    expect(extra.exitCode).toBe(1);
    expect(extra.failure).toBeUndefined();
    expect(extra.stderrTail).toEqual(["RuntimeError: boom", "  at agent.ts:1"]);
  });

  test("clean exits keep today's shape (no tail, no failure)", () => {
    const extra = exitStatusExtra(0, null, ["leftover stderr noise"]);
    expect(extra).toEqual({ exitCode: 0 });
  });
});

// ── Supervisor integration: spawn a fake harness, watch the broadcasts ──────

const TMP_ROOT = join(import.meta.dir, `.tmp-host-test-${process.pid}`);
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const CONFIG = {
  shape: "cli",
  title: "test",
  tagline: "",
  runClass: "stdio-oneshot",
  entry: ["agent.ts"],
  input: "oneshot",
} as const;

/** Write a throwaway harness dir whose agent.ts is the given source. */
function makeHarness(name: string, agentSource: string): string {
  const dir = join(TMP_ROOT, name);
  mkdirSync(join(dir, "node_modules"), { recursive: true }); // skip `bun install`
  writeFileSync(join(dir, "agent.ts"), agentSource);
  return dir;
}

/** Start the supervisor and collect broadcasts until the exited status. */
async function runToExit(harnessDir: string): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  let onExited: (() => void) | null = null;
  const exited = new Promise<void>((res) => {
    onExited = res;
  });
  const sup = new Supervisor(harnessDir, CONFIG as never, (msg) => {
    const m = msg as Record<string, unknown>;
    messages.push(m);
    if (m.type === "status" && m.state === "exited") onExited?.();
  });
  await sup.start();
  await exited;
  return messages;
}

const RUN_FAILED_EVENT = {
  kind: "run_failed",
  runId: "run_x",
  sessionId: "sess_0123456789abcdef",
  turnNumber: 1,
  traceId: "0".repeat(32),
  spanId: "0".repeat(16),
  timestamp: "2026-07-13T00:00:00.000Z",
  class: "billing",
  message:
    'provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API."',
  remediation: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
  exitCode: 31,
};

describe("Supervisor exit broadcast", () => {
  test("attaches the run's last run_failed event to a coded exit", async () => {
    const dir = makeHarness(
      "billing",
      `console.log(JSON.stringify(${JSON.stringify(RUN_FAILED_EVENT)}));\n` +
        `console.error("RunFailedError: run stopped — provider account out of funding");\n` +
        `process.exit(31);\n`,
    );
    const messages = await runToExit(dir);

    // The structured event reached the event channel...
    const events = messages.filter((m) => m.type === "event");
    expect(events.some((m) => (m.event as { kind?: string }).kind === "run_failed")).toBe(true);

    // ...and rides along on the exit status, which stderr tail defers to.
    const exit = messages.find((m) => m.type === "status" && m.state === "exited");
    expect(exit).toBeDefined();
    expect(exit?.detail).toBe("exit code 31");
    expect(exit?.exitCode).toBe(31);
    expect((exit?.failure as { kind?: string }).kind).toBe("run_failed");
    expect((exit?.failure as { class?: string }).class).toBe("billing");
    expect(exit?.stderrTail).toBeUndefined();
  });

  test("falls back to the stderr tail when the crash was unstructured", async () => {
    const dir = makeHarness(
      "unstructured",
      `console.error("error: MISSING_ENV not set");\n` +
        `console.error("  at boot (agent.ts:2)");\n` +
        `process.exit(21);\n`,
    );
    const messages = await runToExit(dir);

    const exit = messages.find((m) => m.type === "status" && m.state === "exited");
    expect(exit?.exitCode).toBe(21);
    expect(exit?.failure).toBeUndefined();
    expect(exit?.stderrTail).toEqual(["error: MISSING_ENV not set", "  at boot (agent.ts:2)"]);
  });

  test("clean exits broadcast only the structured code", async () => {
    const dir = makeHarness("clean", `console.log("bye");\nprocess.exit(0);\n`);
    const messages = await runToExit(dir);

    const exit = messages.find((m) => m.type === "status" && m.state === "exited");
    expect(exit?.exitCode).toBe(0);
    expect(exit?.failure).toBeUndefined();
    expect(exit?.stderrTail).toBeUndefined();
  });
});

// ── Phase 1: identity latch + reconnect replay ──────────────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the supervisor, collect broadcasts AND return the live supervisor. */
async function runCollectingSup(
  harnessDir: string,
): Promise<{ messages: Record<string, unknown>[]; sup: Supervisor }> {
  const messages: Record<string, unknown>[] = [];
  let onExited: (() => void) | null = null;
  const exited = new Promise<void>((res) => {
    onExited = res;
  });
  const sup = new Supervisor(harnessDir, CONFIG as never, (msg) => {
    const m = msg as Record<string, unknown>;
    messages.push(m);
    if (m.type === "status" && m.state === "exited") onExited?.();
  });
  await sup.start();
  await exited;
  return { messages, sup };
}

const SESSION_ID = "sess_0123456789abcdef";
const envelope = (kind: string, extra: Record<string, unknown>) => ({
  kind,
  runId: "run_x",
  sessionId: SESSION_ID,
  turnNumber: 1,
  traceId: "0".repeat(32),
  spanId: "0".repeat(16),
  timestamp: "2026-07-14T00:00:00.000Z",
  ...extra,
});

describe("identity latch + event replay", () => {
  test("latches sessionId from a scripted trace event and exposes it", async () => {
    const ev = envelope("turn_start", { turn: 1, messageCount: 1 });
    const dir = makeHarness(
      "latch",
      `console.log(JSON.stringify(${JSON.stringify(ev)}));\nprocess.exit(0);\n`,
    );
    const { messages, sup } = await runCollectingSup(dir);

    // The supervisor kept the id...
    expect(sup.identity().sessionId).toBe(SESSION_ID);
    // ...and it rode along on the state/status broadcasts.
    const withId = messages.find(
      (m) => (m.identity as { sessionId?: string } | undefined)?.sessionId === SESSION_ID,
    );
    expect(withId).toBeDefined();
    // snapshot() (WS-open state msg, /api/state) carries identity too.
    expect((sup.snapshot().identity as { sessionId?: string }).sessionId).toBe(SESSION_ID);
  });

  test("re-broadcasts identity mid-run on the FIRST sessionId latch", async () => {
    // Regression: the sessionId latches from the first trace envelope, which
    // arrives AFTER the "running" status (so that status carried a null id).
    // Without a re-broadcast, sessionId-keyed memory views (skills, context
    // evictions) can't fetch `.crewhaus/sessions/<id>.jsonl` until the run ends.
    const ev = envelope("turn_start", { turn: 1, messageCount: 1 });
    const dir = makeHarness(
      "latch-rebroadcast",
      `console.log(JSON.stringify(${JSON.stringify(ev)}));\nprocess.exit(0);\n`,
    );
    const { messages } = await runCollectingSup(dir);
    // A NON-terminal status must carry the latched id (not just the final
    // "exited" one) — that is the push the client adopts to populate the views.
    const midRun = messages.find(
      (m) =>
        m.type === "status" &&
        m.state !== "exited" &&
        (m.identity as { sessionId?: string } | undefined)?.sessionId === SESSION_ID,
    );
    expect(midRun).toBeDefined();
  });

  test("buffers this run's trace events for replay to a late subscriber", async () => {
    const a = envelope("turn_start", { turn: 1, messageCount: 1 });
    const b = envelope("turn_end", { turn: 1, durationMs: 5, stopReason: "end_turn" });
    const dir = makeHarness(
      "replay",
      `console.log(JSON.stringify(${JSON.stringify(a)}));\n` +
        `console.log(JSON.stringify(${JSON.stringify(b)}));\n` +
        `process.exit(0);\n`,
    );
    const { sup } = await runCollectingSup(dir);

    const buffered = sup.recentEvents();
    expect(buffered.map((e) => e.kind)).toEqual(["turn_start", "turn_end"]);

    // A newly-connected client would replay exactly these (the ws.open loop).
    const replayed: unknown[] = [];
    for (const event of sup.recentEvents()) replayed.push({ type: "event", event, replay: true });
    expect(replayed.length).toBe(2);
    expect((replayed[0] as { event: { kind: string } }).event.kind).toBe("turn_start");
  });
});

// ── Phase 1: spec-name derivation ───────────────────────────────────────────

describe("deriveSpecName", () => {
  test("reads the top-level name: from the spec yaml", () => {
    const root = join(TMP_ROOT, "spec-yaml");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "crewhaus.yaml"), "target: cli\nname: my-agent\nmodel: opus\n");
    expect(deriveSpecName(root)).toBe("my-agent");
  });

  test("falls back to the sole .crewhaus/state/<spec> dir", () => {
    const root = join(TMP_ROOT, "spec-statedir");
    mkdirSync(join(root, ".crewhaus", "state", "solo"), { recursive: true });
    writeFileSync(join(root, "crewhaus.yaml"), "target: cli\n"); // no name:
    expect(deriveSpecName(root)).toBe("solo");
  });

  test("returns null when nothing identifies the spec", () => {
    const root = join(TMP_ROOT, "spec-none");
    mkdirSync(root, { recursive: true });
    expect(deriveSpecName(root)).toBeNull();
  });
});

// ── Phase 1: the .crewhaus/ read route (allowlist + traversal guard) ─────────

describe("crewhaus read route", () => {
  const root = join(TMP_ROOT, "cw-root");
  function seed() {
    mkdirSync(join(root, ".crewhaus", "state", "demo"), { recursive: true });
    writeFileSync(
      join(root, ".crewhaus", "state", "demo", "focus.md"),
      "<!-- crewhaus:focus -->\n# Focus\nship the bridge\n",
    );
    mkdirSync(join(root, ".crewhaus", "wiki", "demo", "articles"), { recursive: true });
    writeFileSync(join(root, ".crewhaus", "wiki", "demo", "articles", "foo.md"), "# Foo\n");
    mkdirSync(join(root, ".crewhaus", "secrets"), { recursive: true });
    writeFileSync(join(root, ".crewhaus", "secrets", "keys.json"), '{"k":1}');
    writeFileSync(join(root, ".crewhaus", ".env"), "SECRET=1\n");
  }

  test("serves an allowlisted state file as raw text", async () => {
    seed();
    const r = crewhausResponse(root, "state/demo/focus.md");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("ship the bridge");
    expect(r.headers.get("content-type")).toContain("text/markdown");
  });

  test("lists a directory (wiki articles / plans) as JSON", async () => {
    seed();
    const r = crewhausResponse(root, "wiki/demo/articles");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { type: string; entries: { name: string }[] };
    expect(body.type).toBe("dir");
    expect(body.entries.map((e) => e.name)).toContain("foo.md");
  });

  test("BLOCKS the non-allowlisted subtrees (secrets/audit/feedback) with 403", () => {
    seed();
    expect(crewhausResponse(root, "secrets/keys.json").status).toBe(403);
    expect(crewhausResponse(root, "audit/log.jsonl").status).toBe(403);
    expect(crewhausResponse(root, "feedback/feedback.jsonl").status).toBe(403);
  });

  test("BLOCKS .env and any dotfile with 403", () => {
    seed();
    expect(crewhausResponse(root, ".env").status).toBe(403);
    expect(crewhausResponse(root, "state/demo/.lock").status).toBe(403);
  });

  test("BLOCKS `..` traversal (even routed through an allowlisted prefix)", () => {
    seed();
    expect(crewhausResponse(root, "../.env").status).toBe(403);
    expect(crewhausResponse(root, "state/../secrets/keys.json").status).toBe(403);
    expect(crewhausResponse(root, "state/demo/../../../crewhaus.yaml").status).toBe(403);
  });

  test("404s a missing allowlisted path", () => {
    seed();
    expect(crewhausResponse(root, "state/nope/focus.md").status).toBe(404);
  });

  test("resolveCrewhausPath returns null for every denied shape", () => {
    expect(resolveCrewhausPath(root, "state/demo/focus.md")).not.toBeNull();
    expect(resolveCrewhausPath(root, "secrets/x")).toBeNull();
    expect(resolveCrewhausPath(root, "../etc/passwd")).toBeNull();
    expect(resolveCrewhausPath(root, "")).toBeNull();
  });
});

// ── Phase 1: path -> surface mapping (pure, exact) ──────────────────────────

describe("memorySurfaceOf", () => {
  test("maps each .crewhaus/ path to its panel surface", () => {
    expect(memorySurfaceOf(["state", "demo", "focus.md"])).toBe("focus");
    expect(memorySurfaceOf(["state", "demo", "plans", "plan-0001-x.md"])).toBe("plan");
    expect(memorySurfaceOf(["state", "demo", "goals.yaml"])).toBe("goals");
    expect(memorySurfaceOf(["state", "demo", "handoff.md"])).toBe("handoff");
    expect(memorySurfaceOf(["wiki", "demo", "articles", "foo.md"])).toBe("wiki");
    expect(memorySurfaceOf(["dream", "demo", "state.json"])).toBe("dream");
    expect(memorySurfaceOf(["sessions", "sess_0123456789abcdef.jsonl"])).toBe("session");
  });

  test("a coarse (directory-granular) state event still yields a valid surface", () => {
    // macOS FSEvents is directory-granular, so the watcher may report just the
    // spec dir; default such state events to the focus surface.
    expect(memorySurfaceOf(["state", "demo"])).toBe("focus");
    expect(memorySurfaceOf(["state"])).toBe("focus");
  });
});

// ── Phase 1: the .crewhaus/ watcher ─────────────────────────────────────────

const MEMORY_SURFACES = new Set(["focus", "plan", "goals", "handoff", "wiki", "dream", "session"]);

describe("MemoryWatcher", () => {
  // fs.watch on macOS is directory-granular and reports file vs parent-dir
  // events non-deterministically, so we assert the RELIABLE contract (a
  // debounced memory broadcast for the right subtree + a valid surface) here,
  // and pin the exact path->surface mapping in the pure test above.
  test("broadcasts a memory message on a watched file change", async () => {
    const root = join(TMP_ROOT, "watch-root");
    mkdirSync(join(root, ".crewhaus", "state", "demo"), { recursive: true });
    const focus = join(root, ".crewhaus", "state", "demo", "focus.md");
    writeFileSync(focus, "before");

    let onMem: ((m: Record<string, unknown>) => void) | null = null;
    const got = new Promise<Record<string, unknown>>((res) => {
      onMem = res;
    });
    const w = new MemoryWatcher(root, (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.type === "memory") onMem?.(m);
    });
    w.start();
    await delay(200); // let fs.watch establish before the write

    writeFileSync(focus, "after");

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("no memory message within 3s")), 3000),
    );
    const msg = (await Promise.race([got, timeout])) as Record<string, unknown>;
    w.stop();

    expect(msg.type).toBe("memory");
    expect(msg.changed).toBe(true);
    expect(String(msg.path).startsWith("state/demo")).toBe(true);
    expect(MEMORY_SURFACES.has(msg.surface as string)).toBe(true);
  });

  test("does NOT broadcast for non-allowlisted subtrees (secrets)", async () => {
    const root = join(TMP_ROOT, "watch-secrets");
    mkdirSync(join(root, ".crewhaus", "secrets"), { recursive: true });
    const secret = join(root, ".crewhaus", "secrets", "keys.json");
    writeFileSync(secret, "{}");

    const seen: Record<string, unknown>[] = [];
    const w = new MemoryWatcher(root, (msg) => seen.push(msg as Record<string, unknown>));
    w.start();
    await delay(200);
    writeFileSync(secret, '{"k":2}');
    await delay(400); // give any (unwanted) event time to fire + debounce
    w.stop();

    expect(seen.filter((m) => m.type === "memory")).toEqual([]);
  });
});

// ── A managed daemon's signing secret ───────────────────────────────────────

const MANAGED_CONFIG = {
  shape: "managed",
  title: "test",
  tagline: "",
  runClass: "daemon-http",
  entry: ["agent.ts"],
  input: "none",
  port: 3000,
} as const;

/** A fake daemon that records the secret it was started with, then exits. */
const RECORD_SECRET = `
  await Bun.write("seen-secret.txt", process.env.CREWHAUS_GATEWAY_JWT_SECRET ?? "<unset>");
`;

type SecretMessage = { type: "gateway_secret"; secret: string | null };

/** Run the fake daemon once on `sup`, and wait for it to exit. */
async function startAndExit(sup: Supervisor, exited: () => Promise<void>): Promise<void> {
  const done = exited();
  await sup.start();
  await done;
}

function managedSupervisor(name: string, config: Record<string, unknown> = MANAGED_CONFIG) {
  const dir = makeHarness(name, RECORD_SECRET);
  const messages: Record<string, unknown>[] = [];
  let onExited: (() => void) | null = null;
  const sup = new Supervisor(dir, config as never, (msg) => {
    const m = msg as Record<string, unknown>;
    messages.push(m);
    if (m.type === "status" && m.state === "exited") onExited?.();
  });
  const exited = () =>
    new Promise<void>((res) => {
      onExited = res;
    });
  const seen = () => readFileSync(join(dir, "seen-secret.txt"), "utf8");
  const secrets = () =>
    messages.filter((m) => m.type === "gateway_secret") as unknown as SecretMessage[];
  return { dir, sup, messages, exited, seen, secrets };
}

describe("a managed daemon's signing secret", () => {
  const saved = process.env.CREWHAUS_GATEWAY_JWT_SECRET;
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "CREWHAUS_GATEWAY_JWT_SECRET");
  });
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_GATEWAY_JWT_SECRET");
    else process.env.CREWHAUS_GATEWAY_JWT_SECRET = saved;
  });

  test("with none set: the daemon starts with a generated one and the page is handed the same value", async () => {
    const h = managedSupervisor("secret-generated");
    await startAndExit(h.sup, h.exited);
    const given = h.seen();
    expect(given).toMatch(/^[0-9a-f]{48}$/);
    expect(h.secrets()).toEqual([{ type: "gateway_secret", secret: given }]);
    expect(h.sup.gatewaySecretMessage()).toEqual({ type: "gateway_secret", secret: given });
  });

  test("a restart keeps the value, so a token stays valid", async () => {
    const h = managedSupervisor("secret-restart");
    await startAndExit(h.sup, h.exited);
    const first = h.seen();
    await startAndExit(h.sup, h.exited);
    expect(h.seen()).toBe(first);
  });

  test("the value stays out of the snapshot /api/state answers", async () => {
    const h = managedSupervisor("secret-snapshot");
    await startAndExit(h.sup, h.exited);
    expect(JSON.stringify(h.sup.snapshot())).not.toContain(h.seen());
    const notSecretMessages = h.messages.filter((m) => m.type !== "gateway_secret");
    expect(JSON.stringify(notSecretMessages)).not.toContain(h.seen());
  });

  test("set by the operator in the environment: used as it is, and not handed to the page", async () => {
    const operator = ["operator", "secret", "0".repeat(16)].join("-");
    process.env.CREWHAUS_GATEWAY_JWT_SECRET = operator;
    const h = managedSupervisor("secret-operator");
    await startAndExit(h.sup, h.exited);
    expect(h.seen()).toBe(operator);
    expect(h.secrets()).toEqual([{ type: "gateway_secret", secret: null }]);
  });

  test("set by the operator in the harness .env: used as it is, and not handed to the page", async () => {
    const operator = ["dotenv", "secret", "0".repeat(16)].join("-");
    const h = managedSupervisor("secret-dotenv");
    writeFileSync(join(h.dir, ".env"), `CREWHAUS_GATEWAY_JWT_SECRET=${operator}\n`);
    await startAndExit(h.sup, h.exited);
    expect(h.seen()).toBe(operator);
    expect(h.secrets()).toEqual([{ type: "gateway_secret", secret: null }]);
  });

  test("the operator setting one replaces what the page was handed", async () => {
    const operator = ["later", "secret", "0".repeat(16)].join("-");
    const h = managedSupervisor("secret-later");
    await startAndExit(h.sup, h.exited);
    expect(h.secrets().at(-1)?.secret).toBe(h.seen());
    writeFileSync(join(h.dir, ".env"), `CREWHAUS_GATEWAY_JWT_SECRET=${operator}\n`);
    await startAndExit(h.sup, h.exited);
    expect(h.seen()).toBe(operator);
    expect(h.secrets().at(-1)?.secret).toBeNull();
  });

  test("another daemon shape gets no secret and no message", async () => {
    const h = managedSupervisor("secret-other-shape", { ...MANAGED_CONFIG, shape: "channel" });
    await startAndExit(h.sup, h.exited);
    expect(h.seen()).toBe("<unset>");
    expect(h.secrets()).toEqual([]);
    expect(h.sup.gatewaySecretMessage()).toBeNull();
  });
});

// ── Run ids are opaque ───────────────────────────────────────────────────────

describe("a run id of any form marks a trace event", () => {
  const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
  const crock = (n: number, seed: number) =>
    Array.from({ length: n }, (_, i) => CROCKFORD[(seed * 11 + i * 5) % 32]).join("");
  const canon = (time: string, rand: string) => `run_${time}${rand}`;
  const CANONICAL = canon(crock(10, 1), crock(16, 2));

  test("the canonical id is well formed", () => {
    expect(CANONICAL).toMatch(/^run_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  test("looksLikeEvent accepts every id form and decides by type", () => {
    const ids = [
      CANONICAL,
      "run_0123456789abcdef",
      "run_0a1b2c3d",
      "grun_fedcba9876543210",
      "nightly 2026/11 #3",
    ];
    for (const runId of ids) expect(looksLikeEvent({ kind: "turn_start", runId })).toBe(true);
    expect(looksLikeEvent({ kind: "turn_start", runId: 42 })).toBe(false);
  });

  test("drain holds an event cut inside its run id until the rest arrives", () => {
    const line = JSON.stringify({ runId: CANONICAL, kind: "turn_start" });
    const whole = `some prose ${line}`;
    const cut = whole.indexOf(CANONICAL) + 10;
    const first = drain(whole.slice(0, cut));
    expect(first.text).toBe("some prose ");
    expect(first.events).toEqual([]);
    expect(first.rest).toBe(whole.slice("some prose ".length, cut));
    const second = drain(first.rest + whole.slice(cut));
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.runId).toBe(CANONICAL);
    expect(second.text).toBe("");
  });
});
