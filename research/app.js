/* CrewHaus — Research shape UI.
   An autonomous, multi-branch research agent rendered as a live investigation:
   a goal is decomposed into sub-questions (branches), each branch is researched
   with the Source/CiteFact tools, and the findings are assembled into a cited
   markdown report. Run class is stdio-oneshot — each Run spawns a fresh process
   that streams its plan, branches, sources and report, then exits.

   IMPORTANT — event routing (verified against the emitter):
     The compiled agent emits its research milestones as JSON lines on STDOUT
     ({kind:"plan_done", subQuestions}, {kind:"branch_start", branchId, question},
      {kind:"branch_end", branchId, citationCount}, {kind:"sources_resolved", ...},
      {kind:"budget_exceeded", ...}). These carry no runId/timestamp, so the host
     does NOT classify them as TraceEvents — they arrive via api.on('stdout').
     Only run_start / resume / run_done (which carry runId) plus the real
     runChatLoop TraceEvents (model_response, tool_call_*, cost_accrual, …)
     arrive via api.on('event'). Branch answer prose is interleaved on stdout
     between those JSON lines. We parse stdout line-by-line accordingly. */
(function () {
  "use strict";
  const { el, icon, mdInto, clear, dropzone, stripAnsi, events, fmtBytes, fmtMs, fmtUsd, fmtTokens, copy } = window.CH;

  // Research milestone kinds carried on stdout (no runId -> not TraceEvents).
  const RESEARCH_KINDS = new Set([
    "run_start", "resume", "plan_start", "plan_done", "plan_loaded",
    "sources_resolved", "branch_start", "branch_end", "budget_exceeded", "run_done",
  ]);

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
      // ── Run model ────────────────────────────────────────────────────────
      // A single investigation. Reset on each Run.
      let run = null;
      function newRun(goal) {
        return {
          goal: goal || "",
          runId: null,
          status: "running", // running | done | budget | error | exited
          branches: [],      // { id, question, status, answer, citationCount, node, els }
          byId: {},          // branchId -> branch
          activeBranchIdx: -1,
          sources: new Map(), // url -> { url, bytes, branchId, cited }
          sourcesResolved: 0,
          report: null,      // assembled markdown when run completes
          plannedCount: 0,
          stats: events.newStats(),
        };
      }

      // ── DOM handles (rebuilt by buildActive) ─────────────────────────────
      let ui = null;
      let goalInput = null;

      // Pre-run / banner stdout (before the first plan) -> raw log.
      function isLogNoise(t) {
        return !t.trim();
      }

      // ── stdout: split into JSON-line research events + branch prose ──────
      let proseBuffer = ""; // accumulates partial prose lines
      api.on("stdout", (m) => {
        const raw = stripAnsi(m.text);
        proseBuffer += raw;
        let nl;
        while ((nl = proseBuffer.indexOf("\n")) >= 0) {
          const line = proseBuffer.slice(0, nl);
          proseBuffer = proseBuffer.slice(nl + 1);
          handleStdoutLine(line);
        }
      });

      function handleStdoutLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        // Try to parse a research milestone JSON line.
        if (trimmed[0] === "{" && trimmed[trimmed.length - 1] === "}") {
          let obj = null;
          try { obj = JSON.parse(trimmed); } catch { obj = null; }
          if (obj && typeof obj.kind === "string" && RESEARCH_KINDS.has(obj.kind)) {
            onResearchEvent(obj);
            return;
          }
        }
        // Otherwise it's assistant/branch answer prose.
        if (isLogNoise(line)) return;
        appendBranchProse(line + "\n");
      }

      // Branch answer prose -> the active branch body (and live into report view).
      function appendBranchProse(text) {
        if (!run) return;
        const b = run.branches[run.activeBranchIdx];
        if (b) {
          b.answer = (b.answer || "") + text;
          if (b.els && b.els.body) mdInto(b.els.body, b.answer);
          if (b.els && b.els.body) b.els.body.classList.add("cursor-blink");
          renderLiveReport();
          if (ui && ui.branchScroll) ui.branchScroll.scrollTop = ui.branchScroll.scrollHeight;
        } else {
          // Prose before any branch (rare) -> raw log.
          api.log(text, "stdout");
        }
      }

      // ── TraceEvents (runChatLoop + run_start/run_done) ───────────────────
      api.on("event", (m) => {
        const ev = m.event;
        if (!ev || !ev.kind) return;
        if (RESEARCH_KINDS.has(ev.kind)) {
          onResearchEvent(ev);
          return;
        }
        // Standard TraceEvent: accrue stats, feed it, and capture Source fetches.
        if (run) {
          events.accrue(ev, run.stats);
          updateStats();
        }
        captureSource(ev);
        const node = events.render(ev);
        if (node && ui && ui.feedEl) {
          ui.feedEl.appendChild(node);
          if (ui.feedScroll) ui.feedScroll.scrollTop = ui.feedScroll.scrollHeight;
        }
      });

      // The Source tool fetches a URL; CiteFact records a citation. We mine
      // tool_call events to build the live Sources panel.
      function captureSource(ev) {
        if (!run) return;
        if (ev.kind === "tool_call_start" && ev.toolName === "Source") {
          run.stats._sourceCalls = (run.stats._sourceCalls || 0) + 1;
        }
        if (ev.kind === "tool_call_end" && ev.toolName === "Source" && !ev.isError) {
          // We can't see the URL in the event, so register an anonymous fetch
          // keyed by an incrementing id; the count is what matters for the panel.
          const id = "src-" + run.sources.size;
          if (!run.sources.has(id)) {
            run.sources.set(id, {
              url: null,
              bytes: ev.outputBytes || 0,
              branchId: run.branches[run.activeBranchIdx] ? run.branches[run.activeBranchIdx].id : null,
              cited: false,
            });
          }
          renderSources();
        }
        if (ev.kind === "tool_call_end" && ev.toolName === "CiteFact" && !ev.isError) {
          run.stats._citations = (run.stats._citations || 0) + 1;
          renderSources();
          updateStats();
        }
      }

      // ── Research milestone handler ───────────────────────────────────────
      function onResearchEvent(ev) {
        if (!run) return;
        switch (ev.kind) {
          case "run_start":
            run.runId = ev.runId || run.runId;
            if (ev.goal) run.goal = ev.goal;
            setStatusLine("Decomposing the goal into research branches…", "running");
            renderHeader();
            break;
          case "resume":
            run.runId = ev.runId || run.runId;
            setStatusLine(`Resumed run · ${ev.completedBranches || 0} branch(es) already done`, "running");
            renderHeader();
            break;
          case "plan_start":
            run.plannedCount = ev.branchingFactor || 0;
            setStatusLine(`Planning ${run.plannedCount} branch(es)…`, "running");
            break;
          case "plan_done":
          case "plan_loaded":
            if (Array.isArray(ev.subQuestions)) ingestPlan(ev.subQuestions);
            setStatusLine("Plan ready — researching each branch in turn.", "running");
            break;
          case "sources_resolved":
            run.sourcesResolved = ev.count || 0;
            renderSources();
            break;
          case "branch_start":
            startBranch(ev.branchId, ev.question);
            break;
          case "branch_end":
            endBranch(ev.branchId, ev.citationCount);
            break;
          case "budget_exceeded":
            run.status = "budget";
            setStatusLine(`Time budget reached after ${fmtMs(ev.elapsedMs)} — writing a partial report.`, "budget");
            break;
          case "run_done":
            finishRun(ev);
            break;
        }
      }

      function ingestPlan(subQuestions) {
        // Build the branch tree from the plan. branch_start fills in ids later.
        run.plannedCount = subQuestions.length;
        run.branches = subQuestions.map((q, i) => makeBranch("b" + i, q, "pending"));
        run.byId = {};
        for (const b of run.branches) run.byId[b.id] = b;
        renderBranches();
        renderLiveReport();
        updateProgress();
      }

      function makeBranch(id, question, status) {
        return { id, question, status, answer: "", citationCount: 0, node: null, els: null };
      }

      function startBranch(branchId, question) {
        let b = run.byId[branchId];
        if (!b) {
          // Plan wasn't seen (e.g. resume without plan_loaded) — synthesize.
          b = makeBranch(branchId, question || "(branch)", "active");
          run.branches.push(b);
          run.byId[branchId] = b;
        }
        if (question && (!b.question || b.question === "(branch)")) b.question = question;
        b.status = "active";
        run.activeBranchIdx = run.branches.indexOf(b);
        setStatusLine(`Researching branch ${run.activeBranchIdx + 1} of ${run.branches.length}…`, "running");
        renderBranches();
        updateProgress();
      }

      function endBranch(branchId, citationCount) {
        const b = run.byId[branchId];
        if (b) {
          b.status = "done";
          b.citationCount = citationCount || 0;
          b.answer = (b.answer || "").trim();
          if (b.els && b.els.body) {
            b.els.body.classList.remove("cursor-blink");
            mdInto(b.els.body, b.answer || "_(no answer captured)_");
          }
        }
        renderBranches();
        renderLiveReport();
        updateProgress();
      }

      function finishRun(ev) {
        run.runId = ev.runId || run.runId;
        if (run.status !== "budget") run.status = "done";
        // Mark any still-active branch closed.
        for (const b of run.branches) {
          if (b.status === "active") b.status = "done";
          if (b.els && b.els.body) b.els.body.classList.remove("cursor-blink");
        }
        run.activeBranchIdx = -1;
        run.report = assembleReport();
        renderBranches();
        renderReport(true);
        const cites = ev.citations != null ? ev.citations : (run.stats._citations || 0);
        const word = run.status === "budget" ? "Partial report ready" : "Report complete";
        setStatusLine(`${word} · ${run.branches.length} branch(es) · ${cites} citation(s)`, run.status === "budget" ? "budget" : "done");
        api.toast(run.status === "budget" ? "Partial report ready" : "Research complete — report ready");
        updateProgress();
      }

      // ── Report assembly (mirrors report-writer's markdown layout) ────────
      function assembleReport() {
        const lines = [];
        lines.push("# " + (run.goal || "Research report"));
        lines.push("");
        for (const b of run.branches) {
          if (!b.answer && b.status !== "done") continue;
          lines.push("## " + b.question);
          lines.push("");
          lines.push((b.answer || "").trim() || "_(no findings captured)_");
          lines.push("");
        }
        return lines.join("\n").trimEnd() + "\n";
      }

      function renderLiveReport() {
        // While running, the report pane mirrors what we have so far.
        if (run && run.status === "done") return;
        renderReport(false);
      }

      // ── Status / header bits ─────────────────────────────────────────────
      let statusKind = "idle";
      function setStatusLine(text, kind) {
        statusKind = kind || "idle";
        if (ui && ui.statusLine) {
          clear(ui.statusLine);
          const dotKind = { running: "spin", done: "ok", budget: "warn", error: "err", idle: "" }[kind] || "";
          if (kind === "running") ui.statusLine.appendChild(el("span", { class: "spinner" }));
          else ui.statusLine.appendChild(icon(kind === "budget" ? "clock" : kind === "error" ? "alert" : "check", 13));
          ui.statusLine.appendChild(el("span", { text }));
          ui.statusLine.className = "run-status " + (dotKind || "");
        }
      }

      function renderHeader() {
        if (!ui || !ui.goalEcho) return;
        clear(ui.goalEcho);
        ui.goalEcho.appendChild(el("span", { class: "geicon" }, icon("search", 13)));
        ui.goalEcho.appendChild(el("span", { class: "getext", text: run.goal || "—" }));
        if (run.runId) {
          ui.goalEcho.appendChild(el("span", { class: "badge", text: run.runId.slice(0, 12) }));
        }
      }

      // ── Stats ────────────────────────────────────────────────────────────
      function updateStats() {
        if (!ui || !ui.statEls || !run) return;
        const s = run.stats;
        const done = run.branches.filter((b) => b.status === "done").length;
        ui.statEls.branches.textContent = run.branches.length ? `${done}/${run.branches.length}` : "0";
        ui.statEls.sources.textContent = String(s._sourceCalls || 0);
        ui.statEls.citations.textContent = String(s._citations || 0);
        ui.statEls.tokens.textContent = fmtTokens((s.tokensIn || 0) + (s.tokensOut || 0));
        ui.statEls.cost.textContent = fmtUsd(s.costMicros || 0);
      }

      function updateProgress() {
        if (!ui || !ui.progBar) return;
        updateStats();
        const total = run.branches.length || run.plannedCount || 0;
        const done = run.branches.filter((b) => b.status === "done").length;
        const active = run.branches.some((b) => b.status === "active") ? 0.5 : 0;
        const pct = total ? Math.min(100, Math.round(((done + active) / total) * 100)) : (run.status === "done" ? 100 : 0);
        ui.progBar.style.width = pct + "%";
        if (ui.progPillBar) ui.progPillBar.style.width = pct + "%";
        if (ui.progLabel) ui.progLabel.textContent = total ? `${done} / ${total} branches` : "planning…";
      }

      // ── Branch tree rendering ────────────────────────────────────────────
      function renderBranches() {
        if (!ui || !ui.branchList) return;
        clear(ui.branchList);
        if (run.branches.length === 0) {
          ui.branchList.appendChild(
            el("div", { class: "branch-wait" }, [
              el("span", { class: "spinner" }),
              el("span", { text: "Decomposing the goal into sub-questions…" }),
            ]),
          );
          return;
        }
        run.branches.forEach((b, i) => {
          const sevClass = b.status === "active" ? "active" : b.status === "done" ? "done" : "pending";
          const head = el("div", { class: "branch-head" }, [
            el("div", { class: `branch-marker ${sevClass}` }, [
              b.status === "active" ? el("span", { class: "spinner" })
                : b.status === "done" ? icon("check", 12)
                : el("span", { class: "branch-num", text: String(i + 1) }),
            ]),
            el("div", { class: "branch-q" }, [
              el("div", { class: "branch-title", text: b.question }),
              el("div", { class: "branch-meta" }, [
                el("span", { class: `branch-state ${sevClass}`, text: b.status }),
                b.status === "done"
                  ? el("span", { class: "chip-mini" }, [icon("link", 11), el("span", { text: `${b.citationCount} cited` })])
                  : null,
              ]),
            ]),
          ]);
          const body = el("div", { class: "branch-body md" });
          if (b.answer) mdInto(body, b.answer);
          else if (b.status === "active") body.appendChild(el("span", { class: "muted", text: "researching…" }));
          else body.appendChild(el("span", { class: "muted", text: "queued" }));
          const card = el("div", { class: `branch ${sevClass}` }, [head, body]);
          b.node = card;
          b.els = { body };
          ui.branchList.appendChild(card);
        });
      }

      // ── Sources rendering ────────────────────────────────────────────────
      function renderSources() {
        if (!ui || !ui.sourceList) return;
        clear(ui.sourceList);
        const fetched = run.sources.size;
        const fileSources = run.sourcesResolved;
        if (fetched === 0 && fileSources === 0) {
          ui.sourceList.appendChild(el("div", { class: "muted small", text: "No sources retrieved yet." }));
          return;
        }
        if (fileSources > 0) {
          ui.sourceList.appendChild(
            el("div", { class: "source-row file" }, [
              el("span", { class: "src-ic" }, icon("folder", 13)),
              el("span", { class: "src-main", text: `${fileSources} local file source(s) available` }),
            ]),
          );
        }
        let n = 1;
        for (const s of run.sources.values()) {
          ui.sourceList.appendChild(
            el("div", { class: "source-row" }, [
              el("span", { class: "src-n", text: "[" + n + "]" }),
              el("span", { class: "src-ic" }, icon("globe", 13)),
              el("span", { class: "src-main" }, [
                el("span", { text: s.url || "fetched source" }),
                el("span", { class: "src-bytes", text: fmtBytes(s.bytes) }),
              ]),
            ]),
          );
          n++;
        }
        const cites = run.stats._citations || 0;
        if (ui.sourceFoot) {
          clear(ui.sourceFoot);
          ui.sourceFoot.appendChild(el("span", { text: `${fetched} fetched · ${cites} cited` }));
        }
      }

      // ── Report rendering ─────────────────────────────────────────────────
      function renderReport(final) {
        if (!ui || !ui.reportBody) return;
        const reportSrc = run.report || assembleReport();
        const hasAnswers = run.branches.some((b) => b.answer && b.answer.trim());
        if (!hasAnswers && !final) {
          clear(ui.reportBody);
          ui.reportBody.appendChild(
            el("div", { class: "report-empty" }, [
              el("div", { class: "big-icon soft" }, icon("book", 24)),
              el("div", { class: "muted", text: "The report assembles here as branches complete." }),
            ]),
          );
          if (ui.reportActions) ui.reportActions.style.display = "none";
          return;
        }
        mdInto(ui.reportBody, reportSrc);
        if (ui.reportActions) ui.reportActions.style.display = final ? "flex" : "none";
        ui._reportMarkdown = reportSrc;
      }

      // ── View switching ───────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want !== mode) {
          mode = want;
          want === "active" ? buildActive() : buildEmpty();
        }
      });

      api.on("status", (m) => {
        // stdio-oneshot: 'running' = process spawned, 'exited' = finished.
        if (!ui) return;
        setRunControls(m.state);
        if (m.state === "exited") {
          flushProse();
          if (run && run.status === "running") {
            // Process exited without a run_done (e.g. error before report).
            run.status = "exited";
            for (const b of run.branches) if (b.els && b.els.body) b.els.body.classList.remove("cursor-blink");
            if (!run.report) { run.report = assembleReport(); renderReport(true); }
            if (statusKind === "running") setStatusLine("Process exited. Run again to start a new investigation.", "idle");
          }
        } else if (m.state === "error") {
          if (run) run.status = "error";
          setStatusLine("The research agent could not start — check the raw output log.", "error");
          api.openLog();
        }
      });

      function flushProse() {
        if (proseBuffer.trim()) {
          handleStdoutLine(proseBuffer);
          proseBuffer = "";
        }
      }

      function setRunControls(state) {
        if (!goalInput || !ui.runBtn) return;
        const running = state === "running" || state === "starting";
        goalInput.disabled = running;
        ui.runBtn.disabled = running || !api.isPresent();
        clear(ui.runBtn);
        if (running) {
          ui.runBtn.appendChild(el("span", { class: "spinner" }));
          ui.runBtn.appendChild(el("span", { text: "Researching…" }));
        } else {
          ui.runBtn.appendChild(icon("search", 15));
          ui.runBtn.appendChild(el("span", { text: run && run.report ? "New investigation" : "Run research" }));
        }
      }

      // ── Empty state ──────────────────────────────────────────────────────
      function buildEmpty() {
        ui = null; goalInput = null; run = null; proseBuffer = "";
        clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "search",
            title: "Drop in a compiled research agent",
            subtitle: "This UI runs any bundle compiled from a CrewHaus spec with target: research — decompose a question, research each branch, get a cited report.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Type a research question below and press **Run** — deps install on first run",
            ],
          }),
        );
      }

      // ── Active layout ────────────────────────────────────────────────────
      function startResearch() {
        const goal = (goalInput.value || "").trim();
        if (!goal) { goalInput.focus(); return; }
        // Reset the run + every panel for a fresh investigation.
        run = newRun(goal);
        proseBuffer = "";
        if (ui.feedEl) clear(ui.feedEl);
        renderHeader();
        renderBranches();
        renderSources();
        renderReport(false);
        updateProgress();
        setStatusLine("Launching research agent…", "running");
        api.submit(goal); // stdio-oneshot: writes goal to stdin, closes EOF.
      }

      function buildActive() {
        clear(api.main);
        run = run || newRun("");

        // ── Goal bar (top) ──────────────────────────────────────────────
        goalInput = el("textarea", {
          class: "field goal-field",
          rows: 1,
          placeholder: "What should the agent research? e.g. “Compare the leading approaches to vector database indexing in 2025.”",
        });
        goalInput.addEventListener("input", () => {
          goalInput.style.height = "auto";
          goalInput.style.height = Math.min(goalInput.scrollHeight, 120) + "px";
        });
        goalInput.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault(); startResearch();
          }
        });
        const runBtn = el("button", { class: "btn primary run-btn", onClick: startResearch }, [
          icon("search", 15), el("span", { text: "Run research" }),
        ]);
        const stopBtn = el("button", { class: "btn ghost sm", title: "Stop the current run", onClick: () => api.stop() }, [
          icon("square", 13), el("span", { text: "Stop" }),
        ]);
        const goalEcho = el("div", { class: "goal-echo" });
        const statusLine = el("div", { class: "run-status" });
        const progLabel = el("span", { class: "prog-label", text: "idle" });
        const progBar = el("i");
        const goalBar = el("div", { class: "goal-bar" }, [
          el("div", { class: "goal-row" }, [
            el("span", { class: "goal-icon" }, icon("sparkles", 16)),
            goalInput,
            el("div", { class: "goal-actions" }, [runBtn, stopBtn]),
          ]),
          el("div", { class: "goal-status-row" }, [
            statusLine,
            el("span", { class: "grow" }),
            el("div", { class: "prog" }, [progLabel, el("div", { class: "bar prog-bar" }, progBar)]),
          ]),
          goalEcho,
        ]);

        // ── Stats strip ─────────────────────────────────────────────────
        const statsBar = el("div", { class: "stats research-stats" });
        const statEls = {
          branches: stat(statsBar, "Branches", "0", "layers"),
          sources: stat(statsBar, "Sources", "0", "globe"),
          citations: stat(statsBar, "Citations", "0", "link", true),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          cost: stat(statsBar, "Cost", "$0.00", "coins"),
        };

        // ── LEFT pane: Branches + Sources + Activity stacked ────────────
        const branchList = el("div", { class: "branch-list" });
        const branchScroll = el("div", { class: "pane-scroll" }, [
          el("div", { class: "col" }, [
            statsBar,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Research branches" }),
            branchList,
          ]),
        ]);
        const leftPane = el("div", { class: "pane" }, [
          paneHead("layers", "Branches", el("span", { class: "prog-pill mono" }, [
            el("span", { class: "bar prog-mini" }, el("i", { style: { width: "0%" } })),
          ])),
          branchScroll,
        ]);

        // ── MIDDLE pane: the hero report ────────────────────────────────
        const reportBody = el("div", { class: "report-body md" });
        const copyBtn = el("button", { class: "btn ghost sm", onClick: () => copy(ui._reportMarkdown || "") }, [
          icon("copy", 13), el("span", { text: "Copy markdown" }),
        ]);
        const dlBtn = el("button", { class: "btn ghost sm", onClick: downloadReport }, [
          icon("download", 13), el("span", { text: "Download .md" }),
        ]);
        const reportActions = el("div", { class: "report-actions", style: { display: "none" } }, [copyBtn, dlBtn]);
        const reportScroll = el("div", { class: "pane-scroll" }, [reportBody]);
        const midPane = el("div", { class: "pane report-pane" }, [
          paneHead("book", "Report", reportActions),
          reportScroll,
        ]);

        // ── RIGHT pane: Sources + Activity feed ─────────────────────────
        const sourceList = el("div", { class: "source-list" });
        const sourceFoot = el("div", { class: "source-foot mono muted" });
        const feedEl = el("div", { class: "feed" });
        const feedScroll = el("div", { class: "pane-scroll" }, [
          el("div", { class: "col" }, [
            el("div", { class: "section-label", text: "Sources retrieved" }),
            sourceList,
            sourceFoot,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Activity" }),
            feedEl,
          ]),
        ]);
        const rightPane = el("div", { class: "pane" }, [paneHead("activity", "Sources & activity"), feedScroll]);

        // ── Assemble ────────────────────────────────────────────────────
        const grid = el("div", { class: "research-grid" }, [
          goalBar,
          el("div", { class: "split research-cols" }, [leftPane, midPane, rightPane]),
        ]);
        api.main.appendChild(grid);

        ui = {
          goalInput, runBtn, statusLine, goalEcho, progBar: progBar, progLabel,
          statEls, branchList, branchScroll,
          reportBody, reportActions, reportScroll,
          sourceList, sourceFoot, feedEl, feedScroll,
          progPillBar: leftPane.querySelector(".prog-mini > i"),
          _reportMarkdown: "",
        };

        renderHeader();
        renderBranches();
        renderSources();
        renderReport(false);
        updateStats();
        updateProgress();
        setRunControls(api.state.state);
        if (!api.isPresent()) {
          setStatusLine("Drop a compiled agent.ts into harness/ to begin.", "idle");
        } else if (api.state.state !== "running") {
          setStatusLine("Ready — type a question and press Run.", "idle");
        }
      }

      function downloadReport() {
        const src = ui._reportMarkdown || assembleReport();
        const blob = new Blob([src], { type: "text/markdown" });
        const a = el("a", { href: URL.createObjectURL(blob), download: (run.runId || "research-report") + ".md" });
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      }

      function stat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(
          el("div", { class: "stat" }, [
            el("div", { class: "stat-top" }, [el("span", { class: "stat-ic" }, icon(ic, 13)), v]),
            el("div", { class: "k", text: label }),
          ]),
        );
        return v;
      }

      // ── Shape-local styles (layout the design system doesn't cover) ──────
      injectStyles();
      function injectStyles() {
        if (document.getElementById("research-styles")) return;
        const css = `
        .research-grid { display: grid; grid-template-rows: auto 1fr; min-height: 0; overflow: hidden; }
        .goal-bar { border-bottom: 1px solid var(--rule); background: linear-gradient(180deg, var(--panel-2), var(--panel)); padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
        .goal-row { display: flex; gap: 12px; align-items: flex-start; }
        .goal-icon { width: 34px; height: 34px; flex: 0 0 auto; border-radius: 9px; display: grid; place-items: center; background: var(--accent-ghost); color: var(--accent); border: 1px solid var(--accent-glow); margin-top: 2px; }
        .goal-field { min-height: 40px; max-height: 120px; line-height: 1.45; font-size: 14.5px; }
        .goal-actions { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
        .run-btn { padding: 10px 16px; }
        .goal-status-row { display: flex; align-items: center; gap: 12px; }
        .run-status { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); font-family: var(--mono); min-height: 18px; }
        .run-status svg { width: 13px; height: 13px; }
        .run-status.ok, .run-status.done { color: var(--accent); }
        .run-status.warn, .run-status.budget { color: var(--amber); }
        .run-status.err { color: var(--red); }
        .prog { display: flex; align-items: center; gap: 9px; min-width: 220px; }
        .prog-label { font-family: var(--mono); font-size: 11px; color: var(--ink-3); white-space: nowrap; }
        .prog-bar { width: 150px; }
        .prog-mini { width: 80px; height: 5px; }
        .prog-pill { display: inline-flex; align-items: center; }
        .goal-echo { display: flex; align-items: center; gap: 9px; font-family: var(--mono); font-size: 12px; color: var(--ink-2); }
        .goal-echo .geicon { color: var(--accent); display: inline-grid; place-items: center; }
        .goal-echo .getext { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; color: var(--ink); }

        .research-cols { grid-template-columns: 340px 1fr 360px; }
        @media (max-width: 1200px) { .research-cols { grid-template-columns: 300px 1fr; } .research-cols .pane:nth-child(3) { display: none; } }
        @media (max-width: 860px) { .research-cols { grid-template-columns: 1fr; grid-auto-rows: minmax(0, 1fr); } .research-cols .pane:nth-child(3) { display: flex; } }

        .research-stats { grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: 8px; }
        .research-stats .stat { padding: 9px 11px; }
        .research-stats .stat-top { display: flex; align-items: center; gap: 7px; }
        .research-stats .stat-ic { color: var(--accent); display: inline-grid; place-items: center; opacity: .85; }
        .research-stats .stat .v { font-size: 17px; }

        .branch-list { display: flex; flex-direction: column; gap: 10px; }
        .branch-wait { display: flex; align-items: center; gap: 10px; color: var(--ink-3); font-size: 12.5px; padding: 8px 2px; }
        .branch { border: 1px solid var(--rule); border-left: 2px solid var(--rule-2); border-radius: var(--radius-sm); background: var(--panel); overflow: hidden; animation: rise .18s ease both; }
        .branch.active { border-left-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-ghost) inset; }
        .branch.done { border-left-color: var(--accent); }
        .branch.pending { opacity: .82; }
        .branch-head { display: flex; gap: 11px; padding: 11px 12px; align-items: flex-start; }
        .branch-marker { width: 24px; height: 24px; flex: 0 0 auto; border-radius: 7px; display: grid; place-items: center; background: var(--panel-3); color: var(--ink-2); border: 1px solid var(--rule-2); }
        .branch-marker.active { background: var(--accent-ghost); color: var(--accent); border-color: var(--accent-glow); }
        .branch-marker.done { background: var(--accent-ghost); color: var(--accent); border-color: var(--accent-glow); }
        .branch-marker svg { width: 12px; height: 12px; }
        .branch-num { font-family: var(--mono); font-size: 12px; }
        .branch-q { min-width: 0; flex: 1; }
        .branch-title { font-size: 13px; font-weight: 500; color: var(--ink); line-height: 1.4; }
        .branch-meta { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
        .branch-state { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); }
        .branch-state.active { color: var(--accent); }
        .branch-state.done { color: var(--accent); }
        .chip-mini { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 10.5px; color: var(--ink-2); }
        .chip-mini svg { width: 11px; height: 11px; opacity: .7; }
        .branch-body { padding: 0 12px 12px 47px; font-size: 12.5px; color: var(--ink-2); max-height: 220px; overflow: auto; }
        .branch-body.md > *:first-child { margin-top: 0; }
        .branch-body .muted { font-family: var(--mono); font-size: 11.5px; }

        .report-pane { background: linear-gradient(180deg, var(--panel), var(--bg-2)); }
        .report-body { max-width: 760px; margin: 0 auto; padding: 8px 6px 40px; font-size: 14.5px; line-height: 1.7; }
        .report-body.md h1 { font-size: 1.7em; border-bottom: 1px solid var(--rule); padding-bottom: .35em; }
        .report-body.md h2 { font-size: 1.22em; color: var(--ink); margin-top: 1.5em; }
        .report-actions { display: flex; gap: 8px; }
        .report-empty { height: 100%; min-height: 320px; display: grid; place-items: center; text-align: center; gap: 12px; align-content: center; }
        .report-empty .big-icon.soft { width: 56px; height: 56px; margin: 0 auto; display: grid; place-items: center; border-radius: 16px; background: var(--accent-ghost); color: var(--accent); border: 1px solid var(--accent-glow); }

        .source-list { display: flex; flex-direction: column; gap: 6px; }
        .source-row { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); padding: 6px 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--panel-2); }
        .source-row.file { color: var(--ink-3); }
        .source-row .src-n { color: var(--accent); }
        .source-row .src-ic { color: var(--ink-3); display: inline-grid; place-items: center; }
        .source-row .src-main { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
        .source-row .src-main > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .source-row .src-bytes { margin-left: auto; color: var(--ink-3); flex: 0 0 auto; }
        .source-foot { font-size: 11px; }
        .small { font-size: 12px; }
        `;
        document.head.appendChild(el("style", { id: "research-styles", text: css }));
      }
    },
  });
})();
