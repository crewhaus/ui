# Drop your compiled graph Worker bundle here

This folder is where the host looks for a CrewHaus bundle compiled with
**`target: cf-worker-graph`** — a self-contained Cloudflare Worker that runs a
**linear chain of single-turn LLM nodes** at the edge, over HTTP with
Server-Sent Events.

## What to drop

The three files emitted by the compiler:

- **`worker.js`** — the ES-module Worker (entrypoint; runs `fetch`). It also
  carries the baked `CONFIG.nodes` array — the UI reads it statically to draw
  the node pipeline before the first run.
- **`wrangler.toml`** — the deploy descriptor (name, compat flags, observability).
- **`package.json`** — the runtime version stamp + deploy scripts.

Plus one secret file you create yourself:

- **`.dev.vars`** — a single line `ANTHROPIC_API_KEY=sk-ant-...`. Every node
  POSTs the Anthropic Messages API with this key. It is git-ignored and never
  deployed; in production you set the same key with
  `wrangler secret put ANTHROPIC_API_KEY`.

## How to produce it

# the cf-worker bundle is emitted by the CrewHaus compiler's cf-worker mode
# (emitAs: "cf-worker") from a `target: graph` spec — it produces worker.js +
# wrangler.toml + package.json. Copy those three files here:
```
cp build/worker.js build/wrangler.toml build/package.json ui/cf-worker-graph/harness/
printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" > ui/cf-worker-graph/harness/.dev.vars
```

## How to run

From the shape directory (one level up):

```
bun ../serve.ts
```

Open the printed URL. There is **no process to start** — this shape has no
lifecycle controls. The host imports `worker.js` in-process and routes every
`/worker/<path>` request straight into the Worker's `fetch` handler, so the
Request Console and the node pipeline are live the moment the page loads.

## How it works

- The console POSTs to `/worker/chat` with `{ "messages": [{ "role", "content" }] }`.
  Your latest message seeds the graph state (`{ input }`).
- The worker runs each node **single-turn in the baked linear order**. Before
  each node it streams a marker `[node N/M: <name>]`, which the UI uses to light
  up the **Node pipeline** panel; intermediate node outputs accumulate into the
  state passed to the next node.
- The **final** node streams its answer token by token as `text` events, then a
  `done` `{ text, stopReason }` (or `error` `{ message }`) event.
- `GET /worker/health` returns `{ ok, harness }` and powers the live endpoint probe.

## Constraints (M2)

This target is **linear, non-HITL, Anthropic-only, tools-free**. The compiler
rejects branching (a node with >1 outgoing edge), cycles, unreachable nodes,
HITL nodes, tools, and non-`claude-*` models — use the local `graph` target for
any of those. If a request 500s with `NO_KEY`, your `.dev.vars` is missing or
unreadable.

---

**Secrets:** copy `.dev.vars.example` → `.dev.vars` in this folder and set `ANTHROPIC_API_KEY`
(Cloudflare’s native local-secrets format — the same file `wrangler dev` reads). It is
gitignored; the host loads it for the worker.
