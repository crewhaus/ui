# Drop your compiled eval bundle here

This folder holds the single file emitted when you compile a CrewHaus spec
with `target: eval`.

## 1. Compile your spec

```
crewhaus compile crewhaus.yaml -o build
```

This writes a self-contained **`agent.ts`** for the eval target. It boots
`@crewhaus/dataset-registry`, looks up your graders, drives
`@crewhaus/eval-runner`, and prints a JSON summary
(`{ runId, passRate, samples, outDir }`) when the run finishes.

## 2. Copy the bundle into this folder

```
cp build/agent.ts ./agent.ts
```

So the layout is:

```
eval/
  harness/
    agent.ts        <- the compiled eval bundle (this file's neighbour)
```

## 3. Provide a dataset

The bundle loads its dataset from **`.crewhaus/datasets`** (relative to the
working directory) — or from `CREWHAUS_DATASETS_DIR` if set. The dataset your
spec references (`dataset.name@version`, split `train`/`dev`/`test`) must exist
there before you run, e.g.:

```
.crewhaus/datasets/<name>/<version>.json
```

Without a dataset the bundle exits with a `DatasetRegistryError`.

## 4. Run

```
bun ../serve.ts
```

Open the printed URL and press **Run eval**. The bundle runs every case,
grades it, and the score board + per-case verdicts fill in live. Per-sample
artifacts (`grades.json`, `events.jsonl`, `transcript.jsonl`) and the run
summary (`results.json`) are written under `.crewhaus/evals/<runId>/`.
