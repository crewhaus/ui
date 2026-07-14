/**
 * Phase 4 — settings view + seamless recompile/resume (host side).
 *
 * DOM-less/host tests for the write path and launch logic:
 *   • building a SpecPatch from a form delta (add vs replace incl. whole-array)
 *   • `parseSpec` rejecting a bad edit (the batch rejects, nothing is written)
 *   • the `.env` writer honouring the configured path + refusing traversal
 *   • the launch-mode selection (Path B when spec + CLI present, else Path A)
 *   • the sessionId threaded into the `--resume` spawn argv
 *   • the secret writer never echoing a value + writing 0600
 *
 * The spec-patch tooling (`@crewhaus/spec` + `@crewhaus/spec-patch`) is not a
 * dependency of the compiled bundle, so the host resolves it from the harness
 * at runtime. Here we inject a faithful FAKE that honours the same contract
 * (`applySpecPatch` mutates + re-validates through a `parseSpec` that THROWS on
 * an invalid edit; `specHasPath` reports document presence) so the host's
 * orchestration is tested without a network install.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applySpecChanges,
  buildSpecPatch,
  ENV_KEY_RE,
  envRefPresence,
  findSpecPath,
  resolveCrewhausBin,
  resolveEnvPath,
  selectLaunch,
  Supervisor,
  upsertEnvVar,
  type SpecChange,
  type SpecPatch,
} from "../_shared/host.ts";

// ── A faithful in-memory fake of the spec tooling (JSON stands in for YAML) ──

type Obj = Record<string, unknown>;
const parse = (yaml: string): Obj => JSON.parse(yaml);
const serialize = (o: Obj): string => JSON.stringify(o);
function hasIn(o: unknown, path: string[]): boolean {
  let c: unknown = o;
  for (const s of path) {
    if (c == null || typeof c !== "object" || !(s in (c as Obj))) return false;
    c = (c as Obj)[s];
  }
  return true;
}
function setIn(o: Obj, path: string[], v: unknown): void {
  let c: Obj = o;
  for (let i = 0; i < path.length - 1; i++) {
    const s = path[i];
    if (c[s] == null || typeof c[s] !== "object") c[s] = {};
    c = c[s] as Obj;
  }
  c[path[path.length - 1]] = v;
}
function delIn(o: Obj, path: string[]): void {
  let c: Obj = o;
  for (let i = 0; i < path.length - 1; i++) {
    c = c[path[i]] as Obj;
    if (c == null) return;
  }
  delete c[path[path.length - 1]];
}
/** Stand-in for `parseSpec`'s cross-field validation — throws on a bad edit. */
function validate(o: Obj): Obj {
  const agent = o.agent as { max_tokens?: unknown } | undefined;
  if (agent && typeof agent.max_tokens === "number" && agent.max_tokens < 1)
    throw new Error("agent.max_tokens must be a positive integer");
  const perms = o.permissions as { mode?: unknown } | undefined;
  if (perms && perms.mode === "bypass") throw new Error("permissions.mode 'bypass' is rejected");
  return o;
}
const fakeTooling = {
  specHasPath: (yaml: string, path: string[]) => hasIn(parse(yaml), path),
  applySpecPatch: (yaml: string, patch: SpecPatch) => {
    const o = parse(yaml);
    if (patch.op === "remove") delIn(o, patch.path);
    else setIn(o, patch.path, patch.value);
    validate(o); // like the real applySpecPatch: re-validate, throw on invalid
    return { yaml: serialize(o), spec: o };
  },
};

const BASE = serialize({
  target: "cli",
  name: "demo",
  agent: { model: "opus", instructions: "be helpful", max_tokens: 4096 },
  tools: ["Read", "Write"],
  permissions: { mode: "default", rules: [{ type: "alwaysAsk", pattern: "Bash(*)" }] },
});

// ── buildSpecPatch (pure op decision, incl. whole-array replace) ─────────────

describe("buildSpecPatch", () => {
  test("present path → replace; absent path → add", () => {
    expect(buildSpecPatch("cli", { path: ["agent", "model"], value: "sonnet" }, true)).toMatchObject({
      target: "cli",
      path: ["agent", "model"],
      op: "replace",
      value: "sonnet",
    });
    expect(buildSpecPatch("cli", { path: ["budget", "hardUsd"], value: 5 }, false)).toMatchObject({
      op: "add",
      value: 5,
    });
  });

  test("remove carries no value", () => {
    const p = buildSpecPatch("cli", { path: ["agent", "max_tokens"], remove: true }, true);
    expect(p.op).toBe("remove");
    expect("value" in p).toBe(false);
  });

  test("a whole-array edit is a single replace carrying the full array", () => {
    const rules = [
      { type: "alwaysAllow", pattern: "Read(*)" },
      { type: "alwaysDeny", pattern: "Bash(*)" },
    ];
    const p = buildSpecPatch("cli", { path: ["permissions", "rules"], value: rules }, true);
    expect(p.op).toBe("replace");
    expect(p.path).toEqual(["permissions", "rules"]);
    expect(p.value).toEqual(rules);
  });

  test("empty path is rejected", () => {
    expect(() => buildSpecPatch("cli", { path: [], value: 1 }, false)).toThrow();
  });
});

