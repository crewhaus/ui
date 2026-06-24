# Drop your compiled `channel` bundle here

This folder is where the operator dashboard looks for a compiled CrewHaus
**channel-bot** bundle. The channel target emits **four** files — drop them all
in here:

| File | Role |
|---|---|
| `daemon.ts` | **Entry point.** Boots the adapters, serves webhooks, runs the heartbeat. |
| `agent.ts` | The `runChatLoop` wrapper that runs one turn per inbound message. |
| `session-router.ts` | Resumes a per-thread/user/channel session and drives each turn. |
| `gateway.ts` | Channel-generic HTTP handler — verifies signatures, dedups, dispatches. |

```bash
# 1. Compile your spec to the channel target
crewhaus compile crewhaus.yaml -o build

# 2. Copy the emitted files into this folder
cp build/daemon.ts build/agent.ts build/session-router.ts build/gateway.ts \
   public/ui/channel/harness/

# 3. Export the secrets your channels + model need, then run the UI
export ANTHROPIC_API_KEY=…          # or your configured provider's key
export SLACK_BOT_TOKEN=…            # whatever your spec's channels reference
export SLACK_SIGNING_SECRET=…       # the daemon EXITS if a required one is unset
bun ../serve.ts                     # opens http://localhost:4100
```

Open the printed URL and press **Start**. Dependencies (`@crewhaus/*`, all
public on npm) install automatically on first run.

## What the dashboard shows

- **Channels strip** — which adapters are configured/live (Slack, Discord,
  Telegram, WhatsApp, iMessage), each with its `/{channel}/events` webhook path.
- **Daemon status** — turns, heartbeats, uptime, webhook errors, the listening
  port, heartbeat cadence, and the gateway control-UI port if your spec enables
  it. Status is derived from the daemon's own log lines and, when reachable,
  from a 2-second `/status` poll.
- **Simulate inbound** — POSTs a fake webhook to a real `/{channel}/events`
  route. Adapters verify signatures, so an unsigned probe returns **HTTP 401** —
  the honest confirmation that the route is live and secured without needing
  real platform credentials.
- **Activity feed** — TraceEvents (turns, tools, cost, errors), heartbeat ticks
  and wake replies, simulated probes, and gateway handler errors.
- **Daemon log** — the raw `daemon.ts` / gateway / heartbeat stdout + stderr.

> Note: the daemon's `/status` endpoint runs on a *separate* gateway-UI port
> (set when your spec has a `gateway:` block). The host proxies the main webhook
> port, so when `/status` isn't reachable through the proxy the dashboard falls
> back to the daemon's log lines — which carry the same state.
