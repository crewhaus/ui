/**
 * DOM-less unit tests for the Phase-3c memory views (_shared/views.js): the
 * pure PARSERS + derivations behind the focus / plan / context / wiki / skills
 * panels. These mirror the EXACT factory v0.3.0 file grammars (verified against
 * tag v0.3.0 / a609f23: continuity-store index.ts + handoff.ts), so the browser
 * can parse the RAW `.crewhaus/` files the host serves without importing
 * @crewhaus/*.
 *
 * Like views.test.ts / panels.test.ts, views.js is a browser IIFE that attaches
 * its pure helpers to window.CH.views (and registers views on CH.panels). We
 * load panels.js then views.js against a globalThis-backed window. The
 * DOM-touching parts (mount/render/fetch) run in the app, not here.
 *
 * The claimed↔proven distinction — the whole point of the proof ladder — is
 * pinned at the parse layer (a claimed step is a free, UNVERIFIED claim with no
 * proofs; a proven step carries its machine-verified evidence toolUseId) and at
 * the presentation layer (statusMeta).
 */
import { beforeAll, describe, expect, test } from "bun:test";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;
type Views = {
  parseFocus: (raw: string) => Rec;
  summarizeRequirements: (reqs: Rec[]) => Rec;
  parsePlan: (raw: string) => Rec;
  parseGoals: (raw: string) => Rec[];
  statusMeta: (s: string) => Rec;
  parseHandoffNextActions: (raw: string) => string[];
  parseWikiIndex: (json: unknown) => Rec[];
  filterWiki: (list: Rec[], q: string) => Rec[];
  sortWiki: (list: Rec[]) => Rec[];
  stripFrontmatter: (md: string) => string;
  parseJsonl: (text: string) => Rec[];
  sessionEvictions: (records: Rec[]) => Rec[];
  aggregateSkills: (records: Rec[]) => Rec[];
  countSkillCalls: (events: Rec[]) => number;
  accumulateContext: (events: Rec[]) => Rec;
  collectCompactions: (events: Rec[]) => Rec[];
  normalizePlanId: (id: string) => string;
  NOMINAL_CONTEXT_WINDOW: number;
};
type Panels = { VIEW_FEATURES: Record<string, string[]> };

let V: Views;
let panels: Panels;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { CH: Record<string, unknown> }).CH =
    (globalThis as unknown as { CH?: Record<string, unknown> }).CH || {};
  await import("../_shared/panels.js");
  await import("../_shared/views.js");
  const CH = (globalThis as unknown as { CH: { views: Views; panels: Panels } }).CH;
  V = CH.views;
  panels = CH.panels;
});

// ── focus.md ────────────────────────────────────────────────────────────────
const FOCUS = [
  "<!-- crewhaus:focus -->",
  "# Focus",
  "",
  "Refactor the memory panel views and keep tests green.",
  "",
  "## Active plan",
  "<!-- crewhaus:active-plan -->",
  "plan-0002",
  "",
  "## Requirements",
  "<!-- crewhaus:requirements -->",
  '- REQ-001 [open] "Keep the claimed vs proven distinction visible" (user, sess_0123456789abcdef, turn 2)',
  '- REQ-002 [confirmed] "No innerHTML anywhere" (user, sess_0123456789abcdef, turn 4)',
  '- REQ-003 [dropped] "Also ship a diff viewer" (user, sess_0123456789abcdef, turn 5)',
  '- REQ-004 [open] "She said \\"hi\\" to me" (user, sess_0123456789abcdef, turn 6)',
  "",
].join("\n");

describe("parseFocus — mirror factory parseFocusFile", () => {
  test("extracts body, active plan, and the verbatim REQ ledger", () => {
    const f = V.parseFocus(FOCUS);
    expect(f.present).toBe(true);
    expect(f.body).toBe("Refactor the memory panel views and keep tests green.");
    expect(f.activePlan).toBe("plan-0002");
    expect(f.requirements).toHaveLength(4);
    const r0 = f.requirements[0];
    expect(r0.id).toBe("REQ-001");
    expect(r0.status).toBe("open");
    expect(r0.text).toBe("Keep the claimed vs proven distinction visible");
    expect(r0.sessionId).toBe("sess_0123456789abcdef");
    expect(r0.turn).toBe(2);
  });

  test("JSON-decodes the verbatim text (embedded escaped quotes survive)", () => {
    const f = V.parseFocus(FOCUS);
    expect(f.requirements[3].text).toBe('She said "hi" to me');
  });

  test("_none_ active plan → null; a ledger-truncated marker is flagged", () => {
    const raw = FOCUS.replace("plan-0002", "_none_").replace(
      "<!-- crewhaus:requirements -->",
      "<!-- crewhaus:requirements -->\n[ledger truncated]",
    );
    const f = V.parseFocus(raw);
    expect(f.activePlan).toBeNull();
    expect(f.ledgerTruncated).toBe(true);
  });

  test("a file without the focus marker is not ours (present:false)", () => {
    const f = V.parseFocus("# My own notes\nnot a crewhaus file");
    expect(f.present).toBe(false);
    expect(f.requirements).toEqual([]);
  });

  test("summarizeRequirements counts by status", () => {
    const f = V.parseFocus(FOCUS);
    const s = V.summarizeRequirements(f.requirements);
    expect(s).toEqual({ open: 2, confirmed: 1, dropped: 1, total: 4 });
  });
});

