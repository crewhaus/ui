/**
 * Where the UI listens, read from the socket table: `lsof` on macOS, `ss` on
 * Linux. Never from the server's own getter, and never by fetching the address
 * it bound, since neither can tell 127.0.0.1 from a wildcard.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServeHandle } from "../_shared/host.ts";

type Tool = "lsof" | "ss";

/** The socket-table tool for this OS, or undefined when it is not installed. */
function socketTool(): Tool | undefined {
  if (process.platform === "darwin") return Bun.which("lsof") ? "lsof" : undefined;
  if (process.platform === "linux") return Bun.which("ss") ? "ss" : undefined;
  return undefined;
}

/** `lsof -Fn` prints one `n<address>:<port>` line per listening socket. */
function parseLsof(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("n"))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);
}

/** `ss -ltnH` prints the local `<address>:<port>` in column 4. */
function parseSs(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[3])
    .filter((a): a is string => typeof a === "string" && a !== "");
}

/** Whether a listening address is this computer only, every address, or other. */
function classify(entry: string): "loopback" | "wildcard" | "other" {
  const host = entry.slice(0, entry.lastIndexOf(":"));
  if (host === "*" || host === "0.0.0.0" || host === "[::]" || host === "::") return "wildcard";
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || host === "[::1]" || host === "::1") return "loopback";
  return "other";
}

/**
 * What listens on `port` in this process. `undefined` means it could not be
 * determined (no tool), which is not the same as `[]` (nothing listens).
 */
function listening(port: number): string[] | undefined {
  const tool = socketTool();
  if (tool === undefined) return undefined;
  if (tool === "lsof") {
    const r = Bun.spawnSync(["lsof", "-nP", "-a", "-p", String(process.pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"]);
    return parseLsof(r.stdout.toString());
  }
  const r = Bun.spawnSync(["ss", "-ltnH", `sport = :${port}`]);
  return parseSs(r.stdout.toString());
}

describe("the socket-table readers", () => {
  test("lsof lines: each address is found and labelled", () => {
    const out = ["p4242", "f12", "n127.0.0.1:5", "f13", "n*:5", "f14", "n[::1]:5", ""].join("\n");
    const found = parseLsof(out);
    expect(found).toEqual(["127.0.0.1:5", "*:5", "[::1]:5"]);
    expect(found.map(classify)).toEqual(["loopback", "wildcard", "loopback"]);
  });

  test("ss lines: each address is found and labelled", () => {
    const out = [
      "LISTEN 0      512        127.0.0.1:5        0.0.0.0:*",
      "LISTEN 0      512          0.0.0.0:5        0.0.0.0:*",
      "LISTEN 0      512                *:5              *:*",
      "LISTEN 0      512             [::]:5           [::]:*",
      "",
    ].join("\n");
    const found = parseSs(out);
    expect(found).toEqual(["127.0.0.1:5", "0.0.0.0:5", "*:5", "[::]:5"]);
    expect(found.map(classify)).toEqual(["loopback", "wildcard", "wildcard", "wildcard"]);
  });

  test("nothing listening is an empty list, not undefined", () => {
    expect(parseLsof("")).toEqual([]);
    expect(parseSs("")).toEqual([]);
  });
});

describe("the default server", () => {
  const tool = socketTool();
  const saved = { host: process.env.CREWHAUS_UI_HOST, key: process.env.CREWHAUS_UI_KEY };
  let root: string;
  let h: ServeHandle | undefined;

  beforeAll(() => {
    Reflect.deleteProperty(process.env, "CREWHAUS_UI_HOST");
    Reflect.deleteProperty(process.env, "CREWHAUS_UI_KEY");
    root = mkdtempSync(join(tmpdir(), "crewhaus-ui-"));
    const ui = join(root, "ui");
    mkdirSync(ui, { recursive: true });
    mkdirSync(join(root, "_shared"), { recursive: true });
    mkdirSync(join(root, "harness"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<!doctype html>");
    writeFileSync(
      join(ui, "config.json"),
      JSON.stringify({
        shape: "cli",
        title: "Bind",
        tagline: "",
        runClass: "stdio-oneshot",
        entry: ["agent.ts"],
        input: "oneshot",
      }),
    );
    const out = spyOn(process.stdout, "write").mockImplementation(
      (() => true) as unknown as typeof process.stdout.write,
    );
    try {
      h = serve({ uiDir: ui, harnessDir: join(root, "harness"), sharedDir: join(root, "_shared"), port: 0 });
    } finally {
      out.mockRestore();
    }
  });

  afterAll(async () => {
    await h?.stop();
    rmSync(root, { recursive: true, force: true });
    for (const [name, value] of [
      ["CREWHAUS_UI_HOST", saved.host],
      ["CREWHAUS_UI_KEY", saved.key],
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  });

  const why = tool ? "" : " (skipped: no lsof or ss on this machine; CI's smoke checks the bind)";
  test.skipIf(tool === undefined)(`listens on 127.0.0.1 only${why}`, () => {
    const port = (h as ServeHandle).port;
    const found = listening(port);
    expect(found).toBeDefined();
    expect((found as string[]).length).toBeGreaterThan(0);
    for (const entry of found as string[]) expect(entry).toBe(`127.0.0.1:${port}`);
  });
});
