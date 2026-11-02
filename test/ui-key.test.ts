/**
 * The page's half of the key (_shared/ui.js): taking it from the printed link,
 * sending it with the page's own requests and socket, and saying so when the
 * page has none or an old one.
 *
 * ui.js is a classic browser IIFE over `window`. It is evaluated from its
 * source text against globalThis stubs, not import()ed: `bun test
 * --rerun-each` evaluates an imported module once per process, so later runs
 * would see the globals an earlier run's afterAll already restored. Every
 * replaced global is restored in afterAll, since other files share them.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_HEADER, OPERATOR_KEY_RE, resolveAccess, WS_KEY_PROTOCOL_PREFIX, WS_PROTOCOL } from "../_shared/host.ts";

type Rec = Record<string, unknown>;
type UiKey = {
  HEADER: string;
  WS_PROTOCOL: string;
  WS_KEY_PREFIX: string;
  STORAGE_KEY: string;
  fromHash(hash: string): string | null;
  get(): string | null;
  init(): boolean;
  wsProtocols(key: string): string[];
};
type Conn = { on(type: string, cb: (m: Rec) => void): Conn; connect(): Conn };
type CHApi = { uiKey: UiKey; Connection(): Conn };

const REPO = join(import.meta.dir, "..");
const ORIGIN = "http://127.0.0.1:4100";
const g = globalThis as unknown as Rec;
const GLOBALS = ["window", "CH", "location", "sessionStorage", "history", "addEventListener", "fetch", "WebSocket"];

const newKey = () => randomBytes(32).toString("base64url");

// ── Stubs. Their state is rebuilt at the start of every run. ────────────────

const state = {
  store: new Map<string, string>(),
  blocked: false,
  replaced: [] as unknown[][],
  reloads: 0,
  listeners: {} as Record<string, (() => void)[]>,
  fetches: [] as { input: unknown; init: RequestInit | undefined }[],
  answer: 200 as number | "reject",
  sockets: [] as { url: string; protocols: unknown; inst: { onclose: (() => void) | null } }[],
};

const loc = {
  href: `${ORIGIN}/`,
  origin: ORIGIN,
  host: "127.0.0.1:4100",
  protocol: "http:",
  pathname: "/",
  search: "",
  hash: "",
  reload() {
    state.reloads++;
  },
};
function setHash(hash: string): void {
  loc.hash = hash;
  loc.href = `${ORIGIN}${loc.pathname}${loc.search}${hash}`;
}

const storageStub = {
  getItem(k: string): string | null {
    if (state.blocked) throw new Error("site data blocked");
    return state.store.get(k) ?? null;
  },
  setItem(k: string, v: string): void {
    if (state.blocked) throw new Error("site data blocked");
    state.store.set(k, String(v));
  },
  removeItem(k: string): void {
    if (state.blocked) throw new Error("site data blocked");
    state.store.delete(k);
  },
};

const historyStub = {
  replaceState(data: unknown, title: string, url: string): void {
    state.replaced.push([data, title, url]);
    const u = new URL(url, loc.href);
    loc.pathname = u.pathname;
    loc.search = u.search;
    setHash(u.hash);
  },
};

function addEventListenerStub(type: string, fn: () => void): void {
  (state.listeners[type] ||= []).push(fn);
}

function fetchStub(input: unknown, init?: RequestInit): Promise<Response> {
  state.fetches.push({ input, init });
  if (state.answer === "reject") return Promise.reject(new TypeError("network down"));
  return Promise.resolve(new Response(null, { status: state.answer }));
}

class SocketStub {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  constructor(url: string, protocols?: unknown) {
    state.sockets.push({ url, protocols, inst: this });
  }
  send(): void {}
  close(): void {}
}

/** Clear what the stubs recorded; the load-time listener stays. */
function reset(hash = ""): void {
  state.store.clear();
  state.blocked = false;
  state.replaced = [];
  state.reloads = 0;
  state.fetches = [];
  state.answer = 200;
  state.sockets = [];
  loc.pathname = "/";
  loc.search = "";
  setHash(hash);
}

