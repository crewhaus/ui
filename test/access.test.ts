/**
 * The UI host listens on this computer only and opens only with the key it
 * prints. First the pure helpers, then one in-process server per layout.
 *
 * Every server binds 127.0.0.1 on port 0 through the object form of serve()
 * (the string form takes its port only from CREWHAUS_UI_PORT) and is stopped
 * in afterAll. The variables the host reads are saved and removed first, so a
 * developer's own shell or `.env` never decides a result. Fixture keys are
 * built at runtime.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childEnv,
  isLoopbackHost,
  isPublicAssetName,
  KEY_HEADER,
  keyMatches,
  presentedKey,
  resolveAccess,
  ServeRefusedError,
  serve,
  type ServeHandle,
  type ServeOptions,
  withoutKey,
  WS_KEY_PROTOCOL_PREFIX,
  WS_PROTOCOL,
  wsOriginAllowed,
} from "../_shared/host.ts";

type Rec = Record<string, unknown>;

// ── Environment and temp dirs ────────────────────────────────────────────────

const READ_BY_HOST = ["CREWHAUS_UI_HOST", "CREWHAUS_UI_KEY", "HOST"] as const;
const savedEnv: Record<string, string | undefined> = {};
const tempRoots: string[] = [];

beforeAll(() => {
  for (const name of READ_BY_HOST) {
    savedEnv[name] = process.env[name];
    Reflect.deleteProperty(process.env, name);
  }
});

afterAll(() => {
  for (const name of READ_BY_HOST) {
    if (savedEnv[name] === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = savedEnv[name];
  }
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-ui-"));
  tempRoots.push(root);
  return root;
}

const key43 = () => randomBytes(32).toString("base64url");

/** A shape config as complete as a real one (detectHarness reads `entry`). */
function shapeConfig(over: Rec = {}): Rec {
  return {
    shape: "cli",
    title: "Test",
    tagline: "",
    runClass: "stdio-oneshot",
    entry: ["agent.ts"],
    input: "oneshot",
    ...over,
  };
}

/** The page's own files, as a shape directory ships them. */
function writeShape(dir: string, config: Rec = shapeConfig()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>test page</title>");
  writeFileSync(join(dir, "app.js"), "/* app */");
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

function writeShared(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ui.js"), "/* shared */");
}

/** Start a server without printing its banner into the test output. */
function startQuiet(opts: ServeOptions): ServeHandle {
  const out = spyOn(process.stdout, "write").mockImplementation(
    (() => true) as unknown as typeof process.stdout.write,
  );
  try {
    return serve(opts);
  } finally {
    out.mockRestore();
  }
}

const keyOf = (h: ServeHandle): string => h.link.slice(h.link.indexOf("#k=") + 3);

async function get(
  h: ServeHandle,
  path: string,
  key?: string,
): Promise<{ status: number; body: string; headers: Headers }> {
  const headers = new Headers();
  if (key !== undefined) headers.set(KEY_HEADER, key);
  const res = await fetch(`http://127.0.0.1:${h.port}${path}`, { headers });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

type RawResponse = { status: number; head: string; body: string; raw: string };

/**
 * Send `request` over a raw TCP socket and read the status line and headers,
 * plus the body when `withBody` (by Content-Length). Unlike fetch, this sends
 * the request target, Host, Origin and subprotocol header exactly as given.
 */
function rawRequest(port: number, request: string, withBody = false): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const parse = (final: boolean): RawResponse | null => {
      const text = buf.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end === -1) return final ? { status: 0, head: text, body: "", raw: text } : null;
      const head = text.slice(0, end);
      const body = text.slice(end + 4);
      if (withBody && !final) {
        const len = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? Number.NaN);
        if (!Number.isNaN(len) && Buffer.byteLength(body, "latin1") < len) return null;
      }
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      return { status, head, body, raw: text };
    };
    const settle = (r: RawResponse | null, sock?: { end(): void }) => {
      if (settled || !r) return;
      settled = true;
      sock?.end();
      resolve(r);
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) {
          sock.write(request);
        },
        data(sock, chunk) {
          buf = Buffer.concat([buf, chunk]);
          settle(parse(false), sock);
        },
        close() {
          settle(parse(true));
        },
        error(_sock, err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      },
    }).catch(reject);
  });
}

