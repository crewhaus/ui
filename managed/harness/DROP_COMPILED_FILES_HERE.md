# Drop your compiled `managed` bundle here

This UI is an operator dashboard for a CrewHaus **managed runtime** — a
multi-tenant agent gateway built on `@crewhaus/gateway-server`.

## What to drop

Compile a spec with `target: managed` and copy the **emitted bundle** into this
folder. The `managed` target emits two files — drop **both**:

- **`daemon.ts`** — the gateway daemon (the entry point this UI boots). It wires
  `@crewhaus/gateway-server` on `process.env.PORT`, per-tenant routing via
  `@crewhaus/tenancy`, the per-tenant audit log, and the policy engine.
- **`agent.ts`** — the per-turn dispatcher the daemon calls inside
  `runs.create` / `runs.continue`.

```sh
crewhaus compile crewhaus.yaml -o build      # spec must use target: managed
cp build/daemon.ts build/agent.ts \
   ui/managed/harness/
```

## Run it

```sh
bun ../serve.ts        # from this directory's parent (ui/managed)
```

Then open the printed URL and click **Start**. Dependencies (`@crewhaus/*` from
npm) install automatically on first boot.

## Auth note

The gateway verifies **HS256 JWT bearer tokens** (claim `tenant_id`). It never
mints them. On boot with no `CREWHAUS_GATEWAY_JWT_SECRET` set, the daemon
auto-generates a one-shot dev secret and prints it to its log:

```
[managed] no CREWHAUS_GATEWAY_JWT_SECRET in env — generated a one-shot dev secret. Export it to re-use:
  export CREWHAUS_GATEWAY_JWT_SECRET=<hex>
```

This dashboard reads that line automatically and mints short-lived tenant tokens
in the browser so the **Request console** works out of the box. To pin the
secret across restarts (so previously-minted tokens keep working), export it
before running:

```sh
export CREWHAUS_GATEWAY_JWT_SECRET=<a-secret-at-least-16-chars>
```

---

**Secrets:** copy `.env.example` → `.env` in this folder and fill in your provider key
(and any `${VAR}` your spec uses). The host loads it for the harness; `.env` is gitignored.
A key in the repo-root `.env` covers every shape instead.
