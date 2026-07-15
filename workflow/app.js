/* CrewHaus — Workflow Runtime shape UI.

   A deterministic, multi-step orchestration runtime rendered as a live STEP
   TIMELINE. The compiled `agent.ts` runs each step sequentially: step 1 reads
   the run input from stdin, steps 2+ are fed the prior step's output. Each
   step announces itself on stdout as `[step N/M: name]`, then streams its
   assistant prose until the next marker. We turn that into a timeline of
   running -> done cards with per-step timing, render the final step's text as
   the result, and stream the structured TraceEvent feed alongside. */
(function () {
  "use strict";
  const { el, icon, md, mdInto, clear, stripAnsi, fmtMs, fmtTokens, fmtUsd, events, toast } =
    window.CH;

  // Matches the per-step banner the workflow emitter writes to stdout:
  //   "[step 2/4: draft outline]"
  //
  // Phase-5 migration note (Part B): this brittle text marker is the ONLY source
  // of step state for the hero timeline. The 0.3.0 memory release adds a
  // structured equivalent — `plan_update` writes `.crewhaus/state/<spec>/
  // plan-*.md`, which the host's memory bridge surfaces as
  // `{type:"memory",surface:"plan"}` and the shared `plan` view (now enabled via
  // this shape's features[] "steps") renders through the unit-tested
  // CH.views.parsePlan(). It is DELIBERATELY left in place here: swapping the
  // hero off `[step N/M]` requires confirming the workflow harness actually
  // emits plan_update steps 1:1 with these banners, which cannot be verified
  // without a live 0.3.0 workflow harness (the local factory is still v0.2.4).
  // Ripping it out on an unverified assumption would break a working hero, so
  // the real-signal path ships as the complementary right-rail plan view and
  // this parser stays until the emission is confirmed equivalent.
  const STEP_RE = /\[step\s+(\d+)\/(\d+):\s*([^\]]*)\]/;

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
      // ── Run state ──────────────────────────────────────────────────────
      const stats = events.newStats();
      let booted = false; // active layout built once

      // refs into the active layout (null until built)
      let runInput = null;
      let runBtn = null;
      let timelineEl = null;
      let resultBody = null;
      let resultEmpty = null;
      let progressFill = null;
      let progressLabel = null;
      let statEls = null;
      let feedEl = null;
      let feedScroll = null;

      // per-run model
      let steps = []; // [{ idx, total, name, status, startedAt, durationMs, rowEl, els:{} }]
      let current = null; // active step record
      let totalDeclared = 0; // M from the first marker we see
      let lastQuery = ""; // the run input we submitted
      let runStartedAt = 0;
      let runActive = false;
      let preStepBuffer = ""; // stdout before the first [step] marker (banner/logs)

      // ── helpers ────────────────────────────────────────────────────────
      function updateStats() {
        if (!statEls) return;
        statEls.steps.textContent = `${doneCount()}/${totalDeclared || steps.length || "—"}`;
        statEls.tools.textContent = String(stats.tools);
        statEls.tokens.textContent = fmtTokens(stats.tokensIn + stats.tokensOut);
        statEls.cost.textContent = fmtUsd(stats.costMicros);
        statEls.errors.textContent = String(stats.errors);
      }

      function doneCount() {
        return steps.filter((s) => s.status === "done" || s.status === "error").length;
      }

      function updateProgress() {
        if (!progressFill) return;
        const total = totalDeclared || steps.length || 0;
        const done = doneCount();
        const pct = total ? Math.round((done / total) * 100) : 0;
        progressFill.style.width = `${pct}%`;
        if (!runActive && total && done >= total) progressLabel.textContent = "Complete";
        else if (runActive && current)
          progressLabel.textContent = `Step ${current.idx}/${total || "?"}`;
        else if (runActive) progressLabel.textContent = "Starting…";
        else progressLabel.textContent = total ? `${done}/${total}` : "Idle";
      }

      // ── timeline rendering ─────────────────────────────────────────────
      function clearTimeline() {
        steps = [];
        current = null;
        totalDeclared = 0;
        preStepBuffer = "";
        if (timelineEl) clear(timelineEl);
      }

      function stepRow(rec) {
        const dot = el("div", { class: "wf-dot" }, icon("dot", 12));
        const num = el("span", { class: "wf-num", text: `${rec.idx}` });
        const total = el("span", { class: "wf-total", text: `/${rec.total || "?"}` });
        const name = el("span", { class: "wf-name", text: rec.name || `step ${rec.idx}` });
        const timeBadge = el("span", { class: "wf-time" });
        const statusBadge = el("span", { class: "badge", text: "queued" });

        const head = el("div", { class: "wf-row-head" }, [
          dot,
          el("span", { class: "wf-idx" }, [num, total]),
          name,
          el("span", { class: "grow" }),
          timeBadge,
          statusBadge,
        ]);

        const out = el("div", { class: "wf-step-out md" });
        const outWrap = el("div", { class: "wf-step-outwrap" }, out);

        const row = el("div", { class: "wf-row", dataset: { status: "queued" } }, [
          el("div", { class: "wf-line" }),
          el("div", { class: "wf-row-body" }, [head, outWrap]),
        ]);

        rec.els = { dot, statusBadge, timeBadge, out, outWrap, row };
        rec.rowEl = row;
        return row;
      }

      function setStepStatus(rec, status) {
        rec.status = status;
        const e = rec.els;
        rec.rowEl.dataset.status = status;
        clear(e.dot);
        if (status === "running") {
          e.dot.appendChild(el("span", { class: "spinner" }));
          e.statusBadge.className = "badge info";
          e.statusBadge.textContent = "running";
        } else if (status === "done") {
          e.dot.appendChild(icon("check", 12));
          e.statusBadge.className = "badge ok";
          e.statusBadge.textContent = "done";
        } else if (status === "error") {
          e.dot.appendChild(icon("alert", 12));
          e.statusBadge.className = "badge err";
          e.statusBadge.textContent = "failed";
        } else {
          e.dot.appendChild(icon("dot", 12));
          e.statusBadge.className = "badge";
          e.statusBadge.textContent = "queued";
        }
      }

      function finishCurrentStep(status) {
        if (!current) return;
        current.durationMs = Date.now() - current.startedAt;
        current.els.timeBadge.textContent = fmtMs(current.durationMs);
        setStepStatus(current, status || "done");
        // collapse long output once the step is done, keep it scrollable
        current.els.outWrap.classList.add("settled");
        current = null;
      }

      function beginStep(idx, total, name) {
        // a new marker means the previous step finished
        finishCurrentStep("done");
        if (total) totalDeclared = total;
        const rec = {
          idx,
          total: total || totalDeclared,
          name: (name || "").trim(),
          status: "running",
          startedAt: Date.now(),
          durationMs: 0,
          buffer: "",
        };
        steps.push(rec);
        const row = stepRow(rec);
        timelineEl.appendChild(row);
        setStepStatus(rec, "running");
        current = rec;
        // scroll timeline to keep the active step in view
        const sc = timelineEl.closest(".pane-scroll");
        if (sc) sc.scrollTop = sc.scrollHeight;
        updateProgress();
        updateStats();
      }

      function appendStepText(text) {
        if (!current) {
          // prose before the first step marker = banner / pre-run logs
          preStepBuffer += text;
          api.log(text, "stdout");
          return;
        }
        current.buffer += text;
        mdInto(current.els.out, current.buffer);
        // mirror the latest step's output into the result panel live
        renderResult(current.buffer);
        const sc = timelineEl.closest(".pane-scroll");
        if (sc) sc.scrollTop = sc.scrollHeight;
      }

      function renderResult(text) {
        if (!resultBody) return;
        const t = (text || "").trim();
        if (!t) return;
        if (resultEmpty) resultEmpty.style.display = "none";
        mdInto(resultBody, text);
      }

      function finalizeRun(ok) {
        runActive = false;
        finishCurrentStep(ok ? "done" : "error");
        if (runBtn) {
          runBtn.disabled = false;
          const lbl = runBtn.querySelector("span");
          if (lbl) lbl.textContent = "Run workflow";
        }
        if (runInput) runInput.disabled = false;
        // result = the final completed step's output
        const finalStep = steps[steps.length - 1];
        if (finalStep && finalStep.buffer.trim()) renderResult(finalStep.buffer);
        updateProgress();
        updateStats();
      }

      // ── WS handlers (attached once) ────────────────────────────────────
      api.on("stdout", (m) => {
        const raw = stripAnsi(m.text);
        if (!raw) return;
        // Split on step markers; route prose to the current step, markers to
        // the timeline. Markers may arrive mid-chunk, so scan iteratively.
        let rest = raw;
        let guard = 0;
        while (rest && guard++ < 5000) {
          const mm = rest.match(STEP_RE);
          if (!mm) {
            appendStepText(rest);
            break;
          }
          const before = rest.slice(0, mm.index);
          if (before) appendStepText(before);
          beginStep(parseInt(mm[1], 10), parseInt(mm[2], 10), mm[3]);
          rest = rest.slice(mm.index + mm[0].length);
        }
      });

      api.on("event", (ev) => pushEvent(ev.event));

      api.on("status", (m) => {
        if (m.state === "running") {
          // process spawned; the run is live
          runActive = true;
          updateProgress();
        } else if (m.state === "exited") {
          const exit = CH.failure.exitInfo(m);
          finalizeRun(!exit.failed);
          if (exit.failed) toast(`Workflow exited — ${exit.line}. See raw output.`, "err");
        } else if (m.state === "error") {
          finalizeRun(false);
          toast("Workflow could not start — see raw output", "err");
          api.openLog();
        }
      });

      function pushEvent(ev) {
        events.accrue(ev, stats);
        // mark a running step as failed if a tool errored within it
        if (ev.kind === "tool_call_end" && ev.isError && current) {
          // keep running; surface error count only
        }
        updateStats();
        const node = events.render(ev);
        if (node && feedEl) {
          feedEl.appendChild(node);
          if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
        }
      }

      // ── run trigger ────────────────────────────────────────────────────
      function runWorkflow() {
        if (!api.isPresent()) {
          toast("Drop a compiled agent.ts into harness/ first", "err");
          return;
        }
        const q = (runInput.value || "").trim();
        if (!q && !api.config) return;
        lastQuery = q;
        // reset run model
        stats.turns = stats.tools = stats.errors = 0;
        stats.costMicros = stats.tokensIn = stats.tokensOut = stats.subAgents = 0;
        clearTimeline();
        if (feedEl) clear(feedEl);
        if (resultBody) clear(resultBody);
        if (resultEmpty) {
          resultEmpty.style.display = "";
          if (resultBody) resultBody.appendChild(resultEmpty);
        }
        updateStats();
        runStartedAt = Date.now();
        runActive = true;
        runBtn.disabled = true;
        const lbl = runBtn.querySelector("span");
        if (lbl) lbl.textContent = "Running…";
        runInput.disabled = true;
        updateProgress();
        api.submit(q);
      }

      // ── view switching ─────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      function buildEmpty() {
        booted = false;
        runInput = runBtn = timelineEl = resultBody = resultEmpty = null;
        progressFill = progressLabel = statEls = feedEl = feedScroll = null;
        CH.clear(api.main);
        api.main.appendChild(
          CH.dropzone({
            icon: "workflow",
            title: "Drop in a compiled workflow",
            subtitle:
              "This runtime executes a CrewHaus spec compiled with target: workflow — each step runs in sequence, chaining its output into the next.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Type your run input below and press **Run** — deps install on first run",
            ],
          }),
        );
      }

      function buildActive() {
        if (booted) return;
        booted = true;
        CH.clear(api.main);

        // ── left (hero): run bar + step timeline + result ────────────────
        runInput = el("textarea", {
          class: "field wf-input",
          rows: 1,
          placeholder: "Enter the input for step 1 (read from stdin)…",
        });
        const autosize = () => {
          runInput.style.height = "auto";
          runInput.style.height = Math.min(runInput.scrollHeight, 160) + "px";
        };
        runInput.addEventListener("input", autosize);
        runInput.addEventListener("keydown", (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            if (!runBtn.disabled) runWorkflow();
          }
        });
        runBtn = el("button", { class: "btn primary", onClick: runWorkflow }, [
          icon("play", 15),
          el("span", { text: "Run workflow" }),
        ]);
        const runBar = el("div", { class: "wf-runbar" }, [
          el("div", { class: "wf-runbar-row" }, [runInput, runBtn]),
          el("div", { class: "composer-hint" }, [
            el("span", null, [CH.kbd("Cmd"), "/", CH.kbd("Ctrl"), "+", CH.kbd("Enter"), " run"]),
            el("span", { class: "muted", text: "Step 1 reads this from stdin; later steps chain automatically." }),
          ]),
        ]);

        // progress strip
        progressFill = el("i", { style: { width: "0%" } });
        progressLabel = el("span", { class: "wf-prog-label", text: "Idle" });
        const progress = el("div", { class: "wf-progress" }, [
          el("div", { class: "bar" }, progressFill),
          progressLabel,
        ]);

        timelineEl = el("div", { class: "wf-timeline" });
        const timelineEmpty = el("div", { class: "wf-tl-empty" }, [
          el("div", { class: "wf-tl-empty-icon" }, icon("layers", 22)),
          el("div", { class: "muted", text: "No run yet — enter input above and press Run to watch each step execute in order." }),
        ]);
        timelineEl.appendChild(timelineEmpty);

        const leftScroll = el("div", { class: "pane-scroll" }, [
          el("div", { class: "col" }, [
            el("div", { class: "section-label", text: "Step timeline" }),
            progress,
            timelineEl,
          ]),
        ]);
        // hide the empty placeholder as soon as a step appears
        const obs = new MutationObserver(() => {
          timelineEmpty.style.display = timelineEl.children.length > 1 ? "none" : "";
        });
        obs.observe(timelineEl, { childList: true });

        const left = el("div", { class: "pane" }, [
          paneHead("workflow", "Workflow", null),
          runBar,
          leftScroll,
        ]);

        // ── middle/right via a nested split is overkill; use cols-2-wide:
        //    left = timeline (hero), right = result + activity stacked.
        // To give the result room, put result above the feed in the right pane.
        resultEmpty = el("div", { class: "wf-result-empty muted" }, [
          icon("sparkles", 18),
          el("span", { text: "The final step's output will render here as Markdown." }),
        ]);
        resultBody = el("div", { class: "md wf-result-body" }, resultEmpty);
        const copyBtn = el(
          "button",
          {
            class: "btn ghost sm icon-only",
            title: "Copy result",
            onClick: () => {
              const finalStep = steps[steps.length - 1];
              const text = finalStep ? finalStep.buffer.trim() : "";
              if (text) CH.copy(text);
              else toast("No result to copy yet", "err");
            },
          },
          icon("copy", 14),
        );
        const resultPane = el("div", { class: "pane wf-result-pane" }, [
          paneHead("sparkles", "Result", copyBtn),
          el("div", { class: "pane-scroll" }, resultBody),
        ]);

        // stats + activity feed
        const statsBar = el("div", { class: "stats" });
        statEls = {
          steps: stat(statsBar, "Steps done", "0/—", "layers"),
          tools: stat(statsBar, "Tool calls", "0", "wrench"),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          cost: stat(statsBar, "Cost", "$0.00", "coins", true),
          errors: stat(statsBar, "Errors", "0", "alert"),
        };
        feedScroll = el("div", { class: "pane-scroll" });
        feedEl = el("div", { class: "feed" });
        feedScroll.appendChild(
          el("div", { class: "col" }, [statsBar, el("div", { class: "divider" }), feedEl]),
        );
        const activityPane = el("div", { class: "pane wf-activity-pane" }, [
          paneHead("activity", "Activity"),
          feedScroll,
        ]);

        const rightCol = el("div", { class: "wf-right" }, [resultPane, activityPane]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, rightCol]));

        // inject scoped styles once
        injectStyles();
        autosize();
        runInput.focus();
        updateStats();
        updateProgress();
      }

      function stat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(el("div", { class: "stat" }, [v, el("div", { class: "k", text: label })]));
        return v;
      }

      // ── scoped styles (workflow-specific timeline visuals) ─────────────
      let stylesInjected = false;
      function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;
        const css = `
          .wf-runbar { flex: 0 0 auto; border-bottom: 1px solid var(--rule); background: var(--panel); padding: 12px 16px; }
          .wf-runbar-row { display: flex; gap: 10px; align-items: flex-end; }
          .wf-input { min-height: 44px; max-height: 160px; line-height: 1.5; }
          .wf-progress { display: flex; align-items: center; gap: 12px; }
          .wf-progress .bar { flex: 1; }
          .wf-prog-label { font-family: var(--mono); font-size: 11px; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }

          .wf-right { display: grid; grid-template-rows: 1.15fr 1fr; min-height: 0; min-width: 0; overflow: hidden; }
          .wf-result-pane { border-left: 1px solid var(--rule); }
          .wf-activity-pane { border-left: 1px solid var(--rule); border-top: 1px solid var(--rule); }
          @media (max-width: 900px) {
            .wf-right { grid-template-rows: auto auto; }
          }
          .wf-result-empty { display: flex; align-items: center; gap: 10px; padding: 6px 2px; }
          .wf-result-empty svg { color: var(--accent); flex: 0 0 auto; }
          .wf-result-body { min-width: 0; }

          .wf-tl-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; padding: 36px 24px; border: 1.5px dashed var(--rule-2); border-radius: var(--radius); }
          .wf-tl-empty-icon { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 13px; background: var(--accent-ghost); color: var(--accent); border: 1px solid var(--accent-glow); }

          .wf-timeline { display: flex; flex-direction: column; }
          .wf-row { display: grid; grid-template-columns: 26px 1fr; gap: 12px; position: relative; padding-bottom: 14px; animation: rise 0.2s ease both; }
          .wf-row:last-child { padding-bottom: 0; }
          .wf-line { position: relative; }
          .wf-line::before { content: ""; position: absolute; left: 12px; top: 26px; bottom: -14px; width: 2px; background: var(--rule); }
          .wf-row:last-child .wf-line::before { display: none; }
          .wf-row[data-status="done"] .wf-line::before { background: var(--accent-glow); }

          .wf-dot { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--panel-3); border: 1px solid var(--rule-2); color: var(--ink-3); position: relative; z-index: 1; }
          .wf-row[data-status="running"] .wf-dot { background: var(--accent-ghost); border-color: var(--accent-glow); color: var(--accent); }
          .wf-row[data-status="done"] .wf-dot { background: var(--accent-ghost); border-color: var(--accent-glow); color: var(--accent); }
          .wf-row[data-status="error"] .wf-dot { background: var(--red-ghost); border-color: rgba(239,111,111,0.3); color: var(--red); }
          .wf-dot svg { width: 12px; height: 12px; }

          .wf-row-body { min-width: 0; }
          .wf-row-head { display: flex; align-items: center; gap: 9px; }
          .wf-idx { font-family: var(--mono); font-size: 12px; }
          .wf-num { color: var(--accent); font-weight: 600; }
          .wf-total { color: var(--ink-3); }
          .wf-name { font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .wf-time { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); }

          .wf-step-outwrap { margin-top: 7px; max-height: 280px; overflow: auto; border: 1px solid var(--rule); border-radius: var(--radius-sm); background: var(--panel); padding: 10px 12px; }
          .wf-step-outwrap.settled { max-height: 150px; }
          .wf-row[data-status="queued"] .wf-step-outwrap { display: none; }
          .wf-step-out { font-size: 13px; }
          .wf-step-out:empty::before { content: "…"; color: var(--ink-3); }
        `;
        document.head.appendChild(el("style", { text: css }));
      }
    },
  });
})();
