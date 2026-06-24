#!/usr/bin/env bun
// CrewHaus Managed Runtime shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `managed`-target bundle (daemon.ts + agent.ts) into ./harness first.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
