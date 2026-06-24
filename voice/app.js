/* CrewHaus — voice shape UI.

   A realtime voice/turn agent rendered as a live TRANSCRIPT (user utterance /
   agent reply turns) alongside a voice-loop activity panel (session, VAD turns,
   barge-in, tool-use, transcripts). Real microphone / speaker audio is NOT
   bridged by this browser UI — the compiled daemon is headless and pumps PCM
   from a file via `--smoke <pcm-path>`. To explore the conversation surface you
   can TYPE an utterance below; it is mirrored into the transcript as a stand-in
   for spoken speech.

   GROUND TRUTH (target-voice emitter): the daemon writes its OWN JSON-Lines to
   stdout — one object per line — that are NOT CrewHaus TraceEvents (they carry
   no runId/timestamp envelope), so the host streams them to us as raw `stdout`
   text rather than `event` messages. We parse those lines here:
     { kind: "smoke_start", pcmPath }
     { kind: "smoke_pcm_loaded", samples }
     { kind: "voice_event", event: RealtimeEvent | { kind:"barge_in", speechFrames } }
     { kind: "smoke_done" }
   RealtimeEvent kinds: session_created | transcript_partial | transcript_final |
     audio_chunk | tool_use | interrupt | disconnect | error | raw.
   Any genuine TraceEvents (a future bridge may emit them) still arrive via
   api.on("event") and are rendered into the activity feed too. */
