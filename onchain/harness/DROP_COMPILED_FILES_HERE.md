# Drop your compiled on-chain agent here

This UI runs a bundle compiled from a CrewHaus spec with `target: onchain` —
a long-running, event-driven EVM daemon that runs one agent turn per inbound
chain event (contract events, new blocks, or watched-address transfers).

## What to drop here

Copy the single emitted entry file into this folder:

- **`agent.ts`** — the compiled on-chain daemon (the only file `target-onchain`
  emits). It exports the resolved `CHAINS`, `WALLETS`, `CONTRACTS`,
  `TRANSACTION_POLICY`, and `TRIGGERS` plus the agent model + instructions.

## How to build it

```
crewhaus compile crewhaus.yaml -o build
```

Then copy `build/agent.ts` into this `harness/` directory.

## How to run it

From the shape directory (one level up):

```
bun ../serve.ts
```

Open the printed URL, then press **Start**. Dependencies (the
`@crewhaus/chain-adapter-evm` adapter and friends) install automatically on the
first run. The daemon boots, builds an EVM adapter per chain, subscribes to
every configured trigger, and waits — chain activity, transactions, and the
structured trace feed stream into the dashboard as events fire.

## Secrets

RPC URLs and wallet key handles are read from the environment at runtime
(`process.env`). Export them before launching, e.g.:

```
export ALCHEMY_MAINNET_URL="https://eth-mainnet.g.alchemy.com/v2/<key>"
export TREASURY_WALLET_KEY="kms://my-key-handle"
bun ../serve.ts
```

Signing keys are never embedded in the bundle — only `env` references and
`kms://` / `hsm://` handles are permitted.

---

**Secrets:** copy `.env.example` → `.env` in this folder and fill in your provider key
(and any `${VAR}` your spec uses). The host loads it for the harness; `.env` is gitignored.
A key in the repo-root `.env` covers every shape instead.
