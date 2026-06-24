# Drop your compiled RAG pipeline here

This folder is the runtime root for the **RAG Pipeline** shape UI.

## What to drop

Drop the file emitted by compiling a CrewHaus spec with `target: pipeline`:

- **`agent.ts`** — the generated pipeline agent (required entry file).

That single bundle boots the embedder + vector store, indexes the seed
documents declared in your spec's `indexing.documents`, registers the
`Retrieve` tool, and drops into the chat loop.

## How to produce it

```
crewhaus compile crewhaus.yaml -o build
cp build/agent.ts ui/pipeline/harness/agent.ts
```

## How to run

From the `pipeline/` directory:

```
bun ../serve.ts
```

Then open the printed URL. Dependencies install automatically on the first run.

## How it behaves

This is a **single-shot** console (`stdio-oneshot`): each question spawns a
fresh run. The host writes your query to the bundle's stdin, the bundle
indexes its corpus, embeds the query, retrieves top-k chunks via `Retrieve`,
streams back a cited answer, then exits. Ask another question to run again.

- Indexing progress (`[pipeline] indexed N chunks`) is printed to stderr and
  shows up in the **Raw output** drawer (terminal icon, top-right).
- Retrieval calls appear as cards in the **Retrieved sources** panel.
- Inline `[1]`, `[2]` citation markers in the answer are cross-referenced in
  the same panel.

---

**Secrets:** copy `.env.example` → `.env` in this folder and fill in your provider key
(and any `${VAR}` your spec uses). The host loads it for the harness; `.env` is gitignored.
A key in the repo-root `.env` covers every shape instead.
