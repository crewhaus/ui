# Drop your compiled Batch Worker here

This folder is where the host looks for a compiled **`batch`-target** CrewHaus bundle.

## What to drop

Drop the single emitted entry file into this directory:

- **`agent.ts`** — the self-contained queue-worker daemon emitted by the compiler.

That one file is the whole bundle. Its `@crewhaus/*` dependencies are installed
automatically the first time you press **Start** (the host scans the imports and
runs `bun install` for you).

## How to compile

```
crewhaus compile crewhaus.yaml -o build      # spec must use target: batch
cp build/agent.ts ./harness/agent.ts
```

## How to run

From the `batch/` shape directory:

```
bun ../serve.ts
```

Then open the printed `http://localhost:4100` URL and press **Start**.

## What happens on Start

The worker takes **no input** — it boots, pulls jobs off its queue, runs one
single-turn agent per job, and **exits on its own** once the queue is drained
(it emits a `queue_idle` event, drains in-flight work, then stops). The dashboard
turns each job into a live row (queued → processing → done / failed) and tallies
throughput, cache hits, retries and dead-lettered jobs as the events stream in.

> v0 ships the **in-memory** queue adapter only. Jobs come from the spec's
> `queue.seedJobs`. If your spec selects SQS / Redis Streams / Postgres the
> worker boots and then exits with a clean "adapter not implemented" diagnostic
> — visible in the worker log and the Raw output drawer.
