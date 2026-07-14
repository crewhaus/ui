/**
 * DOM-less unit tests for the Phase-3b live views (_shared/views.js): the pure
 * logic behind each view — tool/MCP pairing by toolUseId, sub-agent pairing by
 * childRunId, the harness file-tree builder, artifact derivation from a file
 * list, the path→read-route resolver, and the chat-link matchers (file paths +
 * sub-agent names).
 *
 * views.js is a classic browser IIFE that registers views on CH.panels and
 * attaches its pure helpers to window.CH.views. It requires panels.js to have
 * loaded first (it registers against CH.panels), so we import panels.js then
 * views.js against a globalThis-backed window, exactly like panels.test.ts.
 * The DOM-touching parts (mount/render/fetch) run in the app, not here.
 */
import { beforeAll, describe, expect, test } from "bun:test";

type Rec = Record<string, unknown>;
type Views = {
  pairTools: (events: Rec[]) => Rec[];
  pairSubAgents: (events: Rec[]) => Rec[];
  buildFileTree: (paths: string[]) => Rec[];
  deriveArtifacts: (files: string[]) => Rec[];
  resolvePathRoute: (path: string) => { route: string; subpath: string; url: string };
  matchTaskNames: (text: string, names: Iterable<string>) => Rec[];
  toolKey: (ev: Rec) => string;
  EXTRA_FILE_RE: RegExp;
};
type Panels = {
  scanLinks: (text: string, ms?: unknown[]) => Rec[];
  VIEW_FEATURES: Record<string, string[]>;
};

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

