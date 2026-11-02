#!/usr/bin/env bun
/**
 * crewhaus-ui — scaffold (or directly run) a UI for a compiled CrewHaus harness.
 *
 *   crewhaus-ui                 detect the shape here, write a runner, install dep
 *   crewhaus-ui <shape>         force a shape
 *   crewhaus-ui serve [shape]   run the UI now (no file written)
 *   crewhaus-ui list            list shapes
 *
 * The scaffolded runner is a 3-line file that imports `@crewhaus/ui` and "just
 * works": `bun crewhaus-ui.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { join } from "node:path";
import { spawn } from "bun";
import { detectShape, listShapes, resolveHarnessDir, scaffold } from "../src/scaffold.ts";
import { serve, ServeRefusedError, type ServeOptions } from "../_shared/host.ts";

const HELP = `crewhaus-ui — drop-in UIs for compiled CrewHaus harnesses

Usage
  crewhaus-ui [shape] [options]     write a local runner that imports @crewhaus/ui (default)
  crewhaus-ui serve [shape] [opts]  run the UI now, no file written
  crewhaus-ui list                  list available shapes

Options
  -d, --dir <dir>     harness dir (compiled files). Default: auto (., ./build, ./dist)
  -o, --out <file>    runner file to write. Default: crewhaus-ui.ts
  -p, --port <n>      UI port. Default: 4100 (or $CREWHAUS_UI_PORT)
      --host <addr>   listen address. Default: 127.0.0.1 (this computer only); any other address needs CREWHAUS_UI_KEY
  -s, --serve         run the UI right after scaffolding
      --shape <name>  force the shape (skip auto-detection)
      --force         overwrite an existing runner file
      --no-install    don't run \`bun add @crewhaus/ui\`
  -h, --help

The shape is auto-detected from your spec's \`target:\` (and the compiled files).
`;

function die(msg: string): never {
  process.stderr.write(`crewhaus-ui: ${msg}\n`);
  process.exit(1);
}

/** Run the UI; a refused address or key is a one-line error, not a stack. */
function serveOrDie(opts: ServeOptions): void {
  try {
    serve(opts);
  } catch (e) {
    if (e instanceof ServeRefusedError) die(e.message);
    throw e;
  }
}

// ── Parse argv ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags: {
  help?: boolean;
  serve?: boolean;
  force?: boolean;
  noInstall?: boolean;
  dir?: string;
  out?: string;
  port?: number;
  host?: string;
  shape?: string;
} = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") flags.help = true;
  else if (a === "-s" || a === "--serve") flags.serve = true;
  else if (a === "--force") flags.force = true;
  else if (a === "--no-install") flags.noInstall = true;
  else if (a === "-d" || a === "--dir") flags.dir = argv[++i];
  else if (a === "-o" || a === "--out") flags.out = argv[++i];
  else if (a === "-p" || a === "--port") flags.port = Number(argv[++i]);
  else if (a === "--host") {
    // No --key flag on purpose: other users of this computer can read argv.
    const v = argv[++i];
    if (!v || v.startsWith("-")) die("--host needs an address");
    flags.host = v;
  } else if (a === "--shape") flags.shape = argv[++i];
  else if (a.startsWith("-")) die(`unknown flag: ${a}`);
  else positional.push(a);
}

const COMMANDS = new Set(["serve", "list", "add", "init", "help"]);
const cmd = positional[0] && COMMANDS.has(positional[0]) ? (positional.shift() as string) : "add";

if (flags.help || cmd === "help") {
  process.stdout.write(HELP);
  process.exit(0);
}
if (cmd === "list") {
  process.stdout.write(`Available shapes:\n${listShapes().map((s) => `  - ${s}`).join("\n")}\n`);
  process.exit(0);
}

// ── Resolve harness dir + shape ─────────────────────────────────────────────
const cwd = process.cwd();
const harnessDir = resolveHarnessDir(flags.dir, cwd);
const shapes = listShapes();
const shape = flags.shape || positional[0] || detectShape(harnessDir) || "";
if (!shape) {
  die(
    `couldn't detect a shape in ${harnessDir}.\n` +
      `  Pass one explicitly, e.g. \`crewhaus-ui cli\`.\n` +
      `  Shapes: ${shapes.join(", ")}`,
  );
}
if (!shapes.includes(shape)) {
  die(`unknown shape "${shape}". Available: ${shapes.join(", ")}`);
}

// ── serve: run now ──────────────────────────────────────────────────────────
if (cmd === "serve") {
  serveOrDie({ shape, harnessDir, port: flags.port, host: flags.host });
} else {
  // ── scaffold a local runner ───────────────────────────────────────────────
  const outFile = resolve(cwd, flags.out || "crewhaus-ui.ts");
  let written: string;
  try {
    written = scaffold({ shape, harnessDir, outFile, port: flags.port, force: flags.force });
  } catch (e) {
    die((e as Error).message);
  }
  process.stdout.write(`\n  ✓ wrote ${basename(written)}  (shape: ${shape}, harness: ${harnessDir})\n`);

  if (!flags.noInstall) await ensureDep(cwd);

  process.stdout.write(`\n  Next:\n    bun ${basename(written)}\n  then open the link it prints\n\n`);

  if (flags.serve) serveOrDie({ shape, harnessDir, port: flags.port, host: flags.host });
}

// ── Ensure @crewhaus/ui is installed in the user's project ──────────────────
async function ensureDep(dir: string): Promise<void> {
  if (existsSync(join(dir, "node_modules", "@crewhaus", "ui"))) return;
  const pj = join(dir, "package.json");
  let listed = false;
  if (existsSync(pj)) {
    try {
      const p = JSON.parse(readFileSync(pj, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      listed = !!(p.dependencies?.["@crewhaus/ui"] || p.devDependencies?.["@crewhaus/ui"]);
    } catch {
      /* unreadable package.json */
    }
  }
  process.stdout.write(`  Installing @crewhaus/ui …\n`);
  const proc = spawn(["bun", "add", "@crewhaus/ui"], { cwd: dir, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    process.stderr.write(
      `  warning: \`bun add @crewhaus/ui\` failed${listed ? "" : ""} — install it manually before running the runner.\n`,
    );
  }
}
