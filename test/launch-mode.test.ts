/**
 * Launch-mode matrix: which spawn path each shape gets on a DEFAULT install.
 *
 * `crewhaus run` executes cli and browser targets only — factory's `runRun`
 * dispatches on the spec target and dies with
 *   "crewhaus run supports target: cli or browser (got "<target>")"
 * for everything else, because every other target is compile-only. So the
 * interpreter launch (Path B) is correct for exactly two of the eighteen
 * shapes; on the other ten stdio shapes it would exit 1 where `bun <entry>`
 * (Path A) works, and picking it was the bug this matrix pins shut.
 *
 * The properties asserted here, against the REAL config.json files on disk:
 *
 *   1. Every shape on disk is in the matrix (no shape added later escapes it).
 *   2. Under the exact conditions that USED to mis-select — a spec at the
 *      harness root and a resolvable `crewhaus` binary, i.e. what a default
 *      `bun add @crewhaus/ui` + `crewhaus compile` install looks like — each
 *      shape gets its expected mode.
 *   3. Removing the CLI never changes the answer for a compile-only shape (it
 *      was already compiled) and only ever downgrades cli/browser to compiled.
 *   4. An explicit `interpreter` preference on a compile-only shape is ignored
 *      WITH A WARNING (not refused), and the plan is still a runnable Path A.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  canInterpretShape,
  canResumeShape,
  INTERPRETER_SHAPES,
  RESUMABLE_SHAPES,
  selectLaunch,
} from "../_shared/host.ts";

/** The §10.1 launch matrix — every shape UI in the repo and the mode it must
 *  get when a spec AND a `crewhaus` CLI are both present.
 *
 *  interpreter → `crewhaus run <spec>` really runs this target.
 *  compiled    → `bun <entry>`; either a compile-only target (`crewhaus run`
 *                would exit 1) or a non-stdio run class with its own entry. */
const EXPECTED: Record<string, "interpreter" | "compiled"> = {
  // `crewhaus run` targets — the only two that may take Path B.
  cli: "interpreter",
  browser: "interpreter",

  // stdio, but COMPILE-ONLY targets: `crewhaus run` exits 1 on each of these.
  batch: "compiled",
  crew: "compiled",
  eval: "compiled",
  graph: "compiled",
  onchain: "compiled",
  "onchain-game": "compiled",
  pipeline: "compiled",
  research: "compiled",
  voice: "compiled",
  workflow: "compiled",

  // non-stdio run classes: they keep their own compiled entry regardless.
  channel: "compiled", // daemon-http
  managed: "compiled", // daemon-http
  "cf-worker-cli": "compiled",
  "cf-worker-graph": "compiled",
  "cf-worker-workflow": "compiled",
  "claude-plugin": "compiled", // never spawned at all (inspected, not run)
};

type Cfg = { shape: string; runClass: string };

function readConfig(shape: string): Cfg {
  const raw = readFileSync(join(import.meta.dir, "..", shape, "config.json"), "utf8");
  return JSON.parse(raw) as Cfg;
}

/** Every top-level dir shipping a config.json is a shape (mirrors
    shape-features.test.ts / scaffold.ts listShapes). */
function discoverShapes(): string[] {
  const root = join(import.meta.dir, "..");
  return readdirSync(root)
    .filter((name) => {
      const dir = join(root, name);
      return (
        !name.startsWith(".") &&
        name !== "_shared" &&
        name !== "node_modules" &&
        existsSync(dir) &&
        statSync(dir).isDirectory() &&
        existsSync(join(dir, "config.json"))
      );
    })
    .sort();
}

const SHAPES = Object.keys(EXPECTED);

/** What a default install offers: a spec at the harness root and a resolvable
 *  `crewhaus` on PATH. This is the state in which the old code chose the
 *  interpreter for every stdio shape. */
function planFor(cfg: Cfg, over: Partial<Parameters<typeof selectLaunch>[0]> = {}) {
  return selectLaunch({
    shape: cfg.shape,
    runClass: cfg.runClass,
    specPath: "/h/crewhaus.yaml",
    crewhausBin: "/usr/local/bin/crewhaus",
    entryPath: "/h/agent.ts",
    ...over,
  });
}