// ── plan-NNNN.md ──────────────────────────────────────────────────────────
const PLAN = [
  "---",
  "id: plan-0002",
  "slug: ship-it",
  'title: "Ship: the thing"',
  "createdAt: 2026-07-14T10:00:00.000Z",
  "updatedAt: 2026-07-14T12:00:00.000Z",
  "proofs:",
  '  "3":',
  "    - toolUseId: toolu_abc123",
  "      sessionId: sess_0123456789abcdef",
  "      toolName: Bash",
  "      inputHash: h1",
  "      resultDigest: d1",
  "      verifiedAt: 2026-07-14T11:00:00.000Z",
  "---",
  "",
  "# Ship: the thing",
  "",
  "## Steps",
  "",
  "1. [open] Write the code",
  "2. [in_progress] Test it",
  "3. [proven] Ship it",
  "4. [claimed] Celebrate",
  "",
].join("\n");

describe("parsePlan — mirror factory parsePlanFile", () => {
  test("reads frontmatter scalars (quoted title with a colon is decoded)", () => {
    const p = V.parsePlan(PLAN);
    expect(p.frontmatter.id).toBe("plan-0002");
    expect(p.frontmatter.slug).toBe("ship-it");
    expect(p.frontmatter.title).toBe("Ship: the thing");
    expect(p.frontmatter.createdAt).toBe("2026-07-14T10:00:00.000Z");
  });

  test("steps are numbered by position with their ladder status + text", () => {
    const p = V.parsePlan(PLAN);
    expect(p.steps.map((s: Rec) => [s.n, s.status])).toEqual([
      [1, "open"],
      [2, "in_progress"],
      [3, "proven"],
      [4, "claimed"],
    ]);
    expect(p.steps[0].text).toBe("Write the code");
  });

  test("claimed ≠ proven: proven carries its evidence toolUseId; claimed has none", () => {
    const p = V.parsePlan(PLAN);
    const proven = p.steps[2];
    const claimed = p.steps[3];
    expect(proven.status).toBe("proven");
    expect(proven.proofs).toEqual(["toolu_abc123"]); // machine-verified evidence
    expect(claimed.status).toBe("claimed");
    expect(claimed.proofs).toEqual([]); // a free, UNVERIFIED claim
  });

  test("a plan with no frontmatter still yields its steps", () => {
    const p = V.parsePlan("## Steps\n\n1. [open] Do a thing\n");
    expect(p.frontmatter.id).toBe("");
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].status).toBe("open");
  });
});

describe("statusMeta — pin the claimed↔proven presentation", () => {
  test("proven is verified/green, claimed is unverified/amber, distinct classes", () => {
    const proven = V.statusMeta("proven");
    const claimed = V.statusMeta("claimed");
    expect(proven.verified).toBe(true);
    expect(proven.note).toBe("verified");
    expect(claimed.verified).toBe(false);
    expect(claimed.note).toBe("unverified");
    expect(proven.cls).not.toBe(claimed.cls);
    expect(proven.cls).toBe("st-proven");
    expect(claimed.cls).toBe("st-claimed");
  });

  test("in_progress / open / confirmed / dropped map to their own classes", () => {
    expect(V.statusMeta("in_progress").cls).toBe("st-in-progress");
    expect(V.statusMeta("open").cls).toBe("st-open");
    expect(V.statusMeta("confirmed").cls).toBe("st-confirmed");
    expect(V.statusMeta("dropped").cls).toBe("st-dropped");
  });
});

