# Drop your compiled crew bundle here

This folder is where the **compiled output of a `target: crew` CrewHaus spec** goes.

A crew compiles to several files:

- `daemon.ts` — the entry point (reads your prompt from stdin, runs the crew)
- `orchestrator.ts` — wires the roles, entry role, and routing together
- `agent_<role>.ts` — one file per role (its model, instructions, and tools)

```bash
# from your agent project
crewhaus compile crewhaus.yaml -o build

# copy the emitted crew files here (the whole build/ dir is fine)
cp build/daemon.ts build/orchestrator.ts build/agent_*.ts \
   /path/to/ui/crew/harness/
```

Then start the UI:

```bash
bun ../serve.ts      # or: bun ui/crew/serve.ts
```

Open the printed URL, type a task, and press **Run**. The UI installs the
bundle's dependencies (`@crewhaus/*`, all public on npm) automatically on first
run, then feeds your prompt to the crew, watches roles hand work off to one
another, and shows the final answer.

`daemon.ts` is the required entry; it imports `orchestrator.ts` and every
`agent_<role>.ts`, so keep them all together in this folder.

---

**Secrets:** copy `.env.example` → `.env` in this folder and fill in your provider key
(and any `${VAR}` your spec uses). The host loads it for the harness; `.env` is gitignored.
A key in the repo-root `.env` covers every shape instead.