// ── applySpecChanges (threaded apply + validation) ───────────────────────────

describe("applySpecChanges", () => {
  test("applies scalar edits, deciding add vs replace per path", () => {
    const changes: SpecChange[] = [
      { path: ["agent", "model"], value: "sonnet" }, // replace (present)
      { path: ["agent", "max_tokens"], value: 8192 }, // replace (present)
      { path: ["observability", "level"], value: "debug" }, // add (absent block)
    ];
    const { yaml, patches } = applySpecChanges(BASE, "cli", changes, fakeTooling);
    expect(patches.map((p) => p.op)).toEqual(["replace", "replace", "add"]);
    const out = parse(yaml) as { agent: Obj; observability: Obj };
    expect(out.agent.model).toBe("sonnet");
    expect(out.agent.max_tokens).toBe(8192);
    expect(out.observability.level).toBe("debug");
  });

  test("whole-array replace swaps the entire tools / rules array", () => {
    const changes: SpecChange[] = [
      { path: ["tools"], value: ["Read", "Grep", "Bash"] },
      { path: ["permissions", "rules"], value: [{ type: "alwaysDeny", pattern: "Bash(*)" }] },
    ];
    const { yaml, patches } = applySpecChanges(BASE, "cli", changes, fakeTooling);
    expect(patches.every((p) => p.op === "replace")).toBe(true);
    const out = parse(yaml) as { tools: string[]; permissions: { rules: unknown[] } };
    expect(out.tools).toEqual(["Read", "Grep", "Bash"]);
    expect(out.permissions.rules).toEqual([{ type: "alwaysDeny", pattern: "Bash(*)" }]);
  });

  test("a later change sees a path added by an earlier one (threaded)", () => {
    const changes: SpecChange[] = [
      { path: ["memory", "backend"], value: "thredz" }, // add (block + key absent)
      { path: ["memory", "backend"], value: "file" }, // replace — sees the just-added path
    ];
    const { yaml, patches } = applySpecChanges(BASE, "cli", changes, fakeTooling);
    expect(patches[0].op).toBe("add");
    expect(patches[1].op).toBe("replace");
    expect((parse(yaml) as { memory: Obj }).memory.backend).toBe("file");
  });

  test("parseSpec REJECTS a bad edit → the batch throws and nothing is written", () => {
    expect(() =>
      applySpecChanges(BASE, "cli", [{ path: ["agent", "max_tokens"], value: 0 }], fakeTooling),
    ).toThrow(/max_tokens/);
    expect(() =>
      applySpecChanges(BASE, "cli", [{ path: ["permissions", "mode"], value: "bypass" }], fakeTooling),
    ).toThrow(/bypass/);
    // The input YAML is untouched (the caller only writes on success).
    expect(() => validate(parse(BASE))).not.toThrow();
  });

  test("a mid-batch rejection aborts before the caller can write", () => {
    const changes: SpecChange[] = [
      { path: ["agent", "model"], value: "sonnet" }, // ok
      { path: ["agent", "max_tokens"], value: -1 }, // rejected
    ];
    expect(() => applySpecChanges(BASE, "cli", changes, fakeTooling)).toThrow();
  });
});

// ── resolveEnvPath (configurable target + traversal guard) ───────────────────

describe("resolveEnvPath", () => {
  const root = "/tmp/harness-root";

  test("defaults to <harnessRoot>/.env", () => {
    expect(resolveEnvPath(root)).toBe(join(root, ".env"));
    expect(resolveEnvPath(root, "")).toBe(join(root, ".env"));
  });

  test("honours an explicit absolute path (user-owned, may be outside the repo)", () => {
    expect(resolveEnvPath(root, "/etc/shared/secrets.env")).toBe("/etc/shared/secrets.env");
  });

  test("resolves a relative path under the root", () => {
    expect(resolveEnvPath(root, "config/.env")).toBe(join(root, "config", ".env"));
    expect(resolveEnvPath(root, ".env")).toBe(join(root, ".env"));
  });

  test("REFUSES a relative path that escapes the root, or a NUL byte", () => {
    expect(resolveEnvPath(root, "../evil.env")).toBeNull();
    expect(resolveEnvPath(root, "a/../../evil.env")).toBeNull();
    expect(resolveEnvPath(root, "a\0b")).toBeNull();
  });
});