describe("launch mode per shape (§10.1)", () => {
  test("the matrix covers exactly the shapes on disk", () => {
    expect(discoverShapes()).toEqual([...SHAPES].sort());
  });

  test("only cli and browser are interpreter shapes", () => {
    expect([...INTERPRETER_SHAPES].sort()).toEqual(["browser", "cli"]);
    expect(
      SHAPES.filter((s) => EXPECTED[s] === "interpreter").sort(),
    ).toEqual(["browser", "cli"]);
  });

  for (const shape of SHAPES) {
    const want = EXPECTED[shape];
    test(`${shape} → ${want} (spec + crewhaus CLI both present)`, () => {
      const cfg = readConfig(shape);
      expect(cfg.shape).toBe(shape); // config.shape is the gate's input — pin it
      const plan = planFor(cfg);
      expect(plan.mode).toBe(want);
      expect(plan.warning).toBeUndefined(); // "auto" never warns
      if (want === "interpreter") {
        expect(plan.argv).toEqual(["/usr/local/bin/crewhaus", "run", "/h/crewhaus.yaml"]);
      } else {
        expect(plan.argv).toEqual(["bun", "/h/agent.ts"]);
      }
      // canInterpretShape is the shared predicate `start()` and
      // `recompileAndResume()` both gate on — it must agree with the plan.
      expect(canInterpretShape(cfg.shape, cfg.runClass)).toBe(want === "interpreter");
    });
  }

  test("without a crewhaus CLI every shape is compiled", () => {
    for (const shape of SHAPES) {
      const plan = planFor(readConfig(shape), { crewhausBin: null });
      expect(plan.mode).toBe("compiled");
    }
  });

  test("without a spec every shape is compiled", () => {
    for (const shape of SHAPES) {
      const plan = planFor(readConfig(shape), { specPath: null });
      expect(plan.mode).toBe("compiled");
    }
  });
});

// ── Explicit `launch: interpreter` / CREWHAUS_UI_LAUNCH=interpreter ──────────
//
// Chosen behavior: IGNORED WITH A WARNING, not refused. The compiled path is a
// working launch, so failing the start over a preference would be worse than
// starting and saying why — and it matches what an explicit `interpreter`
// already does when the spec or CLI is missing.

describe("explicit interpreter preference on a compile-only shape", () => {
  const COMPILE_ONLY = SHAPES.filter((s) => EXPECTED[s] === "compiled");

  for (const shape of COMPILE_ONLY) {
    test(`${shape} ignores prefer:"interpreter" and warns`, () => {
      const plan = planFor(readConfig(shape), { prefer: "interpreter" });
      expect(plan.mode).toBe("compiled");
      expect(plan.argv).toEqual(["bun", "/h/agent.ts"]); // still runnable
      expect(typeof plan.warning).toBe("string");
      // The warning must name the shape and why, so the run log explains itself.
      expect(plan.warning).toContain(shape);
      expect(plan.warning).toContain("compile-only");
      expect(plan.warning).toContain("crewhaus run");
    });
  }

  test('prefer:"interpreter" is honoured on cli and browser', () => {
    for (const shape of ["cli", "browser"]) {
      const plan = planFor(readConfig(shape), { prefer: "interpreter" });
      expect(plan.mode).toBe("interpreter");
      expect(plan.warning).toBeUndefined();
    }
  });

  test('prefer:"compiled" is honoured everywhere and never warns', () => {
    for (const shape of SHAPES) {
      const plan = planFor(readConfig(shape), { prefer: "compiled" });
      expect(plan.mode).toBe("compiled");
      expect(plan.warning).toBeUndefined();
    }
  });
});

// ── `--resume` is a SEPARATE capability from the interpreter launch ──────────
//
// `crewhaus run` runs a browser target but refuses to resume one:
//   runRunBrowser → die("--resume and --continue are not supported for
//                       target: browser (single-turn)")
// so emitting the flag turns a working restart into an exit 1. Being runnable
// and being resumable are gated separately, and this pins the difference.

const SID = "sess_0123456789abcdef";

describe("--resume per shape", () => {
  test("only cli is resumable, and resumable implies interpretable", () => {
    expect([...RESUMABLE_SHAPES]).toEqual(["cli"]);
    for (const s of RESUMABLE_SHAPES) expect(INTERPRETER_SHAPES).toContain(s);
  });

  for (const shape of SHAPES) {
    const wantResume = shape === "cli";
    test(`${shape} ${wantResume ? "gets" : "never gets"} --resume`, () => {
      const cfg = readConfig(shape);
      expect(canResumeShape(cfg.shape, cfg.runClass)).toBe(wantResume);
      const plan = planFor(cfg, { resume: true, sessionId: SID });
      expect(plan.argv.includes("--resume")).toBe(wantResume);
      if (wantResume) {
        expect(plan.argv).toEqual(["/usr/local/bin/crewhaus", "run", "/h/crewhaus.yaml", "--resume", SID]);
      }
    });
  }

  test("browser takes the interpreter but bare — no --resume flag", () => {
    const plan = planFor(readConfig("browser"), { resume: true, sessionId: SID });
    expect(plan.mode).toBe("interpreter"); // still Path B: `crewhaus run` runs it
    expect(plan.argv).toEqual(["/usr/local/bin/crewhaus", "run", "/h/crewhaus.yaml"]);
  });
});
