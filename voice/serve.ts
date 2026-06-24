#!/usr/bin/env bun
// CrewHaus voice shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `voice`-target bundle (daemon.ts + voice-loop.ts + agent.ts)
// into ./harness first.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