// ── upsertEnvVar (preserve other lines; quote when needed) ───────────────────

describe("upsertEnvVar", () => {
  test("appends to an empty file with a trailing newline", () => {
    expect(upsertEnvVar("", "TOKEN", "abc123")).toBe("TOKEN=abc123\n");
  });

  test("replaces an existing key in place, preserving comments + other vars", () => {
    const before = "# creds\nOPENAI_API_KEY=old\nOTHER=keep\n";
    const after = upsertEnvVar(before, "OPENAI_API_KEY", "new-value");
    expect(after).toContain("# creds");
    expect(after).toContain("OTHER=keep");
    expect(after).toContain("OPENAI_API_KEY=new-value");
    expect(after).not.toContain("OPENAI_API_KEY=old");
  });

  test("replaces an `export KEY=` line too", () => {
    expect(upsertEnvVar("export TOKEN=old\n", "TOKEN", "fresh")).toBe("TOKEN=fresh\n");
  });

  test("quotes a value that needs it", () => {
    expect(upsertEnvVar("", "K", "a b c")).toBe('K="a b c"\n');
  });
});

// ── envRefPresence (names only — never a value) ──────────────────────────────

describe("envRefPresence", () => {
  test("reports set/unset for each $VAR the spec references, by NAME only", () => {
    const yaml = "mcp_servers:\n  s:\n    env:\n      OPENAI_API_KEY: $OPENAI_API_KEY\n      SLACK: $SLACK_TOKEN\n";
    const refs = envRefPresence(yaml, { OPENAI_API_KEY: "sk-real" });
    expect(refs).toEqual({ OPENAI_API_KEY: true, SLACK_TOKEN: false });
    // The presence map carries only booleans — no secret value anywhere.
    expect(JSON.stringify(refs)).not.toContain("sk-real");
  });
});

// ── selectLaunch (Path B when spec + CLI, else Path A; resume argv) ───────────

const SID = "sess_0123456789abcdef";

describe("selectLaunch", () => {
  test("Path B (interpreter) when a spec AND a crewhaus CLI are present", () => {
    const plan = selectLaunch({
      specPath: "/h/crewhaus.yaml",
      crewhausBin: "/usr/local/bin/crewhaus",
      entryPath: "/h/agent.ts",
    });
    expect(plan.mode).toBe("interpreter");
    expect(plan.argv).toEqual(["/usr/local/bin/crewhaus", "run", "/h/crewhaus.yaml"]);
  });

  test("threads the latched sessionId into --resume", () => {
    const plan = selectLaunch({
      specPath: "/h/crewhaus.yaml",
      crewhausBin: "/bin/crewhaus",
      entryPath: "/h/agent.ts",
      sessionId: SID,
      resume: true,
    });
    expect(plan.mode).toBe("interpreter");
    expect(plan.argv).toEqual(["/bin/crewhaus", "run", "/h/crewhaus.yaml", "--resume", SID]);
  });

  test("does not add --resume for an invalid/absent sessionId", () => {
    const noSid = selectLaunch({
      specPath: "/h/crewhaus.yaml",
      crewhausBin: "/bin/crewhaus",
      entryPath: "/h/agent.ts",
      resume: true,
    });
    expect(noSid.argv).not.toContain("--resume");
    const badSid = selectLaunch({
      specPath: "/h/crewhaus.yaml",
      crewhausBin: "/bin/crewhaus",
      entryPath: "/h/agent.ts",
      sessionId: "not-a-session",
      resume: true,
    });
    expect(badSid.argv).not.toContain("--resume");
  });

  test("Path A (compiled) when there is no spec, or no CLI", () => {
    expect(
      selectLaunch({ specPath: null, crewhausBin: "/bin/crewhaus", entryPath: "/h/agent.ts" }),
    ).toEqual({ mode: "compiled", argv: ["bun", "/h/agent.ts"] });
    expect(
      selectLaunch({ specPath: "/h/crewhaus.yaml", crewhausBin: null, entryPath: "/h/agent.ts" }),
    ).toEqual({ mode: "compiled", argv: ["bun", "/h/agent.ts"] });
  });

  test("prefer overrides: 'compiled' forces Path A; 'interpreter' still needs the CLI", () => {
    const forcedA = selectLaunch({
      specPath: "/h/crewhaus.yaml",
      crewhausBin: "/bin/crewhaus",
      entryPath: "/h/agent.ts",
      prefer: "compiled",
    });
    expect(forcedA.mode).toBe("compiled");
    const wantB = selectLaunch({
      specPath: "/h/crewhaus.yaml",
      crewhausBin: null,
      entryPath: "/h/agent.ts",
      prefer: "interpreter",
    });
    expect(wantB.mode).toBe("compiled"); // no CLI → falls back to A
  });
});

