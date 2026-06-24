# Drop your compiled research bundle here

This folder is where the host looks for a CrewHaus bundle compiled with
**`target: research`**.

## What to drop

Exactly one file:

- **`agent.ts`** — the self-contained research daemon emitted by the compiler.

That single file decomposes your goal into branches, researches each one with
the `Source` / `CiteFact` tools, and assembles a cited markdown report under
`.crewhaus/research/<runId>/`.

## How to produce it

```
crewhaus compile crewhaus.yaml -o build
cp build/agent.ts public/ui/research/harness/agent.ts
```

## How to run

From `public/ui/research/`:

```
bun serve.ts
```

Then open the printed URL, type a research question in the goal box, and press
**Run**. Dependencies (`@crewhaus/*` and friends) install automatically on the
first run — no `bun install` needed.

> This is a **one-shot** shape: each Run spawns a fresh process that streams its
> plan, branches, sources and final report, then exits. Press **Run** again to
> start a new investigation. The compiled agent also supports `--resume <runId>`
> and `--branching <n>` if you invoke it directly from a shell.
