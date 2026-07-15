/**
 * Phase-5 rollout guard: every shape's config.features[] must drive exactly the
 * right-rail panel views the §8 view matrix assigns it, and no feature key may
 * be silently ignored.
 *
 * Two properties are asserted against the REAL config.json files on disk:
 *
 *   1. Nothing silently ignored — every key in every shape's features[] is
 *      either a panel-view key (appears in some CH.panels.VIEW_FEATURES array)
 *      or a documented shape-native / hero-panel feature. This catches typos
 *      (e.g. "subagent" for "subagents") that would quietly fail to mount a view.
 *
 *   2. The enabled-view set matches the §8 matrix — for each shape we compute
 *      which registered views mount (a view enables when ANY of its feature keys
 *      is present) and compare to the plan's per-shape assignment. This catches
 *      BOTH a missing view (forgot a key) and an unintended extra view (a native
 *      key colliding with a panel key, e.g. cf-worker-graph's old "graph"
 *      lighting up the plan view).
 *
 * panels.js is a classic browser IIFE; we load it against a globalThis-backed
 * window exactly like panels.test.ts to read the exported VIEW_FEATURES map.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Panels = { VIEW_FEATURES: Record<string, string[]> };
let VIEW_FEATURES: Record<string, string[]>;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { CH: Record<string, unknown> }).CH =
    (globalThis as unknown as { CH?: Record<string, unknown> }).CH || {};
  await import("../_shared/panels.js");
  VIEW_FEATURES = (globalThis as unknown as { CH: { panels: Panels } }).CH.panels.VIEW_FEATURES;
});

// The views actually registered by _shared/views.js (id → its VIEW_FEATURES key).
// `upload` and `diff` are in VIEW_FEATURES but are deferred (not registered), so
// they are intentionally absent here.
const REGISTERED_VIEWS: Record<string, string> = {
  tools: "tools",
  tasks: "background-tasks",
  files: "files",
  artifacts: "artifacts",
  focus: "focus",
  plan: "plan",
  context: "context",
  wiki: "wiki",
  skills: "skills",
  settings: "settings",
};

// The §8 per-shape view matrix — the spec this rollout implements. Each value is
// the set of right-rail views that shape should mount, sorted for comparison.
const EXPECTED: Record<string, string[]> = {
  cli: ["context", "files", "focus", "plan", "settings", "skills", "tasks", "tools", "wiki"],
  crew: ["files", "focus", "plan", "settings", "tasks"],
  graph: ["artifacts", "context", "files", "plan", "settings"],
  managed: ["files", "settings", "tasks", "tools"],
  pipeline: ["artifacts", "files", "settings", "tools", "wiki"],
  research: ["artifacts", "context", "plan", "settings", "wiki"],
  batch: ["artifacts", "settings", "tasks"],
  voice: ["settings", "tasks", "tools"],
  browser: ["artifacts", "files", "plan", "settings"],
  workflow: ["artifacts", "files", "plan", "settings"],
  eval: ["artifacts", "files", "settings"],
  onchain: ["files", "plan", "settings", "tools"],
  "onchain-game": ["files", "plan", "settings", "tools"],
  // channel is not in the §8 table (it post-dates it); given a conservative
  // daemon set — everything it can produce without a memory/trace-plan surface.
  channel: ["files", "settings", "tools"],
  "cf-worker-cli": ["files", "settings"],
  "cf-worker-graph": ["files", "settings"],
  "cf-worker-workflow": ["files", "settings"],
  "claude-plugin": ["files", "settings"],
};

// Shape-native / hero-panel feature keys: declarative markers that describe a
// shape's own bespoke panels (not the shared right-rail views) and legitimately
// drive no VIEW_FEATURES view. Kept explicit so a typo of a real panel key
// can't hide here.
const NATIVE_FEATURES = new Set<string>([
  // cli
  "chat", "mcp", "permissions",
  // crew
  "handoffs", "routing",
  // graph / workflow / onchain-game
  "state", "edges", "run",
  // managed
  "tenants", "gateway", "requests", "health",
  // pipeline
  "retrieve", "rag", "index",
  // eval
  "dataset", "verdicts", "grader", "score",
  // onchain
  "chain", "contracts", "tx", "wallet",
  // onchain-game
  "game", "actions",
  // channel
  "channels", "webhooks", "status", "sessions", "heartbeat", "activity",
  // voice
  "transcript", "turns", "voice",
  // browser
  "viewport",
  // batch
  "throughput", "queue",
  // claude-plugin
  "manifest", "commands", "install",
  // cf-worker-*
  "sse", "request", "edge",
]);

function readFeatures(shape: string): string[] {
  const raw = readFileSync(join(import.meta.dir, "..", shape, "config.json"), "utf8");
  const cfg = JSON.parse(raw) as { features?: string[] };
  return Array.isArray(cfg.features) ? cfg.features : [];
}

/** Views (from REGISTERED_VIEWS) enabled by a features[] array. Mirrors
    CH.panels.viewEnabled: a view mounts when ANY of its keys is present. */
function enabledViews(features: string[]): string[] {
  const out: string[] = [];
  for (const [viewId, fKey] of Object.entries(REGISTERED_VIEWS)) {
    const keys = VIEW_FEATURES[fKey] || [];
    if (keys.some((k) => features.includes(k))) out.push(viewId);
  }
  return out.sort();
}

const SHAPES = Object.keys(EXPECTED);

/** Every top-level dir shipping a config.json is a shape (mirrors scaffold.ts
    listShapes). Used to prove the matrix below covers the repo's actual shapes. */
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

describe("shape features[] → panel views (Phase 5 rollout)", () => {
  test("the matrix covers exactly the shapes on disk", () => {
    expect(discoverShapes()).toEqual([...SHAPES].sort());
  });

  test("VIEW_FEATURES covers every registered view's feature key", () => {
    for (const fKey of Object.values(REGISTERED_VIEWS)) {
      expect(Array.isArray(VIEW_FEATURES[fKey])).toBe(true);
      expect(VIEW_FEATURES[fKey].length).toBeGreaterThan(0);
    }
  });

  test("no features[] key is silently ignored (panel key or documented native)", () => {
    const panelKeys = new Set<string>(Object.values(VIEW_FEATURES).flat());
    const offenders: string[] = [];
    for (const shape of SHAPES) {
      for (const key of readFeatures(shape)) {
        if (!panelKeys.has(key) && !NATIVE_FEATURES.has(key)) {
          offenders.push(`${shape}:${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("features[] has no duplicate keys", () => {
    for (const shape of SHAPES) {
      const f = readFeatures(shape);
      expect(f.length).toBe(new Set(f).size);
    }
  });

  for (const shape of SHAPES) {
    test(`${shape} mounts exactly its §8 matrix views`, () => {
      expect(enabledViews(readFeatures(shape))).toEqual(EXPECTED[shape]);
    });
  }
});
