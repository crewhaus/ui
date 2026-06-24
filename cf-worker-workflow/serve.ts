#!/usr/bin/env bun
// CrewHaus cf-worker-workflow shape UI. Run: `bun serve.ts` then open the URL.
// Drop a compiled `cf-worker-workflow`-target bundle (worker.js + wrangler.toml +
// package.json) into ./harness first, and add a .dev.vars with ANTHROPIC_API_KEY.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
