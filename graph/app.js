/* CrewHaus — graph shape UI.
   A stateful DAG of LLM nodes. The user sends one initial message; the graph
   engine threads state from the entry node along its edges to a terminal node,
   adding each LLM node's reply to the state under its own name. This UI is a
   one-shot run console:

     • a prominent Run box that calls api.submit(query) (stdin -> EOF);
     • a NODES panel that lists the graph's nodes and lights them up as they
       enter / complete (derived from the engine's [graph] events on stderr);
     • a Result panel that renders the streamed answer (markdown) + final state;
     • the standard TraceEvent activity feed (inner per-node runChatLoop events).

   Data flow (verified against target-graph emitter + graph-engine + host.ts):
     - graph-engine events (node_start | node_end | checkpoint | hitl_pause |
       run_done | edge_taken) are written to STDERR as `[graph] {json}` lines and
       arrive on api.on('stderr'); we parse them to drive the NODES panel + result.
     - inner runChatLoop TraceEvents (model_response, cost_accrual, …) arrive on
       api.on('event') with CREWHAUS_TRACE=json -> standard feed + cost/token stats.
     - per-node assistant prose + the final pretty-printed JSON state arrive on
       api.on('stdout'); the engine also dumps a `paused at …` / `to resume: …`
       hint on stdout when a node pauses for human approval. */
