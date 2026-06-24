#!/usr/bin/env bun
// CrewHaus eval shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `eval`-target bundle (agent.ts) into ./harness first, and
// make sure a dataset exists under .crewhaus/datasets (see harness README).
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
