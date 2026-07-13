/**
 * DOM-less unit tests for the shared run-failure vocabulary
 * (_shared/failure.js): the exit-code labeling helper the shape frontends
 * use to explain a nonzero exit, and the run_failed message splitter.
 *
 * failure.js is a classic browser script (IIFE attaching to window.CH).
 * Point `window` at globalThis before loading it — no DOM required, the
 * module is pure string/number logic by design.
 */
import { beforeAll, describe, expect, test } from "bun:test";

type ExitInfo = {
  code: number | null;
  failed: boolean;
  label: string | null;
  line: string | null;
  failure: Record<string, unknown> | null;
  stderrTail: string[] | null;
};

type FailureModule = {
  EXIT_LABELS: Record<number, string>;
  exitCodeOf: (msg: unknown) => number | null;
  exitInfo: (msg: unknown) => ExitInfo;
  splitMessage: (message: unknown) => { title: string; detail: string };
};

let failure: FailureModule;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  await import("../_shared/failure.js");
  failure = (globalThis as unknown as { CH: { failure: FailureModule } }).CH.failure;
});

describe("exitCodeOf", () => {
  test("prefers the structured exitCode field", () => {
    expect(failure.exitCodeOf({ exitCode: 31, detail: "exit code 1" })).toBe(31);
  });

  test("falls back to parsing 'exit code N' from detail (older hosts)", () => {
    expect(failure.exitCodeOf({ detail: "exit code 31" })).toBe(31);
  });

  test("also accepts the short 'exit N' form", () => {
    expect(failure.exitCodeOf({ detail: "exit 33" })).toBe(33);
  });

  test("returns null when nothing is parseable", () => {
    expect(failure.exitCodeOf({ detail: null })).toBeNull();
    expect(failure.exitCodeOf({})).toBeNull();
    expect(failure.exitCodeOf(undefined)).toBeNull();
  });
});

describe("exitInfo — the exit-code table", () => {
  const label = (code: number) => failure.exitInfo({ exitCode: code }).label;

  test("maps every classified code from the factory table", () => {
    expect(label(20)).toBe("spec error");
    expect(label(21)).toBe("config / missing env");
    expect(label(30)).toBe("provider rejected the credentials (auth)");
    expect(label(31)).toBe("out of funding (provider billing)");
    expect(label(32)).toBe("provider rate/quota limit");
    expect(label(33)).toBe("budget cap reached");
    expect(label(40)).toBe("tool/MCP failure");
  });

  test("clean exit: failed=false, no failure treatment", () => {
    const x = failure.exitInfo({ exitCode: 0, detail: "exit code 0" });
    expect(x.code).toBe(0);
    expect(x.failed).toBe(false);
    expect(x.label).toBeNull();
  });

  test("unknown state (no code anywhere): failed=false", () => {
    const x = failure.exitInfo({ detail: null });
    expect(x.code).toBeNull();
    expect(x.failed).toBe(false);
    expect(x.line).toBeNull();
  });

  test("labeled crash composes the fleet-style line", () => {
    const x = failure.exitInfo({ exitCode: 31 });
    expect(x.failed).toBe(true);
    expect(x.line).toBe("out of funding (provider billing) · exit 31");
  });

  test("unlabeled nonzero exit keeps the bare code line", () => {
    const x = failure.exitInfo({ exitCode: 137 });
    expect(x.failed).toBe(true);
    expect(x.label).toBeNull();
    expect(x.line).toBe("exit 137");
  });

  test("surfaces host-attached failure event and stderr tail", () => {
    const ev = { kind: "run_failed", class: "billing", exitCode: 31 };
    expect(failure.exitInfo({ exitCode: 31, failure: ev }).failure).toEqual(ev);
    expect(failure.exitInfo({ exitCode: 1, stderrTail: ["boom"] }).stderrTail).toEqual(["boom"]);
    expect(failure.exitInfo({ exitCode: 1, stderrTail: [] }).stderrTail).toBeNull();
    expect(failure.exitInfo({ exitCode: 1 }).failure).toBeNull();
  });
});

describe("splitMessage — run_failed.message is '<title>: <detail>'", () => {
  test("splits at the FIRST ': ' so detail may contain colons", () => {
    const msg =
      'provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API."';
    expect(failure.splitMessage(msg)).toEqual({
      title: "provider account out of funding",
      detail: 'Anthropic said: "Your credit balance is too low to access the Anthropic API."',
    });
  });

  test("message without a separator becomes title-only", () => {
    expect(failure.splitMessage("unexpected error")).toEqual({
      title: "unexpected error",
      detail: "",
    });
  });

  test("tolerates non-string input", () => {
    expect(failure.splitMessage(undefined)).toEqual({ title: "", detail: "" });
  });
});
