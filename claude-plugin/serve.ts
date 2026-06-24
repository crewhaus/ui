#!/usr/bin/env bun
// CrewHaus claude-plugin shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `claude-plugin`-target bundle (.claude-plugin/, .mcp.json,
// README.md, skills/, agents/) into ./harness — nothing runs; it's inspected.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
