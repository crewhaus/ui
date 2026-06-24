# Drop your compiled CLI bundle here

This folder is where the **compiled output of a `target: cli` CrewHaus spec** goes.

```bash
# from your agent project
crewhaus compile crewhaus.yaml -o build

# copy the emitted files here
cp build/agent.ts /path/to/public/ui/cli/harness/
```

Then start the UI:

```bash
bun ../serve.ts      # or: bun public/ui/cli/serve.ts
```

Open the printed URL and click **Start**. The UI installs the bundle's
dependencies (`@crewhaus/*`, all public on npm) automatically on first run,
then boots the agent and streams the conversation + a live activity feed.

You only need `agent.ts`. Anything else the compiler emitted (it is fine to
copy the whole `build/` directory) is ignored unless referenced.
