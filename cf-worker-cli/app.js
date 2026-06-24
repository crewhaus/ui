/* CrewHaus — cf-worker-cli shape UI.
   A compiled Cloudflare Worker that exposes an agent over HTTP with
   Server-Sent Events. There is NO process to run: the host imports worker.js
   in-process and routes every fetch('/worker/<path>') straight into the
   Worker's fetch handler. The hero is a streaming SSE Request Console that
   POSTs to /worker/chat with {messages:[{role,content}]} and renders the
   text / done / error events live, token by token. */
(function () {
  "use strict";
  const { el, icon, md, mdInto, clear, Composer, dropzone, fmtMs, fmtTokens, toast } = window.CH;

  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  // Minimal wrangler.toml reader — pulls the few top-level scalars + arrays we
  // surface as chips. String#match only (no RegExp.exec); never eval'd.
  function parseToml(src) {
    const out = {};
    for (const rawLine of String(src).split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("[")) continue;
      const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      const hash = val.indexOf(" #");
      if (hash >= 0 && val[0] !== '"' && val[0] !== "[") val = val.slice(0, hash).trim();
      if (val.startsWith("[")) {
        const items = [];
        let rest = val;
        let mm;
        // Non-global match in a loop; advance `rest` past each quoted item.
        while ((mm = rest.match(/"([^"]*)"/))) {
          items.push(mm[1]);
          rest = rest.slice(mm.index + mm[0].length);
        }
        out[key] = items;
      } else {
        out[key] = val.replace(/^"(.*)"$/, "$1");
      }
    }
    return out;
  }

  CH.app({
    // cf-worker run class hides lifecycle controls automatically.
    build(api) {
      let chat = null;
      let composer = null;
      let sending = false;
      let mode = null;
      // Conversation history sent to the worker as {messages:[{role,content}]}.
      const history = [];
      // Per-session request stats.
      const stats = { requests: 0, tokens: 0, errors: 0, lastMs: 0 };
      let statEls = null;
      let healthDot = null;
      let healthTxt = null;

      function updateStats() {
        if (!statEls) return;
        statEls.requests.textContent = String(stats.requests);
        statEls.tokens.textContent = fmtTokens(stats.tokens);
        statEls.latency.textContent = stats.lastMs ? fmtMs(stats.lastMs) : "—";
        statEls.errors.textContent = String(stats.errors);
      }

      // ── View switching ────────────────────────────────────────────────
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      function buildEmpty() {
        chat = composer = statEls = healthDot = healthTxt = null;
        clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "cloud",
            title: "Drop in a compiled Cloudflare Worker",
            subtitle:
              "This UI invokes a Cloudflare Worker emitted from a target: cli CrewHaus spec — no process, no build step.",
            steps: [
              "Emit a Cloudflare Worker from a `target: cli` spec (the CrewHaus compiler's `cf-worker` mode)",
              "Copy `worker.js`, `wrangler.toml` and `package.json` into this UI's `harness/` folder",
              "Add a `harness/.dev.vars` line: `ANTHROPIC_API_KEY=sk-ant-…`",
              "Reload — the **Request Console** is live the instant the page loads (nothing to start)",
            ],
          }),
        );
      }

      function buildActive() {
        clear(api.main);

        // ── left: request console (the hero) ─────────────────────────────
        const leftScroll = el("div", { class: "pane-scroll" });
        const leftFoot = el("div");
        const sendBadge = el("span", { class: "badge info", text: "POST /worker/chat" });
        const left = el("div", { class: "pane" }, [
          paneHead("zap", "Request Console", sendBadge),
          leftScroll,
          leftFoot,
        ]);
        chat = window.CH.Chat(leftScroll, { agentLabel: api.config.title });
        composer = Composer(leftFoot, (txt) => send(txt), {
          placeholder: "Send a message to the Worker…",
          hint: "streams text/event-stream",
        });
        composer.setEnabled(true);
        chat.systemNote(
          "This endpoint streams Server-Sent Events. Send a message and tokens render live. The full conversation is forwarded each turn as the messages[] array.",
        );

        // ── right: worker dashboard ──────────────────────────────────────
        const right = el("div", { class: "pane" }, [
          paneHead("cloud", "Worker", clearBtn()),
          buildRightScroll(),
        ]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));
        loadMeta();
        probeHealth();
      }

      function clearBtn() {
        return el(
          "button",
          {
            class: "btn ghost sm",
            title: "Clear the conversation history",
            onClick: () => {
              history.length = 0;
              if (chat) {
                chat.clear();
                chat.systemNote("Conversation cleared. The next message starts a fresh messages[] array.");
              }
            },
          },
          [icon("refresh", 13), el("span", { text: "Reset" })],
        );
      }

      // Right scroll: endpoint probe + meta chips + request stats + routes + files.
      let metaChips = null;
      let routesWrap = null;
      let filesWrap = null;

      function buildRightScroll() {
        const scroll = el("div", { class: "pane-scroll" });

        // endpoint probe card
        healthDot = el("span", { class: "dot-probe" });
        healthTxt = el("span", { class: "mono", text: "probing…" });
        const probeCard = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon-acc" }, icon("activity", 14)),
            el("span", { class: "label", text: "Endpoint" }),
            el("span", { class: "grow" }),
            el(
              "button",
              { class: "btn ghost sm", onClick: () => probeHealth() },
              [icon("refresh", 13), el("span", { text: "Probe" })],
            ),
          ]),
          el("div", { class: "card-body" }, [
            el("div", { class: "probe-row" }, [healthDot, healthTxt]),
            el("div", { class: "endpoint-list" }, [
              endpointRow("POST", "/worker/chat", "streaming SSE chat turn"),
              endpointRow("GET", "/worker/health", "liveness + harness name"),
            ]),
          ]),
        ]);

        // request stats
        const statsBar = el("div", { class: "stats" });
        statEls = {
          requests: stat(statsBar, "Requests", "0", "send"),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          latency: stat(statsBar, "Last latency", "—", "clock"),
          errors: stat(statsBar, "Errors", "0", "alert"),
        };

        // worker meta chips (populated from wrangler.toml / package.json)
        metaChips = el("div", { class: "chips" }, el("span", { class: "muted", text: "loading manifest…" }));

        // routes / config
        routesWrap = el("div", { class: "chips" });

        // bundle files
        filesWrap = el("div", { class: "filelist" });

        scroll.appendChild(
          el("div", { class: "col" }, [
            probeCard,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Session" }),
            statsBar,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Manifest" }),
            metaChips,
            routesWrap,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Bundle files" }),
            filesWrap,
            el("div", { class: "secret-note" }, [
              icon("shield", 13),
              el("span", null, [
                "Secrets live in ",
                el("code", { text: ".dev.vars" }),
                " (",
                el("code", { text: "ANTHROPIC_API_KEY" }),
                ") — never served to the browser, never committed.",
              ]),
            ]),
          ]),
        );
        renderFiles();
        return scroll;
      }

      function endpointRow(method, path, desc) {
        return el("div", { class: "ep" }, [
          el("span", { class: `ep-m ep-${method.toLowerCase()}`, text: method }),
          el("span", { class: "ep-p mono", text: path }),
          el("span", { class: "ep-d", text: desc }),
        ]);
      }

      function renderFiles() {
        if (!filesWrap) return;
        clear(filesWrap);
        const files = (api.state.harness && api.state.harness.files) || [];
        const shown = files.filter((f) => !/README|DROP_/i.test(f));
        if (!shown.length) {
          filesWrap.appendChild(el("span", { class: "muted", text: "—" }));
          return;
        }
        for (const f of shown) {
          const isEntry = f === (api.state.harness && api.state.harness.entry);
          const isSecret = f === ".dev.vars";
          filesWrap.appendChild(
            el("div", { class: `f ${isEntry ? "entry" : ""}` }, [
              icon(isSecret ? "shield" : isEntry ? "cloud" : "file", 13),
              el("span", { text: f }),
              isEntry ? el("span", { class: "badge ok", text: "entry" }) : null,
              isSecret ? el("span", { class: "badge", text: "secret" }) : null,
            ]),
          );
        }
      }

      // Refresh the file list whenever the harness changes.
      api.onState(() => {
        if (mode === "active") renderFiles();
      });

      // ── Meta: read wrangler.toml + package.json (static, never secrets) ──
      async function loadMeta() {
        let toml = {};
        let pkg = {};
        try {
          const r = await fetch("/harness/wrangler.toml");
          if (r.ok) toml = parseToml(await r.text());
        } catch (_) {}
        try {
          const r = await fetch("/harness/package.json");
          if (r.ok) pkg = await r.json();
        } catch (_) {}

        if (metaChips) {
          clear(metaChips);
          const add = (k, v) =>
            v != null &&
            metaChips.appendChild(
              el("span", { class: "chip" }, [
                el("span", { class: "k", text: k }),
                el("span", { class: "v", text: String(v) }),
              ]),
            );
          add("name", toml.name || pkg.name);
          add("main", toml.main);
          add("compat", toml.compatibility_date);
          add("version", pkg.version);
          if (!metaChips.childNodes.length)
            metaChips.appendChild(el("span", { class: "muted", text: "no manifest found" }));
        }
        if (routesWrap) {
          clear(routesWrap);
          const flags = toml.compatibility_flags;
          if (Array.isArray(flags))
            for (const fl of flags)
              routesWrap.appendChild(
                el("span", { class: "chip" }, [icon("zap", 12), el("span", { class: "v", text: fl })]),
              );
          if (toml.route)
            routesWrap.appendChild(
              el("span", { class: "chip" }, [icon("link", 12), el("span", { class: "v", text: toml.route })]),
            );
          const scripts = pkg.scripts || {};
          for (const name of Object.keys(scripts))
            routesWrap.appendChild(
              el("span", { class: "chip" }, [
                el("span", { class: "k", text: name }),
                el("span", { class: "v", text: scripts[name] }),
              ]),
            );
        }
      }

      // ── Health probe: GET /worker/health -> { ok, harness } ─────────────
      function setHealth(state, text) {
        if (!healthDot) return;
        healthDot.dataset.state = state;
        healthTxt.textContent = text;
      }
      async function probeHealth() {
        setHealth("pending", "probing…");
        const t0 = performance.now();
        try {
          const r = await fetch("/worker/health");
          const dt = Math.round(performance.now() - t0);
          if (!r.ok) {
            setHealth("down", `HTTP ${r.status} · ${dt}ms`);
            return;
          }
          const j = await r.json().catch(() => ({}));
          if (j && j.ok) setHealth("up", `ok · ${j.harness || "worker"} · ${dt}ms`);
          else setHealth("down", `unexpected response · ${dt}ms`);
        } catch (e) {
          setHealth("down", `unreachable: ${e && e.message ? e.message : "error"}`);
        }
      }

      // ── The hero: POST /worker/chat and consume the SSE stream ──────────
      async function send(text) {
        if (sending || !chat) return;
        sending = true;
        if (composer) composer.setEnabled(false);
        chat.user(text);
        history.push({ role: "user", content: text });

        const t0 = performance.now();
        let acc = "";
        let gotText = false;
        let hadError = false;

        try {
          const resp = await fetch("/worker/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: history }),
          });

          const ctype = resp.headers.get("content-type") || "";
          if (!resp.ok || !resp.body || ctype.indexOf("text/event-stream") < 0) {
            // The worker returns JSON {error:{code,message}} on the unhappy path.
            const j = await resp.json().catch(() => null);
            const detail =
              j && j.error
                ? `${j.error.code}${j.error.message ? ` — ${j.error.message}` : ""}`
                : `HTTP ${resp.status}`;
            failTurn(detail);
            return;
          }

          // Parse the SSE body: blocks separated by \n\n, "event:" + "data:" lines.
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let sep;
            while ((sep = buf.indexOf("\n\n")) !== -1) {
              const raw = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              let eventName = "message";
              let data = "";
              for (const line of raw.split("\n")) {
                if (line.startsWith("event:")) eventName = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
              }
              if (!data) continue;
              let payload;
              try {
                payload = JSON.parse(data);
              } catch (_) {
                continue;
              }
              if (eventName === "text" && payload.text) {
                acc += payload.text;
                gotText = true;
                chat.assistant(payload.text);
              } else if (eventName === "done") {
                if (payload.text && !gotText) {
                  acc = payload.text;
                  chat.assistant(payload.text);
                }
                if (payload.stopReason && payload.stopReason !== "end_turn")
                  chat.systemNote(`stop reason: ${payload.stopReason}`);
              } else if (eventName === "error") {
                hadError = true;
                failTurn(payload.message || "stream error");
              }
            }
          }

          chat.endTurn();
          if (!hadError) {
            if (acc) history.push({ role: "assistant", content: acc });
            const dt = Math.round(performance.now() - t0);
            stats.requests++;
            stats.lastMs = dt;
            // Rough token estimate from streamed characters (~4 chars/token).
            stats.tokens += Math.max(1, Math.round(acc.length / 4));
            updateStats();
          }
        } catch (e) {
          failTurn(e && e.message ? e.message : "request failed");
        } finally {
          sending = false;
          if (composer) composer.setEnabled(true);
        }

        function failTurn(detail) {
          hadError = true;
          chat.endTurn();
          chat.systemNote(`Request failed — ${detail}`);
          // The failed user turn would poison the next messages[] array, so drop it.
          if (history.length && history[history.length - 1].role === "user") history.pop();
          stats.errors++;
          updateStats();
          toast(`Worker error: ${detail}`, "err");
        }
      }

      function stat(mount, label, value, ic) {
        const head = el("div", { class: "stat-head" }, [
          el("span", { class: "stat-ic" }, icon(ic, 12)),
          el("div", { class: "k", text: label }),
        ]);
        const v = el("div", { class: "v", text: value });
        mount.appendChild(el("div", { class: "stat" }, [head, v]));
        return v;
      }
    },
  });

  // ── Shape-local styles (kept tiny; everything else uses ui.css) ─────────
  const css = `
    .dot-probe{width:9px;height:9px;border-radius:50%;background:var(--ink-3);flex:0 0 auto}
    .dot-probe[data-state="up"]{background:var(--accent);box-shadow:0 0 0 3px var(--accent-ghost)}
    .dot-probe[data-state="down"]{background:var(--red);box-shadow:0 0 0 3px var(--red-ghost)}
    .dot-probe[data-state="pending"]{background:var(--amber);animation:pulse 1s infinite}
    .probe-row{display:flex;align-items:center;gap:9px;margin-bottom:12px;font-size:12.5px;color:var(--ink-2)}
    .icon-acc{color:var(--accent);display:inline-grid;place-items:center}
    .endpoint-list{display:flex;flex-direction:column;gap:8px}
    .ep{display:grid;grid-template-columns:auto auto 1fr;gap:9px;align-items:center}
    .ep-m{font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.05em;
      padding:2px 6px;border-radius:5px;border:1px solid var(--rule-2);color:var(--ink-2);background:var(--panel-3)}
    .ep-m.ep-post{color:var(--accent);background:var(--accent-ghost);border-color:var(--accent-glow)}
    .ep-m.ep-get{color:var(--blue);background:var(--blue-ghost);border-color:rgba(100,181,255,.3)}
    .ep-p{font-size:12px;color:var(--ink)}
    .ep-d{font-size:11px;color:var(--ink-3);text-align:right;font-family:var(--mono)}
    .stat .stat-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
    .stat .stat-ic{color:var(--accent);display:inline-grid;place-items:center;opacity:.85}
    .stat .stat-head .k{margin:0}
    .secret-note{display:flex;gap:9px;align-items:flex-start;margin-top:4px;padding:11px 12px;
      border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--panel-2);
      font-size:11.5px;color:var(--ink-3);line-height:1.5}
    .secret-note svg{color:var(--amber);flex:0 0 auto;margin-top:2px;width:13px;height:13px}
    .secret-note code{font-family:var(--mono);font-size:11px;color:var(--accent)}
  `;
  document.head.appendChild(el("style", { text: css }));
})();