const saved: Rec = {};
const had: Record<string, boolean> = {};
let CH: CHApi;
let STORAGE_KEY: string;
const LOAD_KEY = newKey();
const atLoad = { stored: null as string | null, replaced: [] as unknown[][], hashAfter: "", wrapped: false };

beforeAll(() => {
  state.listeners = {};
  reset(`#k=${LOAD_KEY}`);
  for (const name of GLOBALS) {
    had[name] = name in g;
    saved[name] = g[name];
  }
  g.window = globalThis;
  g.location = loc;
  g.sessionStorage = storageStub;
  g.history = historyStub;
  g.addEventListener = addEventListenerStub;
  g.fetch = fetchStub;
  g.WebSocket = SocketStub;
  new Function(readFileSync(join(REPO, "_shared", "ui.js"), "utf8"))();
  CH = g.CH as CHApi;
  STORAGE_KEY = CH.uiKey.STORAGE_KEY;
  atLoad.stored = state.store.get(STORAGE_KEY) ?? null;
  atLoad.replaced = [...state.replaced];
  atLoad.hashAfter = loc.hash;
  atLoad.wrapped = g.fetch !== fetchStub;
});

afterAll(() => {
  for (const name of GLOBALS) {
    if (had[name]) g[name] = saved[name];
    else Reflect.deleteProperty(g, name);
  }
});

