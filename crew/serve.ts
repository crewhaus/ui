#!/usr/bin/env bun
// CrewHaus crew shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `crew`-target bundle (daemon.ts + orchestrator.ts + agent_*.ts)
// into ./harness first.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
