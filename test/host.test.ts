/**
 * Host-level tests for the v0.3.0 exit-status broadcast: the supervisor
 * attaches the run's last `run_failed` trace event — or a rolling stderr
 * tail — to the `state:"exited"` status message so frontends can explain
 * a crash even when the process died before emitting anything structured.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  crewhausResponse,
  deriveSpecName,
  exitStatusExtra,
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
