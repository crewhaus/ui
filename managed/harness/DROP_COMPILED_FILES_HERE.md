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
mints them. When you click **Start** with no `CREWHAUS_GATEWAY_JWT_SECRET` set,
this host generates one for the daemon and hands it to this dashboard, which
mints short-lived tenant tokens in the browser, so the **Request console** works
out of the box. The generated secret lasts until the host stops.

To keep tokens valid across host restarts, set your own before running, and
paste it in the **Auth** panel:

```sh
export CREWHAUS_GATEWAY_JWT_SECRET=<a-secret-at-least-16-chars>
```

A daemon you run yourself, outside this host, with no secret set saves the one
it generates to `.crewhaus/run/gateway-jwt-secret`.

---

**Secrets:** copy `.env.example` → `.env` in this folder and fill in your provider key
(and any `${VAR}` your spec uses). The host loads it for the harness; `.env` is gitignored.
A key in the repo-root `.env` covers every shape instead.
