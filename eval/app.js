/* CrewHaus — Eval Bundle shape UI.
   Grades a compiled target against a labeled dataset. The bundle loads a
   dataset from `.crewhaus/datasets`, runs every case through the agent, applies
   the configured graders, and prints a JSON run summary when it finishes. Run
   class is stdio-oneshot with input:"none" — pressing Run launches a fresh
   process (no stdin), which streams its work and then exits.

   EVENT ROUTING (verified against the emitter — packages/target-eval-bundle,
   eval-runner, eval-grader, dataset-registry):
     • The bundle's ONLY structured stdout is one final JSON line:
         { runId, passRate, samples, outDir }
       We parse that line for the authoritative SCORE BOARD + report.
     • Per-sample agent runs go through runChatLoop, so when CREWHAUS_TRACE=json
       the host extracts real TraceEvents from stdout and delivers them via
       api.on('event'): model_response, tool_call_*, cost_accrual, and —
       whenever a sample exercises a test-running tool — test_verdict. We build
       the per-case VERDICT list from test_verdict events (CH.events renders
       them: pass=green, fail=red) and feed everything to the Activity timeline.
     • Banner / progress / grader prose arrives as plain stdout (no runId), so
       it is NOT a TraceEvent — it goes to the raw output log. */
(function () {
  "use strict";
  const { el, icon, mdInto, clear, dropzone, stripAnsi, events, fmtMs, fmtUsd, fmtTokens, copy } =
    window.CH;

  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  const VERDICT_META = {
    pass: { cls: "pass", icon: "check", label: "pass" },
    fail: { cls: "fail", icon: "x", label: "fail" },
    skip: { cls: "skip", icon: "dot", label: "skip" },
    error: { cls: "error", icon: "alert", label: "error" },
  };

  CH.app({
    controls: ["stop"],
    build(api) {
      // ── Run model (reset on each Run) ───────────────────────────────────
      let run = null;
      function newRun() {
        return {
          status: "running", // running | done | error | exited
          runId: null,
          datasetName: null,
          graderNames: [],
          // per-case verdicts, keyed by testId so re-fires update in place
          verdicts: [],
          byId: {},
          counts: { pass: 0, fail: 0, skip: 0, error: 0 },
          // grader-level tally derived from verdict reasons "[name: ✓/✗]"
          graderTally: {}, // name -> { pass, fail }
          summary: null, // parsed { runId, passRate, samples, outDir }
          stats: events.newStats(),
        };
      }

      let ui = null; // rebuilt by buildActive

      // ── stdout: scan for the final summary JSON line, log the rest ──────
      let lineBuf = "";
      api.on("stdout", (m) => {
        lineBuf += stripAnsi(m.text);
        let nl;
        while ((nl = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          handleStdoutLine(line);
        }
      });

      function handleStdoutLine(line) {
        const t = line.trim();
        if (!t) return;
        if (t[0] === "{" && t[t.length - 1] === "}") {
          let obj = null;
          try {
            obj = JSON.parse(t);
          } catch {
            obj = null;
          }
          if (obj && typeof obj.passRate === "number" && "runId" in obj) {
            onSummary(obj);
            return;
          }
        }
        // Banner / progress / grader prose → raw output log.
        api.log(line + "\n", "stdout");
      }

      function flushLineBuf() {
        if (lineBuf.trim()) {
          handleStdoutLine(lineBuf);
          lineBuf = "";
        }
      }

      // ── TraceEvents (per-sample runChatLoop) ────────────────────────────
      api.on("event", (m) => {
        const ev = m.event;
        if (!ev || !ev.kind || !run) return;
        events.accrue(ev, run.stats);
        if (ev.kind === "test_verdict") ingestVerdict(ev);
        updateStats();
        const node = events.render(ev);
        if (node && ui && ui.feedEl) {
          ui.feedEl.appendChild(node);
          ui.feedEmpty.style.display = "none";
          if (ui.feedScroll) ui.feedScroll.scrollTop = ui.feedScroll.scrollHeight;
        }
      });

      function ingestVerdict(ev) {
        const verdict = VERDICT_META[ev.verdict] ? ev.verdict : "skip";
        let v = run.byId[ev.testId];
        if (v) {
          // Re-fire: adjust the previous tally.
          run.counts[v.verdict] = Math.max(0, run.counts[v.verdict] - 1);
          v.verdict = verdict;
          v.reason = ev.reason || v.reason;
          v.durationMs = ev.durationMs;
        } else {
          v = {
            testId: ev.testId || "(case)",
            verdict,
            reason: ev.reason || "",
            durationMs: ev.durationMs,
          };
          run.verdicts.push(v);
          run.byId[v.testId] = v;
        }
        run.counts[verdict] += 1;
        tallyGraders(v);
        renderVerdicts();
        renderScore();
      }

      // Grader rationales are emitted as "[name: ✓] … & [name: ✗] …".
      function tallyGraders(v) {
        if (!v.reason) return;
        const re = /\[([^:\]]+):\s*([✓✗xX✔✘])\]/;
        const seen = new Set();
        let rest = v.reason;
        let mm;
        while ((mm = rest.match(re)) !== null) {
          const name = mm[1].trim();
          const ok = mm[2] === "✓" || mm[2] === "✔";
          const key = name + "@" + v.testId;
          if (!seen.has(key)) {
            seen.add(key);
            const t = (run.graderTally[name] = run.graderTally[name] || { pass: 0, fail: 0 });
            if (ok) t.pass += 1;
            else t.fail += 1;
          }
          rest = rest.slice(mm.index + mm[0].length);
        }
      }

      // ── Final summary JSON line ─────────────────────────────────────────
      function onSummary(obj) {
        if (!run) return;
        run.summary = obj;
        run.runId = obj.runId || run.runId;
        run.status = "done";
        renderScore();
        renderReport();
        setStatusLine(
          `Run complete · ${obj.samples} case(s) · ${pctText(obj.passRate)} pass rate`,
          "done",
        );
        api.toast("Eval complete — score board ready");
      }

      // ── Stats strip ─────────────────────────────────────────────────────
      function updateStats() {
        if (!ui || !ui.statEls || !run) return;
        const s = run.stats;
        const graded = run.verdicts.length;
        ui.statEls.cases.textContent = String(graded);
        ui.statEls.tools.textContent = String(s.tools || 0);
        ui.statEls.tokens.textContent = fmtTokens((s.tokensIn || 0) + (s.tokensOut || 0));
        ui.statEls.cost.textContent = fmtUsd(s.costMicros || 0);
      }

      // ── Score board (hero) ───────────────────────────────────────────────
      function passRate() {
        if (run.summary && typeof run.summary.passRate === "number") return run.summary.passRate;
        const total = run.counts.pass + run.counts.fail + run.counts.skip + run.counts.error;
        return total === 0 ? 0 : run.counts.pass / total;
      }

      function renderScore() {
        if (!ui || !ui.scoreBody) return;
        const c = run.counts;
        const graded = run.verdicts.length;
        const total = run.summary ? run.summary.samples : graded;
        const rate = passRate();

        clear(ui.scoreBody);

        // Big pass-rate dial.
        const ring = el("div", { class: `score-ring ${run.status}` }, [
          el("div", { class: "score-pct", text: pctText(rate) }),
          el("div", { class: "score-cap", text: "pass rate" }),
        ]);
        ring.style.setProperty("--rate", pctText(rate));
        ui.scoreBody.appendChild(ring);

        // Pass-rate bar.
        ui.scoreBody.appendChild(
          el("div", { class: "score-bar-wrap" }, [
            el("div", { class: "bar score-bar" }, el("i", { style: { width: pctText(rate) } })),
            el("div", { class: "score-bar-foot mono" }, [
              el("span", { text: `${c.pass} / ${total || "—"} passing` }),
              el("span", { class: "grow" }),
              el("span", {
                text:
                  run.status === "running"
                    ? graded
                      ? `${graded} graded so far`
                      : "grading…"
                    : "final",
              }),
            ]),
          ]),
        );

        // Verdict count tiles.
        ui.scoreBody.appendChild(
          el("div", { class: "verdict-tiles" }, [
            verdictTile("pass", "Passed", c.pass, "check"),
            verdictTile("fail", "Failed", c.fail, "x"),
            verdictTile("skip", "Skipped", c.skip, "dot"),
            verdictTile("error", "Errors", c.error, "alert"),
          ]),
        );

        // Grader breakdown.
        const graderNames = Object.keys(run.graderTally);
        if (graderNames.length || run.graderNames.length) {
          ui.scoreBody.appendChild(el("div", { class: "divider" }));
          ui.scoreBody.appendChild(el("div", { class: "section-label", text: "Grader breakdown" }));
          const wrap = el("div", { class: "grader-list" });
          const names = graderNames.length ? graderNames : run.graderNames;
          if (names.length === 0) {
            wrap.appendChild(el("div", { class: "muted small", text: "No grader signal yet." }));
          }
          for (const name of names) {
            const t = run.graderTally[name] || { pass: 0, fail: 0 };
            const tot = t.pass + t.fail;
            const gr = tot === 0 ? 0 : t.pass / tot;
            wrap.appendChild(
              el("div", { class: "grader-row" }, [
                el("div", { class: "grader-top" }, [
                  el("span", { class: "grader-name mono", text: name }),
                  el("span", { class: "grow" }),
                  el("span", {
                    class: "grader-frac mono",
                    text: tot ? `${t.pass}/${tot}` : "—",
                  }),
                ]),
                el("div", { class: "bar grader-bar" }, el("i", { style: { width: pctText(gr) } })),
              ]),
            );
          }
          ui.scoreBody.appendChild(wrap);
        }
      }

      function verdictTile(kind, label, n, ic) {
        return el("div", { class: `vtile ${kind}` }, [
          el("div", { class: "vtile-top" }, [
            el("span", { class: "vtile-ic" }, icon(ic, 14)),
            el("div", { class: "vtile-n", text: String(n) }),
          ]),
          el("div", { class: "vtile-k", text: label }),
        ]);
      }

      // ── Verdict list (hero) ──────────────────────────────────────────────
      function renderVerdicts() {
        if (!ui || !ui.verdictList) return;
        clear(ui.verdictList);
        if (run.verdicts.length === 0) {
          ui.verdictList.appendChild(
            el("div", { class: "verdict-wait" }, [
              run.status === "running" ? el("span", { class: "spinner" }) : icon("flask", 14),
              el("span", {
                text:
                  run.status === "running"
                    ? "Running cases — verdicts appear here as each is graded…"
                    : run.status === "done"
                      ? "No per-case verdict events were streamed. See the score board and report."
                      : "Press Run to grade the dataset.",
              }),
            ]),
          );
          return;
        }
        run.verdicts.forEach((v) => {
          const meta = VERDICT_META[v.verdict] || VERDICT_META.skip;
          ui.verdictList.appendChild(
            el("div", { class: `vcase ${meta.cls}` }, [
              el("div", { class: "vcase-marker" }, icon(meta.icon, 13)),
              el("div", { class: "vcase-main" }, [
                el("div", { class: "vcase-head" }, [
                  el("span", { class: "vcase-id mono", text: v.testId }),
                  el("span", { class: `vbadge ${meta.cls}`, text: meta.label }),
                  el("span", { class: "grow" }),
                  v.durationMs != null
                    ? el("span", { class: "vcase-ms mono", text: fmtMs(v.durationMs) })
                    : null,
                ]),
                v.reason ? el("div", { class: "vcase-reason mono", text: v.reason }) : null,
              ]),
            ]),
          );
        });
        if (ui.verdictScroll) ui.verdictScroll.scrollTop = ui.verdictScroll.scrollHeight;
      }

      // ── Report panel (built from the final summary line) ─────────────────
      function reportMarkdown() {
        if (!run.summary) return "";
        const s = run.summary;
        const c = run.counts;
        const lines = [];
        lines.push("# Eval report");
        lines.push("");
        lines.push(`- **Run id:** \`${s.runId}\``);
        if (run.datasetName) lines.push(`- **Dataset:** \`${run.datasetName}\``);
        lines.push(`- **Cases:** ${s.samples}`);
        lines.push(`- **Pass rate:** ${pctText(s.passRate)}`);
        if (run.verdicts.length) {
          lines.push(
            `- **Verdicts:** ${c.pass} pass · ${c.fail} fail · ${c.skip} skip · ${c.error} error`,
          );
        }
        lines.push(`- **Artifacts:** \`${s.outDir}\``);
        const graderNames = Object.keys(run.graderTally);
        if (graderNames.length) {
          lines.push("");
          lines.push("## Grader breakdown");
          lines.push("");
          for (const name of graderNames) {
            const t = run.graderTally[name];
            lines.push(`- \`${name}\` — ${t.pass}/${t.pass + t.fail} passing`);
          }
        }
        lines.push("");
        lines.push(
          "> Per-sample artifacts (`grades.json`, `events.jsonl`, `transcript.jsonl`) and the " +
            "full `results.json` summary were written under the artifacts directory above.",
        );
        return lines.join("\n");
      }

      function renderReport() {
        if (!ui || !ui.reportBody) return;
        const src = reportMarkdown();
        if (!src) {
          clear(ui.reportBody);
          ui.reportBody.appendChild(
            el("div", { class: "report-empty" }, [
              el("div", { class: "big-icon soft" }, icon("flask", 24)),
              el("div", {
                class: "muted",
                text: "The run summary lands here when the eval finishes.",
              }),
            ]),
          );
          if (ui.reportActions) ui.reportActions.style.display = "none";
          return;
        }
        mdInto(ui.reportBody, src);
        ui._reportMarkdown = src;
        if (ui.reportActions) ui.reportActions.style.display = "flex";
      }

      // ── Status line ──────────────────────────────────────────────────────
      let statusKind = "idle";
      function setStatusLine(text, kind) {
        statusKind = kind || "idle";
        if (!ui || !ui.statusLine) return;
        clear(ui.statusLine);
        const cls = { running: "", done: "done", error: "err", idle: "" }[kind] || "";
        if (kind === "running") ui.statusLine.appendChild(el("span", { class: "spinner" }));
        else
          ui.statusLine.appendChild(
            icon(kind === "error" ? "alert" : kind === "done" ? "check" : "flask", 13),
          );
        ui.statusLine.appendChild(el("span", { text }));
        ui.statusLine.className = "run-status " + cls;
      }

      function pctText(r) {
        return `${Math.round((r || 0) * 100)}%`;
      }

      // ── Run controls ─────────────────────────────────────────────────────
      function setRunControls(state) {
        if (!ui || !ui.runBtn) return;
        const running = state === "running" || state === "starting";
        ui.runBtn.disabled = running || !api.isPresent();
        if (ui.stopBtn) ui.stopBtn.disabled = !running;
        clear(ui.runBtn);
        if (running) {
          ui.runBtn.appendChild(el("span", { class: "spinner" }));
          ui.runBtn.appendChild(el("span", { text: "Grading…" }));
        } else {
          ui.runBtn.appendChild(icon("play", 15));
          ui.runBtn.appendChild(
            el("span", { text: run && run.summary ? "Re-run eval" : "Run eval" }),
          );
        }
      }

      function startEval() {
        if (!api.isPresent()) return;
        run = newRun();
        lineBuf = "";
        if (ui.feedEl) clear(ui.feedEl);
        if (ui.feedEmpty) ui.feedEmpty.style.display = "";
        renderScore();
        renderVerdicts();
        renderReport();
        updateStats();
        setStatusLine("Loading dataset and grading cases…", "running");
        // input:"none" — start (not submit) launches the bundle; main() runs at once.
        api.start();
      }

      // ── status events ────────────────────────────────────────────────────
      api.on("status", (m) => {
        if (!ui) return;
        setRunControls(m.state);
        if (m.state === "exited") {
          flushLineBuf();
          if (run && run.status === "running") {
            run.status = run.summary ? "done" : "exited";
            if (!run.summary && statusKind === "running") {
              setStatusLine(
                "Process exited before a summary — check the raw output log (dataset present?).",
                "error",
              );
              api.openLog();
            }
          }
          renderVerdicts();
        } else if (m.state === "error") {
          if (run) run.status = "error";
          setStatusLine("The eval bundle could not start — check the raw output log.", "error");
          api.openLog();
        }
      });

      // ── View switching ───────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want !== mode) {
          mode = want;
          want === "active" ? buildActive() : buildEmpty();
        }
        // Capture a dataset hint from the harness manifest if exposed.
        if (run && s.harness && s.harness.manifest && s.harness.manifest.dataset) {
          run.datasetName = s.harness.manifest.dataset;
        }
      });

      // ── Empty state ──────────────────────────────────────────────────────
      function buildEmpty() {
        ui = null;
        run = null;
        lineBuf = "";
        clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "flask",
            title: "Drop in a compiled eval bundle",
            subtitle:
              "This UI runs any bundle compiled from a CrewHaus spec with target: eval — it grades a target against a labeled dataset and reports a pass rate.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Make sure the dataset exists under `.crewhaus/datasets` (the spec's `dataset.name@version`)",
              "Press **Run eval** — dependencies install automatically on first run",
            ],
          }),
        );
      }

      // ── Active layout ────────────────────────────────────────────────────
      function buildActive() {
        clear(api.main);
        run = run || newRun();

        // Run bar (top).
        const runBtn = el("button", { class: "btn primary run-btn", onClick: startEval });
        const stopBtn = el("button", {
          class: "btn ghost sm",
          title: "Stop the current run",
          onClick: () => api.stop(),
        });
        stopBtn.appendChild(icon("square", 13));
        stopBtn.appendChild(el("span", { text: "Stop" }));
        const statusLine = el("div", { class: "run-status" });

        const datasetChip = el("div", { class: "chip ds-chip" }, [
          icon("database", 13),
          el("span", { class: "k", text: "dataset" }),
          el("span", { class: "v", text: api.config.title || "labeled set" }),
        ]);

        const runBar = el("div", { class: "eval-bar" }, [
          el("div", { class: "eval-bar-row" }, [
            el("span", { class: "eval-icon" }, icon("flask", 18)),
            el("div", { class: "eval-bar-titles" }, [
              el("div", { class: "eval-bar-title", text: "Grade against the dataset" }),
              el("div", {
                class: "eval-bar-sub muted",
                text: "Run every labeled case through the target, grade it, and score the pass rate.",
              }),
            ]),
            el("div", { class: "eval-bar-actions" }, [runBtn, stopBtn]),
          ]),
          el("div", { class: "eval-bar-foot" }, [
            statusLine,
            el("span", { class: "grow" }),
            datasetChip,
          ]),
        ]);

        // Stats strip.
        const statsBar = el("div", { class: "stats eval-stats" });
        const statEls = {
          cases: stat(statsBar, "Cases graded", "0", "layers"),
          tools: stat(statsBar, "Tool calls", "0", "wrench"),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          cost: stat(statsBar, "Cost", "$0.00", "coins", true),
        };

        // LEFT pane — Score board (hero).
        const scoreBody = el("div", { class: "score-body" });
        const leftPane = el("div", { class: "pane" }, [
          paneHead("activity", "Score board"),
          el("div", { class: "pane-scroll" }, [
            el("div", { class: "col" }, [statsBar, el("div", { class: "divider" }), scoreBody]),
          ]),
        ]);

        // MIDDLE pane — Verdict list (hero).
        const verdictList = el("div", { class: "verdict-list" });
        const verdictScroll = el("div", { class: "pane-scroll" }, [verdictList]);
        const midPane = el("div", { class: "pane" }, [
          paneHead("check", "Case verdicts"),
          verdictScroll,
        ]);

        // RIGHT pane — Report + Activity feed.
        const reportBody = el("div", { class: "report-body md" });
        const copyBtn = el("button", {
          class: "btn ghost sm",
          onClick: () => copy(ui._reportMarkdown || ""),
        });
        copyBtn.appendChild(icon("copy", 13));
        copyBtn.appendChild(el("span", { text: "Copy" }));
        const reportActions = el("div", { class: "report-actions", style: { display: "none" } }, [
          copyBtn,
        ]);
        const feedEl = el("div", { class: "feed" });
        const feedEmpty = el("div", {
          class: "muted small feed-empty",
          text: "Model, tool and cost events stream here while cases run.",
        });
        const feedScroll = el("div", { class: "pane-scroll" }, [
          el("div", { class: "col" }, [
            el("div", { class: "report-head-row" }, [
              el("div", { class: "section-label", text: "Run summary" }),
              el("span", { class: "grow" }),
              reportActions,
            ]),
            reportBody,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Activity" }),
            feedEmpty,
            feedEl,
          ]),
        ]);
        const rightPane = el("div", { class: "pane" }, [
          paneHead("book", "Report & activity"),
          feedScroll,
        ]);

        const grid = el("div", { class: "eval-grid" }, [
          runBar,
          el("div", { class: "split eval-cols" }, [leftPane, midPane, rightPane]),
        ]);
        api.main.appendChild(grid);

        ui = {
          runBtn,
          stopBtn,
          statusLine,
          statEls,
          scoreBody,
          verdictList,
          verdictScroll,
          reportBody,
          reportActions,
          feedEl,
          feedEmpty,
          feedScroll,
          _reportMarkdown: "",
        };

        renderScore();
        renderVerdicts();
        renderReport();
        updateStats();
        setRunControls(api.state.state);
        if (!api.isPresent()) {
          setStatusLine("Drop a compiled agent.ts into harness/ to begin.", "idle");
        } else if (api.state.state !== "running") {
          setStatusLine(
            "Ready — press Run eval. A dataset must exist under .crewhaus/datasets.",
            "idle",
          );
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

      // ── Shape-local styles ───────────────────────────────────────────────
      injectStyles();
      function injectStyles() {
        if (document.getElementById("eval-styles")) return;
        const css = `
        .eval-grid { display: grid; grid-template-rows: auto 1fr; min-height: 0; overflow: hidden; }
        .eval-bar { border-bottom: 1px solid var(--rule); background: linear-gradient(180deg, var(--panel-2), var(--panel)); padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
        .eval-bar-row { display: flex; gap: 13px; align-items: center; }
        .eval-icon { width: 36px; height: 36px; flex: 0 0 auto; border-radius: 10px; display: grid; place-items: center; background: var(--accent-ghost); color: var(--accent); border: 1px solid var(--accent-glow); }
        .eval-bar-titles { min-width: 0; flex: 1; }
        .eval-bar-title { font-size: 14.5px; font-weight: 600; letter-spacing: -0.01em; }
        .eval-bar-sub { font-size: 12px; }
        .eval-bar-actions { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
        .run-btn { padding: 10px 16px; }
        .eval-bar-foot { display: flex; align-items: center; gap: 12px; }
        .ds-chip { flex: 0 0 auto; }
        .ds-chip svg { width: 13px; height: 13px; opacity: .8; color: var(--accent); }
        .run-status { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); font-family: var(--mono); min-height: 18px; }
        .run-status svg { width: 13px; height: 13px; }
        .run-status.done { color: var(--accent); }
        .run-status.err { color: var(--red); }

        .eval-cols { grid-template-columns: 320px 1fr 360px; }
        @media (max-width: 1200px) { .eval-cols { grid-template-columns: 300px 1fr; } .eval-cols .pane:nth-child(3) { display: none; } }
        @media (max-width: 860px) { .eval-cols { grid-template-columns: 1fr; grid-auto-rows: minmax(0, 1fr); } .eval-cols .pane:nth-child(3) { display: flex; } }

        .eval-stats { grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: 8px; }
        .eval-stats .stat { padding: 9px 11px; }
        .eval-stats .stat-top { display: flex; align-items: center; gap: 7px; }
        .eval-stats .stat-ic { color: var(--accent); display: inline-grid; place-items: center; opacity: .85; }
        .eval-stats .stat .v { font-size: 17px; }

        /* score board */
        .score-body { display: flex; flex-direction: column; gap: 14px; }
        .score-ring { position: relative; margin: 6px auto 2px; width: 168px; height: 168px; border-radius: 50%; display: grid; place-items: center; background:
            radial-gradient(closest-side, var(--panel) 79%, transparent 80% 100%),
            conic-gradient(var(--accent) 0, var(--accent) var(--rate, 0%), var(--panel-3) var(--rate, 0%));
          border: 1px solid var(--rule); }
        .score-ring.running { animation: pulsering 2.4s ease-in-out infinite; }
        @keyframes pulsering { 0%,100% { box-shadow: 0 0 0 0 var(--accent-glow); } 50% { box-shadow: 0 0 0 6px transparent; } }
        .score-pct { font-family: var(--mono); font-size: 40px; font-weight: 700; letter-spacing: -0.03em; color: var(--ink); line-height: 1; }
        .score-cap { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--ink-3); margin-top: 4px; }

        .score-bar-wrap { display: flex; flex-direction: column; gap: 6px; }
        .score-bar { height: 9px; }
        .score-bar-foot { display: flex; font-size: 11px; color: var(--ink-3); }

        .verdict-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
        .vtile { border: 1px solid var(--rule); border-left: 2px solid var(--rule-2); border-radius: var(--radius-sm); background: var(--panel-2); padding: 10px 12px; }
        .vtile-top { display: flex; align-items: center; gap: 8px; }
        .vtile-ic { display: inline-grid; place-items: center; color: var(--ink-3); }
        .vtile-ic svg { width: 14px; height: 14px; }
        .vtile-n { font-family: var(--mono); font-size: 22px; font-weight: 700; letter-spacing: -0.02em; margin-left: auto; }
        .vtile-k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); margin-top: 3px; }
        .vtile.pass { border-left-color: var(--accent); } .vtile.pass .vtile-ic { color: var(--accent); } .vtile.pass .vtile-n { color: var(--accent); }
        .vtile.fail { border-left-color: var(--red); } .vtile.fail .vtile-ic { color: var(--red); } .vtile.fail .vtile-n { color: var(--red); }
        .vtile.skip { border-left-color: var(--rule-2); }
        .vtile.error { border-left-color: var(--amber); } .vtile.error .vtile-ic { color: var(--amber); } .vtile.error .vtile-n { color: var(--amber); }

        .grader-list { display: flex; flex-direction: column; gap: 10px; }
        .grader-row { display: flex; flex-direction: column; gap: 5px; }
        .grader-top { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
        .grader-name { color: var(--ink); }
        .grader-frac { color: var(--ink-3); font-size: 11.5px; }
        .grader-bar { height: 6px; }

        /* verdict list */
        .verdict-list { display: flex; flex-direction: column; gap: 8px; }
        .verdict-wait { display: flex; align-items: center; gap: 10px; color: var(--ink-3); font-size: 12.5px; padding: 14px 4px; }
        .verdict-wait svg { width: 14px; height: 14px; color: var(--accent); }
        .vcase { display: grid; grid-template-columns: 24px 1fr; gap: 10px; align-items: start; padding: 10px 12px; background: var(--panel); border: 1px solid var(--rule); border-left: 2px solid var(--rule-2); border-radius: var(--radius-sm); animation: rise .18s ease both; }
        .vcase-marker { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; background: var(--panel-3); color: var(--ink-2); border: 1px solid var(--rule-2); }
        .vcase-marker svg { width: 13px; height: 13px; }
        .vcase.pass { border-left-color: var(--accent); } .vcase.pass .vcase-marker { background: var(--accent-ghost); color: var(--accent); border-color: var(--accent-glow); }
        .vcase.fail { border-left-color: var(--red); } .vcase.fail .vcase-marker { background: var(--red-ghost); color: var(--red); border-color: rgba(239,111,111,.3); }
        .vcase.skip { opacity: .82; }
        .vcase.error { border-left-color: var(--amber); } .vcase.error .vcase-marker { background: var(--amber-ghost); color: var(--amber); border-color: rgba(230,180,80,.3); }
        .vcase-main { min-width: 0; }
        .vcase-head { display: flex; align-items: center; gap: 8px; }
        .vcase-id { font-size: 12.5px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .vbadge { font-family: var(--mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; padding: 1px 7px; border-radius: 100px; border: 1px solid var(--rule-2); color: var(--ink-2); background: var(--panel-3); }
        .vbadge.pass { color: var(--accent); background: var(--accent-ghost); border-color: var(--accent-glow); }
        .vbadge.fail { color: var(--red); background: var(--red-ghost); border-color: rgba(239,111,111,.3); }
        .vbadge.error { color: var(--amber); background: var(--amber-ghost); border-color: rgba(230,180,80,.3); }
        .vcase-ms { font-size: 10.5px; color: var(--ink-3); }
        .vcase-reason { font-size: 11.5px; color: var(--ink-3); margin-top: 5px; overflow-wrap: anywhere; line-height: 1.5; }

        /* report */
        .report-head-row { display: flex; align-items: center; gap: 8px; }
        .report-actions { display: flex; gap: 8px; }
        .report-body { font-size: 13px; line-height: 1.6; }
        .report-body.md h1 { font-size: 1.35em; }
        .report-body.md h2 { font-size: 1.1em; }
        .report-empty { min-height: 140px; display: grid; place-items: center; text-align: center; gap: 12px; align-content: center; padding: 14px; }
        .report-empty .big-icon.soft { width: 52px; height: 52px; margin: 0 auto; display: grid; place-items: center; border-radius: 15px; background: var(--accent-ghost); color: var(--accent); border: 1px solid var(--accent-glow); }
        .feed-empty { padding: 4px 2px; }
        .small { font-size: 12px; }
        `;
        document.head.appendChild(el("style", { id: "eval-styles", text: css }));
      }
    },
  });
})();