// ── Tool / MCP pairing ─────────────────────────────────────────────────────
describe("pairTools — correlate tool/MCP start+end", () => {
  test("pairs a tool call by toolUseId (running → ok)", () => {
    const running = V.pairTools([{ kind: "tool_call_start", toolUseId: "u1", toolName: "Read", inputBytes: 40 }]);
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("running");
    expect(running[0].name).toBe("Read");
    expect(running[0].inputBytes).toBe(40);

    const done = V.pairTools([
      { kind: "tool_call_start", toolUseId: "u1", toolName: "Read", inputBytes: 40 },
      { kind: "tool_call_end", toolUseId: "u1", toolName: "Read", isError: false, outputBytes: 900, durationMs: 12 },
    ]);
    expect(done).toHaveLength(1);
    expect(done[0].status).toBe("ok");
    expect(done[0].outputBytes).toBe(900);
    expect(done[0].durationMs).toBe(12);
  });

  test("an errored end sets status error", () => {
    const recs = V.pairTools([
      { kind: "tool_call_start", toolUseId: "u2", toolName: "Bash", inputBytes: 10 },
      { kind: "tool_call_end", toolUseId: "u2", toolName: "Bash", isError: true, outputBytes: 3, durationMs: 5 },
    ]);
    expect(recs[0].status).toBe("error");
  });

  test("two concurrent calls to the same tool stay distinct (different toolUseId)", () => {
    const recs = V.pairTools([
      { kind: "tool_call_start", toolUseId: "a", toolName: "Read", inputBytes: 1 },
      { kind: "tool_call_start", toolUseId: "b", toolName: "Read", inputBytes: 1 },
      { kind: "tool_call_end", toolUseId: "a", toolName: "Read", isError: false, outputBytes: 2, durationMs: 1 },
    ]);
    expect(recs).toHaveLength(2);
    expect(recs.filter((r) => r.status === "running")).toHaveLength(1);
    expect(recs.filter((r) => r.status === "ok")).toHaveLength(1);
  });

  test("MCP calls pair by spanId and carry a server.tool name", () => {
    const recs = V.pairTools([
      { kind: "mcp_call_start", server: "thredz", toolName: "search", spanId: "s1" },
      { kind: "mcp_call_end", server: "thredz", toolName: "search", spanId: "s1", isError: false, durationMs: 22 },
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe("mcp");
    expect(recs[0].name).toBe("thredz.search");
    expect(recs[0].status).toBe("ok");
    expect(recs[0].durationMs).toBe(22);
  });

  test("MCP without a spanId falls back to server.toolName (LIFO match)", () => {
    const recs = V.pairTools([
      { kind: "mcp_call_start", server: "gh", toolName: "list" },
      { kind: "mcp_call_end", server: "gh", toolName: "list", isError: false, durationMs: 7 },
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe("ok");
    expect(V.toolKey({ kind: "mcp_call_start", server: "gh", toolName: "list" })).toBe("m:gh.list");
  });

  test("an end with no matching start synthesizes a completed record", () => {
    const recs = V.pairTools([
      { kind: "tool_call_end", toolUseId: "orphan", toolName: "Grep", isError: false, outputBytes: 5, durationMs: 2 },
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe("ok");
    expect(recs[0].name).toBe("Grep");
  });
});

// ── Sub-agent pairing ──────────────────────────────────────────────────────
describe("pairSubAgents — correlate sub_agent start+end by childRunId", () => {
  test("running then finished carries counts + session id", () => {
    const recs = V.pairSubAgents([
      { kind: "sub_agent_start", name: "researcher", childRunId: "r1", childSessionId: "sess_0000000000000001", toolCount: 5, promptBytes: 100 },
      { kind: "sub_agent_end", name: "researcher", childRunId: "r1", childSessionId: "sess_0000000000000001", isError: false, toolCallCount: 9, finalMessageBytes: 4000, durationMs: 8000 },
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe("ok");
    expect(recs[0].toolCallCount).toBe(9);
    expect(recs[0].childSessionId).toBe("sess_0000000000000001");
  });

  test("a start with no end is still running; an errored end is error", () => {
    expect(V.pairSubAgents([{ kind: "sub_agent_start", name: "w", childRunId: "x" }])[0].status).toBe("running");
    const err = V.pairSubAgents([
      { kind: "sub_agent_start", name: "w", childRunId: "y" },
      { kind: "sub_agent_end", name: "w", childRunId: "y", isError: true, toolCallCount: 0, finalMessageBytes: 0, durationMs: 1 },
    ]);
    expect(err[0].status).toBe("error");
  });
});

// ── File tree ──────────────────────────────────────────────────────────────
describe("buildFileTree — nest a flat path list", () => {
  test("nests paths and sorts dirs before files", () => {
    const tree = V.buildFileTree(["src/app.ts", "src/lib/util.ts", "README.md"]) as Array<{
      name: string;
      dir: boolean;
      path: string;
      children: Array<{ name: string; dir: boolean }>;
    }>;
    expect(tree.map((n) => n.name)).toEqual(["src", "README.md"]); // dir first
    const src = tree[0];
    expect(src.dir).toBe(true);
    expect(src.path).toBe("src");
    // inside src: the lib/ dir sorts before app.ts
    expect(src.children.map((c) => c.name)).toEqual(["lib", "app.ts"]);
    expect(src.children[0].dir).toBe(true);
  });

  test("does not leak the internal build map", () => {
    const tree = V.buildFileTree(["a/b.ts"]) as Array<Record<string, unknown>>;
    expect(tree[0]).not.toHaveProperty("_map");
    expect((tree[0].children as Array<Record<string, unknown>>)[0]).not.toHaveProperty("_map");
  });

  test("empty / missing input yields an empty tree", () => {
    expect(V.buildFileTree([])).toEqual([]);
    expect(V.buildFileTree(undefined as unknown as string[])).toEqual([]);
  });
});

// ── Artifact derivation ────────────────────────────────────────────────────
describe("deriveArtifacts — recognize output artifacts in a harness file list", () => {
  const files = [
    "out/grades.json",
    "out/transcript.jsonl",
    "report.md",
    "screenshots/shot-1.png",
    "results/results.json",
    "src/agent.ts", // bundle source — not an artifact
    "package.json", // config json — not an artifact (basename not allowlisted)
    "node_modules/pkg/report.md", // excluded dir
    "dist/report.md", // excluded dir
  ];

  test("classifies eval outputs, reports, images and out-dir files; excludes bundle/deps", () => {
    const arts = V.deriveArtifacts(files) as Array<{ path: string; kind: string; label: string }>;
    const byPath: Record<string, { kind: string; label: string }> = {};
    for (const a of arts) byPath[a.path] = a;
    expect(byPath["out/grades.json"].kind).toBe("eval");
    expect(byPath["out/transcript.jsonl"].kind).toBe("eval");
    expect(byPath["results/results.json"].kind).toBe("eval");
    expect(byPath["report.md"].kind).toBe("report");
    expect(byPath["screenshots/shot-1.png"].kind).toBe("image");
    expect(byPath["src/agent.ts"]).toBeUndefined();
    expect(byPath["package.json"]).toBeUndefined();
    expect(byPath["node_modules/pkg/report.md"]).toBeUndefined();
    expect(byPath["dist/report.md"]).toBeUndefined();
  });

  test("each artifact carries a basename label and its dir", () => {
    const grades = (V.deriveArtifacts(["eval/out/grades.json"]) as Array<{ label: string; dir: string }>)[0];
    expect(grades.label).toBe("grades.json");
    expect(grades.dir).toBe("eval/out");
  });

  test("missing input yields no artifacts", () => {
    expect(V.deriveArtifacts(undefined as unknown as string[])).toEqual([]);
  });
});

// ── Path → route ───────────────────────────────────────────────────────────
describe("resolvePathRoute — map a mentioned path to its read route", () => {
  test(".crewhaus/ paths route to the memory read route", () => {
    const r = V.resolvePathRoute(".crewhaus/state/demo/focus.md");
    expect(r.route).toBe("crewhaus");
    expect(r.url).toBe("/crewhaus/state/demo/focus.md");
    expect(V.resolvePathRoute("crewhaus/wiki/x.md").route).toBe("crewhaus");
  });

  test("other paths route to the harness static route (harness/ prefix stripped)", () => {
    expect(V.resolvePathRoute("src/app.ts").url).toBe("/harness/src/app.ts");
    expect(V.resolvePathRoute("harness/out/grades.json").url).toBe("/harness/out/grades.json");
    expect(V.resolvePathRoute("./report.md").url).toBe("/harness/report.md");
  });
});

// ── Chat-link matchers ─────────────────────────────────────────────────────
describe("matchTaskNames — link known sub-agent names in chat", () => {
  test("matches a whole-word known name and routes to the tasks view", () => {
    const hits = V.matchTaskNames("the researcher handed off", new Set(["researcher"])) as Array<{
      index: number;
      length: number;
      view: string;
      arg: { name: string };
    }>;
    expect(hits).toHaveLength(1);
    expect(hits[0].view).toBe("tasks");
    expect(hits[0].arg.name).toBe("researcher");
    expect(hits[0].index).toBe(4);
  });

  test("respects word boundaries and the ≥4-char guard", () => {
    expect(V.matchTaskNames("researchers plural", new Set(["researcher"]))).toHaveLength(0);
    expect(V.matchTaskNames("go ok now", new Set(["ok"]))).toHaveLength(0);
  });

  test("no known names → no hits", () => {
    expect(V.matchTaskNames("anything at all", new Set())).toEqual([]);
  });
});

describe("EXTRA_FILE_RE — image/data extensions the default matcher misses", () => {
  test("via scanLinks: links an image path but not a .ts source path", () => {
    const ms = [{ matcher: V.EXTRA_FILE_RE, resolver: (m: RegExpMatchArray) => ({ view: "files", arg: { path: m[0] } }) }];
    const hits = panels.scanLinks("see out/shot.png but not src/app.ts", ms) as Array<{
      view: string;
      text: string;
      arg: { path: string };
    }>;
    expect(hits).toHaveLength(1);
    expect(hits[0].view).toBe("files");
    expect(hits[0].arg.path).toBe("out/shot.png");
  });

  test("matches jsonl and pdf; disjoint from source/config extensions", () => {
    const src = V.EXTRA_FILE_RE.source;
    expect(new RegExp(src).test("a/b/transcript.jsonl")).toBe(true);
    expect(new RegExp(src).test("report.pdf")).toBe(true);
    expect(new RegExp(src).test("src/app.ts")).toBe(false);
    expect(new RegExp(src).test("notes.md")).toBe(false);
  });
});

// ── VIEW_FEATURES the views declare against ────────────────────────────────
describe("the live views gate on the expected features[] vocabulary", () => {
  test("files/tools/artifacts/background-tasks map to the keys the shapes use", () => {
    expect(panels.VIEW_FEATURES.files).toContain("files");
    expect(panels.VIEW_FEATURES.tools).toContain("tools");
    expect(panels.VIEW_FEATURES.artifacts).toEqual(expect.arrayContaining(["report", "screenshots", "sources"]));
    expect(panels.VIEW_FEATURES["background-tasks"]).toEqual(
      expect.arrayContaining(["subagents", "jobs", "loop", "orchestration"]),
    );
  });
});
