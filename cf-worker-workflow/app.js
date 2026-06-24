/* CrewHaus — cf-worker-workflow shape UI.
   A compiled Cloudflare Worker that runs a multi-step workflow at the edge and
   streams it back over Server-Sent Events. There is NO process to run: the host
   imports worker.js in-process and routes every fetch('/worker/<path>') straight
   into the Worker's fetch handler.

   The worker runs the IR's steps SEQUENTIALLY server-side: steps 1..N-1 are
   non-streaming calls whose terminal text is threaded into the next step, and
   the FINAL step streams token-by-token. The only progress signal on the wire
   is a marker the worker injects into the `text` stream between steps:

       \n[step N/total: <step name>]\n

   This UI's hero is a STEP TIMELINE that pre-loads from the worker's baked-in
   CONFIG.steps (name + model per step) and then advances live as those markers
   arrive — while the answer panel renders only the clean assistant prose, with
   the markers stripped out. */
(function () {
  "use strict";
  const { el, icon, clear, Composer, dropzone, fmtMs, fmtTokens, toast } = window.CH;

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

  // Pull the workflow's baked-in step plan out of the generated worker.js so the
  // timeline can render BEFORE the first run. The emitter writes a literal
  //   const CONFIG = { name: "...", steps: [ { name: "..", model: "..", ... } ] };
  // We never eval it — we scan the `name:`/`model:` pairs inside the steps array
  // with non-global String#match passes. Best-effort: if the format ever drifts,
  // the timeline falls back to whatever the live SSE markers report.
  function parseWorkerPlan(src) {
    const text = String(src);
    const out = { name: null, steps: [] };
    // Worker-level name: first `name: "..."` that appears before `steps:`.
    const stepsIdx = text.indexOf("steps:");
    const head = stepsIdx >= 0 ? text.slice(0, stepsIdx) : text;
    const nameM = head.match(/name:\s*"((?:[^"\\]|\\.)*)"/);
    if (nameM) out.name = unescapeJs(nameM[1]);
    if (stepsIdx < 0) return out;
    // Bound the scan to the steps array literal: from `steps:` to the line that
    // closes it (the emitter writes `  ],` right after the last step entry).
    const after = text.slice(stepsIdx);
    const close = after.indexOf("\n  ],");
    const region = close >= 0 ? after.slice(0, close) : after;
    // Each step entry is `{ name: "..", model: "..", instructions: ".." }`.
    let rest = region;
    let nm;
    while ((nm = rest.match(/name:\s*"((?:[^"\\]|\\.)*)"/))) {
      const consumed = nm.index + nm[0].length;
      const tail = rest.slice(consumed);
      const md = tail.match(/model:\s*"((?:[^"\\]|\\.)*)"/);
      out.steps.push({ name: unescapeJs(nm[1]), model: md ? unescapeJs(md[1]) : null });
      rest = tail;
    }
    return out;
  }

  function unescapeJs(s) {
    return String(s)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  // The worker injects "\n[step N/total: name]\n" markers into the text stream.
  // Parse one out of a chunk; return { num, total, name, before, after } or null.
  function matchStepMarker(s) {
    const m = s.match(/\[step (\d+)\/(\d+): ([^\]]*)\]/);
    if (!m) return null;
    return {
      num: Number(m[1]),
      total: Number(m[2]),
      name: m[3],
      before: s.slice(0, m.index),
      after: s.slice(m.index + m[0].length),
    };
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
      const stats = { runs: 0, steps: 0, tokens: 0, errors: 0, lastMs: 0 };
      let statEls = null;
      let healthDot = null;
      let healthTxt = null;

      // The step plan (from worker.js) and its live rendered rows.
      let plan = { name: null, steps: [] };
      let stepRows = []; // [{ row, dot, dur, started, sub }]
      let timelineEl = null;
      let timelineHint = null;
      let runStart = 0;

      function updateStats() {
        if (!statEls) return;
        statEls.runs.textContent = String(stats.runs);
        statEls.steps.textContent = String(stats.steps);
        statEls.tokens.textContent = fmtTokens(stats.tokens);
        statEls.latency.textContent = stats.lastMs ? fmtMs(stats.lastMs) : "—";
      }

      // ── View switching ────────────────────────────────────────────────
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      function buildEmpty() {
        chat = composer = statEls = healthDot = healthTxt = timelineEl = null;
        stepRows = [];
        clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "workflow",
            title: "Drop in a compiled Workflow Worker",
            subtitle:
              "This UI runs a Cloudflare Worker emitted from a target: workflow CrewHaus spec — a multi-step workflow that executes at the edge. No process, no build step.",
            steps: [
              "Emit a Cloudflare Worker from a `target: workflow` spec (the CrewHaus compiler's `cf-worker` mode)",
              "Copy `worker.js`, `wrangler.toml` and `package.json` into this UI's `harness/` folder",
              "Add a `harness/.dev.vars` line: `ANTHROPIC_API_KEY=sk-ant-…`",
              "Reload — the **Step Timeline** loads from the bundle and the console is live instantly",
            ],
          }),
        );
      }

      function buildActive() {
        clear(api.main);

        // ── left: request console (the answer panel) ─────────────────────
        const leftScroll = el("div", { class: "pane-scroll" });
        const leftFoot = el("div");
        const sendBadge = el("span", { class: "badge info", text: "POST /worker/chat" });
        const left = el("div", { class: "pane" }, [
          paneHead("message", "Request Console", sendBadge),
          leftScroll,
          leftFoot,
        ]);
        chat = window.CH.Chat(leftScroll, { agentLabel: api.config.title });
        composer = Composer(leftFoot, (txt) => run(txt), {
          placeholder: "Enter the workflow's input…",
          hint: "runs steps server-side · streams SSE",
        });
        composer.setEnabled(true);
        chat.systemNote(
          "Send an input to kick off the workflow. The worker runs each step sequentially server-side and threads every step's output into the next; the final step streams back here token by token. Watch the Step Timeline advance on the right.",
        );

        // ── right: workflow dashboard ────────────────────────────────────
        const right = el("div", { class: "pane" }, [
          paneHead("workflow", "Workflow", clearBtn()),
          buildRightScroll(),
        ]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));
        loadPlanAndMeta();
        probeHealth();
      }

      function clearBtn() {
        return el(
          "button",
          {
            class: "btn ghost sm",
            title: "Clear the conversation history and reset the timeline",
            onClick: () => {
              history.length = 0;
              resetTimeline();
              if (chat) {
                chat.clear();
                chat.systemNote("Conversation cleared. The next input starts a fresh run.");
              }
            },
          },
          [icon("refresh", 13), el("span", { text: "Reset" })],
        );
      }

      // Right scroll: step timeline + endpoint probe + stats + manifest + files.
      let metaChips = null;
      let filesWrap = null;

      function buildRightScroll() {
        const scroll = el("div", { class: "pane-scroll" });

        // ── the hero: step timeline ──────────────────────────────────────
        timelineHint = el("div", { class: "tl-hint muted", text: "Loading step plan from worker.js…" });
        timelineEl = el("div", { class: "timeline" });
        const timelineCard = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon-acc" }, icon("layers", 14)),
            el("span", { class: "label", text: "Step Timeline" }),
            el("span", { class: "grow" }),
            el("span", { class: "badge", text: "sequential" }),
          ]),
          el("div", { class: "card-body" }, [timelineHint, timelineEl]),
        ]);

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
              endpointRow("POST", "/worker/chat", "runs the workflow, streams SSE"),
              endpointRow("GET", "/worker/health", "liveness + workflow name"),
            ]),
          ]),
        ]);

        // session stats
        const statsBar = el("div", { class: "stats" });
        statEls = {
          runs: stat(statsBar, "Runs", "0", "play"),
          steps: stat(statsBar, "Steps run", "0", "layers"),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          latency: stat(statsBar, "Last run", "—", "clock"),
        };

        // worker meta chips (populated from wrangler.toml / package.json)
        metaChips = el("div", { class: "chips" }, el("span", { class: "muted", text: "loading manifest…" }));

        // bundle files
        filesWrap = el("div", { class: "filelist" });

        scroll.appendChild(
          el("div", { class: "col" }, [
            timelineCard,
            el("div", { class: "divider" }),
            probeCard,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Session" }),
            statsBar,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Manifest" }),
            metaChips,
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

      // ── Step timeline rendering ─────────────────────────────────────────
      function renderTimeline() {
        if (!timelineEl) return;
        clear(timelineEl);
        stepRows = [];
        if (!plan.steps.length) {
          if (timelineHint) {
            timelineHint.textContent =
              "No step plan found in the bundle — the timeline will build itself from the live stream.";
          }
          return;
        }
        if (timelineHint) {
          const n = plan.steps.length;
          timelineHint.textContent = `${n} step${n === 1 ? "" : "s"} · each is one single-turn LLM call, threaded into the next`;
        }
        plan.steps.forEach((step, i) => {
          const dot = el("div", { class: "tl-dot" }, el("span", { class: "tl-n", text: String(i + 1) }));
          const dur = el("span", { class: "tl-dur mono" });
          const sub = el("div", { class: "tl-sub mono", text: step.model || "" });
          const row = el("div", { class: "tl-row", dataset: { state: "pending" } }, [
            el("div", { class: "tl-rail" }, [dot, i < plan.steps.length - 1 ? el("div", { class: "tl-line" }) : null]),
            el("div", { class: "tl-body" }, [
              el("div", { class: "tl-head" }, [el("span", { class: "tl-name", text: step.name }), dur]),
              sub,
            ]),
          ]);
          timelineEl.appendChild(row);
          stepRows.push({ row, dot, dur, sub, started: 0, name: step.name });
        });
      }

      function resetTimeline() {
        for (const r of stepRows) {
          r.row.dataset.state = "pending";
          r.dur.textContent = "";
          clear(r.dot);
          r.dot.appendChild(el("span", { class: "tl-n", text: String(stepRows.indexOf(r) + 1) }));
        }
      }

      // Find a timeline row for a (1-based) step number / name. Falls back to
      // appending an ad-hoc row if the live stream reports a step we didn't
      // pre-parse (keeps the timeline truthful even when worker.js drifts).
      function rowForStep(num, total, name) {
        let r = stepRows[num - 1];
        if (r) return r;
        if (!timelineEl) return null;
        const dot = el("div", { class: "tl-dot" }, el("span", { class: "tl-n", text: String(num) }));
        const dur = el("span", { class: "tl-dur mono" });
        const sub = el("div", { class: "tl-sub mono", text: total ? `step ${num} of ${total}` : "" });
        const row = el("div", { class: "tl-row", dataset: { state: "pending" } }, [
          el("div", { class: "tl-rail" }, [dot, el("div", { class: "tl-line" })]),
          el("div", { class: "tl-body" }, [
            el("div", { class: "tl-head" }, [el("span", { class: "tl-name", text: name || `step ${num}` }), dur]),
            sub,
          ]),
        ]);
        timelineEl.appendChild(row);
        r = { row, dot, dur, sub, started: 0, name };
        stepRows[num - 1] = r;
        return r;
      }

      function markStepRunning(num, total, name) {
        // Close out any previously running step (its successor starting implies
        // it finished — the worker emits one marker per step in order).
        for (const r of stepRows) {
          if (r && r.row.dataset.state === "running") finishStep(r);
        }
        const r = rowForStep(num, total, name);
        if (!r) return;
        if (name && r.name !== name) {
          const nameEl = r.row.querySelector(".tl-name");
          if (nameEl) nameEl.textContent = name;
          r.name = name;
        }
        r.row.dataset.state = "running";
        r.started = performance.now();
        clear(r.dot);
        r.dot.appendChild(el("span", { class: "tl-spin" }));
        stats.steps++;
        updateStats();
        scrollRowIntoView(r);
      }

      function finishStep(r) {
        if (!r || r.row.dataset.state === "done") return;
        r.row.dataset.state = "done";
        if (r.started) r.dur.textContent = fmtMs(performance.now() - r.started);
        clear(r.dot);
        r.dot.appendChild(icon("check", 12));
      }

      function failStepsFrom() {
        for (const r of stepRows) {
          if (!r) continue;
          if (r.row.dataset.state === "running") {
            r.row.dataset.state = "error";
            clear(r.dot);
            r.dot.appendChild(icon("x", 12));
          }
        }
      }

      function finishAll() {
        for (const r of stepRows) if (r && r.row.dataset.state === "running") finishStep(r);
      }

      function scrollRowIntoView(r) {
        if (r && r.row && r.row.scrollIntoView)
          r.row.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

      // ── Plan + meta: read worker.js / wrangler.toml / package.json ──────
      async function loadPlanAndMeta() {
        let toml = {};
        let pkg = {};
        try {
          const r = await fetch("/harness/worker.js");
          if (r.ok) plan = parseWorkerPlan(await r.text());
        } catch (_) {}
        renderTimeline();

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
          add("name", plan.name || toml.name || pkg.name);
          add("steps", plan.steps.length || null);
          add("compat", toml.compatibility_date);
          add("version", pkg.version);
          const flags = toml.compatibility_flags;
          if (Array.isArray(flags))
            for (const fl of flags)
              metaChips.appendChild(
                el("span", { class: "chip" }, [icon("zap", 12), el("span", { class: "v", text: fl })]),
              );
          if (!metaChips.childNodes.length)
            metaChips.appendChild(el("span", { class: "muted", text: "no manifest found" }));
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
          if (j && j.ok) setHealth("up", `ok · ${j.harness || "workflow"} · ${dt}ms`);
          else setHealth("down", `unexpected response · ${dt}ms`);
        } catch (e) {
          setHealth("down", `unreachable: ${e && e.message ? e.message : "error"}`);
        }
      }

      // ── The hero: POST /worker/chat and consume the SSE stream ──────────
      async function run(text) {
        if (sending || !chat) return;
        sending = true;
        if (composer) composer.setEnabled(false);
        chat.user(text);
        history.push({ role: "user", content: text });
        resetTimeline();
        runStart = performance.now();

        let acc = "";
        let hadError = false;
        let started = false; // whether we've opened the assistant bubble yet

        // text deltas can split a step marker across chunks, so buffer the raw
        // text stream and only flush prose (marker-free) into the chat.
        let pending = "";

        // Drain the buffer: peel off every complete step marker, route prose to
        // the chat, and leave any partial trailing "[step …" fragment buffered.
        function drainPending(isFinal) {
          for (;;) {
            const mk = matchStepMarker(pending);
            if (!mk) break;
            if (mk.before) emitProse(mk.before);
            markStepRunning(mk.num, mk.total, mk.name);
            pending = mk.after;
          }
          // Hold back a possible partial marker at the tail (unless finalizing).
          const open = pending.lastIndexOf("[");
          if (!isFinal && open >= 0 && pending.indexOf("]", open) < 0) {
            emitProse(pending.slice(0, open));
            pending = pending.slice(open);
          } else {
            emitProse(pending);
            pending = "";
          }
        }

        function emitProse(s) {
          if (!s) return;
          acc += s;
          started = true;
          chat.assistant(s);
        }

        try {
          const resp = await fetch("/worker/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: history }),
          });

          const ctype = resp.headers.get("content-type") || "";
          if (!resp.ok || !resp.body || ctype.indexOf("text/event-stream") < 0) {
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
                pending += payload.text;
                drainPending(false);
              } else if (eventName === "done") {
                drainPending(true);
                if (payload.text && !started) emitProse(payload.text);
                finishAll();
                if (payload.stopReason && payload.stopReason !== "end_turn")
                  chat.systemNote(`stop reason: ${payload.stopReason}`);
              } else if (eventName === "error") {
                drainPending(true);
                hadError = true;
                failStepsFrom();
                failTurn(payload.message || "stream error");
              }
            }
          }
          drainPending(true);

          chat.endTurn();
          if (!hadError) {
            finishAll();
            if (acc) history.push({ role: "assistant", content: acc.trim() });
            const dt = Math.round(performance.now() - runStart);
            stats.runs++;
            stats.lastMs = dt;
            // Rough token estimate from streamed characters (~4 chars/token).
            stats.tokens += Math.max(1, Math.round(acc.length / 4));
            updateStats();
          }
        } catch (e) {
          failStepsFrom();
          failTurn(e && e.message ? e.message : "request failed");
        } finally {
          sending = false;
          if (composer) composer.setEnabled(true);
        }

        function failTurn(detail) {
          hadError = true;
          chat.endTurn();
          chat.systemNote(`Workflow failed — ${detail}`);
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

    /* ── Step timeline ─────────────────────────────────────────────────── */
    .tl-hint{font-size:11.5px;margin-bottom:12px;line-height:1.45}
    .timeline{display:flex;flex-direction:column}
    .tl-row{display:grid;grid-template-columns:26px 1fr;gap:11px;min-height:46px}
    .tl-rail{display:flex;flex-direction:column;align-items:center}
    .tl-dot{width:24px;height:24px;flex:0 0 auto;border-radius:50%;display:grid;place-items:center;
      background:var(--panel-3);border:1px solid var(--rule-2);color:var(--ink-3);
      font-family:var(--mono);font-size:11px;transition:all .2s}
    .tl-dot svg{width:12px;height:12px}
    .tl-line{flex:1;width:2px;background:var(--rule-2);margin:3px 0;min-height:14px}
    .tl-body{padding-bottom:14px;min-width:0}
    .tl-head{display:flex;align-items:baseline;gap:8px}
    .tl-name{font-weight:500;color:var(--ink-2);overflow-wrap:anywhere}
    .tl-dur{margin-left:auto;font-size:10.5px;color:var(--ink-3);white-space:nowrap}
    .tl-sub{font-size:11px;color:var(--ink-4);margin-top:2px;overflow-wrap:anywhere}
    .tl-spin{width:12px;height:12px;border:2px solid var(--accent-ghost);border-top-color:var(--accent);
      border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
    .tl-row[data-state="running"] .tl-dot{background:var(--accent-ghost);border-color:var(--accent);color:var(--accent);
      box-shadow:0 0 0 3px var(--accent-ghost)}
    .tl-row[data-state="running"] .tl-name{color:var(--ink)}
    .tl-row[data-state="done"] .tl-dot{background:var(--accent-ghost);border-color:var(--accent-glow);color:var(--accent)}
    .tl-row[data-state="done"] .tl-name{color:var(--ink-2)}
    .tl-row[data-state="done"] .tl-line,.tl-row[data-state="running"] .tl-line{background:var(--accent-glow)}
    .tl-row[data-state="error"] .tl-dot{background:var(--red-ghost);border-color:var(--red);color:var(--red)}
    .tl-row[data-state="error"] .tl-name{color:var(--red)}
  `;
  document.head.appendChild(el("style", { text: css }));
})();
