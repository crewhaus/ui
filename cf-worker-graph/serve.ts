#!/usr/bin/env bun
// CrewHaus cf-worker-graph shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `cf-worker-graph`-target bundle (worker.js + wrangler.toml +
// package.json) into ./harness first, plus a .dev.vars with ANTHROPIC_API_KEY.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
