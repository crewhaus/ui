/* CrewHaus — Browser Agent shape UI.
   A computer-use agent that drives a real browser: it reads a single task from
   stdin, then loops Navigate → Screenshot → FindElement → Click / Type / Key /
   Scroll until the task is done, and prints a final answer. Run class is
   stdio-oneshot — each Run spawns a fresh process that streams its actions and
   result, then exits.

   IMPORTANT — event routing (verified against the emitter
   packages/target-browser-driver/src/index.ts):

     The compiled agent prints three custom JSON lines on STDOUT that carry NO
     runId/timestamp, so the host does NOT classify them as TraceEvents — they
     arrive via api.on('stdout'):
        {kind:"browser_start", backend}        — driver connecting (host|chromium|remote)
        {kind:"navigated", url}                — auto-navigation to the spec startUrl
        {kind:"browser_done", finalText}       — the agent's final answer

     Everything else is a real runChatLoop TraceEvent on api.on('event'):
        model_response, cost_accrual, turn_*, and tool_call_start/tool_call_end
        whose toolName is one of:
          Navigate, Screenshot, Click, Type, Key, Scroll, FindElement
        (plus any spec-declared built-in tools from ir.tools).

     SCREENSHOTS ARE NOT SURFACED AS DATA. The Screenshot tool returns a PNG
     image block to the *model*; the host only ever sees that a Screenshot tool
     call happened and how many bytes it returned (tool_call_end.outputBytes).
     No image pixels reach this UI. So the hero here is the ACTION TIMELINE: a
     richly-rendered sequence of every browser action the agent took, paired with
     a stats strip, an activity feed, and the final result. Tool input/output
     payloads (the click x/y, the typed text, the visited URL) are not in the
     TraceEvent either — only byte sizes — so steps are labelled by kind and
     enriched with what we *can* observe (bytes, duration, errors). */
