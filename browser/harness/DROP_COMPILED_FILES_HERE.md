# Drop your compiled Browser Agent here

This folder is where the Browser Agent UI looks for a compiled CrewHaus bundle.

## What to drop

A single file:

- **`agent.ts`** — the entry emitted by compiling a spec with `target: browser`.

That's the only file this shape needs. The bundle pulls its dependencies
(`@crewhaus/computer-use-driver`, the Navigate / Screenshot / Click / Type / Key /
Scroll / FindElement tools, and `@crewhaus/runtime-core`) from npm on first run.

## How to produce it

```
crewhaus compile crewhaus.yaml -o build
```

Then copy `build/agent.ts` into this `harness/` folder.

## How to run

From the shape directory (one level up):

```
bun ../serve.ts
```

Open the printed URL, type a task ("Find the price of the cheapest flight from SFO
to JFK next Friday"), and press **Run**. Dependencies install automatically on the
first run.

## Notes

- This is a **single-shot** agent: each Run spawns a fresh `bun agent.ts`, feeds
  your task on stdin, drives the browser to completion, then exits. There is no
  multi-turn chat.
- The agent reads its task from stdin (or `--prompt <text>`). The UI uses stdin.
- A real browser backend is required for `chromium`/`remote` driver specs
  (Playwright-backed Chromium). The `host` backend uses the machine's own display.
- Screenshots are captured for the *model* to see, not streamed to this UI — the
  host only observes that a Screenshot tool call happened and how large the result
  was. The UI shows a rich **action timeline** instead.

---

**Secrets:** copy `.env.example` → `.env` in this folder and fill in your provider key
(and any `${VAR}` your spec uses). The host loads it for the harness; `.env` is gitignored.
A key in the repo-root `.env` covers every shape instead.
