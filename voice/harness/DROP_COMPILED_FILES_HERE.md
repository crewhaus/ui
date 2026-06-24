# Drop your compiled `voice` bundle here

This UI runs a CrewHaus bundle compiled with **`target: voice`** — a headless
realtime voice/turn agent (a daemon + a per-call audio loop). No microphone or
speaker is involved; the daemon pumps PCM in and emits transcript/turn events
out.

## What to drop

Compile your spec, then copy the emitted files into **this `harness/` folder**:

```
crewhaus compile crewhaus.yaml -o build
```

Copy all three emitted files here:

- **`daemon.ts`**  — the entry point the UI runs (it boots the call loop).
- **`voice-loop.ts`** — the per-call audio I/O loop (VAD + barge-in + adapter).
- **`agent.ts`** — the model, instructions and `voice` block.

The host picks `daemon.ts` as the entry (falling back to `agent.ts`).

## How to run

From this shape directory (`public/ui/voice`):

```
bun ../serve.ts
```

Then open the printed `http://localhost:4100` URL and click **Start**.
Dependencies (`@crewhaus/*`, voice-runtime, vad-engine, barge-in-controller)
are installed automatically on first run.

## Two ways to drive it

- **Type an utterance** in the transcript composer. The v0 daemon is headless
  and does not read stdin, so a typed turn is mirrored into the transcript as a
  *simulation* of spoken speech — handy for exploring the conversation surface.
- **Run a real headless call** with a PCM clip. The daemon supports
  `--smoke <pcm-path>` (raw 16-bit signed LE mono @ 24kHz); it emits one JSON
  event per line — `smoke_start`, `smoke_pcm_loaded`, `voice_event` (session,
  transcript, audio, tool-use, barge-in, …), `smoke_done` — which this UI parses
  into the transcript and the voice-activity feed.

> The full WebRTC + telephony bridge lands in a follow-up; v0 ships the headless
> smoke path.