// ── goals.yaml ──────────────────────────────────────────────────────────────
const GOALS = [
  "version: 1",
  "goals:",
  "  - id: goal-0001",
  "    title: Merge 10 PRs",
  "    status: in_progress",
  "    target: 10",
  "    current: 3",
  "    unit: PRs",
  "    createdAt: 2026-07-14T10:00:00.000Z",
  "    updatedAt: 2026-07-14T12:00:00.000Z",
  "  - id: goal-0002",
  "    title: No target here",
  "    status: open",
  "",
].join("\n");

describe("parseGoals — mirror the goals.yaml shape", () => {
  test("returns well-shaped goals with numeric target/current", () => {
    const goals = V.parseGoals(GOALS);
    expect(goals).toHaveLength(2);
    expect(goals[0].id).toBe("goal-0001");
    expect(goals[0].title).toBe("Merge 10 PRs");
    expect(goals[0].status).toBe("in_progress");
    expect(goals[0].target).toBe(10);
    expect(goals[0].current).toBe(3);
    expect(goals[0].unit).toBe("PRs");
    expect(goals[1].id).toBe("goal-0002");
    expect(goals[1].target).toBeUndefined();
  });

  test("malformed / empty input yields no goals", () => {
    expect(V.parseGoals("")).toEqual([]);
    expect(V.parseGoals("version: 1\n")).toEqual([]);
    expect(V.parseGoals("not yaml at all")).toEqual([]);
  });
});

// ── handoff.md ── Next actions ──────────────────────────────────────────────
describe("parseHandoffNextActions — the derived next-actions list", () => {
  const HANDOFF = [
    "<!-- crewhaus:handoff -->",
    "# Handoff",
    "",
    "## Next actions",
    "",
    "- Verify or redo: Test it (plan-0002 step 2 is claimed but unproven)",
    "- Do: Ship it (plan-0002 step 3)",
    "",
    "## Last session",
    "",
    "sess_0123456789abcdef",
  ].join("\n");
  test("extracts the list items under the Next actions heading only", () => {
    expect(V.parseHandoffNextActions(HANDOFF)).toEqual([
      "Verify or redo: Test it (plan-0002 step 2 is claimed but unproven)",
      "Do: Ship it (plan-0002 step 3)",
    ]);
  });
  test("missing section or _none_ → []", () => {
    expect(V.parseHandoffNextActions("# Handoff\nno actions section")).toEqual([]);
    expect(V.parseHandoffNextActions("## Next actions\n\n- _none_\n")).toEqual([]);
  });
});

// ── wiki index.json ─────────────────────────────────────────────────────────
const WIKI = JSON.stringify([
  {
    slug: "caching",
    title: "Caching strategy",
    tags: ["perf", "cache"],
    confidence: 0.82,
    verified: true,
    version: 3,
    updatedAt: "2026-07-14T10:00:00.000Z",
    status: "published",
  },
  {
    slug: "auth",
    title: "Auth flow",
    tags: ["security"],
    confidence: 0.4,
    verified: false,
    version: 1,
    updatedAt: "2026-07-13T10:00:00.000Z",
    status: "draft",
  },
  { notASlug: true }, // dropped
]);

describe("parseWikiIndex / filterWiki / sortWiki", () => {
  test("normalizes valid entries and drops shapeless ones", () => {
    const list = V.parseWikiIndex(WIKI);
    expect(list).toHaveLength(2);
    expect(list[0].slug).toBe("caching");
    expect(list[0].verified).toBe(true);
    expect(list[0].version).toBe(3);
  });
  test("accepts a raw JSON string or a parsed array; junk → []", () => {
    expect(V.parseWikiIndex(JSON.parse(WIKI))).toHaveLength(2);
    expect(V.parseWikiIndex("not json")).toEqual([]);
    expect(V.parseWikiIndex({} as unknown)).toEqual([]);
  });
  test("filter matches slug, title, or tag (case-insensitive)", () => {
    const list = V.parseWikiIndex(WIKI);
    expect(V.filterWiki(list, "auth").map((r) => r.slug)).toEqual(["auth"]);
    expect(V.filterWiki(list, "PERF").map((r) => r.slug)).toEqual(["caching"]);
    expect(V.filterWiki(list, "")).toHaveLength(2);
  });
  test("sort is most-recently-updated first", () => {
    const sorted = V.sortWiki(V.parseWikiIndex(WIKI));
    expect(sorted.map((r) => r.slug)).toEqual(["caching", "auth"]);
  });
  test("stripFrontmatter removes a leading YAML block", () => {
    expect(V.stripFrontmatter("---\nslug: x\n---\n# Body\n")).toBe("# Body\n");
    expect(V.stripFrontmatter("# No frontmatter")).toBe("# No frontmatter");
  });
});

