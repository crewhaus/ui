# Drop your compiled Cloudflare Worker bundle here

This folder is where the host looks for a CrewHaus bundle compiled with
**`target: cf-worker-cli`** — a self-contained Cloudflare Worker that exposes
your agent over HTTP with Server-Sent Events.

## What to drop

The three files emitted by the compiler:

- **`worker.js`** — the ES-module Worker (entrypoint; runs `fetch`).
- **`wrangler.toml`** — the deploy descriptor (name, routes, observability).
- **`package.json`** — the runtime version stamp + deploy scripts.

Plus one secret file you create yourself:

- **`.dev.vars`** — a single line `ANTHROPIC_API_KEY=sk-ant-...`. The worker
  reads this for the upstream Anthropic Messages API call. It is git-ignored and
  never deployed; in production you set the same key with
  `wrangler secret put ANTHROPIC_API_KEY`.

## How to produce it

# the cf-worker bundle is emitted by the CrewHaus compiler's cf-worker mode
# (emitAs: "cf-worker") from a `target: cli` spec — it produces worker.js +
# wrangler.toml + package.json. Copy those three files here:
```
cp build/worker.js build/wrangler.toml build/package.json ui/cf-worker-cli/harness/
printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" > ui/cf-worker-cli/harness/.dev.vars
```

## How to run

From the shape directory (one level up):

```
bun ../serve.ts
```

Open the printed URL. There is **no process to start** — this shape has no
lifecycle controls. The host imports `worker.js` in-process and routes every
`/worker/<path>` request straight into the Worker's `fetch` handler, so the
Request Console works the moment the page loads.

## Notes

- The console POSTs to `/worker/chat` with `{ "messages": [{ "role", "content" }] }`
  and renders the `text` / `done` / `error` SSE events live, token by token.
- `GET /worker/health` returns `{ ok, harness }` and powers the live endpoint probe.
- This target is **Anthropic-only** and **tools-free** (M0): the worker inlines a
  minimal `api.anthropic.com` streaming client and POSTs the baked-in model.
- If a request 500s with `NO_KEY`, your `.dev.vars` is missing or unreadable.

---

**Secrets:** copy `.dev.vars.example` → `.dev.vars` in this folder and set `ANTHROPIC_API_KEY`
(Cloudflare’s native local-secrets format — the same file `wrangler dev` reads). It is
gitignored; the host loads it for the worker.
