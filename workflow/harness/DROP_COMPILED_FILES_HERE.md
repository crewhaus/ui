# Drop your compiled workflow bundle here

This UI runs any bundle compiled from a CrewHaus spec with `target: workflow`.

## What to drop

Copy the emitted entry file into this folder:

- **`agent.ts`** — the generated workflow runtime (required)

A `workflow` bundle is a single self-contained `agent.ts`. It runs each step
sequentially: **step 1** reads the run input from stdin, and **steps 2+** are
fed the previous step's output automatically.

## How to run

1. Compile your spec:
   `crewhaus compile crewhaus.yaml -o build` (with `target: workflow`)
2. Copy `build/agent.ts` into this `harness/` folder.
3. From the shape directory, start the UI:
   `bun ../serve.ts`
4. Open the printed URL, type your run input, and press **Run**.
   Dependencies install automatically on the first run.

Each step streams into the live **step timeline**; the final step's text is
rendered as the **result**.
