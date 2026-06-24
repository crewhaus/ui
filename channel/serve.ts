#!/usr/bin/env bun
// CrewHaus channel shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `channel`-target bundle (daemon.ts + agent.ts +
// session-router.ts + gateway.ts) into ./harness first.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
