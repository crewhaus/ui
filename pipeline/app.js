/* CrewHaus — RAG Pipeline shape UI.
   A retrieval-augmented question-answering pipeline: a query goes in, the agent
   embeds it, retrieves top-k chunks from a vector store via the `Retrieve` tool,
   and writes back a cited answer. This UI is a single-shot console — one query
   per run (stdio-oneshot): the host feeds the query on stdin, the bundle indexes
   its seed corpus, answers, then exits.

   Sources & citations are the hero. We can observe two retrieval signals:
     - `Retrieve` tool_call_start / tool_call_end TraceEvents — each call's
       query size, result size and latency. These become "Retrieval" cards.
     - inline [n] citation markers the model weaves into its answer prose
       (which arrives on stdout). We scan the streamed answer for those markers
       and surface a live citation index that highlights as the answer grows. */
(function () {
  "use strict";
  const { el, icon, mdInto, clear, dropzone, stripAnsi, fmtBytes, fmtMs, events } = window.CH;

  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  function stat(mount, label, value, accent) {
    const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
    mount.appendChild(el("div", { class: "stat" }, [v, el("div", { class: "k", text: label })]));
    return v;
  }

  CH.app({
    controls: ["start", "stop"],
    build(api) {
      // ── per-run state ────────────────────────────────────────────────────
      let composer = null; // query input row
      let runBtn = null;
      let answerWrap = null; // markdown answer container
      let answerBody = null;
      let answerStatus = null;
      let sourcesBody = null; // retrieved-sources / citations list
      let sourcesCount = null;
      let feedScroll = null;
      let feedEl = null;
      let statEls = null;
      let questionEl = null;

      let answerText = ""; // accumulated assistant prose for this run
      let running = false; // a query is in flight
      const stats = events.newStats();
      const pulls = []; // retrieval cards { idx, el, queryEl, statusEl }
      const citeRows = new Map(); // citation no -> row element
      let pendingPull = null; // open Retrieve tool_call awaiting its end

      function updateStats() {
        if (!statEls) return;
        statEls.pulls.textContent = String(pulls.length);
        statEls.cites.textContent = String(citeRows.size);
        statEls.tokens.textContent = CH.fmtTokens(stats.tokensIn + stats.tokensOut);
        statEls.cost.textContent = CH.fmtUsd(stats.costMicros);
      }

      // ── derive citation markers from the answer prose ─────────────────────
      // The model cites sources inline as [1], [2], [3] (matching the Retrieve
      // tool's numbered hit list). We surface each distinct marker as a row.
      function syncCitations() {
        if (!sourcesBody) return;
        const seen = new Set();
        const re = /\[(\d{1,3})\]/g;
        for (const hit of answerText.matchAll(re)) {
          const n = Number(hit[1]);
          if (n >= 1 && n <= 99) seen.add(n);
        }
        for (const n of seen) {
          if (!citeRows.has(n)) addCitationRow(n);
          const row = citeRows.get(n);
          if (row) row.classList.add("cited");
        }
        if (sourcesCount) sourcesCount.textContent = String(citeRows.size);
        toggleSourcesEmpty();
        updateStats();
      }

      function addCitationRow(n) {
        const row = el("div", { class: "cite-row", dataset: { n: String(n) } }, [
          el("div", { class: "cite-no", text: `[${n}]` }),
          el("div", { class: "cite-meta" }, [
            el("div", { class: "cite-title", text: `Citation ${n}` }),
            el("div", {
              class: "cite-sub mono muted",
              text: "referenced in answer · retrieved from vector store",
            }),
          ]),
          el("span", { class: "badge ok", text: "cited" }),
        ]);
        citeRows.set(n, row);
        if (sourcesBody) sourcesBody.appendChild(row);
      }

      function toggleSourcesEmpty() {
        if (!sourcesBody) return;
        const hasAny = pulls.length > 0 || citeRows.size > 0;
        let ph = sourcesBody.querySelector(".sources-empty");
        if (hasAny) {
          if (ph) ph.remove();
          return;
        }
        if (!ph) {
          ph = el("div", { class: "sources-empty muted" }, [
            el("div", { class: "row", style: { gap: "8px", marginBottom: "6px" } }, [
              icon("search", 14),
              el("span", { class: "mono", text: "awaiting retrieval" }),
            ]),
            el("div", {
              text: "Ask a question. The agent embeds it, queries the vector store, and the chunks it cites appear here.",
            }),
          ]);
          sourcesBody.appendChild(ph);
        }
      }

      // ── retrieval cards (from Retrieve tool_call events) ──────────────────
      function beginPull(ev) {
        const idx = pulls.length + 1;
        const queryEl = el("div", {
          class: "ret-query mono",
          text: `embedding query · ${fmtBytes(ev.inputBytes)}`,
        });
        const statusEl = el("span", { class: "badge", text: "querying" });
        const node = el("div", { class: "retrieval" }, [
          el("div", { class: "ret-head" }, [
            el("span", { class: "ret-icon" }, icon("database", 13)),
            el("span", { class: "ret-no mono", text: `retrieval #${idx}` }),
            el("span", { class: "grow" }),
            statusEl,
          ]),
          queryEl,
        ]);
        const rec = { idx, el: node, queryEl, statusEl };
        pulls.push(rec);
        pendingPull = rec;
        if (sourcesBody) {
          const ph = sourcesBody.querySelector(".sources-empty");
          if (ph) ph.remove();
          sourcesBody.appendChild(node);
          sourcesBody.scrollTop = sourcesBody.scrollHeight;
        }
        updateStats();
      }

      function closePull(ev) {
        const rec = pendingPull;
        pendingPull = null;
        if (!rec) return;
        if (ev.isError) {
          rec.statusEl.className = "badge err";
          rec.statusEl.textContent = "failed";
          rec.queryEl.textContent = `retrieval errored · ${fmtMs(ev.durationMs)}`;
          return;
        }
        rec.statusEl.className = "badge ok";
        rec.statusEl.textContent = "hits returned";
        rec.queryEl.textContent = `top-k chunks · ${fmtBytes(ev.outputBytes)} returned · ${fmtMs(ev.durationMs)}`;
      }

      // ── event ingestion ───────────────────────────────────────────────────
      function pushEvent(ev) {
        events.accrue(ev, stats);
        if (ev.kind === "tool_call_start" && ev.toolName === "Retrieve") beginPull(ev);
        if (ev.kind === "tool_call_end" && ev.toolName === "Retrieve") closePull(ev);
        if (ev.kind === "turn_end") finishRun();
        updateStats();
        const node = events.render(ev);
        if (node && feedEl) {
          feedEl.appendChild(node);
          if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
        }
      }

      function finishRun() {
        running = false;
        if (answerBody) answerBody.classList.remove("cursor-blink");
        if (composer) composer.disabled = false;
        if (runBtn) {
          runBtn.disabled = false;
          const lbl = runBtn.querySelector("span");
          if (lbl) lbl.textContent = "Ask";
        }
        if (answerStatus && answerText.trim()) {
          answerStatus.className = "badge ok";
          answerStatus.textContent = "answered";
        }
      }

      // ── WS handlers (attached once) ───────────────────────────────────────
      api.on("stdout", (m) => {
        const txt = stripAnsi(m.text);
        // Pre-run banner / [memory] / [pipeline] noise -> raw log, not the answer.
        if (!running) {
          if (txt.trim() || txt.indexOf("\n") >= 0) api.log(txt, "stdout");
          return;
        }
        answerText += txt;
        if (answerBody) {
          mdInto(answerBody, answerText);
          answerBody.classList.add("cursor-blink");
        }
        syncCitations();
        if (answerWrap) answerWrap.scrollTop = answerWrap.scrollHeight;
      });
      api.on("event", (m) => pushEvent(m.event));
      api.on("status", (m) => {
        if (m.state === "exited") {
          finishRun();
          if (answerStatus && !answerText.trim()) {
            answerStatus.className = "badge warn";
            answerStatus.textContent = "no answer";
          }
        } else if (m.state === "error") {
          finishRun();
          if (answerStatus) {
            answerStatus.className = "badge err";
            answerStatus.textContent = "error";
          }
          api.openLog();
        }
      });

      // ── submitting a query (single-shot) ──────────────────────────────────
      function submitQuery(q) {
        if (!q || running) return;
        running = true;
        answerText = "";
        pulls.length = 0;
        citeRows.clear();
        pendingPull = null;

        if (answerBody) clear(answerBody);
        if (sourcesBody) clear(sourcesBody);
        toggleSourcesEmpty();
        if (feedEl) clear(feedEl);
        if (answerStatus) {
          answerStatus.className = "badge";
          answerStatus.textContent = "retrieving…";
        }
        if (sourcesCount) sourcesCount.textContent = "0";
        updateStats();

        renderQuestion(q);

        if (composer) composer.disabled = true;
        if (runBtn) {
          runBtn.disabled = true;
          const lbl = runBtn.querySelector("span");
          if (lbl) lbl.textContent = "Asking…";
        }
        // start() boots the bundle, feeds the query on stdin, then EOFs.
        api.submit(q);
      }

      function renderQuestion(q) {
        if (!questionEl) return;
        clear(questionEl);
        questionEl.appendChild(
          el("div", { class: "question" }, [
            el("span", { class: "q-icon" }, icon("search", 14)),
            el("div", { class: "q-text", text: q }),
          ]),
        );
      }

      // ── view switching ────────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      function buildEmpty() {
        composer = runBtn = answerWrap = answerBody = sourcesBody = feedEl = feedScroll = statEls = null;
        clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "database",
            title: "Drop in a compiled RAG pipeline",
            subtitle:
              "This console runs any bundle compiled from a CrewHaus spec with target: pipeline — it indexes a seed corpus, then answers queries with cited retrievals.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Click **Start** (or just ask a question) — the seed corpus is embedded and indexed on first run",
            ],
          }),
        );
      }

      function buildActive() {
        clear(api.main);
        questionEl = el("div", { class: "question-bar" });

        // composer row — a single-shot query box
        const ta = el("textarea", {
          class: "field",
          rows: 1,
          placeholder: "Ask a question — answered from the indexed corpus with citations…",
        });
        runBtn = el("button", { class: "btn primary" }, [icon("send", 15), el("span", { text: "Ask" })]);
        composer = ta;
        const autosize = () => {
          ta.style.height = "auto";
          ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
        };
        ta.addEventListener("input", autosize);
        const fire = () => {
          const v = ta.value.trim();
          if (!v || running) return;
          submitQuery(v);
          ta.value = "";
          autosize();
        };
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            fire();
          }
        });
        runBtn.addEventListener("click", fire);
        const queryRow = el("div", { class: "composer" }, [
          el("div", { class: "composer-row" }, [ta, runBtn]),
          el("div", { class: "composer-hint" }, [
            el("span", null, [CH.kbd("Enter"), " ask"]),
            el("span", null, [CH.kbd("Shift"), "+", CH.kbd("Enter"), " newline"]),
            el("span", { class: "muted", text: "single-shot · one query per run" }),
          ]),
        ]);

        // ── LEFT pane: question + answer ────────────────────────────────────
        answerStatus = el("span", { class: "badge", text: "idle" });
        answerWrap = el("div", { class: "pane-scroll" });
        answerBody = el("div", { class: "md answer-body" });
        answerWrap.appendChild(el("div", { class: "col" }, [questionEl, answerBody]));
        renderAnswerPlaceholder();
        const left = el("div", { class: "pane" }, [
          paneHead("sparkles", "Answer", answerStatus),
          answerWrap,
          queryRow,
        ]);

        // ── RIGHT pane: sources / citations (hero) + stats + feed ──────────
        sourcesCount = el("span", { class: "badge", text: "0" });
        sourcesBody = el("div", { class: "sources-body" });
        toggleSourcesEmpty();

        const statsBar = el("div", { class: "stats" });
        statEls = {
          pulls: stat(statsBar, "Retrievals", "0"),
          cites: stat(statsBar, "Citations", "0", true),
          tokens: stat(statsBar, "Tokens", "0"),
          cost: stat(statsBar, "Cost", "$0.00"),
        };

        feedScroll = el("div", { class: "feed-scroll" });
        feedEl = el("div", { class: "feed" });
        feedScroll.appendChild(
          el("div", { class: "col" }, [statsBar, el("div", { class: "divider" }), feedEl]),
        );

        const right = el("div", { class: "pane" }, [
          paneHead("database", "Retrieved sources", sourcesCount),
          el("div", { class: "sources-scroll" }, sourcesBody),
          paneHead("activity", "Pipeline activity"),
          feedScroll,
        ]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));
        injectStyles();
        updateStats();
      }

      function renderAnswerPlaceholder() {
        if (!answerBody) return;
        clear(answerBody);
        answerBody.classList.remove("cursor-blink");
        answerBody.appendChild(
          el("div", { class: "answer-ph muted" }, [
            el("div", { class: "answer-ph-icon" }, icon("sparkles", 22)),
            el("div", { class: "answer-ph-title", text: "Ask a question to begin" }),
            el("div", {
              text: "Your query is embedded, matched against the vector store, and answered with inline citations like [1], [2] — each one is cross-referenced in the sources panel.",
            }),
          ]),
        );
      }

      // ── shape-specific styles (scoped class names; no innerHTML) ───────────
      let stylesInjected = false;
      function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;
        const css = [
          ".question-bar:empty{display:none}",
          ".question{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;margin-bottom:4px;background:var(--accent-ghost);border:1px solid var(--accent-glow);border-radius:var(--radius)}",
          ".question .q-icon{color:var(--accent);display:grid;place-items:center;flex:0 0 auto;margin-top:1px}",
          ".question .q-text{font-weight:600;color:var(--ink);overflow-wrap:anywhere}",
          ".answer-body{min-height:40px}",
          ".answer-ph{display:grid;place-items:center;text-align:center;gap:8px;padding:48px 24px;max-width:440px;margin:0 auto}",
          ".answer-ph-icon{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:var(--accent-ghost);color:var(--accent);border:1px solid var(--accent-glow)}",
          ".answer-ph-title{font-size:15px;font-weight:600;color:var(--ink-2)}",
          ".sources-scroll{flex:0 0 auto;max-height:42%;overflow:auto;padding:14px 16px;border-bottom:1px solid var(--rule)}",
          ".feed-scroll{flex:1;min-height:0;overflow:auto;padding:16px}",
          ".sources-body{display:flex;flex-direction:column;gap:9px}",
          ".sources-empty{font-size:12.5px;line-height:1.5}",
          ".retrieval{border:1px solid var(--rule);border-left:2px solid var(--accent);border-radius:var(--radius-sm);background:var(--panel);padding:9px 11px;animation:rise .18s ease both}",
          ".retrieval .ret-head{display:flex;align-items:center;gap:8px}",
          ".retrieval .ret-icon{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;background:var(--accent-ghost);color:var(--accent)}",
          ".retrieval .ret-icon svg{width:12px;height:12px}",
          ".retrieval .ret-no{font-size:11.5px;color:var(--ink-2)}",
          ".retrieval .ret-query{margin-top:5px;font-size:11px;color:var(--ink-3);overflow-wrap:anywhere}",
          ".cite-row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--panel-2);padding:8px 11px;animation:rise .18s ease both}",
          ".cite-row.cited{border-color:var(--accent-glow)}",
          ".cite-row .cite-no{font-family:var(--mono);font-weight:600;font-size:13px;color:var(--accent)}",
          ".cite-row .cite-title{font-size:12.5px;font-weight:500;color:var(--ink)}",
          ".cite-row .cite-sub{font-size:10.5px;margin-top:1px}",
        ].join("\n");
        const style = document.createElement("style");
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
      }
    },
  });
})();
