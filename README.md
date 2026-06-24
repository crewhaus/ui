# `@crewhaus/ui`

A professional, modern web UI for **every CrewHaus harness shape**. Compile a
spec to any target, point `@crewhaus/ui` at it, and get a polished, shape-aware
interface for it in the browser. No build step, no config.

## Quick start (the one command)

From a directory that holds your compiled harness (and its `crewhaus.yaml`):

```bash
bunx @crewhaus/ui          # detect the shape, write a runner, install the dep
bun crewhaus-ui.ts         # run it  ->  http://localhost:4100
```

`bunx @crewhaus/ui` auto-detects the shape from your spec's `target:` and the
compiled files, then writes a 3-line local runner that "just works":

```ts
// crewhaus-ui.ts
import { serve } from "@crewhaus/ui";
serve({ shape: "cli", harnessDir: import.meta.dir });
```

Force a shape, run without writing a file, or list shapes:

```bash
bunx @crewhaus/ui channel          # force the shape
bunx @crewhaus/ui serve            # run now, no file written
bunx @crewhaus/ui list             # list all shapes
```

Flags: `--dir <harness>` `--out <file>` `--port <n>` `--serve` `--shape <name>`
`--force` `--no-install`. Run `bunx @crewhaus/ui --help` for the full list.

## Programmatic API

```ts
import { serve, detectShape, scaffold, listShapes } from "@crewhaus/ui";

serve({ shape: "graph", harnessDir: "./build", port: 4100 });
```

## Develop against the repo

This repo is also runnable directly (the source the package ships):

```
crewhaus compile crewhaus.yaml -o build      # compile your spec to a shape
cp build/* ui/<shape>/harness/               # drop the compiled files in
bun ui/<shape>/serve.ts                      # run the UI  ->  http://localhost:4100
```

That's it. Open the URL and press **Start** (or **Run**).

## Shapes

| Folder | Target | What the UI gives you |
|---|---|---|
| `cli/` | `cli` | An interactive terminal agent as a chat, with a live activity feed (tools, sub-agents, permissions, cost). |
| `channel/` | `channel` | A bot operator dashboard — channels, live `/status`, an inbound-message simulator, activity + logs. |
| `graph/` | `graph` | A stateful DAG runtime — node graph that lights up as it executes, plus the result. |
| `workflow/` | `workflow` | A step timeline for deterministic multi-step orchestration. |
| `crew/` | `crew` | A multi-role crew — roles panel + handoff timeline. |
| `pipeline/` | `pipeline` | A RAG pipeline — query in, retrieved sources/citations + cited answer. |
| `research/` | `research` | An autonomous research agent — branch tree, sources, assembled report. |
| `batch/` | `batch` | A queue worker — job board + throughput. |
| `voice/` | `voice` | A realtime voice agent — transcript + voice-loop activity (type to simulate speech). |
| `browser/` | `browser` | A computer-use agent — action timeline + viewport info. |
| `managed/` | `managed` | A multi-tenant gateway — health dashboard + request console. |
| `eval/` | `eval` | An eval bundle — score board, per-case verdicts, report. |
| `onchain/` | `onchain` | An event-driven EVM agent — contracts, wallet, tx activity. |
| `onchain-game/` | `onchain-game` | A perceive-act game loop — game state + loop visualization. |
| `cf-worker-cli/` | `cf-worker` (cli) | A Cloudflare Worker agent — streaming SSE request console. |
| `cf-worker-graph/` | `cf-worker` (graph) | The graph runtime at the edge — SSE console + node progression. |
| `cf-worker-workflow/` | `cf-worker` (workflow) | The workflow runtime at the edge — SSE console + step timeline. |
| `claude-plugin/` | `claude-plugin` | A plugin inspector — manifest, MCP servers, README, install instructions. |

## Requirements

- [Bun](https://bun.sh) ≥ 1.2 (the same runtime CrewHaus bundles use).
- A provider credential for the agent to actually think, e.g. `ANTHROPIC_API_KEY`
  — see [Secrets & environment](#secrets--environment) below.

The first run installs the bundle's npm dependencies (`@crewhaus/*`, all public)
automatically — subsequent runs are instant.

## Secrets & environment

Agents need credentials (a provider key, maybe channel tokens or an RPC URL).
**These live in `.env` files that are never committed** — every folder that needs
one ships a `*.example` template. Copy it, drop in real values, and the host
loads it for you:

```bash
cp .env.example .env            # repo-root: applies to ALL shapes (best for a shared key)
# …or per shape:
cp cli/harness/.env.example cli/harness/.env
# …cf-worker shapes use Cloudflare's native format:
cp cf-worker-cli/harness/.dev.vars.example cf-worker-cli/harness/.dev.vars
```

The host loads `.env` in increasing precedence: **repo-root → `<shape>/` →
`<shape>/harness/`**, and an exported shell variable overrides them all. So a
single `ANTHROPIC_API_KEY` in the root `.env` covers every shape, and a
`<shape>/harness/.env` can override it per shape. cf-worker shapes read
`<shape>/harness/.dev.vars` (the same file `wrangler dev` uses).

`.gitignore` keeps real `.env` / `.dev.vars` files out of git; only the
`.example` templates are tracked.

## How it works

Each shape folder is a tiny static front-end plus a one-line `serve.ts`. A single
shared host (`_shared/host.ts`) does the work:

- **Detects** your dropped-in entry file (`daemon.ts` › `agent.ts` › `worker.js`).
- **Installs** dependencies on first run (it scans the bundle's imports).
- **Runs** the harness the way its shape demands:
  - *stdio* shapes (cli, graph, workflow, crew, pipeline, research, batch, voice,
    browser, eval, onchain, onchain-game) are spawned as `bun <entry>`, with
    stdin/stdout bridged to the browser.
  - *daemon* shapes (channel, managed) are spawned on an internal port and
    reverse-proxied.
  - *cf-worker* shapes are imported and their `fetch` handler is invoked directly
    (Server-Sent Events stream straight to the page) — no `wrangler` needed.
  - *plugin* bundles are parsed and inspected (nothing to run).
- **Streams** structured `TraceEvent`s. Bundles run with `CREWHAUS_TRACE=json`, so
  the UI renders tool calls, sub-agents, permission decisions, cost, model
  responses, role hand-offs, eval verdicts, and more — as they happen.

The front-end is dependency-free: a small DOM toolkit (`_shared/ui.js`), a
TraceEvent renderer (`_shared/events.js`), shared chrome (`_shared/app-kit.js`),
and one design system (`_shared/ui.css`). All rendering is built from DOM nodes
and `textContent`, so a harness can never inject markup into the page.

## Configuration

- `CREWHAUS_UI_PORT` — change the UI port (default `4100`).
- `CREWHAUS_SANDBOX=noop` — disable the code-exec sandbox floor.
- Anything in a `.env` (or an exported var) is forwarded to the harness; `PORT`
  for daemon shapes is assigned automatically. See
  [Secrets & environment](#secrets--environment).

## Folder layout

```
ui/
  .env.example    copy to .env — a shared key/config for every shape
  _shared/        host.ts, ui.css, ui.js, events.js, app-kit.js   (the engine)
  <shape>/
    config.json   how this shape is run + which panels to show
    index.html    loads the shared assets + app.js
    serve.ts      `serve(import.meta.dir)` — run this
    app.js        the shape's tailored interface
    harness/      <-- drop your compiled bundle here
      .env.example          copy to .env for per-shape secrets
                            (cf-worker shapes: .dev.vars.example -> .dev.vars)
```
