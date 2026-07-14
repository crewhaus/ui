/**
 * DOM-less unit tests for the panel system (_shared/panels.js): the view
 * registry's validation, the features[] → views gating function, the
 * chat-link matcher (scanLinks), and the light/dark theme helper.
 *
 * panels.js is a classic browser IIFE attaching to window.CH. Point `window`
 * at globalThis and give it a CH object before loading — the pieces under test
 * are pure string/array/object logic; the DOM-touching parts (init, mount,
 * applyLinks, theme.apply) are exercised in the running app, not here.
 */
import { beforeAll, describe, expect, test } from "bun:test";

type ViewDef = {
  id: string;
  title?: string;
  icon?: string;
  order?: number;
  feature?: string | string[];
  mount: (...a: unknown[]) => void;
  update?: (...a: unknown[]) => void;
  badge?: () => unknown;
};
type Matcher = { matcher: RegExp | ((t: string) => unknown[]); resolver?: (m: RegExpMatchArray) => unknown };
type Hit = { index: number; length: number; text: string; view: string; arg?: unknown };

type PanelsModule = {
  register: (def: unknown) => unknown;
  gateViews: (defs: ViewDef[], features: unknown) => ViewDef[];
  viewEnabled: (def: ViewDef, features: unknown) => boolean;
  scanLinks: (text: string, ms?: Matcher[]) => Hit[];
  linkify: (m: unknown, r?: unknown) => () => void;
  theme: {
    KEY: string;
    DEFAULT: string;
    normalize: (v: unknown) => string;
    next: (v: unknown) => string;
    read: () => string;
  };
  VIEW_FEATURES: Record<string, string[]>;
};

let panels: PanelsModule;
const mount = () => {};

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { CH: Record<string, unknown> }).CH =
    (globalThis as unknown as { CH?: Record<string, unknown> }).CH || {};
  await import("../_shared/panels.js");
  panels = (globalThis as unknown as { CH: { panels: PanelsModule } }).CH.panels;
});

describe("register — view validation", () => {
  test("rejects a view with no id", () => {
    expect(() => panels.register({ mount })).toThrow(/needs an id/);
  });

  test("rejects a view with no mount()", () => {
    expect(() => panels.register({ id: "x" })).toThrow(/mount/);
  });

  test("accepts a well-formed view and returns a record carrying the def", () => {
    const def = { id: "demo", title: "Demo", mount };
    const rec = panels.register(def) as { def: ViewDef };
    expect(rec.def).toBe(def);
  });
});

describe("viewEnabled / gateViews — the features[] → views selector", () => {
  const tools: ViewDef = { id: "tools", feature: "tools", mount };
  const plan: ViewDef = { id: "plan", feature: ["nodes", "roles", "steps"], mount };
  const always: ViewDef = { id: "always", mount }; // no feature → always-on

  test("a single-key view enables only when that key is present", () => {
    expect(panels.viewEnabled(tools, ["chat", "tools"])).toBe(true);
    expect(panels.viewEnabled(tools, ["chat", "cost"])).toBe(false);
  });

  test("a multi-key view enables when ANY key is present", () => {
    expect(panels.viewEnabled(plan, ["roles"])).toBe(true); // crew
    expect(panels.viewEnabled(plan, ["nodes"])).toBe(true); // graph
    expect(panels.viewEnabled(plan, ["voice"])).toBe(false);
  });

  test("a feature-less view is always enabled, even with no features[]", () => {
    expect(panels.viewEnabled(always, undefined)).toBe(true);
    expect(panels.viewEnabled(always, [])).toBe(true);
  });

  test("a gated view is hidden when the shape declares no features[]", () => {
    expect(panels.viewEnabled(tools, undefined)).toBe(false);
  });

  test("gateViews returns exactly the enabled subset", () => {
    const enabled = panels.gateViews([tools, plan, always], ["tools"]);
    expect(enabled.map((v) => v.id)).toEqual(["tools", "always"]);
  });
});

describe("VIEW_FEATURES — the planned-view mapping", () => {
  test("covers the 11 catalog views plus settings", () => {
    for (const id of [
      "tools",
      "background-tasks",
      "files",
      "artifacts",
      "focus",
      "plan",
      "context",
      "wiki",
      "skills",
      "upload",
      "diff",
      "settings",
    ]) {
      expect(Array.isArray(panels.VIEW_FEATURES[id])).toBe(true);
    }
  });

  test("plan is enabled by the roster/step vocabulary the shapes already use", () => {
    for (const key of ["roles", "nodes", "branches", "steps"]) {
      expect(panels.VIEW_FEATURES.plan).toContain(key);
    }
  });
});

describe("scanLinks — chat-link matcher", () => {
  test("the built-in defaults catch files, plan ids, and [[wiki]] slugs", () => {
    const hits = panels.scanLinks("edit src/app.ts for plan-0003 and see [[design-notes]]");
    const byView: Record<string, Hit> = {};
    for (const h of hits) byView[h.view] = h;
    expect(byView.file?.text).toBe("src/app.ts");
    expect((byView.file?.arg as { path: string }).path).toBe("src/app.ts");
    expect(byView.plan?.text).toBe("plan-0003");
    expect((byView.plan?.arg as { id: string }).id).toBe("plan-0003");
    expect(byView.wiki?.text).toBe("design-notes"); // brackets stripped for display
    expect((byView.wiki?.arg as { slug: string }).slug).toBe("design-notes");
  });

  test("hits are position-sorted and non-overlapping (longest match wins)", () => {
    const ms: Matcher[] = [
      { matcher: /foo/g, resolver: () => ({ view: "a" }) },
      { matcher: /foobar/g, resolver: () => ({ view: "b" }) },
    ];
    const hits = panels.scanLinks("say foobar now", ms);
    // both start at index 4; the longer /foobar/ wins and the shorter,
    // overlapped /foo/ is dropped.
    expect(hits).toHaveLength(1);
    expect(hits[0].view).toBe("b");
    expect(hits[0].index).toBe(4);
    expect(hits[0].length).toBe(6);
  });

  test("supports a function matcher returning explicit hits", () => {
    const ms: Matcher[] = [
      {
        matcher: (t: string) => {
          const i = t.indexOf("@run");
          return i < 0 ? [] : [{ index: i, length: 4, view: "runs" }];
        },
      },
    ];
    const hits = panels.scanLinks("check @run status", ms);
    expect(hits).toEqual([{ index: 6, length: 4, text: "@run", view: "runs", arg: undefined }]);
  });

  test("empty / falsy input yields no hits", () => {
    expect(panels.scanLinks("")).toEqual([]);
    expect(panels.scanLinks("nothing to see here")).toEqual([]);
  });
});

describe("theme — light/dark helper", () => {
  test("normalize coerces anything but 'light' to 'dark'", () => {
    expect(panels.theme.normalize("light")).toBe("light");
    expect(panels.theme.normalize("dark")).toBe("dark");
    expect(panels.theme.normalize("garbage")).toBe("dark");
    expect(panels.theme.normalize(null)).toBe("dark");
    expect(panels.theme.normalize(undefined)).toBe("dark");
  });

  test("next flips the theme", () => {
    expect(panels.theme.next("light")).toBe("dark");
    expect(panels.theme.next("dark")).toBe("light");
    expect(panels.theme.next("whatever")).toBe("light");
  });

  test("default is dark and read() falls back to it with no storage", () => {
    expect(panels.theme.DEFAULT).toBe("dark");
    expect(panels.theme.read()).toBe("dark");
    expect(panels.theme.KEY).toBe("crewhaus-ui-theme");
  });
});
