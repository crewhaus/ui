#!/usr/bin/env bun
// CrewHaus graph shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `graph`-target bundle (agent.ts) into ./harness first.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
