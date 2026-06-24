# Drop your compiled on-chain game bundle here

This UI runs a bundle compiled from a CrewHaus spec with **`target: onchain-game`** —
a single autonomous **perceive → decide → act** loop that reads game state from a
contract view function, asks the agent for a move, and broadcasts it as a signed
transaction.

## What to drop here

- **`agent.ts`** — the file emitted by `crewhaus compile` for an `onchain-game`
  spec. It is the loop entry point and exports `CHAIN`, `WALLET`, `GAME`, and
  `TRANSACTION_POLICY`.

That's the only required file. The host generates a `package.json` from the
bundle's imports and installs `@crewhaus/*` (all public on npm) on first run.

## Compile + run

1. Compile your spec:
   ```
   crewhaus compile crewhaus.yaml -o build
   ```
2. Copy the emitted `agent.ts` into this `harness/` folder.
3. Start the UI host from the shape directory:
   ```
   bun ../serve.ts
   ```
   then open the printed `http://localhost:4100` URL and click **Start**.

## Runtime environment

The loop signs and broadcasts real transactions, so it expects:

- RPC URL(s) for the configured chain (often an env var the spec references,
  e.g. `ALCHEMY_URL`).
- A wallet key reference — an env var, or a `kms://` / `hsm://` handle. Bare
  signing keys are rejected at compile time, so none will ever live in `agent.ts`.

Set those in your shell before `bun ../serve.ts`. The loop's turn semantics
(`turn-based`, `real-time`, or `async`) and stop condition (objective met or move
ceiling reached) are baked into the bundle.