const wsHandshake = (port: number, path: string, headers: Record<string, string>): string =>
  [
    `GET ${path} HTTP/1.1`,
    ...Object.entries({
      Host: `127.0.0.1:${port}`,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    }).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ].join("\r\n");

const plainGet = (port: number, path: string, headers: Record<string, string> = {}): string =>
  [
    `GET ${path} HTTP/1.1`,
    ...Object.entries({ Host: `127.0.0.1:${port}`, Connection: "close", ...headers }).map(
      ([k, v]) => `${k}: ${v}`,
    ),
    "",
    "",
  ].join("\r\n");

type WsClient = {
  frames: Rec[];
  next(pred: (m: Rec) => boolean): Promise<Rec>;
  send(msg: Rec): void;
  close(): void;
};

/** A keyed browser-style client (Bun's WebSocket sends no Origin). Resolves
 *  once it is open; `next` waits for the first frame matching `pred`. */
function connectWs(h: ServeHandle, key: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, [WS_PROTOCOL, WS_KEY_PROTOCOL_PREFIX + key]);
    const frames: Rec[] = [];
    const waiters: { pred: (m: Rec) => boolean; done: (m: Rec) => void }[] = [];
    const client: WsClient = {
      frames,
      next(pred) {
        const seen = frames.find(pred);
        if (seen) return Promise.resolve(seen);
        return new Promise((done) => waiters.push({ pred, done }));
      },
      send(msg) {
        ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close();
      },
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Rec;
      frames.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.done(m);
        }
      }
    };
    ws.onopen = () => resolve(client);
    ws.onerror = () => reject(new Error("websocket did not open"));
  });
}

const NEEDS_LINK = "Open the link the UI printed when it started.";
const OTHER_PAGE = "This UI accepts connections only from its own page.";

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("isLoopbackHost", () => {
  test("names of this computer only", () => {
    for (const h of ["localhost", "LOCALHOST", "::1", "[::1]", "127.0.0.1", "127.1.2.3", "127.255.255.255"]) {
      expect([h, isLoopbackHost(h)]).toEqual([h, true]);
    }
  });

  test("everything else, conservatively", () => {
    for (const h of [
      "",
      "0.0.0.0",
      "::",
      "[::]",
      "10.0.0.5",
      "192.168.1.20",
      "100.64.0.1",
      "printer.local",
      "127.0.0.1.example.com",
      "127.256.0.1",
      "127.0.0",
      "::ffff:127.0.0.1",
      "localhost.example.com",
    ]) {
      expect([h, isLoopbackHost(h)]).toEqual([h, false]);
    }
  });
});

