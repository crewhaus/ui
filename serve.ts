#!/usr/bin/env bun
// CrewHaus Shape UIs — root launcher.
//   bun ui/serve.ts <shape>      e.g. `bun ui/serve.ts cli`
// Equivalent to running that shape's own `serve.ts`.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { serve } from "./_shared/host.ts";

const here = import.meta.dir;
const shapes = readdirSync(here)
  .filter((n) => n !== "_shared" && !n.startsWith(".") && statSync(join(here, n)).isDirectory())
  .filter((n) => existsSync(join(here, n, "config.json")))
  .sort();

const shape = process.argv[2];
if (!shape || !shapes.includes(shape)) {
  process.stdout.write(
    `\n  CrewHaus Shape UIs\n\n  Usage: bun ui/serve.ts <shape>\n\n  Available shapes:\n` +
      shapes.map((s) => `    - ${s}`).join("\n") +
      `\n\n  Then drop a compiled bundle into ui/<shape>/harness/ and open the URL.\n`,
  );
  process.exit(shape ? 1 : 0);
}

serve(join(here, shape));
