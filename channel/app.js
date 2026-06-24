/* CrewHaus — channel shape UI.
   An operator dashboard for a channel-bot daemon: one agent fronting Slack /
   Discord / Telegram / WhatsApp / iMessage. The compiled bundle is a Bun
   daemon that verifies signed webhooks at /<channel>/events, routes each
   inbound message to a per-thread session turn, and (optionally) wakes on a
   heartbeat. This UI gives the operator a channels strip, a live status card,
   an inbound-message simulator, an activity feed of TraceEvents, and the
   daemon log. */
(function () {
  "use strict";
  const { el, icon, events } = window.CH;

  // Channels the channel target can adapt, in display order. `import` is the
  // codegen import marker emitted into daemon.ts so we can tell from the
  // dropped files which adapters were configured before the daemon even boots.
  const CHANNELS = [
    { id: "slack", label: "Slack", icon: "message", marker: "channel-adapter-slack" },
    { id: "discord", label: "Discord", icon: "gamepad", marker: "channel-adapter-discord" },
    { id: "telegram", label: "Telegram", icon: "send", marker: "channel-adapter-telegram" },
    { id: "whatsapp", label: "WhatsApp", icon: "message", marker: "channel-adapter-whatsapp" },
    { id: "imessage", label: "iMessage", icon: "message", marker: "channel-adapter-imessage" },
  ];
  const BY_ID = Object.fromEntries(CHANNELS.map((c) => [c.id, c]));

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
      // ── Live model ────────────────────────────────────────────────────
      const model = {
        name: api.config.title || "channel-bot",
        configured: new Set(), // channel ids found in the dropped daemon.ts
        live: new Set(), // channel ids the running daemon reports / served
        listening: false, // saw "[daemon] listening"
        port: null,
        gatewayPort: null,
        gatewayUi: false,
        heartbeat: { enabled: false, everyMs: null, ticks: 0, lastPreview: "" },
        turnCount: 0,
        heartbeatCount: 0,
        startedAt: null, // Date when we observed the daemon come up
        statusReachable: false, // /proxy/status answered with JSON
        lastStatusAt: null,
        webhookErrors: 0,
        missingEnv: null,
      };

      const stats = events.newStats();

      // ── Active-view element handles (null until built) ─────────────────
      let ui = null;
      let pollTimer = null;
      let clockTimer = null;

      // ── Helpers ───────────────────────────────────────────────────────
      function scanConfiguredChannels(files) {
        model.configured = new Set();
        const blob = (files || []).join("\n");
        // Inspect daemon.ts directly when present; fall back to filenames.
        let daemonSrc = "";
        for (const f of files || []) {
          if (/daemon\.ts$/.test(f)) daemonSrc = f; // we only have names here
        }
        for (const c of CHANNELS) {
          // The dropped file list contains daemon.ts/agent.ts/etc; the adapter
          // marker lives inside daemon.ts which we cannot read from the client.
          // Heuristic: filenames never carry the marker, so default-detect via
          // the live /status + log lines. We still pre-seed nothing here and
          // let live signals fill the strip. (Kept for forward-compat if the
          // harness ever ships per-channel files.)
          if (blob.indexOf(c.marker) >= 0) model.configured.add(c.id);
        }
      }

      function knownChannels() {
        // Union of configured (static) and live (runtime) channel ids,
        // preserving canonical order; unknown ids appended at the end.
        const ids = new Set([...model.configured, ...model.live]);
        const ordered = CHANNELS.filter((c) => ids.has(c.id)).map((c) => c.id);
        for (const id of ids) if (!BY_ID[id]) ordered.push(id);
        return ordered;
      }

      function uptimeStr() {
        if (!model.startedAt) return "—";
        return CH.fmtMs(Date.now() - model.startedAt.getTime());
      }

      // ── Log-line parsing (authoritative; always reaches the UI) ────────
      // The proxy can only reach the daemon's main webhook port, while the
      // /status endpoint lives on a SEPARATE gateway-UI port the host can't
      // proxy to. So the daemon's own stdout/stderr is the ground-truth
      // source for live state — we parse the exact lines the emitter writes.
      function parseLogLine(line) {
        let m;
        if ((m = line.match(/\[daemon\] listening on http:\/\/[^:]+:(\d+)/))) {
          model.listening = true;
          model.port = Number(m[1]);
          if (!model.startedAt) model.startedAt = new Date();
          refreshStatusCard();
          return;
        }
        if ((m = line.match(/\[gateway\] listening on http:\/\/[^:]+:(\d+)(.*)/))) {
          model.gatewayPort = Number(m[1]);
          model.gatewayUi = /UI enabled/.test(m[2] || "");
          refreshStatusCard();
          return;
        }
        if ((m = line.match(/\[heartbeat\] enabled every (\d+)ms/))) {
          model.heartbeat.enabled = true;
          model.heartbeat.everyMs = Number(m[1]);
          refreshStatusCard();
          return;
        }
        if ((m = line.match(/\[heartbeat\] tick #(\d+) \(session (\w+)\)/))) {
          model.heartbeat.ticks = Number(m[1]);
          model.heartbeatCount = Number(m[1]);
          pushActivity({
            icon: "clock",
            sev: "info",
            name: "heartbeat",
            title: `tick #${m[1]}`,
            sub: `session ${m[2]}`,
          });
          refreshStatusCard();
          return;
        }
        if ((m = line.match(/\[heartbeat\] → ([\s\S]*)/))) {
          model.heartbeat.lastPreview = m[1];
          pushActivity({
            icon: "sparkles",
            sev: "accent",
            name: "heartbeat",
            title: "wake reply",
            sub: m[1].length > 140 ? m[1].slice(0, 140) + "…" : m[1],
          });
          return;
        }
        if ((m = line.match(/\[heartbeat\] error: (.*)/))) {
          pushActivity({ icon: "alert", sev: "error", name: "heartbeat", title: "error", sub: m[1] });
          return;
        }
        if ((m = line.match(/\[gateway\] handler error \(([^)]*)\): (.*)/))) {
          model.webhookErrors++;
          pushActivity({
            icon: "alert",
            sev: "error",
            name: "webhook",
            title: "handler error",
            sub: m[2],
            meta: m[1],
          });
          refreshStatusCard();
          return;
        }
        if ((m = line.match(/\[daemon\] missing required env vars: (.*)/))) {
          model.missingEnv = m[1];
          refreshStatusCard();
          return;
        }
        if ((m = line.match(/\[mcp\] registered (.*)/))) {
          pushActivity({ icon: "plug", sev: "info", name: "mcp", title: "registered", sub: m[1] });
          return;
        }
      }

      // ── Status polling (best-effort; degrades to log-derived) ──────────
      async function pollStatus() {
        if (!api.isRunning()) return;
        try {
          const r = await fetch("/proxy/status", { headers: { accept: "application/json" } });
          if (!r.ok) {
            model.statusReachable = false;
            refreshStatusCard();
            return;
          }
          const ct = r.headers.get("content-type") || "";
          if (ct.indexOf("application/json") < 0) {
            model.statusReachable = false;
            refreshStatusCard();
            return;
          }
          const s = await r.json();
          model.statusReachable = true;
          model.lastStatusAt = new Date();
          if (s.name) model.name = s.name;
          if (Array.isArray(s.channels)) {
            model.live = new Set(s.channels.filter((c) => typeof c === "string"));
          }
          if (typeof s.turnCount === "number") model.turnCount = s.turnCount;
          if (typeof s.heartbeatCount === "number") model.heartbeatCount = s.heartbeatCount;
          if (typeof s.heartbeatEnabled === "boolean") model.heartbeat.enabled = s.heartbeatEnabled;
          if (typeof s.uiEnabled === "boolean") model.gatewayUi = s.uiEnabled;
          if (s.startedAt) {
            const d = new Date(s.startedAt);
            if (!isNaN(d.getTime())) model.startedAt = d;
          }
          refreshChannels();
          refreshStatusCard();
        } catch {
          model.statusReachable = false;
          refreshStatusCard();
        }
      }

      // ── Activity feed ──────────────────────────────────────────────────
      function pushActivity(opts) {
        if (!ui) return;
        const empty = ui.feedEl.querySelector(".feed-empty");
        if (empty) empty.remove();
        ui.feedEl.appendChild(events.card(opts));
        ui.feedScroll.scrollTop = ui.feedScroll.scrollHeight;
      }

      function pushTraceEvent(ev) {
        events.accrue(ev, stats);
        if (ev.kind === "turn_start") model.turnCount = Math.max(model.turnCount, stats.turns);
        refreshStatusCard();
        const node = events.render(ev);
        if (node && ui) {
          const empty = ui.feedEl.querySelector(".feed-empty");
          if (empty) empty.remove();
          ui.feedEl.appendChild(node);
          ui.feedScroll.scrollTop = ui.feedScroll.scrollHeight;
        }
      }

      // ── WS handlers (attached once) ────────────────────────────────────
      api.on("event", (m) => pushTraceEvent(m.event));
      api.on("stdout", (m) => {
        const txt = CH.stripAnsi(m.text);
        for (const line of txt.split("\n")) {
          if (line.trim()) parseLogLine(line);
        }
        // Mirror raw daemon stdout into the inline tail + drawer.
        if (txt.trim()) tail(txt);
      });
      api.on("stderr", (m) => {
        parseLogLine(CH.stripAnsi(m.line));
        tail(CH.stripAnsi(m.line), "stderr");
      });
      api.on("log", (m) => tail(CH.stripAnsi(m.line), "system"));
      api.on("status", (m) => {
        if (m.state === "running") {
          if (!model.startedAt) model.startedAt = new Date();
          startPolling();
        } else {
          stopPolling();
          if (m.state === "exited" || m.state === "error") {
            model.listening = false;
            model.live = new Set();
          }
        }
        refreshChannels();
        refreshStatusCard();
        refreshConsoleEnabled();
      });

      function startPolling() {
        if (pollTimer) return;
        pollStatus();
        pollTimer = setInterval(pollStatus, 2000);
      }
      function stopPolling() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }

      // ── Inline log tail (mirror of the raw-output drawer) ──────────────
      let tailTerm = null;
      function tail(text, cls) {
        if (tailTerm) tailTerm.write(text.endsWith("\n") ? text : text + "\n", cls);
      }

      // ── View switching ─────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        if (s.harness && s.harness.files) scanConfiguredChannels(s.harness.files);
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want !== mode) {
          mode = want;
          want === "active" ? buildActive() : buildEmpty();
        } else {
          refreshChannels();
          refreshStatusCard();
        }
      });

      // ── Empty / onboarding state ───────────────────────────────────────
      function buildEmpty() {
        ui = null;
        stopPolling();
        if (clockTimer) {
          clearInterval(clockTimer);
          clockTimer = null;
        }
        CH.clear(api.main);
        api.main.appendChild(
          CH.dropzone({
            icon: "message",
            title: "Drop in a compiled channel bot",
            subtitle:
              "This dashboard operates any bundle compiled from a CrewHaus spec with target: channel — one agent fronting Slack, Discord, Telegram, WhatsApp or iMessage.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `daemon.ts`, `agent.ts`, `session-router.ts` and `gateway.ts` into this UI's `harness/` folder",
              "Export your channel + provider secrets (e.g. `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`) — the daemon **exits** if a required one is unset",
              "Click **Start** — deps install on first run, then the daemon serves webhooks on its internal port",
            ],
          }),
        );
      }

      // ── Active dashboard ───────────────────────────────────────────────
      function buildActive() {
        CH.clear(api.main);

        // LEFT column: channels strip + status card + simulate-inbound console
        const channelsStrip = el("div", { class: "chips" });
        const statusGrid = el("div", { class: "col", style: { gap: "10px" } });
        const consoleBody = el("div", { class: "col", style: { gap: "10px" } });

        const left = el("div", { class: "pane" }, [
          paneHead("layers", "Operator"),
          el("div", { class: "pane-scroll" }, [
            el("div", { class: "col", style: { gap: "16px" } }, [
              el("div", null, [
                el("div", { class: "section-label", text: "Channels" }),
                channelsStrip,
              ]),
              el("div", { class: "divider" }),
              el("div", null, [
                el("div", { class: "section-label", text: "Daemon status" }),
                statusGrid,
              ]),
              el("div", { class: "divider" }),
              el("div", null, [
                el("div", { class: "section-label", text: "Simulate inbound webhook" }),
                consoleBody,
              ]),
            ]),
          ]),
        ]);

        // RIGHT column: activity feed (top) + live daemon log (bottom)
        const feedScroll = el("div", { class: "pane-scroll" });
        const feedEl = el("div", { class: "feed" }, [
          el("div", {
            class: "feed-empty muted",
            style: { padding: "8px 2px", fontSize: "12.5px" },
            text: "Waiting for activity — webhook turns, heartbeat ticks and model events appear here.",
          }),
        ]);
        feedScroll.appendChild(feedEl);

        const logScroll = el("div", { class: "pane-scroll flush" });
        tailTerm = CH.Terminal(logScroll);

        const right = el("div", { class: "pane" }, [
          paneHead(
            "activity",
            "Activity",
            el(
              "button",
              {
                class: "btn ghost sm",
                onClick: () => {
                  CH.clear(feedEl);
                  feedEl.appendChild(
                    el("div", {
                      class: "feed-empty muted",
                      style: { padding: "8px 2px", fontSize: "12.5px" },
                      text: "Cleared.",
                    }),
                  );
                },
              },
              "Clear",
            ),
          ),
          el("div", { style: { flex: "1 1 0", minHeight: "0", display: "flex", flexDirection: "column" } }, [
            feedScroll,
          ]),
          el(
            "div",
            { class: "pane", style: { flex: "0 0 38%", minHeight: "120px", borderTop: "1px solid var(--rule)" } },
            [
              paneHead(
                "terminal",
                "Daemon log",
                el("button", { class: "btn ghost sm", onClick: () => tailTerm && tailTerm.clear() }, "Clear"),
              ),
              logScroll,
            ],
          ),
        ]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));

        ui = { channelsStrip, statusGrid, consoleBody, feedScroll, feedEl };

        buildConsole(consoleBody);
        refreshChannels();
        buildStatusCard();
        refreshStatusCard();
        refreshConsoleEnabled();

        if (clockTimer) clearInterval(clockTimer);
        clockTimer = setInterval(() => {
          if (ui && ui.uptimeEl) ui.uptimeEl.textContent = uptimeStr();
        }, 1000);

        if (api.isRunning()) startPolling();
      }

      // ── Channels strip ─────────────────────────────────────────────────
      function refreshChannels() {
        if (!ui) return;
        CH.clear(ui.channelsStrip);
        const ids = knownChannels();
        if (ids.length === 0) {
          ui.channelsStrip.appendChild(
            el("span", { class: "muted", style: { fontSize: "12.5px" }, text: "No adapters detected yet — start the daemon to confirm configured channels." }),
          );
          return;
        }
        for (const id of ids) {
          const c = BY_ID[id] || { id, label: id, icon: "message" };
          const isLive = model.live.has(id);
          const chip = el("span", { class: "chip", title: `webhook path: /${id}/events` }, [
            el("span", { style: { color: isLive ? "var(--accent)" : "var(--ink-3)", display: "inline-grid" } }, icon(c.icon, 13)),
            el("span", { class: "v", text: c.label }),
            el("span", {
              class: `badge ${isLive ? "ok" : ""}`,
              text: isLive ? "live" : model.listening ? "idle" : "configured",
            }),
          ]);
          ui.channelsStrip.appendChild(chip);
        }
      }

      // ── Status card ────────────────────────────────────────────────────
      function buildStatusCard() {
        if (!ui) return;
        CH.clear(ui.statusGrid);

        const statsBar = el("div", { class: "stats" });
        const mk = (label, ic, accent) => {
          const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: "—" });
          statsBar.appendChild(el("div", { class: "stat" }, [v, el("div", { class: "k", text: label })]));
          return v;
        };
        ui.turnsEl = mk("Turns", "play", true);
        ui.heartbeatsEl = mk("Heartbeats", "clock");
        ui.uptimeEl = mk("Uptime", "activity");
        ui.errorsEl = mk("Webhook errs", "alert");

        const metaList = el("div", { class: "col", style: { gap: "7px" } });
        ui.metaList = metaList;

        ui.statusGrid.appendChild(statsBar);
        ui.statusGrid.appendChild(el("div", { class: "card" }, [el("div", { class: "card-body" }, metaList)]));
      }

      function metaRow(k, valueNode) {
        return el("div", { class: "row", style: { justifyContent: "space-between", gap: "12px", fontSize: "12.5px" } }, [
          el("span", { class: "muted mono", style: { fontSize: "11px" }, text: k }),
          valueNode,
        ]);
      }

      function refreshStatusCard() {
        if (!ui || !ui.turnsEl) return;
        ui.turnsEl.textContent = String(model.turnCount);
        ui.heartbeatsEl.textContent = String(model.heartbeatCount);
        ui.uptimeEl.textContent = uptimeStr();
        ui.errorsEl.textContent = String(model.webhookErrors);

        CH.clear(ui.metaList);

        // daemon line
        const running = api.isRunning();
        ui.metaList.appendChild(
          metaRow(
            "daemon",
            el("span", { class: `badge ${running && model.listening ? "ok" : running ? "warn" : ""}` }, [
              running ? (model.listening ? "listening" : "starting") : "stopped",
            ]),
          ),
        );
        if (model.port != null) {
          ui.metaList.appendChild(metaRow("webhook port", el("span", { class: "mono", text: String(model.port) })));
        }

        // status source — honest about how we know what we know
        ui.metaList.appendChild(
          metaRow(
            "status source",
            el(
              "span",
              { class: "mono", style: { fontSize: "11.5px", color: model.statusReachable ? "var(--accent)" : "var(--ink-2)" } },
              model.statusReachable ? "/status (live poll)" : "daemon log (derived)",
            ),
          ),
        );

        // gateway control-UI
        if (model.gatewayPort != null) {
          ui.metaList.appendChild(
            metaRow(
              "control-ui",
              el("span", { class: `badge ${model.gatewayUi ? "info" : ""}` }, [
                `:${model.gatewayPort}${model.gatewayUi ? " · ui" : ""}`,
              ]),
            ),
          );
        }

        // heartbeat
        ui.metaList.appendChild(
          metaRow(
            "heartbeat",
            model.heartbeat.enabled
              ? el("span", { class: "badge ok" }, [
                  model.heartbeat.everyMs != null ? `every ${CH.fmtMs(model.heartbeat.everyMs)}` : "on",
                ])
              : el("span", { class: "badge", text: "off" }),
          ),
        );

        // missing env (fatal)
        if (model.missingEnv) {
          ui.metaList.appendChild(
            metaRow("missing env", el("span", { class: "badge err", text: model.missingEnv })),
          );
        }

        // last heartbeat preview
        if (model.heartbeat.lastPreview) {
          ui.metaList.appendChild(
            el("div", { style: { marginTop: "4px" } }, [
              el("div", { class: "muted mono", style: { fontSize: "11px", marginBottom: "3px" }, text: "last wake" }),
              el("div", { class: "mono", style: { fontSize: "11.5px", color: "var(--ink-2)" }, text: model.heartbeat.lastPreview }),
            ]),
          );
        }
      }

      // ── Simulate-inbound console ───────────────────────────────────────
      // Posts a fake webhook to the daemon's real gateway route
      // (/<channel>/events). Adapters verify the signature, so an unsigned
      // probe returns 401 — that's the honest, useful operator signal that
      // the route is live and rejecting unsigned traffic. The response is
      // surfaced verbatim.
      function buildConsole(mount) {
        const channelSel = el("select", { class: "field", style: { cursor: "pointer" } });
        const refreshOpts = () => {
          CH.clear(channelSel);
          const ids = knownChannels();
          const list = ids.length ? ids : CHANNELS.map((c) => c.id);
          for (const id of list) {
            const c = BY_ID[id] || { id, label: id };
            channelSel.appendChild(el("option", { value: id, text: c.label }));
          }
        };
        refreshOpts();
        ui && (ui.refreshConsoleOpts = refreshOpts);

        const textInput = el("textarea", {
          class: "field",
          rows: 2,
          placeholder: "Message text to deliver as if it arrived from the channel…",
        });
        textInput.value = "Hello from the operator console";

        const pathLabel = el("code", { class: "codepath" });
        const updatePath = () => {
          pathLabel.textContent = `POST /proxy/${channelSel.value}/events`;
        };
        channelSel.addEventListener("change", () => {
          updatePath();
        });
        updatePath();

        const out = el("div", {
          class: "card",
          style: { display: "none" },
        });
        const outBody = el("div", { class: "card-body mono", style: { fontSize: "11.5px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } });
        const outHead = el("div", { class: "card-head" }, [el("span", { class: "label", text: "Response" })]);
        out.appendChild(outHead);
        out.appendChild(outBody);

        const sendBtn = el("button", { class: "btn primary" }, [icon("send", 15), el("span", { text: "Send probe" })]);
        ui && (ui.consoleSendBtn = sendBtn);

        sendBtn.addEventListener("click", async () => {
          const ch = channelSel.value;
          const text = textInput.value.trim();
          out.style.display = "block";
          CH.clear(outHead);
          outHead.appendChild(el("span", { class: "label", text: "Response" }));
          outHead.appendChild(el("span", { class: "grow" }));
          outHead.appendChild(el("span", { class: "spinner" }));
          outBody.textContent = `→ POST /${ch}/events …`;

          // A plausible, channel-shaped body. The adapter's verify() will
          // reject it (no valid signature) — surfacing the live, secured route.
          const payload = JSON.stringify({
            simulated: true,
            channel: ch,
            text,
            ts: Date.now(),
          });
          let resp, bodyText;
          const t0 = performance.now();
          try {
            resp = await fetch(`/proxy/${ch}/events`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: payload,
            });
            bodyText = await resp.text();
          } catch (e) {
            CH.clear(outHead);
            outHead.appendChild(el("span", { class: "label", text: "Response" }));
            outBody.textContent = `network error: ${e && e.message ? e.message : e}`;
            return;
          }
          const dt = performance.now() - t0;
          const status = resp.status;
          const kind =
            status === 401
              ? "err"
              : status === 200
                ? "ok"
                : status === 404 || status === 503
                  ? "warn"
                  : "";
          CH.clear(outHead);
          outHead.appendChild(el("span", { class: "label", text: "Response" }));
          outHead.appendChild(el("span", { class: "grow" }));
          outHead.appendChild(el("span", { class: `badge ${kind}`, text: `HTTP ${status}` }));
          outHead.appendChild(el("span", { class: "mono muted", style: { fontSize: "10.5px" }, text: CH.fmtMs(dt) }));

          const explain =
            status === 401
              ? "Route is live and rejecting unsigned webhooks — exactly what a secured /events endpoint should do. A real platform signs the request; the adapter verifies it before any model turn."
              : status === 200
                ? "Accepted (challenge ack, dedup, or an adapter that does not verify simulated bodies). If a turn ran, watch the activity feed."
                : status === 404
                  ? "No adapter mounted at this path, or the daemon is not running."
                  : status === 503
                    ? "Daemon not running — press Start."
                    : "";
          outBody.textContent = `${bodyText || "(empty body)"}${explain ? "\n\n" + explain : ""}`;

          pushActivity({
            icon: "hook",
            sev: kind === "ok" ? "accent" : kind === "err" ? "warn" : "muted",
            name: ch,
            title: "simulated inbound",
            sub: `HTTP ${status} · ${text.length} chars`,
            meta: CH.fmtMs(dt),
          });
        });

        mount.appendChild(
          el("div", { class: "col", style: { gap: "10px" } }, [
            el("div", { class: "row", style: { gap: "8px" } }, [
              el("div", { style: { flex: "0 0 130px" } }, channelSel),
              el("div", { class: "grow", style: { display: "flex", alignItems: "center" } }, pathLabel),
            ]),
            textInput,
            el("div", { class: "row", style: { gap: "8px" } }, [sendBtn]),
            out,
            el("div", {
              class: "muted",
              style: { fontSize: "11.5px", lineHeight: "1.5" },
              text: "Probes the daemon's real webhook route through the proxy. Unsigned bodies are rejected (HTTP 401) — that confirms the endpoint is live and secured without needing real platform credentials.",
            }),
          ]),
        );
      }

      function refreshConsoleEnabled() {
        if (!ui) return;
        const running = api.isRunning();
        if (ui.consoleSendBtn) {
          ui.consoleSendBtn.disabled = !running;
          const span = ui.consoleSendBtn.querySelector("span");
          if (span) span.textContent = running ? "Send probe" : "Start daemon first";
        }
        if (ui.refreshConsoleOpts) ui.refreshConsoleOpts();
      }
    },
  });
})();