(function () {
  "use strict";
  const { el, icon, md, mdInto, dropzone, stripAnsi, events, fmtMs, fmtTokens, fmtUsd, clear } =
    window.CH;

  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  CH.app({
    controls: ["stop"],
    build(api) {
      // ── run + render state ───────────────────────────────────────────────
      const stats = events.newStats();
      let running = false; // a graph run is in flight (between submit and exit)
      let resultBuf = ""; // accumulated assistant prose for the current run
      let finalState = null; // parsed run_done state (authoritative result)
      let pausedInfo = null; // { nodeName, prompt, checkpointId, graphRunId }
      let lastGraphRunId = null;

      // node bookkeeping: name -> { status, durationMs, turn }
      const nodeOrder = []; // discovery order
      const nodeMap = new Map();

      // live DOM handles (set in buildActive)
      let runInput = null;
      let runBtn = null;
      let resultEl = null;
      let resultMeta = null;
      let nodesEl = null;
      let nodesEmpty = null;
      let feedEl = null;
      let feedScroll = null;
      let statEls = null;
      let pauseBanner = null;
      let hintLine = null;

      // ── helpers ──────────────────────────────────────────────────────────
      function updateStats() {
        if (!statEls) return;
        const done = nodeOrder.filter((n) => nodeMap.get(n).status === "done").length;
        statEls.nodes.textContent = nodeOrder.length ? `${done}/${nodeOrder.length}` : "0";
        statEls.turns.textContent = String(stats.turns);
        statEls.tokens.textContent = fmtTokens(stats.tokensIn + stats.tokensOut);
        statEls.cost.textContent = fmtUsd(stats.costMicros);
      }

      function ensureNode(name) {
        if (nodeMap.has(name)) return nodeMap.get(name);
        const rec = { name, status: "pending", durationMs: null, turn: null, row: null };
        nodeMap.set(name, rec);
        nodeOrder.push(name);
        if (nodesEl) {
          if (nodesEmpty) {
            nodesEmpty.remove();
            nodesEmpty = null;
          }
          rec.row = nodeRow(rec);
          nodesEl.appendChild(rec.row);
        }
        return rec;
      }

      function nodeRow(rec) {
        const dot = el("span", { class: "gnode-dot" });
        const name = el("span", { class: "gnode-name", text: rec.name });
        const meta = el("span", { class: "gnode-meta" });
        const row = el("div", { class: "gnode", dataset: { status: rec.status } }, [
          el("span", { class: "gnode-rail" }, [dot]),
          el("div", { class: "gnode-body" }, [
            el("div", { class: "gnode-line" }, [name, el("span", { class: "grow" }), meta]),
          ]),
        ]);
        rec._dot = dot;
        rec._meta = meta;
        return row;
      }

      function paintNode(rec) {
        if (!rec.row) return;
        rec.row.dataset.status = rec.status;
        if (rec.status === "running") {
          clear(rec._dot);
          rec._dot.appendChild(el("span", { class: "spinner" }));
          rec._meta.textContent = rec.turn != null ? `step ${rec.turn}` : "running";
        } else if (rec.status === "done") {
          clear(rec._dot);
          rec._dot.appendChild(icon("check", 12));
          rec._meta.textContent = rec.durationMs != null ? fmtMs(rec.durationMs) : "done";
        } else if (rec.status === "paused") {
          clear(rec._dot);
          rec._dot.appendChild(icon("shield", 12));
          rec._meta.textContent = "awaiting approval";
        }
      }

      function renderResult() {
        if (!resultEl) return;
        if (finalState && typeof finalState === "object") {
          // Prefer a human-readable terminal-node reply if we can find one.
          const terminal = pickTerminalText(finalState);
          clear(resultEl);
          if (terminal) {
            const md1 = el("div", { class: "md" });
            mdInto(md1, terminal);
            resultEl.appendChild(md1);
          }
          resultEl.appendChild(stateBlock(finalState));
        } else if (resultBuf.trim()) {
          const md1 = el("div", { class: "md" });
          mdInto(md1, resultBuf);
          clear(resultEl);
          resultEl.appendChild(md1);
        }
      }

      // The terminal node's reply is the most useful "answer". Heuristic: the
      // last string value added to state that isn't the original input.
      function pickTerminalText(state) {
        const keys = Object.keys(state).filter((k) => k !== "input" && !k.endsWith("_decision"));
        for (let i = keys.length - 1; i >= 0; i--) {
          const v = state[keys[i]];
          if (typeof v === "string" && v.trim()) return v;
        }
        return "";
      }

      function stateBlock(state) {
        const entries = Object.entries(state);
        const rows = entries.map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v, null, 2);
          return el("details", { class: "kv" }, [
            el("summary", null, [
              el("span", { class: "kv-key", text: k }),
              el("span", { class: "kv-peek", text: oneLine(val) }),
            ]),
            el("div", { class: "kv-val md" }, valNode(val)),
          ]);
        });
        return el("div", { class: "statecard" }, [
          el("div", { class: "section-label", text: "Final state" }),
          el("div", { class: "kvlist" }, rows),
        ]);
      }

      function valNode(text) {
        // Render string values as markdown, otherwise as a code block.
        const wrap = document.createDocumentFragment();
        mdInto(el("div"), ""); // no-op to keep mdInto referenced
        wrap.appendChild(md(text));
        return wrap;
      }

      function oneLine(s) {
        const t = String(s).replace(/\s+/g, " ").trim();
        return t.length > 64 ? t.slice(0, 64) + "…" : t;
      }

      function showPause(info) {
        if (!pauseBanner) return;
        clear(pauseBanner);
        pauseBanner.style.display = "flex";
        pauseBanner.appendChild(
          el("div", { class: "pause-icon" }, icon("shield", 16)),
        );
        const cmd = `bun agent.ts --resume ${info.graphRunId || "<graphRunId>"} <decision>`;
        pauseBanner.appendChild(
          el("div", { class: "pause-body" }, [
            el("div", { class: "pause-title" }, [
              el("strong", { text: `Paused at "${info.nodeName}"` }),
              el("span", { class: "badge warn", text: "human-in-the-loop" }),
            ]),
            el("div", { class: "pause-prompt", text: info.prompt }),
            el("div", { class: "pause-hint" }, [
              el("span", { text: "Resume from your shell:" }),
              el("code", { class: "codepath", text: cmd }),
            ]),
          ]),
        );
      }

      function hidePause() {
        if (pauseBanner) {
          pauseBanner.style.display = "none";
          clear(pauseBanner);
        }
      }

      function setRunning(on) {
        running = on;
        if (runBtn) {
          clear(runBtn);
          runBtn.appendChild(on ? el("span", { class: "spinner" }) : icon("play", 15));
          runBtn.appendChild(el("span", { text: on ? "Running…" : "Run graph" }));
          runBtn.disabled = on;
        }
        if (runInput) runInput.disabled = on;
        if (hintLine) {
          hintLine.textContent = on
            ? "Streaming nodes — state threads along the edges…"
            : "One initial message seeds the graph state; nodes run to a terminal node.";
        }
      }

      function resetRun() {
        resultBuf = "";
        finalState = null;
        pausedInfo = null;
        nodeOrder.length = 0;
        nodeMap.clear();
        const fresh = events.newStats();
        Object.assign(stats, fresh);
        hidePause();
        if (nodesEl) {
          clear(nodesEl);
          nodesEmpty = el("div", { class: "nodes-empty muted", text: "Run the graph to trace node execution." });
          nodesEl.appendChild(nodesEmpty);
        }
        if (feedEl) clear(feedEl);
        if (resultEl) {
          clear(resultEl);
          resultEl.appendChild(
            el("div", {
              class: "muted result-placeholder",
              text: "The streamed answer and final graph state appear here.",
            }),
          );
        }
        if (resultMeta) resultMeta.textContent = "";
        updateStats();
      }

      function submit() {
        if (!runInput || running) return;
        const q = runInput.value.trim();
        if (!q) return;
        resetRun();
        setRunning(true);
        if (resultEl) {
          clear(resultEl);
          resultEl.appendChild(
            el("div", { class: "muted result-placeholder" }, [
              el("span", { class: "spinner" }),
              el("span", { text: " Seeding graph state…" }),
            ]),
          );
        }
        api.submit(q);
      }

      // ── graph-engine event handling (from [graph] stderr lines) ───────────
      function handleGraphEvent(ev) {
        if (!ev || !ev.kind) return;
        if (ev.graphRunId) lastGraphRunId = ev.graphRunId;
        switch (ev.kind) {
          case "node_start": {
            const rec = ensureNode(ev.nodeName);
            rec.status = "running";
            rec.turn = ev.turn;
            paintNode(rec);
            if (resultMeta) resultMeta.textContent = `running: ${ev.nodeName}`;
            updateStats();
            break;
          }
          case "node_end": {
            const rec = ensureNode(ev.nodeName);
            rec.status = "done";
            rec.durationMs = ev.durationMs;
            paintNode(rec);
            if (ev.state && typeof ev.state === "object") finalState = ev.state;
            renderResult();
            updateStats();
            break;
          }
          case "edge_taken":
            // No standalone row; edges are implied by the node order.
            break;
          case "checkpoint":
            feedAppend(
              events.card({
                icon: "database",
                sev: "muted",
                name: ev.nodeName,
                title: "checkpoint saved",
                meta: short(ev.checkpointId),
              }),
            );
            break;
          case "hitl_pause": {
            const rec = ensureNode(ev.nodeName);
            rec.status = "paused";
            paintNode(rec);
            pausedInfo = {
              nodeName: ev.nodeName,
              prompt: ev.prompt,
              checkpointId: ev.checkpointId,
              graphRunId: ev.graphRunId || lastGraphRunId,
            };
            showPause(pausedInfo);
            feedAppend(
              events.card({
                icon: "shield",
                sev: "warn",
                name: ev.nodeName,
                title: "human-in-the-loop pause",
                sub: ev.prompt,
              }),
            );
            if (resultMeta) resultMeta.textContent = "paused — awaiting approval";
            break;
          }
          case "run_done":
            if (ev.state && typeof ev.state === "object") finalState = ev.state;
            renderResult();
            if (resultMeta) resultMeta.textContent = "run complete";
            feedAppend(
              events.card({
                icon: "check",
                sev: "accent",
                title: "graph run complete",
                sub: `${nodeOrder.length} node${nodeOrder.length === 1 ? "" : "s"} executed`,
              }),
            );
            updateStats();
            break;
          case "branch":
            feedAppend(
              events.card({
                icon: "git",
                sev: "info",
                title: "branched run",
                sub: `from ${short(ev.fromCheckpointId)}`,
                meta: short(ev.newGraphRunId),
              }),
            );
            break;
        }
      }

      function short(id) {
        const s = String(id || "");
        return s.length > 14 ? s.slice(0, 14) + "…" : s;
      }

      function feedAppend(node) {
        if (node && feedEl) {
          feedEl.appendChild(node);
          if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
        }
      }

      // ── WS handlers (attached once) ───────────────────────────────────────
      // graph-engine events arrive on stderr as `[graph] {json}` lines.
      api.on("stderr", (m) => {
        const line = stripAnsi(m.line || "");
        const idx = line.indexOf("[graph]");
        if (idx >= 0) {
          const braceAt = line.indexOf("{", idx);
          if (braceAt >= 0) {
            const json = line.slice(braceAt);
            let ev = null;
            try {
              ev = JSON.parse(json);
            } catch {
              ev = null;
            }
            if (ev) {
              handleGraphEvent(ev);
              return;
            }
          }
        }
        // Other stderr (warnings, deps) -> raw log drawer.
        api.log(line + "\n", "stderr");
      });

      // inner per-node runChatLoop TraceEvents (stdout JSON) -> feed + stats.
      api.on("event", (m) => {
        const ev = m.event;
        if (!ev || !ev.kind) return;
        events.accrue(ev, stats);
        updateStats();
        feedAppend(events.render(ev));
      });

      // prose on stdout: per-node assistant text, the final JSON dump, and the
      // engine's `paused at …` / `to resume: …` hints.
      api.on("stdout", (m) => {
        const txt = stripAnsi(m.text || "");
        if (!txt) return;
        // The host also writes the final pretty-printed JSON state to stdout.
        // We render the authoritative result from the run_done event instead,
        // so route a leading-`{` blob to the log and prose to the result view.
        const trimmed = txt.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          // Final state dump — try to parse as the result (covers the case
          // where run_done arrived without a state, e.g. older bundles).
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object" && !finalState) {
              finalState = parsed;
              renderResult();
              return;
            }
          } catch {
            /* not JSON — fall through to prose */
          }
          api.log(txt, "stdout");
          return;
        }
        if (/^paused at |^to resume: |^branched: /.test(trimmed)) {
          api.log(txt, "stdout");
          return;
        }
        // Otherwise it's a node's assistant prose — accumulate + render live.
        resultBuf += txt;
        if (!finalState) renderResult();
      });

      api.on("status", (m) => {
        if (m.state === "running") {
          if (!running) setRunning(true);
        } else if (m.state === "exited") {
          setRunning(false);
          const exit = CH.failure.exitInfo(m);
          if (resultMeta && !pausedInfo && finalState) resultMeta.textContent = "run complete";
          else if (resultMeta && pausedInfo) resultMeta.textContent = "paused — resume from shell";
          else if (resultMeta && !finalState)
            resultMeta.textContent = exit.failed ? `stopped — ${exit.line}` : "process exited";
          if (!finalState && !resultBuf.trim() && !pausedInfo && resultEl) {
            clear(resultEl);
            resultEl.appendChild(
              el("div", {
                class: "muted result-placeholder",
                text: exit.failed
                  ? `The run stopped — ${exit.line}. See the raw output log.`
                  : "The run produced no output — check the raw log.",
              }),
            );
          }
        } else if (m.state === "error") {
          setRunning(false);
          if (resultMeta) resultMeta.textContent = "failed to start";
          api.openLog();
        }
      });

      // ── view switching ────────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      function buildEmpty() {
        runInput = runBtn = resultEl = resultMeta = nodesEl = feedEl = feedScroll = null;
        statEls = pauseBanner = hintLine = null;
        clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "git",
            title: "Drop in a compiled graph runtime",
            subtitle:
              "This UI runs any bundle compiled from a CrewHaus spec with target: graph — a stateful DAG of LLM nodes.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Type an initial message and press **Run graph** — dependencies install on the first run",
            ],
          }),
        );
      }

      function buildActive() {
        clear(api.main);

        // ── left: Run + Result ──────────────────────────────────────────────
        runInput = el("textarea", {
          class: "field",
          rows: 2,
          placeholder: "Initial message — this seeds the graph state (e.g. “Draft a launch plan for X”)…",
        });
        runInput.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault();
            submit();
          }
        });
        runBtn = el("button", { class: "btn primary", onClick: submit });
        hintLine = el("div", { class: "run-hint muted" });

        const runBox = el("div", { class: "runbox" }, [
          el("div", { class: "section-label", text: "Run" }),
          el("div", { class: "run-row" }, [runInput, runBtn]),
          hintLine,
        ]);

        pauseBanner = el("div", { class: "pause-banner", style: { display: "none" } });

        resultMeta = el("span", { class: "result-status mono muted" });
        resultEl = el("div", { class: "result" });
        const resultScroll = el("div", { class: "pane-scroll" }, [
          runBox,
          pauseBanner,
          el("div", { class: "divider" }),
          resultEl,
        ]);
        const left = el("div", { class: "pane" }, [
          paneHead("sparkles", "Result", resultMeta),
          resultScroll,
        ]);

        // ── right: Graph (nodes) + stats + activity feed ────────────────────
        const statsBar = el("div", { class: "stats" });
        statEls = {
          nodes: stat(statsBar, "Nodes done", "0", "git"),
          turns: stat(statsBar, "LLM turns", "0", "cpu"),
          tokens: stat(statsBar, "Tokens", "0", "activity"),
          cost: stat(statsBar, "Cost", "$0.00", "coins", true),
        };

        nodesEl = el("div", { class: "nodes" });
        nodesEmpty = el("div", {
          class: "nodes-empty muted",
          text: "Run the graph to trace node execution.",
        });
        nodesEl.appendChild(nodesEmpty);

        feedEl = el("div", { class: "feed" });
        feedScroll = el("div", { class: "pane-scroll" }, [
          statsBar,
          el("div", { class: "divider" }),
          el("div", { class: "section-label", text: "Nodes" }),
          nodesEl,
          el("div", { class: "divider" }),
          el("div", { class: "section-label", text: "Activity" }),
          feedEl,
        ]);
        const right = el("div", { class: "pane" }, [paneHead("layers", "Graph"), feedScroll]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));

        injectStyles();
        resetRun();
        setRunning(api.isRunning());
        if (!api.isRunning() && resultEl) {
          clear(resultEl);
          resultEl.appendChild(
            el("div", { class: "muted result-placeholder" }, [
              el("span", { text: "Type an initial message and press " }),
              el("strong", { text: "Run graph" }),
              el("span", { text: " — the runtime boots on the first run." }),
            ]),
          );
        }
      }

      function stat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(
          el("div", { class: "stat" }, [
            el("div", { class: "stat-top" }, [el("span", { class: "stat-ic" }, icon(ic, 12)), v]),
            el("div", { class: "k", text: label }),
          ]),
        );
        return v;
      }

      // ── shape-local styles (graph-specific bits not in ui.css) ─────────────
      let stylesInjected = false;
      function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;
        const css = `
.runbox { background: var(--panel-2); border: 1px solid var(--rule); border-radius: var(--radius); padding: 14px; }
.run-row { display: flex; gap: 10px; align-items: stretch; }
.run-row .field { min-height: 52px; }
.run-row .btn.primary { align-self: stretch; flex: 0 0 auto; }
.run-hint { margin-top: 8px; font-size: 11.5px; font-family: var(--mono); }
.result-status { font-size: 11px; }
.result { min-height: 40px; }
.result-placeholder { display: flex; align-items: center; gap: 8px; padding: 18px 0; }
.stat-top { display: flex; align-items: center; gap: 7px; }
.stat-ic { color: var(--accent); display: inline-grid; place-items: center; opacity: .8; }
.stat-ic svg { width: 12px; height: 12px; }
.nodes { display: flex; flex-direction: column; gap: 0; position: relative; }
.nodes-empty { font-size: 12.5px; padding: 6px 2px; }
.gnode { display: grid; grid-template-columns: 26px 1fr; gap: 10px; padding: 7px 0; }
.gnode-rail { position: relative; display: flex; justify-content: center; }
.gnode:not(:last-child) .gnode-rail::after { content: ""; position: absolute; top: 22px; bottom: -14px; width: 2px; background: var(--rule-2); }
.gnode-dot { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--panel-3); border: 1px solid var(--rule-2); color: var(--ink-3); flex: 0 0 auto; position: relative; z-index: 1; }
.gnode-dot svg { width: 12px; height: 12px; }
.gnode-body { min-width: 0; }
.gnode-line { display: flex; align-items: center; gap: 8px; }
.gnode-name { font-family: var(--mono); font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gnode-meta { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); white-space: nowrap; }
.gnode[data-status="pending"] .gnode-name { color: var(--ink-3); }
.gnode[data-status="running"] .gnode-dot { border-color: var(--accent); background: var(--accent-ghost); color: var(--accent); box-shadow: 0 0 0 4px var(--accent-glow); }
.gnode[data-status="running"] .gnode-name { color: var(--accent); }
.gnode[data-status="running"]:not(:last-child) .gnode-rail::after { background: linear-gradient(var(--accent), var(--rule-2)); }
.gnode[data-status="done"] .gnode-dot { border-color: var(--accent-glow); background: var(--accent-ghost); color: var(--accent); }
.gnode[data-status="done"]:not(:last-child) .gnode-rail::after { background: var(--accent-glow); }
.gnode[data-status="paused"] .gnode-dot { border-color: var(--amber); background: var(--amber-ghost); color: var(--amber); }
.gnode[data-status="paused"] .gnode-name { color: var(--amber); }
.pause-banner { display: flex; gap: 12px; align-items: flex-start; background: var(--amber-ghost); border: 1px solid rgba(230,180,80,.3); border-radius: var(--radius); padding: 13px 14px; margin-top: 14px; }
.pause-icon { color: var(--amber); flex: 0 0 auto; margin-top: 1px; }
.pause-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.pause-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pause-prompt { color: var(--ink); font-size: 13px; }
.pause-hint { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-3); font-family: var(--mono); }
.pause-hint .codepath { align-self: flex-start; }
.statecard { margin-top: 16px; }
.kvlist { display: flex; flex-direction: column; gap: 6px; }
.kv { border: 1px solid var(--rule); border-radius: var(--radius-sm); background: var(--panel-2); overflow: hidden; }
.kv > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 10px; padding: 8px 11px; }
.kv > summary::-webkit-details-marker { display: none; }
.kv-key { font-family: var(--mono); font-size: 12px; color: var(--accent); flex: 0 0 auto; }
.kv-peek { font-size: 12px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kv[open] .kv-peek { display: none; }
.kv-val { padding: 0 12px 12px; border-top: 1px solid var(--rule); padding-top: 10px; }
`;
        document.head.appendChild(el("style", { text: css }));
      }
    },
  });
})();
