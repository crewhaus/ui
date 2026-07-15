/**
 * File upload / attach (host side).
 *
 * DOM-less/host tests for the local-write path behind the composer's attach
 * control (decision §10.3 — user-directed, LOCAL, never CrewHaus-hosted):
 *   • filename sanitization (basename only; traversal in the name is defeated)
 *   • destination resolution (default `uploads/`, configured relative/absolute,
 *     traversal refusal) mirroring the secret `.env` writer's guard
 *   • the base64 size cap (rejected before decode; nothing written)
 *   • the Supervisor `attach` handler writing 0600, de-duping, and returning a
 *     local path — while NEVER echoing the raw bytes in its broadcast
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPlausibleBase64,
  resolveUploadDir,
  sanitizeUploadName,
  Supervisor,
  UPLOAD_DEFAULT_DIR,
  UPLOAD_MAX_BYTES,
  uniqueUploadPath,
  uploadDisplayPath,
} from "../_shared/host.ts";

const TMP_ROOT = join(import.meta.dir, `.tmp-attach-test-${process.pid}`);
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

const CONFIG = {
  shape: "cli",
  title: "test",
  tagline: "",
  runClass: "stdio-oneshot",
  entry: ["agent.ts"],
  input: "oneshot",
} as const;

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A harness root with a crewhaus.yaml so findHarnessRoot latches it here. */
function makeRoot(name: string): string {
  const root = join(TMP_ROOT, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "crewhaus.yaml"), "target: cli\nname: demo\n");
  return root;
}

/** Drive one `attach` message through a fresh Supervisor, collect broadcasts. */
async function attach(
  root: string,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const msgs: Record<string, unknown>[] = [];
  const sup = new Supervisor(root, CONFIG as never, (m) => msgs.push(m as Record<string, unknown>));
  await sup.handle({ type: "attach", ...msg } as never);
  return msgs;
}
const result = (msgs: Record<string, unknown>[]) => msgs.find((m) => m.type === "attach_result");

// ── sanitizeUploadName (basename only; traversal defeated) ───────────────────

describe("sanitizeUploadName", () => {
  test("keeps a plain basename (incl. spaces/parens)", () => {
    expect(sanitizeUploadName("data.csv")).toBe("data.csv");
    expect(sanitizeUploadName("My Report (final).pdf")).toBe("My Report (final).pdf");
  });

  test("strips any directory component, defeating traversal in the name", () => {
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("/abs/evil.sh")).toBe("evil.sh");
    expect(sanitizeUploadName("a\\b\\c.txt")).toBe("c.txt");
  });

  test("rejects empty / reserved / control-only names", () => {
    expect(sanitizeUploadName("")).toBeNull();
    expect(sanitizeUploadName(".")).toBeNull();
    expect(sanitizeUploadName("..")).toBeNull();
    expect(sanitizeUploadName("../")).toBeNull(); // basename is empty
    expect(sanitizeUploadName("\x00\x01")).toBeNull();
  });

  test("bounds a pathological length, preserving the extension", () => {
    const out = sanitizeUploadName("x".repeat(500) + ".txt");
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(200);
    expect((out as string).endsWith(".txt")).toBe(true);
  });
});

// ── resolveUploadDir (default + configurable + traversal guard) ──────────────

describe("resolveUploadDir", () => {
  const root = join(TMP_ROOT, "harn");

  test("defaults to <root>/uploads", () => {
    expect(resolveUploadDir(root)).toBe(join(root, UPLOAD_DEFAULT_DIR));
    expect(resolveUploadDir(root, "")).toBe(join(root, UPLOAD_DEFAULT_DIR));
  });

  test("honours an absolute path as user-owned", () => {
    expect(resolveUploadDir(root, "/data/inbox")).toBe("/data/inbox");
  });

  test("resolves a relative path under the root", () => {
    expect(resolveUploadDir(root, "uploads/sub")).toBe(join(root, "uploads", "sub"));
    expect(resolveUploadDir(root, "in")).toBe(join(root, "in"));
  });

  test("refuses traversal / NUL", () => {
    expect(resolveUploadDir(root, "../evil")).toBeNull();
    expect(resolveUploadDir(root, "a/../../evil")).toBeNull();
    expect(resolveUploadDir(root, "a\0b")).toBeNull();
  });
});

// ── isPlausibleBase64 (pre-decode size + charset guard) ──────────────────────

describe("isPlausibleBase64", () => {
  test("accepts a valid payload within the cap", () => {
    expect(isPlausibleBase64(b64("hello"), UPLOAD_MAX_BYTES)).toBe(true);
  });

  test("rejects empty / non-base64 garbage", () => {
    expect(isPlausibleBase64("", UPLOAD_MAX_BYTES)).toBe(false);
    expect(isPlausibleBase64("!!! not base64 !!!", UPLOAD_MAX_BYTES)).toBe(false);
  });

  test("rejects a payload that would exceed the cap before decoding", () => {
    expect(isPlausibleBase64("A".repeat(1000), 100)).toBe(false);
  });
});

// ── uploadDisplayPath / uniqueUploadPath (pure) ──────────────────────────────

describe("uploadDisplayPath", () => {
  test("relativizes a path inside the root to ./…", () => {
    expect(uploadDisplayPath("/h", "/h/uploads/x.csv")).toBe("./uploads/x.csv");
    expect(uploadDisplayPath("/h", "/h")).toBe(".");
  });

  test("returns the absolute path when the target is outside the root", () => {
    expect(uploadDisplayPath("/h", "/data/x.csv")).toBe("/data/x.csv");
  });
});

