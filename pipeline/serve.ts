#!/usr/bin/env bun
// CrewHaus RAG Pipeline shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `pipeline`-target bundle (agent.ts) into ./harness first.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
