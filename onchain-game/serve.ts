#!/usr/bin/env bun
// CrewHaus on-chain game shape UI. Run: `bun serve.ts` then open the printed URL.
// Drop a compiled `onchain-game`-target bundle (agent.ts) into ./harness first.
import { serve } from "../_shared/host.ts";
serve(import.meta.dir);