describe("uniqueUploadPath", () => {
  test("returns the name as-is when free, then de-dupes with ` (n)`", () => {
    const dir = join(TMP_ROOT, "dedupe");
    mkdirSync(dir, { recursive: true });
    expect(uniqueUploadPath(dir, "a.txt")).toBe(join(dir, "a.txt"));
    writeFileSync(join(dir, "a.txt"), "1");
    expect(uniqueUploadPath(dir, "a.txt")).toBe(join(dir, "a (2).txt"));
  });
});

// ── Supervisor attach handler (integration) ──────────────────────────────────

describe("Supervisor attach handler", () => {
  test("writes to the default <root>/uploads/ at 0600 and returns the local path", async () => {
    const root = makeRoot("default");
    const msgs = await attach(root, { name: "data.csv", contentBase64: b64("a,b,c\n1,2,3\n") });
    const res = result(msgs);
    expect(res?.ok).toBe(true);
    expect(res?.relPath).toBe("./uploads/data.csv");
    const full = join(root, "uploads", "data.csv");
    expect(existsSync(full)).toBe(true);
    expect(readFileSync(full, "utf8")).toContain("1,2,3");
    expect(statSync(full).mode & 0o777).toBe(0o600);
  });

  test("honours a configured relative destination under the root", async () => {
    const root = makeRoot("configured");
    const msgs = await attach(root, { name: "n.txt", contentBase64: b64("hi"), dir: "inbox/files" });
    const res = result(msgs);
    expect(res?.ok).toBe(true);
    expect(res?.relPath).toBe("./inbox/files/n.txt");
    expect(existsSync(join(root, "inbox", "files", "n.txt"))).toBe(true);
  });

  test("honours an absolute destination as user-owned (path returned absolute)", async () => {
    const root = makeRoot("abs");
    const dest = join(TMP_ROOT, "abs-dest");
    const msgs = await attach(root, { name: "x.bin", contentBase64: b64("z"), dir: dest });
    const res = result(msgs);
    expect(res?.ok).toBe(true);
    expect(res?.relPath).toBe(join(dest, "x.bin")); // outside root → absolute
    expect(existsSync(join(dest, "x.bin"))).toBe(true);
  });

  test("REFUSES a traversal destination and writes nothing outside the root", async () => {
    const root = makeRoot("dir-traversal");
    const msgs = await attach(root, { name: "e.txt", contentBase64: b64("x"), dir: "../escaped" });
    const res = result(msgs);
    expect(res?.ok).toBe(false);
    expect(String(res?.error)).toMatch(/denied|traversal/i);
    expect(existsSync(join(root, "..", "escaped"))).toBe(false);
  });

  test("sanitizes a traversal FILENAME to a basename inside uploads/", async () => {
    const root = makeRoot("name-traversal");
    const msgs = await attach(root, { name: "../../etc/passwd", contentBase64: b64("nope") });
    const res = result(msgs);
    expect(res?.ok).toBe(true);
    expect(res?.relPath).toBe("./uploads/passwd");
    expect(existsSync(join(root, "uploads", "passwd"))).toBe(true);
    expect(existsSync(join(root, "..", "..", "etc", "passwd"))).toBe(false); // nothing escaped
  });

  test("de-dupes rather than clobbering an existing file", async () => {
    const root = makeRoot("dedupe-write");
    await attach(root, { name: "a.txt", contentBase64: b64("first") });
    const res = result(await attach(root, { name: "a.txt", contentBase64: b64("second") }));
    expect(res?.relPath).toBe("./uploads/a (2).txt");
    expect(readFileSync(join(root, "uploads", "a.txt"), "utf8")).toBe("first");
    expect(readFileSync(join(root, "uploads", "a (2).txt"), "utf8")).toBe("second");
  });

  test("rejects an oversized upload before decoding and writes nothing", async () => {
    const root = makeRoot("toobig");
    // A base64 string whose decoded size would exceed the cap.
    const huge = "A".repeat(Math.ceil((UPLOAD_MAX_BYTES / 3) * 4) + 16);
    const res = result(await attach(root, { name: "big.bin", contentBase64: huge }));
    expect(res?.ok).toBe(false);
    expect(String(res?.error)).toMatch(/limit|large|exceeds/i);
    expect(existsSync(join(root, "uploads", "big.bin"))).toBe(false);
  });

  test("rejects an empty / malformed payload", async () => {
    const root = makeRoot("empty");
    expect(result(await attach(root, { name: "x.txt", contentBase64: "" }))?.ok).toBe(false);
  });

  test("rejects an invalid file name", async () => {
    const root = makeRoot("badname");
    expect(result(await attach(root, { name: "..", contentBase64: b64("x") }))?.ok).toBe(false);
  });

  test("never echoes the raw file bytes in the result broadcast", async () => {
    const root = makeRoot("noecho");
    const secret = "SUPER_SECRET_CONTENT";
    const msgs = await attach(root, { name: "s.txt", contentBase64: b64(secret) });
    expect(result(msgs)?.ok).toBe(true);
    expect(JSON.stringify(msgs)).not.toContain(secret);
    expect(JSON.stringify(msgs)).not.toContain(b64(secret));
  });

  test("threads the correlation id back on the result", async () => {
    const root = makeRoot("id");
    const msgs = await attach(root, { id: "att_9", name: "x.txt", contentBase64: b64("x") });
    expect(result(msgs)?.id).toBe("att_9");
  });
});
