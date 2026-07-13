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
  exitStatusExtra,
  pushStderrTail,
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
