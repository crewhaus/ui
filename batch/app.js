/* CrewHaus — Batch Worker shape UI.

   A queue-draining job worker rendered as a live throughput board. The compiled
   `batch` bundle takes NO input: pressing Start boots it, it pulls jobs off its
   in-memory queue, runs one single-turn agent per job, and exits on its own once
   the queue is idle.

   IMPORTANT routing note — the worker prints its own queue-lifecycle JSON to
   stdout (worker_start | job_start | job_end | drain_start | drain_end |
   shutdown_received | queue_idle | worker_stop). Those objects have `kind` but
   no `runId`/`timestamp`, so the host's TraceEvent splitter does NOT classify
   them as events — they arrive here as raw text on api.on('stdout'). We parse
   them ourselves, line by line, to drive the board. The per-job agent's standard
   CrewHaus TraceEvents (which DO carry runId/timestamp) still arrive on
   api.on('event') and feed the activity timeline + cost/token stats. */
(function () {
  "use strict";
  const { el, icon, dropzone, stripAnsi, events, fmtMs, fmtTokens, fmtUsd } = window.CH;

  const WORKER_KINDS = new Set([
    "worker_start",
    "job_start",
    "job_end",
    "drain_start",
    "drain_end",
    "shutdown_received",
    "queue_idle",
    "worker_stop",
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
    controls: ["start", "stop", "restart"],
    build(api) {
      // ── Worker run model ────────────────────────────────────────────────
      // jobs: Map<jobId, {id, attempt, status, fromCache, reason, error,
      //                    startedAt, endedAt}>
      let jobs = new Map();
      let order = []; // insertion order of jobIds (for stable rendering)
      let run = freshRun();
      const traceStats = events.newStats();

      // DOM handles, populated by buildActive()
      let els = null;
      let stdoutBuf = "";

      function freshRun() {
        return {
          booted: false,
          adapter: null,
          concurrency: null,
          done: 0,
          failed: 0,
          cached: 0,
          retries: 0,
          durations: [], // ms per completed job
          draining: false,
          finished: false,
          finalStats: null, // {pending,inFlight,acked,nacked,deadLetter}
          startedAt: null,
        };
      }

      function resetRun() {
        jobs = new Map();
        order = [];
        run = freshRun();
        Object.assign(traceStats, events.newStats());
      }

      // ── Worker event handling (parsed from stdout JSON lines) ───────────
      function onWorkerEvent(ev) {
        switch (ev.kind) {
          case "worker_start":
            run.booted = true;
            run.adapter = ev.queueAdapter;
            run.concurrency = ev.concurrency;
            run.startedAt = Date.now();
            workerLog(
              `worker started · adapter=${ev.queueAdapter} · concurrency=${ev.concurrency}`,
              "system",
            );
            break;
          case "job_start": {
            const id = String(ev.jobId);
            let j = jobs.get(id);
            if (!j) {
              j = { id, attempt: ev.attempt, status: "processing" };
              jobs.set(id, j);
              order.push(id);
            } else {
              j.status = "processing";
              j.attempt = ev.attempt;
              if (ev.attempt > 1) run.retries++;
            }
            j.startedAt = Date.now();
            workerLog(`job ${id} started (attempt ${ev.attempt})`, "system");
            break;
          }
          case "job_end": {
            const id = String(ev.jobId);
            let j = jobs.get(id);
            if (!j) {
              j = { id, attempt: ev.attempt, startedAt: Date.now() };
              jobs.set(id, j);
              order.push(id);
            }
            j.endedAt = Date.now();
            j.attempt = ev.attempt;
            if (j.startedAt) {
              const d = j.endedAt - j.startedAt;
              if (d >= 0) run.durations.push(d);
              j.durationMs = d;
            }
            if (ev.status === "ok") {
              j.status = "done";
              j.fromCache = !!ev.fromCache;
              run.done++;
              if (ev.fromCache) run.cached++;
              workerLog(
                `job ${id} ok${ev.fromCache ? " (from cache)" : ""}`,
                "system",
              );
            } else {
              j.status = "fail";
              j.reason = ev.reason;
              j.error = ev.error;
              run.failed++;
              workerLog(`job ${id} FAILED (${ev.reason}): ${ev.error || ""}`, "stderr");
            }
            break;
          }
          case "drain_start":
            run.draining = true;
            workerLog(`drain started · in-flight ${ev.inFlight}`, "system");
            break;
          case "drain_end":
            run.draining = false;
            workerLog("drain complete", "system");
            break;
          case "shutdown_received":
            workerLog(`shutdown signal: ${ev.signal}`, "system");
            break;
          case "queue_idle":
            run.finalStats = ev.stats || run.finalStats;
            workerLog("queue idle — no pending or in-flight jobs", "system");
            break;
          case "worker_stop":
            run.finished = true;
            run.finalStats = ev.stats || run.finalStats;
            workerLog("worker stopped", "system");
            break;
        }
        refreshBoard();
      }

      function workerLog(line, cls) {
        if (els && els.logTerm) els.logTerm.write(line + "\n", cls);
        else api.log(line, cls);
      }

      // Split incoming stdout into lines; JSON worker events -> board, else log.
      function ingestStdout(raw) {
        stdoutBuf += stripAnsi(raw);
        let nl;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          handleLine(line);
        }
      }
      function handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed[0] === "{") {
          let obj = null;
          try {
            obj = JSON.parse(trimmed);
          } catch {
            obj = null;
          }
          if (obj && typeof obj.kind === "string" && WORKER_KINDS.has(obj.kind)) {
            onWorkerEvent(obj);
            return;
          }
        }
        // Pre-boot banners and the per-job agent's prose land here.
        workerLog(trimmed, "stdout");
      }

      // ── WS handlers (attached once) ─────────────────────────────────────
      api.on("stdout", (m) => ingestStdout(m.text));
      api.on("event", (m) => {
        const ev = m.event;
        events.accrue(ev, traceStats);
        refreshStats();
        const node = events.render(ev);
        if (node && els && els.feedEl) {
          els.feedEl.appendChild(node);
          if (els.feedScroll) els.feedScroll.scrollTop = els.feedScroll.scrollHeight;
        }
      });
      api.on("status", (m) => {
        if (m.state === "running") {
          // Fresh boot — clear the previous run's board.
          resetRun();
          stdoutBuf = "";
          refreshBoard();
          refreshStats();
        } else if (m.state === "exited") {
          run.finished = true;
          // Flush any trailing partial line.
          if (stdoutBuf.trim()) {
            handleLine(stdoutBuf);
            stdoutBuf = "";
          }
          refreshBoard();
        } else if (m.state === "error") {
          api.openLog();
        }
      });

      // ── View switching ──────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      function buildEmpty() {
        els = null;
        CH.clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "package",
            title: "Drop in a compiled batch worker",
            subtitle:
              "This UI runs any bundle compiled from a CrewHaus spec with target: batch — a queue-draining job worker.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Click **Start** — the worker takes no input; it drains its queue and exits",
            ],
          }),
        );
      }

      function buildActive() {
        CH.clear(api.main);

        // ----- LEFT: throughput board (the hero) + jobs list -----
        const statsBar = el("div", { class: "stats" });
        const sDone = bigStat(statsBar, "Jobs done", "0", "check", true);
        const sFailed = bigStat(statsBar, "Failed", "0", "alert");
        const sAvg = bigStat(statsBar, "Avg / job", "—", "clock");
        const sCached = bigStat(statsBar, "Cache hits", "0", "database");
        const sRetries = bigStat(statsBar, "Retries", "0", "refresh");

        const progBar = el("i", { style: { width: "0%" } });
        const progWrap = el("div", { class: "bar" }, progBar);
        const progLabel = el("div", {
          class: "section-label",
          style: { margin: "0 0 7px" },
          text: "QUEUE PROGRESS",
        });
        const progMeta = el("span", { class: "mono muted", style: { fontSize: "11px" } });

        const queueChips = el("div", { class: "chips", style: { marginTop: "12px" } });

        const jobsHead = el("div", { class: "section-label", text: "JOBS" });
        const jobsList = el("div", { class: "col", style: { gap: "8px" } });
        const jobsEmpty = el("div", {
          class: "muted",
          style: { fontSize: "12.5px", fontFamily: "var(--mono)" },
          text: "No jobs yet — press Start to drain the queue.",
        });

        const boardScroll = el("div", { class: "pane-scroll" }, [
          el("div", { class: "col" }, [
            progLabel,
            progWrap,
            el(
              "div",
              { class: "row", style: { justifyContent: "space-between", marginTop: "7px" } },
              [progMeta],
            ),
            el("div", { class: "divider" }),
            statsBar,
            el("div", { class: "divider" }),
            queueChips,
            el("div", { class: "divider" }),
            jobsHead,
            jobsList,
            jobsEmpty,
          ]),
        ]);
        const left = el("div", { class: "pane" }, [
          paneHead("package", "Throughput board", makeWorkerBadge()),
          boardScroll,
        ]);

        // ----- RIGHT: per-job agent activity feed -----
        const tStatsBar = el("div", { class: "stats" });
        const tTurns = miniStat(tStatsBar, "Turns", "0", "play");
        const tTools = miniStat(tStatsBar, "Tool calls", "0", "wrench");
        const tTokens = miniStat(tStatsBar, "Tokens", "0", "cpu");
        const tCost = miniStat(tStatsBar, "Cost", "$0.00", "coins", true);

        const feedScroll = el("div", { class: "pane-scroll" });
        const feedEl = el("div", { class: "feed" });
        const feedHint = el("div", {
          class: "muted",
          style: { fontSize: "12px", fontFamily: "var(--mono)" },
          text: "Per-job agent activity streams here as the queue drains.",
        });
        feedScroll.appendChild(
          el("div", { class: "col" }, [
            tStatsBar,
            el("div", { class: "divider" }),
            feedHint,
            feedEl,
          ]),
        );
        const right = el("div", { class: "pane" }, [paneHead("activity", "Agent activity"), feedScroll]);

        // ----- BOTTOM-RIGHT in a third column would crowd; use cols-2-wide -----
        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));

        // Worker log lives in a compact panel stacked under the feed via the
        // shared Raw-output drawer + a dedicated terminal inside the right pane
        // footer. Keep it simple: route worker lifecycle text to its own term.
        const logScroll = el("div", { class: "pane-scroll flush", style: { maxHeight: "150px", flex: "0 0 auto" } });
        const logTerm = CH.Terminal(logScroll);
        const logPane = el(
          "div",
          { class: "pane", style: { flex: "0 0 auto", borderTop: "1px solid var(--rule)" } },
          [
            paneHead(
              "terminal",
              "Worker log",
              el("button", { class: "btn ghost sm", onClick: () => logTerm.clear() }, "Clear"),
            ),
            logScroll,
          ],
        );
        right.appendChild(logPane);

        els = {
          sDone,
          sFailed,
          sAvg,
          sCached,
          sRetries,
          progBar,
          progMeta,
          queueChips,
          jobsList,
          jobsEmpty,
          feedEl,
          feedScroll,
          logTerm,
          tTurns,
          tTools,
          tTokens,
          tCost,
        };

        refreshBoard();
        refreshStats();
      }

      function makeWorkerBadge() {
        const b = el("span", { class: "badge", text: "idle" });
        b.id = "__wbadge";
        return b;
      }

      // ── Renderers ───────────────────────────────────────────────────────
      function refreshStats() {
        if (!els) return;
        els.tTurns.textContent = traceStats.turns;
        els.tTools.textContent = traceStats.tools;
        els.tTokens.textContent = fmtTokens(traceStats.tokensIn + traceStats.tokensOut);
        els.tCost.textContent = fmtUsd(traceStats.costMicros);
      }

      function refreshBoard() {
        if (!els) return;

        const total = order.length;
        const settled = run.done + run.failed;
        const processing = total - settled;

        els.sDone.textContent = String(run.done);
        els.sFailed.textContent = String(run.failed);
        els.sCached.textContent = String(run.cached);
        els.sRetries.textContent = String(run.retries);
        els.sAvg.textContent = run.durations.length
          ? fmtMs(run.durations.reduce((a, b) => a + b, 0) / run.durations.length)
          : "—";

        // Progress: settled / discovered jobs.
        const pct = total > 0 ? Math.round((settled / total) * 100) : run.finished ? 100 : 0;
        els.progBar.style.width = pct + "%";
        let metaTxt;
        if (!run.booted) metaTxt = "waiting for worker to boot…";
        else if (run.finished)
          metaTxt = `drained · ${run.done} ok · ${run.failed} failed`;
        else if (total === 0) metaTxt = "queue empty / awaiting jobs…";
        else metaTxt = `${settled} / ${total} settled · ${processing} in flight`;
        els.progMeta.textContent = metaTxt;

        // Queue chips.
        CH.clear(els.queueChips);
        if (run.adapter)
          els.queueChips.appendChild(chip("adapter", run.adapter));
        if (run.concurrency != null)
          els.queueChips.appendChild(chip("concurrency", String(run.concurrency)));
        els.queueChips.appendChild(chip("discovered", String(total)));
        if (processing > 0 && !run.finished)
          els.queueChips.appendChild(chip("in flight", String(processing)));
        const fs = run.finalStats;
        if (fs) {
          els.queueChips.appendChild(chip("acked", String(fs.acked)));
          if (fs.deadLetter)
            els.queueChips.appendChild(chip("dead-letter", String(fs.deadLetter)));
        }

        // Worker badge.
        const wb = document.getElementById("__wbadge");
        if (wb) {
          if (run.finished) {
            wb.textContent = "stopped";
            wb.className = "badge";
          } else if (run.draining) {
            wb.textContent = "draining";
            wb.className = "badge warn";
          } else if (run.booted) {
            wb.textContent = "running";
            wb.className = "badge ok";
          } else {
            wb.textContent = "idle";
            wb.className = "badge";
          }
        }

        // Jobs list.
        els.jobsEmpty.style.display = total ? "none" : "block";
        CH.clear(els.jobsList);
        for (const id of order) {
          els.jobsList.appendChild(jobRow(jobs.get(id)));
        }
      }

      // ── Small builders ──────────────────────────────────────────────────
      function jobRow(j) {
        const sev =
          j.status === "done" ? "accent" : j.status === "fail" ? "error" : j.status === "processing" ? "info" : "muted";
        const ic =
          j.status === "done"
            ? j.fromCache
              ? "database"
              : "check"
            : j.status === "fail"
              ? "alert"
              : j.status === "processing"
                ? "spinner"
                : "dot";

        const iconNode =
          ic === "spinner"
            ? el("span", { class: "spinner" })
            : icon(ic, 13);

        const titleRow = el("div", { class: "ev-title" }, [
          el("span", { class: "ev-name", text: j.id }),
          el("span", { text: statusLabel(j) }),
          j.attempt > 1 ? el("span", { class: "badge warn", text: `attempt ${j.attempt}` }) : null,
          j.fromCache ? el("span", { class: "badge", text: "cache" }) : null,
        ]);
        const subBits = [];
        if (j.status === "fail" && j.error) subBits.push(j.error);
        else if (j.status === "fail" && j.reason) subBits.push(j.reason);
        const sub = subBits.length
          ? el("div", { class: "ev-sub", text: subBits.join(" · ") })
          : null;

        const meta = j.durationMs != null ? el("div", { class: "ev-meta", text: fmtMs(j.durationMs) }) : null;

        return el("div", { class: `event ${sev}` }, [
          el("div", { class: "ev-icon" }, iconNode),
          el("div", { class: "ev-main" }, [titleRow, sub]),
          meta,
        ]);
      }

      function statusLabel(j) {
        switch (j.status) {
          case "done":
            return j.fromCache ? "served from cache" : "completed";
          case "fail":
            return j.reason === "permanent" ? "failed (dead-letter)" : "failed (will retry)";
          case "processing":
            return "processing…";
          default:
            return "queued";
        }
      }

      function chip(k, v) {
        return el("div", { class: "chip" }, [
          el("span", { class: "k", text: k }),
          el("span", { class: "v", text: v }),
        ]);
      }

      function bigStat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(
          el("div", { class: "stat" }, [
            el(
              "div",
              { class: "row", style: { gap: "7px", alignItems: "center", marginBottom: "2px" } },
              [
                el("span", { style: { color: "var(--ink-3)", display: "inline-grid" } }, icon(ic, 13)),
                el("div", { class: "k", style: { margin: "0" }, text: label }),
              ],
            ),
            v,
          ]),
        );
        return v;
      }

      function miniStat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(el("div", { class: "stat" }, [v, el("div", { class: "k", text: label })]));
        return v;
      }
    },
  });
})();
