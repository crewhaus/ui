# Drop your compiled Workflow Worker bundle here

This folder is where the host looks for a CrewHaus bundle compiled with
**`target: cf-worker-workflow`** — a self-contained Cloudflare Worker that runs a
multi-step workflow at the edge and streams it back over Server-Sent Events.

## What to drop

The three files emitted by the compiler:

- **`worker.js`** — the ES-module Worker (entrypoint; runs `fetch`). It bakes in
  the workflow's step plan (`CONFIG.steps`), which this UI reads to draw the
  Step Timeline before you even run.
- **`wrangler.toml`** — the deploy descriptor (name, compat date, observability).
- **`package.json`** — the runtime version stamp + deploy scripts.

Plus one secret file you create yourself:

- **`.dev.vars`** — a single line `ANTHROPIC_API_KEY=sk-ant-...`. The worker
  reads this for the upstream Anthropic Messages API calls (one per step). It is
  git-ignored and never deployed; in production you set the same key with
  `wrangler secret put ANTHROPIC_API_KEY`.

## How to produce it

# the cf-worker bundle is emitted by the CrewHaus compiler's cf-worker mode
# (emitAs: "cf-worker") from a `target: workflow` spec — it produces worker.js +
# wrangler.toml + package.json. Copy those three files here:
```
cp build/worker.js build/wrangler.toml build/package.json ui/cf-worker-workflow/harness/
printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" > ui/cf-worker-workflow/harness/.dev.vars
```

## How to run

From the shape directory (one level up):

```
bun ../serve.ts
```

Open the printed URL. There is **no process to start** — this shape has no
lifecycle controls. The host imports `worker.js` in-process and routes every
`/worker/<path>` request straight into the Worker's `fetch` handler, so the
Request Console and Step Timeline work the moment the page loads.

## How it works

- The console POSTs to `/worker/chat` with `{ "messages": [{ "role", "content" }] }`.
  Your latest user message is the workflow's initial input.
- The worker runs the steps **sequentially, server-side**: steps `1..N-1` are
  non-streaming calls whose terminal assistant text is threaded into the next
  step's user message; the **final** step streams token by token.
- Progress arrives inline in the `text` stream as markers
  `\n[step N/total: <name>]\n`. This UI parses those out, advances the **Step
  Timeline**, and keeps them out of the answer panel.
- `GET /worker/health` returns `{ ok, harness }` and powers the live endpoint probe.

## Notes

- This target is **Anthropic-only** and **tools-free**: the worker inlines a
  minimal `api.anthropic.com` client and POSTs each step's baked-in `claude-*`
  model. Steps with tools or non-Anthropic models are rejected at compile time —
  use the local `workflow` target for those.
- If a request 500s with `NO_KEY`, your `.dev.vars` is missing or unreadable.

---

**Secrets:** copy `.dev.vars.example` → `.dev.vars` in this folder and set `ANTHROPIC_API_KEY`
(Cloudflare’s native local-secrets format — the same file `wrangler dev` reads). It is
gitignored; the host loads it for the worker.