describe("resolveAccess", () => {
  test("defaults to 127.0.0.1 and a new 256-bit key on every call", () => {
    const a = resolveAccess({}, {});
    const b = resolveAccess({}, {});
    expect(a).toMatchObject({ hostname: "127.0.0.1", loopback: true, keySource: "boot" });
    expect(a.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.key).not.toBe(b.key);
  });

  test("localhost binds 127.0.0.1, and [::1] binds ::1", () => {
    expect(resolveAccess({ host: "localhost" }, {}).hostname).toBe("127.0.0.1");
    expect(resolveAccess({}, { CREWHAUS_UI_HOST: "LocalHost" }).hostname).toBe("127.0.0.1");
    expect(resolveAccess({ host: "[::1]" }, {})).toMatchObject({ hostname: "::1", loopback: true });
  });

  test("an empty CREWHAUS_UI_HOST or CREWHAUS_UI_KEY counts as unset", () => {
    const a = resolveAccess({}, { CREWHAUS_UI_HOST: "", CREWHAUS_UI_KEY: "" });
    expect(a).toMatchObject({ hostname: "127.0.0.1", loopback: true, keySource: "boot" });
  });

  test("another address without a key of the operator's own is refused", () => {
    let err: unknown;
    try {
      resolveAccess({ host: "0.0.0.0" }, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ServeRefusedError);
    const refusal = err as ServeRefusedError;
    expect(refusal.reason).toBe("host-needs-key");
    expect(refusal.name).toBe("ServeRefusedError");
    expect(refusal.message).toContain("0.0.0.0");
    expect(refusal.message).toContain("SSH tunnel");
    expect(refusal.message).toContain("Tailscale");
    expect(refusal.message).toContain("CREWHAUS_UI_KEY");
  });

  test("the same address with a key from the environment is allowed", () => {
    const opKey = "t".repeat(40);
    const a = resolveAccess({ host: "0.0.0.0" }, { CREWHAUS_UI_KEY: opKey });
    expect(a).toEqual({ hostname: "0.0.0.0", loopback: false, key: opKey, keySource: "operator" });
    const viaEnv = resolveAccess({}, { CREWHAUS_UI_HOST: "100.64.0.1", CREWHAUS_UI_KEY: opKey });
    expect(viaEnv).toMatchObject({ hostname: "100.64.0.1", loopback: false, keySource: "operator" });
  });

  test("options win over the environment, for the host and for the key", () => {
    const envKey = "e".repeat(40);
    const optKey = "o".repeat(40);
    const a = resolveAccess(
      { host: "127.0.0.2", key: optKey },
      { CREWHAUS_UI_HOST: "0.0.0.0", CREWHAUS_UI_KEY: envKey },
    );
    expect(a).toEqual({ hostname: "127.0.0.2", loopback: true, key: optKey, keySource: "operator" });
  });

  test("a malformed key is refused, even on loopback, and never repeated", () => {
    const bad = ["k".repeat(31), `${"k".repeat(20)} ${"k".repeat(20)}`, `${"k".repeat(20)}#${"k".repeat(20)}`];
    for (const key of bad) {
      for (const attempt of [
        () => resolveAccess({}, { CREWHAUS_UI_KEY: key }),
        () => resolveAccess({ key }, {}),
        () => resolveAccess({ host: "0.0.0.0", key }, {}),
      ]) {
        let err: unknown;
        try {
          attempt();
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(ServeRefusedError);
        expect((err as ServeRefusedError).reason).toBe("bad-key");
        expect((err as ServeRefusedError).message).toContain("CREWHAUS_UI_KEY");
        expect((err as ServeRefusedError).message.includes(key)).toBe(false);
      }
    }
  });
});

describe("keyMatches", () => {
  const key = key43();
  test("the exact key matches", () => {
    expect(keyMatches(key, key)).toBe(true);
  });
  test("one character off does not", () => {
    const off = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(keyMatches(off, key)).toBe(false);
  });
  test("empty and absent values never match", () => {
    expect(keyMatches("", key)).toBe(false);
    expect(keyMatches(null, key)).toBe(false);
    expect(keyMatches(undefined, key)).toBe(false);
  });
  test("a one-character value is false, without throwing", () => {
    expect(() => keyMatches("x", key)).not.toThrow();
    expect(keyMatches("x", key)).toBe(false);
  });
});

describe("presentedKey and withoutKey", () => {
  const key = key43();
  test("reads the header, and the subprotocol only on the socket route", () => {
    expect(presentedKey(new Request("http://h/api/state", { headers: { [KEY_HEADER]: key } }), false)).toBe(key);
    const offer = new Request("http://h/ws", {
      headers: { "sec-websocket-protocol": `${WS_PROTOCOL}, ${WS_KEY_PROTOCOL_PREFIX}${key}` },
    });
    expect(presentedKey(offer, true)).toBe(key);
    expect(presentedKey(offer, false)).toBeNull();
  });

  test("never reads a query parameter or a cookie", () => {
    const req = new Request(`http://h/api/state?k=${key}&key=${key}`, { headers: { cookie: `k=${key}` } });
    expect(presentedKey(req, false)).toBeNull();
    expect(presentedKey(req, true)).toBeNull();
  });

  test("withoutKey drops only the key", () => {
    const out = withoutKey(
      new Headers({ [KEY_HEADER]: key, authorization: "Bearer abc", "content-type": "application/json" }),
    );
    expect(out.has(KEY_HEADER)).toBe(false);
    expect(out.get("authorization")).toBe("Bearer abc");
    expect(out.get("content-type")).toBe("application/json");
  });
});

describe("wsOriginAllowed", () => {
  test("no Origin (a script) passes; the key is checked separately", () => {
    expect(wsOriginAllowed(null, "127.0.0.1:4100", true)).toBe(true);
  });

  test("the page's own origin passes", () => {
    expect(wsOriginAllowed("http://127.0.0.1:4100", "127.0.0.1:4100", true)).toBe(true);
    expect(wsOriginAllowed("http://localhost:4100", "localhost:4100", true)).toBe(true);
    expect(wsOriginAllowed("http://LOCALHOST:4100", "localhost:4100", true)).toBe(true);
    expect(wsOriginAllowed("http://[::1]:4100", "[::1]:4100", true)).toBe(true);
    expect(wsOriginAllowed("https://127.0.0.1:4100", "127.0.0.1:4100", true)).toBe(true);
  });

  test("another site, an opaque origin, or a malformed one is refused", () => {
    expect(wsOriginAllowed("http://example.com", "127.0.0.1:4100", true)).toBe(false);
    expect(wsOriginAllowed("http://127.0.0.1:4101", "127.0.0.1:4100", true)).toBe(false);
    expect(wsOriginAllowed("null", "127.0.0.1:4100", true)).toBe(false);
    expect(wsOriginAllowed("not a url", "127.0.0.1:4100", true)).toBe(false);
    expect(wsOriginAllowed("file:///x", "127.0.0.1:4100", true)).toBe(false);
    expect(wsOriginAllowed("http://127.0.0.1:4100", null, true)).toBe(false);
  });

  test("on loopback, a name that only resolves here is refused; with an operator key it passes", () => {
    expect(wsOriginAllowed("http://elsewhere.example:4100", "elsewhere.example:4100", true)).toBe(false);
    expect(wsOriginAllowed("http://elsewhere.example:4100", "elsewhere.example:4100", false)).toBe(true);
  });
});

describe("isPublicAssetName", () => {
  test("the page's own asset names", () => {
    for (const n of ["index.html", "app.js", "ui.css", "events.js", "favicon.ico", "font.woff2", "x.mjs"]) {
      expect([n, isPublicAssetName(n)]).toEqual([n, true]);
    }
  });
  test("nothing else", () => {
    for (const n of [
      "",
      ".env",
      ".dev.vars",
      "config.json",
      "serve.ts",
      "host.ts",
      "README.md",
      "a/b.js",
      "../x.js",
      "..\\x.js",
      "harness",
      "x.js/",
      "notes.yaml",
      "log.jsonl",
    ]) {
      expect([n, isPublicAssetName(n)]).toEqual([n, false]);
    }
  });
});

describe("childEnv", () => {
  const cli = shapeConfig() as never;
  const daemon = shapeConfig({ runClass: "daemon-http", entry: ["daemon.ts"], input: "none" }) as never;

  test("drops the UI key, whichever source carries it", () => {
    const k = key43();
    expect("CREWHAUS_UI_KEY" in childEnv({ CREWHAUS_UI_KEY: k }, {}, cli)).toBe(false);
    expect("CREWHAUS_UI_KEY" in childEnv({}, { CREWHAUS_UI_KEY: k }, cli)).toBe(false);
    const withConfigEnv = shapeConfig({ env: { CREWHAUS_UI_KEY: k } }) as never;
    expect("CREWHAUS_UI_KEY" in childEnv({}, {}, withConfigEnv)).toBe(false);
  });

  test("a daemon shape is started with HOST=127.0.0.1 unless HOST is set", () => {
    expect(childEnv({}, {}, daemon).HOST).toBe("127.0.0.1");
    expect(childEnv({}, { HOST: "0.0.0.0" }, daemon).HOST).toBe("0.0.0.0");
    expect(childEnv({ HOST: "10.0.0.2" }, {}, daemon).HOST).toBe("10.0.0.2");
    expect(childEnv({}, { HOST: "" }, daemon).HOST).toBe("127.0.0.1");
  });

  test("other shapes get no HOST", () => {
    expect("HOST" in childEnv({}, {}, cli)).toBe(false);
  });

  test("keeps today's composition and precedence", () => {
    const withEnv = shapeConfig({ env: { SHARED: "config", CREWHAUS_TRACE: "off" } }) as never;
    const env = childEnv({ SHARED: "chain", FROM_CHAIN: "1" }, { SHARED: "proc", GONE: undefined }, withEnv);
    expect(env.FROM_CHAIN).toBe("1");
    expect(env.SHARED).toBe("config");
    expect(env.CREWHAUS_TRACE).toBe("off");
    expect(env.CREWHAUS_COST_TRACKING).toBe("1");
    expect("GONE" in env).toBe(false);
    expect(childEnv({ SHARED: "chain" }, { SHARED: "proc" }, cli).SHARED).toBe("proc");
    expect(childEnv({}, {}, cli).CREWHAUS_TRACE).toBe("json");
  });

  test("every child the host starts gets an explicit environment", () => {
    // Bun hands a child spawned without `env` the environment this process
    // started with, even after a variable is removed from process.env. So each
    // spawn passes its environment explicitly: that is what keeps the key out
    // of the environment of `bun install`, `bun add` and the harness child.
    const src = readFileSync(join(import.meta.dir, "..", "_shared", "host.ts"), "utf8");
    const calls = [...src.matchAll(/\bspawn\(/g)].map((m) => src.slice(m.index, src.indexOf("});", m.index)));
    expect(calls.length).toBe(3);
    for (const call of calls) expect(call).toMatch(/\benv\b/);
  });
});

// ── Server, package layout ───────────────────────────────────────────────────

describe("server (package layout)", () => {
  let h: ServeHandle;
  let key: string;
  let root: string;
  const sentinel = `outside-${randomBytes(8).toString("hex")}`;

  beforeAll(() => {
    root = tempRoot();
    // <root>/ui is the shape dir, <root>/pkg/_shared the shared assets: the
    // depths matter to the containment checks below.
    writeShape(join(root, "ui"));
    writeShared(join(root, "pkg", "_shared"));
    mkdirSync(join(root, "harness", "node_modules"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "note.txt"), sentinel);
    symlinkSync(join("..", "outside", "note.txt"), join(root, "ui", "link.js"));
    h = startQuiet({
      uiDir: join(root, "ui"),
      sharedDir: join(root, "pkg", "_shared"),
      harnessDir: join(root, "harness"),
      port: 0,
    });
    key = keyOf(h);
  });

  afterAll(async () => {
    await h?.stop();
  });

  test("the page's own files need no key", async () => {
    for (const path of ["/", "/index.html", "/app.js", "/_shared/ui.js"]) {
      expect([path, (await get(h, path)).status]).toEqual([path, 200]);
    }
    expect((await get(h, "/")).body).toContain("test page");
  });

  test("every other route answers 401 without the key, before any route runs", async () => {
    for (const path of [
      "/api/state",
      "/api/config",
      "/api/harness",
      "/crewhaus/state/x",
      "/harness/x",
      "/proxy/x",
      "/worker/x",
      "/config.json",
      "/_shared/host.ts",
      "/no-such-route",
    ]) {
      const r = await get(h, path);
      expect([path, r.status, r.body]).toEqual([path, 401, NEEDS_LINK]);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    }
  });

  test("with the key, each route is reached", async () => {
    const state = await get(h, "/api/state", key);
    expect(state.status).toBe(200);
    expect((JSON.parse(state.body) as { config: { shape: string } }).config.shape).toBe("cli");
    expect(await get(h, "/proxy/x", key)).toMatchObject({ status: 503, body: "daemon not running" });
    expect(await get(h, "/worker/x", key)).toMatchObject({ status: 404, body: "worker.js not found" });
    expect((await get(h, "/no-such-route", key)).status).toBe(404);
  });

  test("a wrong key, a one-character key and a key in the query are all refused", async () => {
    expect((await get(h, "/api/state", key43())).status).toBe(401);
    expect((await get(h, "/api/state", "x")).status).toBe(401);
    expect((await get(h, `/api/state?k=${key}`)).status).toBe(401);
  });

  test("a malformed escape answers 400, not an error page", async () => {
    expect(await get(h, "/%E0%A4%A")).toMatchObject({ status: 400, body: "Bad request." });
    expect((await get(h, "/%E0%A4%A", key)).status).toBe(400);
  });

  test("serves nothing outside the asset directories", async () => {
    for (const path of ["/..%2Foutside%2Fnote.txt", "/_shared/..%2F..%2Foutside%2Fnote.txt", "/link.js"]) {
      for (const withKey of [false, true]) {
        const r = await get(h, path, withKey ? key : undefined);
        expect(r.status).toBeGreaterThanOrEqual(100);
        expect([path, withKey, r.status === 200]).toEqual([path, withKey, false]);
        expect(r.body.indexOf(sentinel)).toBe(-1);
      }
    }
  });

  describe("/ws", () => {
    test("another site's page is refused, even with the key", async () => {
      const r = await rawRequest(
        h.port,
        wsHandshake(h.port, "/ws", { Origin: "http://example.com", [KEY_HEADER]: key }),
        true,
      );
      expect(r.status).toBe(403);
      expect(r.body).toBe(OTHER_PAGE);
    });

    test("the page's own origin without the key is refused", async () => {
      const r = await rawRequest(h.port, wsHandshake(h.port, "/ws", { Origin: `http://127.0.0.1:${h.port}` }), true);
      expect(r.status).toBe(401);
      expect(r.body).toBe(NEEDS_LINK);
    });

    test("a page whose own name resolves here is refused while the UI listens on loopback", async () => {
      const r = await rawRequest(
        h.port,
        wsHandshake(h.port, "/ws", {
          Host: `elsewhere.example:${h.port}`,
          Origin: `http://elsewhere.example:${h.port}`,
          [KEY_HEADER]: key,
        }),
        true,
      );
      expect(r.status).toBe(403);
      expect(r.body).toBe(OTHER_PAGE);
    });

    test("a script with the key in the header opens it", async () => {
      const r = await rawRequest(h.port, wsHandshake(h.port, "/ws", { [KEY_HEADER]: key }));
      expect(r.status).toBe(101);
    });

    test("the page's offer opens it and is answered with crewhaus-ui, never the key", async () => {
      for (const offer of [
        `${WS_PROTOCOL}, ${WS_KEY_PROTOCOL_PREFIX}${key}`,
        `${WS_KEY_PROTOCOL_PREFIX}${key}, ${WS_PROTOCOL}`,
      ]) {
        const r = await rawRequest(
          h.port,
          wsHandshake(h.port, "/ws", {
            Host: `localhost:${h.port}`,
            Origin: `http://localhost:${h.port}`,
            "Sec-WebSocket-Protocol": offer,
          }),
        );
        expect([offer, r.status]).toEqual([offer, 101]);
        expect(r.head).toMatch(/\r\nsec-websocket-protocol: crewhaus-ui\r?$/im);
        expect(r.raw.indexOf(key)).toBe(-1);
      }
    });

    test("an offer of only the key is not upgraded, so the key is never echoed", async () => {
      const r = await rawRequest(
        h.port,
        wsHandshake(h.port, "/ws", {
          Origin: `http://127.0.0.1:${h.port}`,
          "Sec-WebSocket-Protocol": `${WS_KEY_PROTOCOL_PREFIX}${key}`,
        }),
        true,
      );
      expect(r.status).toBe(400);
      expect(r.raw.indexOf(key)).toBe(-1);
    });

    test("a keyed page client opens and first receives the state", async () => {
      const c = await connectWs(h, key);
      try {
        const first = await c.next(() => true);
        expect(first.type).toBe("state");
      } finally {
        c.close();
      }
    });
  });
});

// ── Server, in-repo layout ───────────────────────────────────────────────────

describe("server (in-repo layout: the harness inside the shape dir)", () => {
  let h: ServeHandle;
  let key: string;
  const sentinel = `env-${randomBytes(8).toString("hex")}`;

  beforeAll(() => {
    const root = tempRoot();
    const shapeDir = join(root, "cli");
    writeShape(shapeDir);
    writeShared(join(root, "_shared"));
    mkdirSync(join(shapeDir, "harness", "node_modules"), { recursive: true });
    writeFileSync(join(shapeDir, "harness", ".env"), `PROVIDER_SECRET=${sentinel}\n`);
    // The layout serve("<shapeDir>") resolves to, through the object form so
    // the port can be 0.
    h = startQuiet({
      uiDir: shapeDir,
      harnessDir: join(shapeDir, "harness"),
      sharedDir: join(root, "_shared"),
      port: 0,
    });
    key = keyOf(h);
  });

  afterAll(async () => {
    await h?.stop();
  });

  test("the harness's .env is never served, by any spelling of its path", async () => {
    // `//harness/.env` goes over a raw socket: Bun's fetch collapses the
    // leading `//` to `/`, which would only test the old guard.
    // `/HARNESS/.env` proves something only on a case-insensitive filesystem.
    for (const withKey of [false, true]) {
      const headers: Record<string, string> = withKey ? { [KEY_HEADER]: key } : {};
      const raw = await rawRequest(h.port, plainGet(h.port, "//harness/.env", headers), true);
      expect(raw.status).toBeGreaterThanOrEqual(100);
      expect([withKey, raw.status === 200]).toEqual([withKey, false]);
      expect(raw.body.indexOf(sentinel)).toBe(-1);
      for (const path of ["/HARNESS/.env", "/harness/.env"]) {
        const r = await get(h, path, withKey ? key : undefined);
        expect([path, withKey, r.status === 200]).toEqual([path, withKey, false]);
        expect(r.body.indexOf(sentinel)).toBe(-1);
      }
    }
  });

  test("with the key, /harness/.env stays forbidden", async () => {
    expect((await get(h, "/harness/.env", key)).status).toBe(403);
  });

  test("config.json and serve.ts are not public", async () => {
    expect((await get(h, "/config.json")).status).toBe(401);
    expect((await get(h, "/serve.ts")).status).toBe(401);
  });
});

// ── What the host hands the harness carries no key ───────────────────────────

describe("the host keeps the key out of what it hands the worker", () => {
  let h: ServeHandle;
  let opKey: string;
  let afterServe: string | undefined;

  beforeAll(() => {
    const root = tempRoot();
    writeShape(
      join(root, "ui"),
      shapeConfig({ shape: "cf-worker-cli", runClass: "cf-worker", entry: ["worker.js"], input: "none" }),
    );
    writeShared(join(root, "_shared"));
    const harnessDir = join(root, "harness");
    mkdirSync(join(harnessDir, "node_modules"), { recursive: true });
    writeFileSync(
      join(harnessDir, "worker.js"),
      [
        "export default {",
        "  async fetch(req, env) {",
        "    return Response.json({",
        '      sawHeader: req.headers.has("x-crewhaus-ui-key"),',
        '      envHasKey: "CREWHAUS_UI_KEY" in env,',
        '      procHasKey: "CREWHAUS_UI_KEY" in process.env,',
        "    });",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    // .dev.vars is merged last into the worker's env, so only the host's own
    // removal keeps this one out.
    writeFileSync(join(harnessDir, ".dev.vars"), `CREWHAUS_UI_KEY=${key43()}\n`);
    opKey = key43();
    process.env.CREWHAUS_UI_KEY = opKey;
    h = startQuiet({ uiDir: join(root, "ui"), harnessDir, sharedDir: join(root, "_shared"), port: 0 });
    afterServe = process.env.CREWHAUS_UI_KEY;
  });

  afterAll(async () => {
    Reflect.deleteProperty(process.env, "CREWHAUS_UI_KEY"); // in case serve() left it
    await h?.stop();
  });

  test("serve() reads the operator's key once and removes it from process.env", () => {
    expect(afterServe).toBeUndefined();
    expect(keyOf(h)).toBe(opKey);
  });

  test("not in the request it forwards, the env it passes, or process.env", async () => {
    const r = await get(h, "/worker/echo", opKey);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ sawHeader: false, envHasKey: false, procHasKey: false });
  });
});

describe("the host keeps the key out of what it hands the daemon, and starts it on loopback", () => {
  let h: ServeHandle;
  let key: string;

  beforeAll(() => {
    const root = tempRoot();
    writeShape(
      join(root, "ui"),
      shapeConfig({
        shape: "managed",
        runClass: "daemon-http",
        entry: ["daemon.ts"],
        input: "none",
        // freePort scans upward from here; 0 would leave the proxy on port 0.
        port: 40000 + (process.pid % 20000),
      }),
    );
    writeShared(join(root, "_shared"));
    const harnessDir = join(root, "harness");
    mkdirSync(join(harnessDir, "node_modules"), { recursive: true });
    writeFileSync(
      join(harnessDir, "daemon.ts"),
      [
        "Bun.serve({",
        "  hostname: process.env.HOST,",
        "  port: Number(process.env.PORT),",
        "  fetch: (req) =>",
        "    Response.json({",
        '      sawHeader: req.headers.has("x-crewhaus-ui-key"),',
        "      host: process.env.HOST ?? null,",
        '      envHasKey: "CREWHAUS_UI_KEY" in process.env,',
        "    }),",
        "});",
        'console.log("ready");',
        "",
      ].join("\n"),
    );
    // The host's `.env` chain reads the harness's parent. (Bun itself loads a
    // `.env` from the child's own directory, which is the operator's to keep
    // the key out of; this one only the host's chain can carry.)
    writeFileSync(join(root, ".env"), `CREWHAUS_UI_KEY=${key43()}\n`);
    h = startQuiet({ uiDir: join(root, "ui"), harnessDir, sharedDir: join(root, "_shared"), port: 0 });
    key = keyOf(h);
  });

  afterAll(async () => {
    await h?.stop();
  });

  test("the proxied request and the child's environment carry no key; HOST is 127.0.0.1", async () => {
    // HOST was removed from process.env in this file's beforeAll, so a
    // developer's exported HOST cannot decide this.
    const c = await connectWs(h, key);
    try {
      c.send({ type: "start" });
      await c.next((m) => m.type === "stdout" && String(m.text).includes("ready"));
      const r = await get(h, "/proxy/echo", key);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ sawHeader: false, host: "127.0.0.1", envHasKey: false });
      c.send({ type: "stop" });
    } finally {
      c.close();
    }
  }, 20_000); // spawns a Bun child and waits for it to listen
});

// ── Start-up ─────────────────────────────────────────────────────────────────

describe("start-up", () => {
  let root: string;
  beforeAll(() => {
    root = tempRoot();
    writeShape(join(root, "ui"));
    writeShared(join(root, "_shared"));
    mkdirSync(join(root, "harness", "node_modules"), { recursive: true });
  });
  const opts = (): ServeOptions => ({
    uiDir: join(root, "ui"),
    harnessDir: join(root, "harness"),
    sharedDir: join(root, "_shared"),
    port: 0,
  });

  test("the banner prints the link, and the key nowhere else", async () => {
    const written: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
    let h: ServeHandle | undefined;
    try {
      h = serve(opts());
    } finally {
      out.mockRestore();
    }
    try {
      expect(h.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#k=[A-Za-z0-9_-]{43}$/);
      const lines = written.join("").split("\n");
      const withKey = lines.filter((l) => l.includes(keyOf(h as ServeHandle)));
      expect(withKey.length).toBe(1);
      expect(withKey[0]).toContain(`> ${h.link}   open this link to sign in (it works on this computer only)`);
    } finally {
      await h.stop();
    }
  });

  test("a refused address is refused before anything listens", () => {
    const listen = spyOn(Bun, "serve").mockImplementation((() => {
      throw new Error("Bun.serve was reached");
    }) as unknown as typeof Bun.serve);
    try {
      let err: unknown;
      try {
        serve({ ...opts(), host: "0.0.0.0" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ServeRefusedError);
      expect((err as ServeRefusedError).reason).toBe("host-needs-key");
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  });
});

describe("one client set per server", () => {
  let a: ServeHandle;
  let b: ServeHandle;

  beforeAll(() => {
    const make = (): ServeOptions => {
      const root = tempRoot();
      writeShape(join(root, "ui"));
      writeShared(join(root, "_shared"));
      mkdirSync(join(root, "harness"), { recursive: true }); // empty: no harness yet
      return { uiDir: join(root, "ui"), harnessDir: join(root, "harness"), sharedDir: join(root, "_shared"), port: 0 };
    };
    a = startQuiet(make());
    b = startQuiet(make());
  });

  afterAll(async () => {
    await a?.stop();
    await b?.stop();
  });

  test("one server's log never reaches the other's page", async () => {
    const ca = await connectWs(a, keyOf(a));
    const cb = await connectWs(b, keyOf(b));
    const fromB = (m: Rec) => m.type === "log" && String(m.line).startsWith("Ignored a rating with no session id");
    const fromA = (m: Rec) => m.type === "log" && String(m.line).startsWith("No compiled harness found");
    try {
      cb.send({ type: "feedback" });
      await cb.next(fromB);
      ca.send({ type: "install" });
      const own = await ca.next(fromA);
      // Frames on one socket arrive in order: a frame B wrote to A's socket
      // before A's own line would sit ahead of it.
      const before = ca.frames.slice(0, ca.frames.indexOf(own));
      expect(ca.frames.indexOf(own)).toBeGreaterThan(-1);
      expect(before.filter(fromB)).toEqual([]);
    } finally {
      ca.close();
      cb.close();
    }
  });
});