const pageFetch = (input: unknown, init?: RequestInit): Promise<Response> =>
  (g.fetch as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
const sentHeaders = (): Headers => new Headers(state.fetches.at(-1)?.init?.headers);

describe("at load", () => {
  test("takes the key from the link and clears it from the address bar", () => {
    expect(atLoad.stored).toBe(LOAD_KEY);
    expect(atLoad.replaced).toEqual([[null, "", "/"]]);
    expect(atLoad.hashAfter).toBe("");
  });

  test("wraps the page's fetch and listens for a link pasted into the tab", () => {
    expect(atLoad.wrapped).toBe(true);
    expect(state.listeners.hashchange?.length).toBe(1);
  });
});

describe("fromHash", () => {
  test("accepts exactly #k=<key>", () => {
    const key = newKey();
    expect(CH.uiKey.fromHash(`#k=${key}`)).toBe(key);
  });
  test("rejects every other shape", () => {
    const key = newKey();
    for (const h of ["#k=short", `#x=${key}`, "", `#k=${key}&z`, `#k=${key} `, `k=${key}`]) {
      expect([h, CH.uiKey.fromHash(h)]).toEqual([h, null]);
    }
  });
});

describe("init", () => {
  test("with the link: stores the key and takes it out of the address bar", () => {
    const key = newKey();
    reset(`#k=${key}`);
    expect(CH.uiKey.init()).toBe(true);
    expect(state.store.get(STORAGE_KEY)).toBe(key);
    expect(state.replaced).toEqual([[null, "", "/"]]);
    expect(String(state.replaced[0][2]).includes("#")).toBe(false);
    expect(CH.uiKey.get()).toBe(key);
  });

  test("without it: changes nothing", () => {
    reset("");
    expect(CH.uiKey.init()).toBe(false);
    expect(state.store.size).toBe(0);
    expect(state.replaced).toEqual([]);
    expect(CH.uiKey.get()).toBeNull();
  });

  test("with site data blocked, the key still works until the page reloads", () => {
    const key = newKey();
    reset(`#k=${key}`);
    state.blocked = true;
    expect(CH.uiKey.init()).toBe(true);
    expect(CH.uiKey.get()).toBe(key);
  });

  test("a link pasted into a tab that already shows the page is stored, then reloads it", () => {
    const key = newKey();
    reset("");
    setHash(`#k=${key}`);
    for (const fn of state.listeners.hashchange ?? []) fn();
    expect(state.store.get(STORAGE_KEY)).toBe(key);
    expect(state.reloads).toBe(1);
  });

  test("a malformed fragment stores nothing and does not reload", () => {
    reset("");
    setHash("#k=short");
    for (const fn of state.listeners.hashchange ?? []) fn();
    expect(state.store.size).toBe(0);
    expect(state.reloads).toBe(0);
  });
});

describe("the page's fetch", () => {
  test("adds the key to requests for its own host", async () => {
    const key = newKey();
    reset("");
    state.store.set(STORAGE_KEY, key);
    for (const url of ["/api/state", `${ORIGIN}/x`, "harness/wrangler.toml"]) {
      await pageFetch(url);
      expect([url, sentHeaders().get(KEY_HEADER)]).toEqual([url, key]);
    }
    await pageFetch(new Request(`${ORIGIN}/api/state`, { headers: { authorization: "Bearer r" } }));
    expect(sentHeaders().get(KEY_HEADER)).toBe(key);
    expect(sentHeaders().get("authorization")).toBe("Bearer r");
  });

  test("never sends it to another site", async () => {
    reset("");
    state.store.set(STORAGE_KEY, newKey());
    for (const url of ["https://example.com/x", "//example.com/x", "http://127.0.0.1:4101/x"]) {
      await pageFetch(url);
      expect([url, sentHeaders().has(KEY_HEADER)]).toEqual([url, false]);
    }
  });

  test("adds nothing when no key is stored", async () => {
    reset("");
    await pageFetch("/api/state");
    expect(sentHeaders().has(KEY_HEADER)).toBe(false);
  });

  test("keeps the request's own headers, method and body", async () => {
    const key = newKey();
    reset("");
    state.store.set(STORAGE_KEY, key);
    await pageFetch("/proxy/", {
      method: "POST",
      headers: { authorization: "Bearer jwt", "content-type": "application/json" },
      body: "{}",
    });
    const sent = state.fetches.at(-1)?.init;
    expect(sent?.method).toBe("POST");
    expect(sent?.body).toBe("{}");
    expect(sentHeaders().get("authorization")).toBe("Bearer jwt");
    expect(sentHeaders().get("content-type")).toBe("application/json");
    expect(sentHeaders().get(KEY_HEADER)).toBe(key);
  });
});

describe("the page and the host agree", () => {
  test("on the header and the socket protocols", () => {
    expect(CH.uiKey.HEADER).toBe(KEY_HEADER);
    expect(CH.uiKey.WS_PROTOCOL).toBe(WS_PROTOCOL);
    expect(CH.uiKey.WS_KEY_PREFIX).toBe(WS_KEY_PROTOCOL_PREFIX);
  });

  test("on which keys a link can carry", () => {
    const boot = resolveAccess({}, {}).key;
    expect(CH.uiKey.fromHash(`#k=${boot}`)).toBe(boot);
    const operator = randomBytes(32).toString("hex"); // shaped like `openssl rand -hex 32`
    expect(OPERATOR_KEY_RE.test(operator)).toBe(true);
    expect(CH.uiKey.fromHash(`#k=${operator}`)).toBe(operator);
    const short = "a".repeat(31);
    expect(OPERATOR_KEY_RE.test(short)).toBe(false);
    expect(CH.uiKey.fromHash(`#k=${short}`)).toBeNull();
  });
});

describe("Connection", () => {
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  /** Count retries without waiting for them: setTimeout records and returns. */
  function countTimers() {
    let calls = 0;
    let fired: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      fired = resolve;
    });
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((..._args: unknown[]) => {
      calls++;
      fired();
      return 0;
    }) as unknown as typeof setTimeout);
    return { spy, first, count: () => calls };
  }

  test("with no key it opens no socket and says the link is missing", () => {
    reset("");
    const auths: Rec[] = [];
    CH.Connection()
      .on("auth", (m) => auths.push(m))
      .connect();
    expect(auths).toEqual([{ reason: "missing" }]);
    expect(state.sockets.length).toBe(0);
  });

  test("with a key it offers crewhaus-ui and the key as subprotocols", () => {
    const key = newKey();
    reset("");
    state.store.set(STORAGE_KEY, key);
    CH.Connection().connect();
    expect(state.sockets.length).toBe(1);
    expect(state.sockets[0].url).toBe("ws://127.0.0.1:4100/ws");
    expect(state.sockets[0].protocols).toEqual(["crewhaus-ui", `crewhaus-ui.key.${key}`]);
  });

  test("a 401 after the socket closes means an old key: say so and stop retrying", async () => {
    const key = newKey();
    reset("");
    state.store.set(STORAGE_KEY, key);
    const auths: Rec[] = [];
    let authed: () => void = () => {};
    const stale = new Promise<void>((resolve) => {
      authed = resolve;
    });
    CH.Connection()
      .on("auth", (m) => {
        auths.push(m);
        authed();
      })
      .connect();
    state.answer = 401;
    const timers = countTimers();
    try {
      state.sockets[0].inst.onclose?.();
      await Promise.race([stale, timers.first]);
      await flush();
      expect(auths).toEqual([{ reason: "stale" }]);
      expect(timers.count()).toBe(0);
      expect(state.fetches.at(-1)?.input).toBe("/api/state");
      expect(sentHeaders().get(KEY_HEADER)).toBe(key);
    } finally {
      timers.spy.mockRestore();
    }
  });

  for (const answer of [200, "reject"] as const) {
    test(`any other answer (${answer}) retries once, with no auth state`, async () => {
      reset("");
      state.store.set(STORAGE_KEY, newKey());
      const auths: Rec[] = [];
      let authed: () => void = () => {};
      const sawAuth = new Promise<void>((resolve) => {
        authed = resolve;
      });
      CH.Connection()
        .on("auth", (m) => {
          auths.push(m);
          authed();
        })
        .connect();
      state.answer = answer;
      const timers = countTimers();
      try {
        state.sockets[0].inst.onclose?.();
        await Promise.race([timers.first, sawAuth]);
        await flush();
        expect(timers.count()).toBe(1);
        expect(auths).toEqual([]);
      } finally {
        timers.spy.mockRestore();
      }
    });
  }
});