// ── resolveCrewhausBin (local .bin wins over global) ─────────────────────────

const TMP_ROOT = join(import.meta.dir, `.tmp-settings-${process.pid}`);
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

describe("resolveCrewhausBin", () => {
  test("prefers the harness's own node_modules/.bin/crewhaus", () => {
    const root = join(TMP_ROOT, "with-bin");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    const bin = join(root, "node_modules", ".bin", "crewhaus");
    writeFileSync(bin, "#!/bin/sh\n");
    expect(resolveCrewhausBin(root)).toBe(bin);
  });
});

// ── Secret writer (never echoes the value; writes 0600; sets the $ref) ────────

const SECRET_CONFIG = {
  shape: "cli",
  title: "test",
  tagline: "",
  runClass: "stdio-interactive",
  entry: ["agent.ts"],
  input: "interactive",
} as const;

describe("secret_set writer", () => {
  test("writes KEY=value to <harnessRoot>/.env (0600) and never echoes the value", async () => {
    const root = join(TMP_ROOT, "secret");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "crewhaus.yaml"), "target: cli\nname: demo\n");

    const msgs: Record<string, unknown>[] = [];
    const sup = new Supervisor(root, SECRET_CONFIG as never, (m) => msgs.push(m as Record<string, unknown>));
    await sup.handle({ type: "secret_set", key: "MY_TOKEN", value: "s3cr3t-value" } as never);

    const envPath = join(root, ".env");
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf8")).toContain("MY_TOKEN=s3cr3t-value");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    const res = msgs.find((m) => m.type === "secret_set_result");
    expect(res).toBeDefined();
    expect(res?.ok).toBe(true);
    expect(res?.key).toBe("MY_TOKEN");
    expect("value" in (res as object)).toBe(false); // the value is NEVER broadcast
    expect(JSON.stringify(msgs)).not.toContain("s3cr3t-value");
  });

  test("rejects a traversal env path and writes nothing outside the root", async () => {
    const root = join(TMP_ROOT, "secret-traversal");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "crewhaus.yaml"), "target: cli\n");

    const msgs: Record<string, unknown>[] = [];
    const sup = new Supervisor(root, SECRET_CONFIG as never, (m) => msgs.push(m as Record<string, unknown>));
    await sup.handle({ type: "secret_set", key: "K", value: "v", path: "../escaped.env" } as never);

    const res = msgs.find((m) => m.type === "secret_set_result");
    expect(res?.ok).toBe(false);
    expect(String(res?.error)).toMatch(/traversal|denied/i);
    expect(existsSync(join(root, "..", "escaped.env"))).toBe(false);
  });

  test("rejects an invalid env key", async () => {
    const root = join(TMP_ROOT, "secret-badkey");
    mkdirSync(root, { recursive: true });
    const msgs: Record<string, unknown>[] = [];
    const sup = new Supervisor(root, SECRET_CONFIG as never, (m) => msgs.push(m as Record<string, unknown>));
    await sup.handle({ type: "secret_set", key: "bad-key!", value: "v" } as never);
    const res = msgs.find((m) => m.type === "secret_set_result");
    expect(res?.ok).toBe(false);
  });
});

// ── ENV_KEY_RE (the $VAR charset the compiler accepts) ───────────────────────

describe("ENV_KEY_RE", () => {
  test("accepts upper-snake env keys, rejects the rest", () => {
    expect(ENV_KEY_RE.test("OPENAI_API_KEY")).toBe(true);
    expect(ENV_KEY_RE.test("_X1")).toBe(true);
    expect(ENV_KEY_RE.test("lower")).toBe(false);
    expect(ENV_KEY_RE.test("HAS-DASH")).toBe(false);
    expect(ENV_KEY_RE.test("1LEAD")).toBe(false);
  });
});

// ── findSpecPath ─────────────────────────────────────────────────────────────

describe("findSpecPath", () => {
  test("locates crewhaus.yaml at the harness root, else null", () => {
    const withSpec = join(TMP_ROOT, "hasspec");
    mkdirSync(withSpec, { recursive: true });
    writeFileSync(join(withSpec, "crewhaus.yaml"), "target: cli\n");
    expect(findSpecPath(withSpec)).toBe(join(withSpec, "crewhaus.yaml"));

    const none = join(TMP_ROOT, "nospec");
    mkdirSync(none, { recursive: true });
    expect(findSpecPath(none)).toBeNull();
  });
});