(function () {
  "use strict";
  const { el, icon, Chat, Composer, dropzone, stripAnsi, events, fmtBytes } = window.CH;

  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  CH.app({
    controls: ["start", "stop", "restart"],
    build(api) {
      // Active-layout handles (null until built once).
      let chat = null;
      let composer = null;
      let feedScroll = null;
      let feedEl = null;
      let statEls = null;
      let pcmBar = null;
      let pcmLabel = null;

      // Conversation/loop accounting.
      let agentOpen = false; // an agent reply turn is currently streaming
      let pcmSamples = 0;
      const s = {
        utterances: 0,
        replies: 0,
        bargeIns: 0,
        toolUses: 0,
        turns: 0,
        errors: 0,
      };

      function setStat(node, v) {
        if (node) node.textContent = String(v);
      }
      function refreshStats() {
        if (!statEls) return;
        setStat(statEls.utterances, s.utterances);
        setStat(statEls.replies, s.replies);
        setStat(statEls.bargeIns, s.bargeIns);
        setStat(statEls.tools, s.toolUses);
        setStat(statEls.errors, s.errors);
      }

      function pushCard(opts) {
        if (!feedEl) return;
        feedEl.appendChild(events.card(opts));
        if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
      }

      function endAgentTurn() {
        if (agentOpen && chat) {
          chat.endTurn();
          agentOpen = false;
        }
      }

      // ── Voice (RealtimeEvent) handling ───────────────────────────────────
      function handleVoiceEvent(ev) {
        if (!ev || typeof ev !== "object") return;
        switch (ev.kind) {
          case "session_created":
            pushCard({
              icon: "plug",
              sev: "info",
              name: "session",
              title: "realtime session created",
              sub: ev.sessionId || "",
            });
            if (chat) chat.systemNote("Realtime session open — streaming inbound audio frames.");
            break;
          case "transcript_partial":
            // Live caption of the agent's speech (or ASR of the caller).
            if (chat) {
              if (!agentOpen) {
                agentOpen = true;
              }
              // Re-render the full partial text as it grows.
              chat.assistant(ev.text || "");
            }
            pushCard({
              icon: "message",
              sev: "muted",
              name: "transcript",
              title: "partial",
              sub: trunc(ev.text),
            });
            break;
          case "transcript_final":
            if (chat) {
              if (!agentOpen) {
                agentOpen = true;
                chat.assistant(ev.text || "");
              }
              endAgentTurn();
            }
            s.replies++;
            s.turns++;
            refreshStats();
            pushCard({
              icon: "check",
              sev: "accent",
              name: "transcript",
              title: "final",
              sub: trunc(ev.text),
            });
            break;
          case "audio_chunk":
            pushCard({
              icon: "activity",
              sev: "info",
              name: "audio out",
              title: "TTS chunk",
              sub: `${ev.sampleRate || 24000} Hz pcm16`,
              meta: ev.pcm && ev.pcm.length ? `${ev.pcm.length} smp` : null,
            });
            break;
          case "tool_use":
            s.toolUses++;
            refreshStats();
            pushCard({
              icon: "wrench",
              sev: "accent",
              name: ev.name || "tool",
              title: "function call",
              sub: ev.input != null ? trunc(safeJson(ev.input)) : "",
            });
            break;
          case "barge_in":
            s.bargeIns++;
            refreshStats();
            pushCard({
              icon: "zap",
              sev: "warn",
              name: "barge-in",
              title: "caller interrupted",
              sub: `${ev.speechFrames ?? "?"} consecutive speech frames`,
            });
            if (chat) chat.systemNote("Barge-in detected — cancelling the in-flight reply.");
            break;
          case "interrupt":
            pushCard({
              icon: "square",
              sev: "warn",
              name: "interrupt",
              title: "response cancelled",
              sub: ev.reason || "",
            });
            endAgentTurn();
            break;
          case "disconnect":
            endAgentTurn();
            pushCard({
              icon: "plug",
              sev: "muted",
              name: "session",
              title: "disconnected",
              sub: ev.reason || "",
              meta: ev.code != null ? `code ${ev.code}` : null,
            });
            break;
          case "error":
            s.errors++;
            refreshStats();
            pushCard({
              icon: "alert",
              sev: "error",
              name: "voice error",
              title: ev.message || "error",
              sub: ev.cause != null ? trunc(safeJson(ev.cause)) : "",
            });
            break;
          case "raw":
            pushCard({
              icon: "dot",
              sev: "muted",
              name: ev.provider || "raw",
              title: "provider frame",
              sub: trunc(safeJson(ev.payload)),
              meta: ev.ts || null,
            });
            break;
          default:
            pushCard({ icon: "dot", sev: "muted", title: String(ev.kind || "voice event") });
        }
      }

      // ── Daemon JSON-Lines (smoke envelope) ───────────────────────────────
      function handleDaemonLine(obj) {
        switch (obj.kind) {
          case "smoke_start":
            pcmSamples = 0;
            if (chat) chat.systemNote(`Smoke call starting — pumping PCM from ${obj.pcmPath || "stdin"}.`);
            pushCard({
              icon: "play",
              sev: "info",
              name: "smoke",
              title: "call started",
              sub: obj.pcmPath || "",
            });
            updatePcm(0, 0);
            break;
          case "smoke_pcm_loaded":
            pcmSamples = obj.samples || 0;
            updatePcm(pcmSamples, pcmSamples);
            pushCard({
              icon: "layers",
              sev: "info",
              name: "pcm",
              title: "clip loaded",
              sub: `${(obj.samples || 0).toLocaleString()} samples · ${pcmDurationLabel(obj.samples)}`,
            });
            break;
          case "voice_event":
            handleVoiceEvent(obj.event);
            break;
          case "smoke_done":
            endAgentTurn();
            pushCard({ icon: "check", sev: "accent", name: "smoke", title: "call complete" });
            if (chat) chat.systemNote("Smoke call complete.");
            break;
          default:
            // Unknown structured line — surface it without guessing.
            pushCard({ icon: "dot", sev: "muted", title: String(obj.kind || "event") });
        }
      }

      function pcmDurationLabel(samples) {
        if (!samples) return "—";
        const sec = samples / 24000; // pcm16 mono @ 24kHz
        return sec < 1 ? `${Math.round(sec * 1000)}ms` : `${sec.toFixed(1)}s`;
      }
      function updatePcm(loaded, total) {
        if (!pcmBar) return;
        const fill = pcmBar.querySelector("i");
        if (fill) fill.style.width = total > 0 ? "100%" : "0%";
        if (pcmLabel)
          pcmLabel.textContent = total > 0 ? `${pcmDurationLabel(total)} clip loaded` : "no clip yet";
      }

      // ── Raw stdout: split into JSON-Lines + prose ────────────────────────
      let lineBuf = "";
      function ingestStdout(text) {
        lineBuf += text;
        let nl;
        while ((nl = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          consumeLine(line);
        }
      }
      function consumeLine(line) {
        const t = line.trim();
        if (!t) return;
        // The daemon prints one JSON object per line. Anything else is prose
        // (banners, follow-up bridge notes) → route to the raw output drawer.
        if (t[0] === "{" && t[t.length - 1] === "}") {
          let obj = null;
          try {
            obj = JSON.parse(t);
          } catch {
            obj = null;
          }
          if (obj && typeof obj.kind === "string") {
            handleDaemonLine(obj);
            return;
          }
        }
        api.log(t + "\n", "stdout");
      }

      // ── WS handlers (attached once) ──────────────────────────────────────
      api.on("user", (m) => {
        // User-typed utterance (stand-in for speech). The v0 daemon does not
        // read stdin, so this is mirrored locally as a simulated turn.
        if (chat) chat.user(m.text);
        s.utterances++;
        s.turns++;
        refreshStats();
        pushCard({
          icon: "mic",
          sev: "accent",
          name: "you (typed)",
          title: "simulated utterance",
          sub: trunc(m.text),
        });
      });

      api.on("stdout", (m) => {
        const txt = stripAnsi(m.text);
        if (txt) ingestStdout(txt);
      });

      // Genuine TraceEvents (if a future bridge emits the full envelope).
      api.on("event", (m) => {
        const node = events.render(m.event);
        if (node && feedEl) {
          feedEl.appendChild(node);
          if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
        }
      });

      api.on("status", (m) => {
        if (composer) composer.setEnabled(m.state === "running");
        if (!chat) return;
        if (m.state === "running")
          chat.systemNote("Daemon booted. It is headless — type an utterance to simulate a turn, or run it with --smoke for a real PCM call.");
        else if (m.state === "exited") {
          endAgentTurn();
          // flush any trailing buffered line
          if (lineBuf.trim()) {
            consumeLine(lineBuf);
            lineBuf = "";
          }
          chat.systemNote("Daemon process exited. Press Start to run it again.");
        } else if (m.state === "error") {
          chat.systemNote("The daemon could not start — check the raw output log.");
          api.openLog();
        }
      });

      // ── View switching ───────────────────────────────────────────────────
      let mode = null;
      api.onState((st) => {
        const want = st.harness && st.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      function buildEmpty() {
        chat = composer = feedEl = feedScroll = statEls = pcmBar = pcmLabel = null;
        CH.clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "mic",
            title: "Drop in a compiled voice agent",
            subtitle:
              "This UI runs a bundle compiled from a CrewHaus spec with target: voice — a headless realtime daemon (no mic/speaker needed).",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy `daemon.ts`, `voice-loop.ts` and `agent.ts` into this UI's `harness/` folder",
              "Click **Start** (deps install on first run). The v0 daemon is headless — pass `--smoke <pcm-path>` for a real call, or **type an utterance here** to simulate one",
            ],
          }),
        );
      }

      function buildActive() {
        CH.clear(api.main);

        // ── Left: transcript ──────────────────────────────────────────────
        const audioNote = el("div", { class: "card", style: { margin: "0 0 14px" } }, [
          el("div", { class: "card-head" }, [
            el("span", { style: { color: "var(--accent)", display: "inline-grid", placeItems: "center" } }, icon("alert", 15)),
            el("span", { class: "label", text: "Audio is not bridged in the browser" }),
          ]),
          el("div", { class: "card-body" }, [
            el(
              "p",
              { class: "muted", style: { margin: "0" } },
              CH.inlineNodes(
                "The compiled daemon is **headless** — there's no microphone or speaker here. Run it with `--smoke <pcm-path>` for a real PCM call, or **type an utterance below** to mirror a turn into the transcript as a stand-in for speech.",
              ),
            ),
          ]),
        ]);

        const leftScroll = el("div", { class: "pane-scroll" });
        const leftFoot = el("div");
        const left = el("div", { class: "pane" }, [
          paneHead("message", "Transcript"),
          leftScroll,
          leftFoot,
        ]);
        leftScroll.appendChild(audioNote);
        chat = Chat(leftScroll, { agentLabel: api.config.title });
        composer = Composer(leftFoot, (txt) => api.sendInput(txt), {
          placeholder: "Type what the caller would say…",
          hint: "simulated speech — mirrored to transcript",
        });
        composer.setEnabled(api.isRunning());

        // ── Right: voice-loop activity ────────────────────────────────────
        const statsBar = el("div", { class: "stats" });
        statEls = {
          utterances: stat(statsBar, "Utterances", "0"),
          replies: stat(statsBar, "Replies", "0", true),
          bargeIns: stat(statsBar, "Barge-ins", "0"),
          tools: stat(statsBar, "Tool uses", "0"),
          errors: stat(statsBar, "Errors", "0"),
        };

        // Voice configuration / loop summary (from harness + features).
        const cfg = api.config || {};
        const configCard = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { style: { color: "var(--accent)", display: "inline-grid", placeItems: "center" } }, icon("cpu", 15)),
            el("span", { class: "label", text: "Voice loop" }),
          ]),
          el("div", { class: "card-body" }, [
            el("div", { class: "chips" }, [
              chip("provider", "realtime"),
              chip("audio", "pcm16 · 24kHz mono"),
              chip("vad", "server"),
              chip("barge-in", "armed"),
            ]),
            el("div", { class: "divider" }),
            el("div", { class: "row", style: { alignItems: "center", gap: "10px" } }, [
              el("span", { style: { color: "var(--ink-3)", display: "inline-grid", placeItems: "center" } }, icon("layers", 14)),
              (pcmBar = el("div", { class: "bar", style: { flex: "1" } }, el("i", { style: { width: "0%" } }))),
            ]),
            (pcmLabel = el("div", {
              class: "section-label",
              style: { margin: "8px 0 0" },
              text: "no clip yet",
            })),
          ]),
        ]);

        feedScroll = el("div", { class: "pane-scroll" });
        feedEl = el("div", { class: "feed" });
        feedScroll.appendChild(
          el("div", { class: "col" }, [
            statsBar,
            el("div", { class: "divider" }),
            configCard,
            el("div", { class: "section-label", style: { margin: "14px 0 0" }, text: "Loop activity" }),
            feedEl,
          ]),
        );
        const right = el("div", { class: "pane" }, [
          paneHead("activity", "Voice activity"),
          feedScroll,
        ]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));
        refreshStats();
        updatePcm(0, 0);
        if (!api.isRunning())
          chat.systemNote("Press Start to boot the daemon, then type an utterance to simulate a turn.");
      }

      function stat(mount, label, value, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(el("div", { class: "stat" }, [v, el("div", { class: "k", text: label })]));
        return v;
      }
      function chip(k, v) {
        return el("div", { class: "chip" }, [
          el("span", { class: "k", text: k }),
          el("span", { class: "v", text: v }),
        ]);
      }
      function trunc(str, n) {
        if (str == null) return "";
        const t = String(str);
        const max = n || 160;
        return t.length > max ? t.slice(0, max) + "…" : t;
      }
      function safeJson(v) {
        try {
          return typeof v === "string" ? v : JSON.stringify(v);
        } catch {
          return String(v);
        }
      }
    },
  });
})();