describe("no link or image points at a keyed route", () => {
  // A new tab or an <img> cannot send the key, so the page never navigates to
  // a keyed route: it fetches, then shows what it fetched.
  const KEYED = "(?:api|proxy|worker|crewhaus|harness)";
  const TARGET = `(?:node\\.url\\b|["'\`]\\/${KEYED}\\/)`;
  const PATTERNS = [
    new RegExp(`\\b(?:href|src)\\s*:\\s*${TARGET}`, "g"), // { href: … } attribute objects
    new RegExp(`setAttribute\\(\\s*["'](?:href|src)["']\\s*,\\s*${TARGET}`, "g"),
    new RegExp(`\\.(?:href|src)\\s*=\\s*${TARGET}`, "g"),
  ];
  const keyedNavigations = (src: string): number =>
    PATTERNS.reduce((n, re) => n + [...src.matchAll(re)].length, 0);

  test("the matcher finds what it looks for, and only in link and image positions", () => {
    expect(keyedNavigations('CH.el("img", { src: node.url })')).toBeGreaterThanOrEqual(1);
    expect(keyedNavigations('CH.el("a", { href: "/crewhaus/x" })')).toBeGreaterThanOrEqual(1);
    expect(keyedNavigations('a.setAttribute("href", node.url)')).toBeGreaterThanOrEqual(1);
    expect(keyedNavigations('img.src = "/harness/x.png"')).toBeGreaterThanOrEqual(1);
    expect(keyedNavigations('fetch("/harness/wrangler.toml")')).toBe(0);
  });

  test("no page file has one", () => {
    const shared = readdirSync(join(REPO, "_shared"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => join(REPO, "_shared", f));
    const apps = readdirSync(REPO)
      .map((d) => join(REPO, d, "app.js"))
      .filter((p) => existsSync(p));
    expect(shared.length).toBeGreaterThanOrEqual(6);
    expect(apps.length).toBeGreaterThanOrEqual(18);
    const hits = [...shared, ...apps]
      .filter((f) => keyedNavigations(readFileSync(f, "utf8")) > 0)
      .map((f) => f.slice(REPO.length + 1));
    expect(hits).toEqual([]);
  });
});