(function () {
  "use strict";
  const { el, icon, mdInto, clear, dropzone, stripAnsi, events, fmtBytes, fmtMs, fmtUsd, fmtTokens, copy } = window.CH;

  // The seven first-class browser-driver tools (from the emitter). Everything
  // else (read/bash/webFetch/…) is a spec-declared built-in and falls through
  // to a generic "tool" action.
  const BROWSER_TOOLS = {
    Navigate:    { icon: "globe",   verb: "Navigate",     blurb: "load a URL",                kind: "nav",  destructive: false },
    Screenshot:  { icon: "eye",     verb: "Screenshot",   blurb: "capture the viewport",      kind: "look", destructive: false },
    FindElement: { icon: "search",  verb: "Find element", blurb: "locate UI via vision",      kind: "look", destructive: false },
    Click:       { icon: "wand",    verb: "Click",        blurb: "click at coordinates",      kind: "act",  destructive: true },
    Type:        { icon: "message", verb: "Type",         blurb: "type text",                 kind: "act",  destructive: true },
    Key:         { icon: "terminal",verb: "Key",          blurb: "press a key / combo",       kind: "act",  destructive: true },
    Scroll:      { icon: "layers",  verb: "Scroll",       blurb: "wheel-scroll the page",     kind: "act",  destructive: true },
  };

  // Custom stdout milestone kinds (no runId -> not TraceEvents).
  const BROWSER_KINDS = new Set(["browser_start", "navigated", "browser_done"]);

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
      // One browser session per Run. Reset on each Run.
      let run = null;
      function newRun(task) {
        return {
          task: task || "",
          backend: null,        // host | chromium | remote (from browser_start)
          startUrl: null,       // from a 'navigated' milestone before the first turn
          status: "running",    // running | done | error | exited
          steps: [],            // ordered action steps mined from tool_call_* events
          byUseId: {},          // toolUseId -> step
          finalText: "",        // browser_done.finalText (preferred) or streamed prose
          prose: "",            // assistant prose interleaved on stdout
          stats: events.newStats(),
          _actCount: 0,
        };
      }

      let ui = null;
      let taskInput = null;

      // ── stdout: split into JSON-line milestones + assistant prose ────────
      let proseBuffer = "";
      api.on("stdout", (m) => {
        proseBuffer += stripAnsi(m.text);
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
        if (trimmed[0] === "{" && trimmed[trimmed.length - 1] === "}") {
          let obj = null;
          try { obj = JSON.parse(trimmed); } catch { obj = null; }
          if (obj && typeof obj.kind === "string" && BROWSER_KINDS.has(obj.kind)) {
            onBrowserMilestone(obj);
            return;
          }
        }
        // Otherwise it's assistant prose (or a pre-turn banner line).
        if (!run || run.status !== "running") { api.log(line, "stdout"); return; }
        appendProse(line + "\n");
      }

      function appendProse(text) {
        if (!run) return;
        run.prose += text;
        renderResult(false);
        if (ui && ui.resultScroll) ui.resultScroll.scrollTop = ui.resultScroll.scrollHeight;
      }

      // ── Browser milestone handler (custom stdout JSON) ───────────────────
      function onBrowserMilestone(ev) {
        if (!run) return;
        switch (ev.kind) {
          case "browser_start":
            run.backend = ev.backend || run.backend;
            setStatusLine(`Browser connecting · ${backendLabel(run.backend)} backend…`, "running");
            addStep({ tool: null, kind: "boot", title: "Driver connected", sub: `${backendLabel(run.backend)} backend`, ic: "plug", sev: "info" });
            renderEnv();
            break;
          case "navigated":
            run.startUrl = ev.url || run.startUrl;
            addStep({ tool: "Navigate", kind: "nav", title: "Opened start page", sub: ev.url || "", ic: "globe", sev: "accent" });
            setStatusLine("Loaded the start page — agent is taking over.", "running");
            renderEnv();
            break;
          case "browser_done":
            run.finalText = (ev.finalText || "").trim();
            run.status = "done";
            finishRun();
            break;
        }
      }

      // ── TraceEvents (runChatLoop tool calls + cost) ──────────────────────
      api.on("event", (m) => {
        const ev = m.event;
        if (!ev || !ev.kind) return;
        if (run) { events.accrue(ev, run.stats); updateStats(); }
        captureAction(ev);
        const node = events.render(ev);
        if (node && ui && ui.feedEl) {
          ui.feedEl.appendChild(node);
          if (ui.feedScroll) ui.feedScroll.scrollTop = ui.feedScroll.scrollHeight;
        }
      });

      // Mine tool_call_start / tool_call_end into the action timeline.
      function captureAction(ev) {
        if (!run) return;
        if (ev.kind === "tool_call_start") {
          const meta = BROWSER_TOOLS[ev.toolName];
          run._actCount++;
          const step = addStep({
            tool: ev.toolName,
            kind: meta ? meta.kind : "tool",
            title: meta ? meta.verb : ev.toolName,
            sub: meta ? meta.blurb : "tool call",
            ic: meta ? meta.icon : "wrench",
            sev: meta ? (meta.destructive ? "accent" : "info") : "muted",
            status: "running",
            inputBytes: ev.inputBytes,
            destructive: meta ? meta.destructive : false,
          });
          if (ev.toolUseId) run.byUseId[ev.toolUseId] = step;
          const which = meta ? meta.verb.toLowerCase() : ev.toolName;
          setStatusLine(`Action ${run._actCount}: ${which}…`, "running");
        } else if (ev.kind === "tool_call_end") {
          const step = ev.toolUseId ? run.byUseId[ev.toolUseId] : null;
          if (step) {
            step.status = ev.isError ? "error" : "done";
            step.outputBytes = ev.outputBytes;
            step.durationMs = ev.durationMs;
            if (ev.isError) { step.sev = "error"; step.ic = "alert"; }
            renderStepNode(step);
          }
          updateProgress();
        }
      }

      function addStep(s) {
        const step = Object.assign({ idx: run.steps.length, status: s.status || "done" }, s);
        run.steps.push(step);
        appendStepNode(step);
        updateProgress();
        return step;
      }

      // ── Status / env line ────────────────────────────────────────────────
      let statusKind = "idle";
      function setStatusLine(text, kind) {
        statusKind = kind || "idle";
        if (!ui || !ui.statusLine) return;
        clear(ui.statusLine);
        if (kind === "running") ui.statusLine.appendChild(el("span", { class: "spinner" }));
        else ui.statusLine.appendChild(icon(kind === "error" ? "alert" : kind === "done" ? "check" : "dot", 13));
        ui.statusLine.appendChild(el("span", { text }));
        ui.statusLine.className = "run-status " + ({ running: "", done: "done", error: "err", idle: "" }[kind] || "");
      }

      function backendLabel(b) {
        return { host: "host display", chromium: "Chromium", remote: "remote" }[b] || (b || "browser");
      }

      function renderEnv() {
        if (!ui || !ui.envRow) return;
        clear(ui.envRow);
        // Backend chip (observed from browser_start).
        ui.envRow.appendChild(chip("cpu", run.backend ? backendLabel(run.backend) : "browser", run.backend ? "" : "muted"));
        // Viewport chip — the dimensions are baked into the bundle (SPEC_VIEWPORT)
        // and not emitted, so we label it as spec-defined rather than guess.
        ui.envRow.appendChild(chip("eye", "viewport: from spec", "muted"));
        // Start URL chip when the agent auto-navigated.
        if (run.startUrl) ui.envRow.appendChild(chip("globe", trimUrl(run.startUrl), ""));
      }

      function chip(ic, text, cls) {
        return el("span", { class: `chip env-chip ${cls || ""}` }, [icon(ic, 12), el("span", { text })]);
      }

      function trimUrl(u) {
        try { const x = new URL(u); return x.host + (x.pathname !== "/" ? x.pathname : ""); }
        catch { return u.length > 42 ? u.slice(0, 42) + "…" : u; }
      }

      // ── Stats ────────────────────────────────────────────────────────────
      function updateStats() {
        if (!ui || !ui.statEls || !run) return;
        const s = run.stats;
        const actions = run.steps.filter((x) => x.tool && BROWSER_TOOLS[x.tool]).length;
        const errs = run.steps.filter((x) => x.status === "error").length;
        ui.statEls.actions.textContent = String(actions);
        ui.statEls.errors.textContent = String(errs);
        ui.statEls.tokens.textContent = fmtTokens((s.tokensIn || 0) + (s.tokensOut || 0));
        ui.statEls.cost.textContent = fmtUsd(s.costMicros || 0);
      }

      function updateProgress() {
        updateStats();
        if (!ui || !ui.actCount) return;
        const actions = run.steps.filter((x) => x.tool && BROWSER_TOOLS[x.tool]).length;
        ui.actCount.textContent = actions ? `${actions} action${actions === 1 ? "" : "s"}` : "no actions yet";
      }

      // ── Action timeline rendering (the hero) ─────────────────────────────
      function appendStepNode(step) {
        if (!ui || !ui.timeline) return;
        const node = buildStepNode(step);
        step._node = node;
        ui.timeline.appendChild(node);
        if (ui.timelineScroll) ui.timelineScroll.scrollTop = ui.timelineScroll.scrollHeight;
        // Hide the waiting placeholder once steps start arriving.
        if (ui.timelineWait) ui.timelineWait.style.display = "none";
      }

      function renderStepNode(step) {
        if (!step._node) return;
        const fresh = buildStepNode(step);
        step._node.replaceWith(fresh);
        step._node = fresh;
      }

      function buildStepNode(step) {
        const sevClass = step.status === "error" ? "error" : step.status === "running" ? "running" : step.sev || "info";
        const marker = el("div", { class: `step-marker ${sevClass}` }, [
          step.status === "running" ? el("span", { class: "spinner" }) : icon(step.ic || "dot", 13),
        ]);
        const metaBits = [];
        if (step.destructive) metaBits.push(el("span", { class: "tag destructive" }, [icon("shield", 10), el("span", { text: "destructive" })]));
        if (step.inputBytes != null && step.kind !== "boot") metaBits.push(el("span", { class: "kv", text: `in ${fmtBytes(step.inputBytes)}` }));
        if (step.outputBytes != null) metaBits.push(el("span", { class: "kv", text: `out ${fmtBytes(step.outputBytes)}` }));
        if (step.durationMs != null) metaBits.push(el("span", { class: "kv mono", text: fmtMs(step.durationMs) }));
        const head = el("div", { class: "step-head" }, [
          el("span", { class: "step-n mono", text: step.tool && BROWSER_TOOLS[step.tool] ? "#" + actionNumber(step) : "·" }),
          el("span", { class: "step-title", text: step.title }),
          step.tool ? el("span", { class: "step-tool mono", text: step.tool }) : null,
        ]);
        const sub = step.sub
          ? el("div", { class: "step-sub", text: step.sub })
          : null;
        const meta = metaBits.length ? el("div", { class: "step-meta" }, metaBits) : null;
        return el("div", { class: `step ${sevClass}` }, [
          marker,
          el("div", { class: "step-body" }, [head, sub, meta]),
        ]);
      }

      function actionNumber(step) {
        // 1-based index among real browser-tool actions only.
        let n = 0;
        for (const s of run.steps) {
          if (s.tool && BROWSER_TOOLS[s.tool]) { n++; if (s === step) return n; }
        }
        return n;
      }

      // ── Result rendering ─────────────────────────────────────────────────
      function renderResult(final) {
        if (!ui || !ui.resultBody) return;
        const text = (run.finalText || run.prose || "").trim();
        if (!text) {
          clear(ui.resultBody);
          ui.resultBody.appendChild(
            el("div", { class: "result-empty" }, [
              el("div", { class: "big-icon soft" }, icon("globe", 24)),
              el("div", { class: "muted", text: run.status === "running"
                ? "The agent's answer will appear here once it finishes navigating."
                : "Run a task to see the agent's answer here." }),
            ]),
          );
          if (ui.resultActions) ui.resultActions.style.display = "none";
          ui._resultMarkdown = "";
          return;
        }
        mdInto(ui.resultBody, text);
        ui._resultMarkdown = text;
        if (ui.resultActions) ui.resultActions.style.display = final ? "flex" : "none";
      }

      function finishRun() {
        // Close out any step still marked running.
        for (const s of run.steps) if (s.status === "running") { s.status = "done"; renderStepNode(s); }
        const actions = run.steps.filter((x) => x.tool && BROWSER_TOOLS[x.tool]).length;
        renderResult(true);
        renderEnv();
        updateProgress();
        const ok = run.status === "done";
        setStatusLine(
          ok ? `Task complete · ${actions} action${actions === 1 ? "" : "s"} taken` : "Run ended.",
          ok ? "done" : "idle",
        );
        if (ok) api.toast("Task complete — answer ready");
      }

      // ── View switching ───────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want !== mode) { mode = want; want === "active" ? buildActive() : buildEmpty(); }
      });

      api.on("status", (m) => {
        if (!ui) return;
        setRunControls(m.state);
        if (m.state === "exited") {
          flushProse();
          const exit = CH.failure.exitInfo(m);
          if (run && run.status === "running") {
            // Exited without a browser_done (error or abort before the answer).
            run.status = "exited";
            for (const s of run.steps) if (s.status === "running") { s.status = "done"; renderStepNode(s); }
            if (exit.failed) {
              setStatusLine(`Process exited — ${exit.line}. Check the raw output log.`, "error");
            } else if (!run.finalText && !run.prose.trim()) {
              setStatusLine("Process exited before producing an answer — check the raw output log.", "idle");
            } else {
              renderResult(true);
              setStatusLine("Process exited. Run again to start a new task.", "idle");
            }
          } else if (exit.failed) {
            // Crash outside a task run (e.g. boot failure after spawn).
            setStatusLine(`Process exited — ${exit.line}. Check the raw output log.`, "error");
          }
        } else if (m.state === "error") {
          if (run) run.status = "error";
          setStatusLine("The browser agent could not start — check the raw output log.", "error");
          api.openLog();
        }
      });

      function flushProse() {
        if (proseBuffer.trim()) { handleStdoutLine(proseBuffer); proseBuffer = ""; }
      }

      function setRunControls(state) {
        if (!taskInput || !ui || !ui.runBtn) return;
        const running = state === "running" || state === "starting";
        taskInput.disabled = running;
        ui.runBtn.disabled = running || !api.isPresent();
        clear(ui.runBtn);
        if (running) {
          ui.runBtn.appendChild(el("span", { class: "spinner" }));
          ui.runBtn.appendChild(el("span", { text: "Driving…" }));
        } else {
          ui.runBtn.appendChild(icon("play", 15));
          ui.runBtn.appendChild(el("span", { text: run && (run.finalText || run.prose) ? "New task" : "Run task" }));
        }
      }

      // ── Empty state ──────────────────────────────────────────────────────
      function buildEmpty() {
        ui = null; taskInput = null; run = null; proseBuffer = "";
        clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "globe",
            title: "Drop in a compiled browser agent",
            subtitle: "This UI runs any bundle compiled from a CrewHaus spec with target: browser — a computer-use agent that navigates, looks, and clicks its way through a real browser to finish a task.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Type a task below and press **Run** — Chromium + deps install on first run",
            ],
          }),
        );
      }

      // ── Active layout ────────────────────────────────────────────────────
      function startTask() {
        const task = (taskInput.value || "").trim();
        if (!task) { taskInput.focus(); return; }
        run = newRun(task);
        proseBuffer = "";
        if (ui.timeline) clear(ui.timeline);
        if (ui.feedEl) clear(ui.feedEl);
        renderTaskEcho();
        renderEnv();
        renderResult(false);
        updateProgress();
        if (ui.timelineWait) { ui.timeline.appendChild(ui.timelineWait); ui.timelineWait.style.display = "flex"; }
        setStatusLine("Launching the browser agent…", "running");
        api.submit(task); // stdio-oneshot: writes the task to stdin, then EOF.
      }

      function renderTaskEcho() {
        if (!ui || !ui.taskEcho) return;
        clear(ui.taskEcho);
        if (!run || !run.task) return;
        ui.taskEcho.appendChild(el("span", { class: "te-ic" }, icon("arrowRight", 13)));
        ui.taskEcho.appendChild(el("span", { class: "te-text", text: run.task }));
      }

      function buildActive() {
        clear(api.main);
        run = run || newRun("");

        // ── Task bar (top) ──────────────────────────────────────────────
        taskInput = el("textarea", {
          class: "field task-field",
          rows: 1,
          placeholder: "What should the agent do in the browser? e.g. “Go to news.ycombinator.com and summarize the top 3 stories.”",
        });
        taskInput.addEventListener("input", () => {
          taskInput.style.height = "auto";
          taskInput.style.height = Math.min(taskInput.scrollHeight, 120) + "px";
        });
        taskInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startTask(); }
        });
        const runBtn = el("button", { class: "btn primary run-btn", onClick: startTask }, [
          icon("play", 15), el("span", { text: "Run task" }),
        ]);
        const stopBtn = el("button", { class: "btn ghost sm", title: "Stop the current run", onClick: () => api.stop() }, [
          icon("square", 13), el("span", { text: "Stop" }),
        ]);
        const statusLine = el("div", { class: "run-status" });
        const envRow = el("div", { class: "env-row" });
        const taskEcho = el("div", { class: "task-echo" });
        const taskBar = el("div", { class: "task-bar" }, [
          el("div", { class: "task-row" }, [
            el("span", { class: "task-icon" }, icon("globe", 16)),
            taskInput,
            el("div", { class: "task-actions" }, [runBtn, stopBtn]),
          ]),
          el("div", { class: "task-status-row" }, [statusLine, el("span", { class: "grow" }), envRow]),
          taskEcho,
        ]);

        // ── Stats strip ─────────────────────────────────────────────────
        const statsBar = el("div", { class: "stats browser-stats" });
        const statEls = {
          actions: stat(statsBar, "Actions", "0", "wand", true),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          cost: stat(statsBar, "Cost", "$0.00", "coins"),
          errors: stat(statsBar, "Errors", "0", "alert"),
        };

        // ── LEFT pane: the action timeline (hero) ───────────────────────
        const timeline = el("div", { class: "timeline" });
        const timelineWait = el("div", { class: "timeline-wait" }, [
          el("span", { class: "spinner" }),
          el("span", { text: "Waiting for the agent's first browser action…" }),
        ]);
        timelineWait.style.display = "none";
        timeline.appendChild(timelineWait);
        const timelineScroll = el("div", { class: "pane-scroll" }, [
          el("div", { class: "col" }, [statsBar, el("div", { class: "divider" }), timeline]),
        ]);
        const actCount = el("span", { class: "mono act-count", text: "no actions yet" });
        const leftPane = el("div", { class: "pane" }, [
          paneHead("activity", "Action timeline", actCount),
          timelineScroll,
        ]);

        // ── MIDDLE pane: the result (agent's final answer) ──────────────
        const resultBody = el("div", { class: "result-body md" });
        const copyBtn = el("button", { class: "btn ghost sm", onClick: () => copy(ui._resultMarkdown || "") }, [
          icon("copy", 13), el("span", { text: "Copy" }),
        ]);
        const resultActions = el("div", { class: "result-actions", style: { display: "none" } }, [copyBtn]);
        const resultScroll = el("div", { class: "pane-scroll" }, [resultBody]);
        const midPane = el("div", { class: "pane result-pane" }, [
          paneHead("message", "Result", resultActions),
          resultScroll,
        ]);

        // ── RIGHT pane: raw activity feed ───────────────────────────────
        const feedEl = el("div", { class: "feed" });
        const feedScroll = el("div", { class: "pane-scroll" }, [
          el("div", { class: "col" }, [
            el("div", { class: "section-label", text: "Trace events" }),
            feedEl,
          ]),
        ]);
        const rightPane = el("div", { class: "pane" }, [paneHead("layers", "Activity"), feedScroll]);

        // ── Assemble ────────────────────────────────────────────────────
        const grid = el("div", { class: "browser-grid" }, [
          taskBar,
          el("div", { class: "split browser-cols" }, [leftPane, midPane, rightPane]),
        ]);
        api.main.appendChild(grid);

        ui = {
          taskInput, runBtn, statusLine, envRow, taskEcho,
          statEls, timeline, timelineScroll, timelineWait, actCount,
          resultBody, resultActions, resultScroll,
          feedEl, feedScroll,
          _resultMarkdown: "",
        };

        renderTaskEcho();
        renderEnv();
        renderResult(false);
        updateStats();
        updateProgress();
        setRunControls(api.state.state);
        if (!api.isPresent()) {
          setStatusLine("Drop a compiled agent.ts into harness/ to begin.", "idle");
        } else if (api.state.state !== "running") {
          setStatusLine("Ready — describe a task and press Run.", "idle");
        }
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
        if (document.getElementById("browser-styles")) return;
        const css = `
        .browser-grid { display: grid; grid-template-rows: auto 1fr; min-height: 0; overflow: hidden; }
        .task-bar { border-bottom: 1px solid var(--rule); background: linear-gradient(180deg, var(--panel-2), var(--panel)); padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
        .task-row { display: flex; gap: 12px; align-items: flex-start; }
        .task-icon { width: 34px; height: 34px; flex: 0 0 auto; border-radius: 9px; display: grid; place-items: center; background: var(--accent-ghost); color: var(--accent); border: 1px solid var(--accent-glow); margin-top: 2px; }
        .task-field { min-height: 40px; max-height: 120px; line-height: 1.45; font-size: 14.5px; }
        .task-actions { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
        .run-btn { padding: 10px 16px; }
        .task-status-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .run-status { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); font-family: var(--mono); min-height: 18px; }
        .run-status svg { width: 13px; height: 13px; }
        .run-status.done { color: var(--accent); }
        .run-status.err { color: var(--red); }
        .env-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
        .env-chip { font-family: var(--mono); font-size: 11px; gap: 5px; }
        .env-chip svg { width: 12px; height: 12px; opacity: .85; color: var(--accent); }
        .env-chip.muted { color: var(--ink-3); }
        .env-chip.muted svg { color: var(--ink-3); }
        .task-echo { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; color: var(--ink-2); min-height: 16px; }
        .task-echo .te-ic { color: var(--accent); display: inline-grid; place-items: center; flex: 0 0 auto; }
        .task-echo .te-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90%; color: var(--ink); }

        .browser-cols { grid-template-columns: 380px 1fr 320px; }
        @media (max-width: 1200px) { .browser-cols { grid-template-columns: 360px 1fr; } .browser-cols .pane:nth-child(3) { display: none; } }
        @media (max-width: 860px) { .browser-cols { grid-template-columns: 1fr; grid-auto-rows: minmax(0, 1fr); } .browser-cols .pane:nth-child(3) { display: flex; } }

        .browser-stats { grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: 8px; }
        .browser-stats .stat { padding: 9px 11px; }
        .browser-stats .stat-top { display: flex; align-items: center; gap: 7px; }
        .browser-stats .stat-ic { color: var(--accent); display: inline-grid; place-items: center; opacity: .85; }
        .browser-stats .stat .v { font-size: 17px; }
        .act-count { font-size: 11px; color: var(--ink-3); }

        /* Action timeline — the hero. A vertical rail of browser actions. */
        .timeline { display: flex; flex-direction: column; position: relative; }
        .timeline::before { content: ""; position: absolute; left: 14px; top: 6px; bottom: 6px; width: 2px; background: var(--rule); }
        .timeline-wait { display: flex; align-items: center; gap: 10px; color: var(--ink-3); font-size: 12.5px; padding: 10px 2px 10px 36px; }
        .step { display: flex; gap: 12px; padding: 7px 2px; position: relative; animation: rise .16s ease both; }
        .step-marker { width: 30px; height: 30px; flex: 0 0 auto; border-radius: 9px; display: grid; place-items: center; background: var(--panel-3); color: var(--ink-2); border: 1px solid var(--rule-2); z-index: 1; }
        .step-marker svg { width: 14px; height: 14px; }
        .step.accent .step-marker, .step.act .step-marker { background: var(--accent-ghost); color: var(--accent); border-color: var(--accent-glow); }
        .step.info .step-marker, .step.nav .step-marker, .step.look .step-marker { background: var(--accent-ghost); color: var(--accent); border-color: var(--accent-glow); }
        .step.running .step-marker { background: var(--accent-ghost); border-color: var(--accent-glow); }
        .step.error .step-marker { background: var(--red-ghost); color: var(--red); border-color: var(--red); }
        .step.muted .step-marker { background: var(--panel-3); color: var(--ink-3); }
        .step-body { min-width: 0; flex: 1; padding-top: 2px; }
        .step-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .step-n { color: var(--ink-3); font-size: 11px; flex: 0 0 auto; }
        .step-title { font-size: 13px; font-weight: 500; color: var(--ink); }
        .step-tool { font-size: 10.5px; color: var(--accent); background: var(--accent-ghost); border: 1px solid var(--accent-glow); border-radius: 5px; padding: 1px 6px; margin-left: auto; }
        .step.error .step-tool { color: var(--red); background: var(--red-ghost); border-color: var(--red); }
        .step-sub { font-size: 12px; color: var(--ink-2); margin-top: 2px; line-height: 1.4; }
        .step-meta { display: flex; align-items: center; gap: 9px; margin-top: 5px; flex-wrap: wrap; }
        .step-meta .kv { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); }
        .step-meta .tag { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 5px; }
        .step-meta .tag.destructive { color: var(--amber); background: var(--amber-ghost); border: 1px solid var(--amber-ghost); }
        .step-meta .tag svg { width: 10px; height: 10px; }

        .result-pane { background: linear-gradient(180deg, var(--panel), var(--bg-2)); }
        .result-body { max-width: 720px; margin: 0 auto; padding: 8px 6px 40px; font-size: 14.5px; line-height: 1.7; }
        .result-body.md > *:first-child { margin-top: 0; }
        .result-actions { display: flex; gap: 8px; }
        .result-empty { height: 100%; min-height: 320px; display: grid; place-items: center; text-align: center; gap: 12px; align-content: center; }
        .result-empty .big-icon.soft { width: 56px; height: 56px; margin: 0 auto; display: grid; place-items: center; border-radius: 16px; background: var(--accent-ghost); color: var(--accent); border: 1px solid var(--accent-glow); }
        `;
        document.head.appendChild(el("style", { id: "browser-styles", text: css }));
      }
    },
  });
})();