// ── session .jsonl derivations (context + skills) ───────────────────────────
const JSONL = [
  '{"ts":1,"version":1,"kind":"context_evicted","payload":{"role":"user","text":"my long message","turnNumber":2}}',
  '{"ts":2,"version":1,"kind":"tool_use","payload":{"id":"t1","name":"Skill","input":{"name":"continuity"}}}',
  '{"ts":3,"version":1,"kind":"tool_use","payload":{"id":"t2","name":"Skill","input":{"name":"continuity"}}}',
  '{"ts":4,"version":1,"kind":"tool_use","payload":{"id":"t3","name":"Skill","input":{"name":"dream"}}}',
  '{"ts":5,"version":1,"kind":"tool_use","payload":{"id":"t4","name":"Bash","input":{"cmd":"ls"}}}',
  "this line is not json and must be skipped",
  '{"ts":6,"version":1,"kind":"context_evicted","payload":{"role":"assistant","text":"a reply"}}',
].join("\n");

describe("session-JSONL derivations", () => {
  test("parseJsonl skips blank / malformed lines", () => {
    expect(V.parseJsonl(JSONL)).toHaveLength(6);
    expect(V.parseJsonl("")).toEqual([]);
  });
  test("sessionEvictions reads context_evicted (verbatim text, optional turn)", () => {
    const ev = V.sessionEvictions(V.parseJsonl(JSONL));
    expect(ev).toHaveLength(2);
    expect(ev[0]).toEqual({ role: "user", text: "my long message", turnNumber: 2 });
    expect(ev[1]).toEqual({ role: "assistant", text: "a reply", turnNumber: null });
  });
  test("aggregateSkills names skills from the tool_use input (desc by count)", () => {
    const skills = V.aggregateSkills(V.parseJsonl(JSONL));
    expect(skills).toEqual([
      { name: "continuity", count: 2 },
      { name: "dream", count: 1 },
    ]);
  });
});

// ── live-event derivations (context meter + skills count + compaction) ──────
describe("live-event derivations", () => {
  const EVENTS: Rec[] = [
    { kind: "model_response", usage: { input: 1000, output: 200, cacheRead: 500 } },
    { kind: "tool_call_start", toolName: "Skill" },
    { kind: "model_response", usage: { input: 3000, output: 400 } },
    { kind: "tool_call_start", toolName: "Read" },
    { kind: "model_response", usage: { input: 2000, output: 100, cacheRead: 800 } },
    { kind: "compaction_fired", subKind: "autocompact", before: 40, after: 12, phase: "reactive" },
  ];

  test("accumulateContext sums the cumulative input, tracks last/peak/turns", () => {
    const acc = V.accumulateContext(EVENTS);
    expect(acc.cumulativeInput).toBe(6000); // 1000 + 3000 + 2000
    expect(acc.cumulativeOutput).toBe(700);
    expect(acc.lastInput).toBe(2000);
    expect(acc.peakInput).toBe(3000);
    expect(acc.turns).toBe(3);
    expect(acc.lastCacheRead).toBe(800);
  });
  test("countSkillCalls counts Skill tool_call_start events (no names, live)", () => {
    expect(V.countSkillCalls(EVENTS)).toBe(1);
  });
  test("collectCompactions reads compaction_fired message counts + phase", () => {
    expect(V.collectCompactions(EVENTS)).toEqual([
      { subKind: "autocompact", before: 40, after: 12, phase: "reactive" },
    ]);
  });
  test("the nominal window is a documented estimate constant", () => {
    expect(V.NOMINAL_CONTEXT_WINDOW).toBe(200000);
  });
});

// ── plan-id normalization + feature gating ──────────────────────────────────
describe("normalizePlanId + VIEW_FEATURES", () => {
  test("a plan-NNNN-slug link id normalizes to its plan-NNNN prefix", () => {
    expect(V.normalizePlanId("plan-0002-ship-it")).toBe("plan-0002");
    expect(V.normalizePlanId("plan-0002")).toBe("plan-0002");
  });
  test("the memory views gate on their expected features[] keys", () => {
    expect(panels.VIEW_FEATURES.focus).toContain("focus");
    expect(panels.VIEW_FEATURES.plan).toEqual(expect.arrayContaining(["plan", "roles", "branches", "nodes"]));
    expect(panels.VIEW_FEATURES.context).toEqual(expect.arrayContaining(["context", "cost"]));
    expect(panels.VIEW_FEATURES.wiki).toEqual(expect.arrayContaining(["wiki", "citations"]));
    expect(panels.VIEW_FEATURES.skills).toContain("skills");
  });
});
