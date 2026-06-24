# Drop your compiled graph bundle here

This UI runs any bundle compiled from a CrewHaus spec with **`target: graph`** — a
stateful DAG of LLM-backed nodes that threads state along its edges from an entry
node to a terminal node.

## What to drop

Copy the single emitted entry file into this folder:

- **`agent.ts`** — the generated graph runtime (emitted by `crewhaus compile`).

That one file is the whole bundle; it imports `@crewhaus/graph-engine`,
`@crewhaus/runtime-core`, and `@crewhaus/checkpoint-store` from npm, which are
installed automatically on first run.

## How to compile it

```
crewhaus compile crewhaus.yaml -o build
```

Then copy `build/agent.ts` into this `harness/` directory.

## How to run

From the shape directory (one level up):

```
bun ../serve.ts
```

Open the printed URL. Click **Start** (dependencies install automatically on the
first run), type an initial message in the **Run** box, and send it.

## How a run works

The graph reads your message from stdin as the initial state, runs each node in
edge order — every LLM node adds its reply to the state under its own name
(`state.plan`, `state.execute`, `state.summarise`, …) — and emits the final state
as the result. The **Graph** panel lights up each node as it enters and completes.

If a node declares a human-in-the-loop prompt, the run **pauses** and prints a
resume command. You can resume or time-travel from the shell:

```
bun agent.ts --resume <graphRunId> <decision>
bun agent.ts --branch-from <graphRunId> <checkpointId>
```

---

**Secrets:** copy `.env.example` → `.env` in this folder and fill in your provider key
(and any `${VAR}` your spec uses). The host loads it for the harness; `.env` is gitignored.
A key in the repo-root `.env` covers every shape instead.
