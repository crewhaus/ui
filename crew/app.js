/* CrewHaus — crew shape UI.
   A multi-role crew runs one task end to end: control is handed from role to
   role until the work is done. This UI makes the handoff flow the hero — a live
   ROLES roster (active role highlighted), a HANDOFF TIMELINE built from
   role_start / role_end / handoff / crew_done TraceEvents, the final result, and
   the full structured activity feed alongside.

   Run class: stdio-oneshot. The host spawns `bun daemon.ts`, writes the task to
   stdin, closes it (EOF), and the crew streams events + prose to stdout, then
   exits. There is no back-and-forth chat — one task, one run. */
(function () {
  "use strict";
  const { el, icon, md, mdInto, dropzone, stripAnsi, events, fmtMs, fmtBytes } = window.CH;

  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  CH.app({
    controls: ["stop", "restart"],
    build(api) {
      // ── Run-scoped state ────────────────────────────────────────────────
      let stats = events.newStats();
      let runActive = false; // a task is in flight
      let started = false; // at least one run has been launched this session

      // crew-specific model
      const roles = new Map(); // name -> { name, activations, lastDurationMs, lastBytes, status }
      let activeRole = null;
      let entryRole = null;
      let handoffCount = 0;
      let finalOutput = "";
      let finalRole = null;
      let proseBuf = ""; // raw assistant prose accreted from stdout during a run

      // ── DOM handles (rebuilt by buildActive) ────────────────────────────
      let rolesEl = null;
      let timelineEl = null;
      let timelineScroll = null;
      let resultEl = null;
      let resultStateEl = null;
      let feedEl = null;
      let feedScroll = null;
      let statEls = null;
      let runInput = null;
      let runBtn = null;
      let crewBanner = null;

      // ── Stats ───────────────────────────────────────────────────────────
      function updateStats() {
        if (!statEls) return;
        statEls.roles.textContent = String(roles.size);
        statEls.handoffs.textContent = String(handoffCount);
        statEls.tools.textContent = String(stats.tools);
        statEls.tokens.textContent = CH.fmtTokens(stats.tokensIn + stats.tokensOut);
        statEls.cost.textContent = CH.fmtUsd(stats.costMicros);
      }

      // ── Roles roster ────────────────────────────────────────────────────
      function ensureRole(name) {
        let r = roles.get(name);
        if (!r) {
          r = { name, activations: 0, lastDurationMs: null, lastBytes: null, status: "idle" };
          roles.set(name, r);
        }
        return r;
      }

      function renderRoles() {
        if (!rolesEl) return;
        CH.clear(rolesEl);
        if (roles.size === 0) {
          rolesEl.appendChild(
            el("div", { class: "muted", style: { fontSize: "12px", padding: "4px 2px" } },
              "Roles appear here as the crew activates them."),
          );
          return;
        }
        for (const r of roles.values()) {
          const isActive = r.status === "active";
          const tags = [];
          if (r.name === entryRole) tags.push(el("span", { class: "badge", text: "entry" }));
          if (r.name === finalRole) tags.push(el("span", { class: "badge ok", text: "final" }));

          const meta = el("div", { class: "role-meta" }, [
            el("span", null, [
              icon("activity", 11),
              el("span", { text: `${r.activations}×` }),
            ]),
            r.lastDurationMs != null
              ? el("span", null, [icon("clock", 11), el("span", { text: fmtMs(r.lastDurationMs) })])
              : null,
            r.lastBytes != null
              ? el("span", null, [icon("file", 11), el("span", { text: fmtBytes(r.lastBytes) })])
              : null,
          ]);

          rolesEl.appendChild(
            el("div", { class: `role-card ${isActive ? "active" : ""} ${r.status}` }, [
              el("div", { class: "role-dot" }, isActive ? el("span", { class: "spinner" }) : icon(r.status === "done" ? "check" : "user", 14)),
              el("div", { class: "role-body" }, [
                el("div", { class: "role-name" }, [
                  el("span", { text: r.name }),
                  ...tags,
                ]),
                meta,
              ]),
            ]),
          );
        }
      }

      // ── Handoff timeline (the hero) ─────────────────────────────────────
      function tlNode(opts) {
        return el("div", { class: `tl-item ${opts.kind || ""}` }, [
          el("div", { class: "tl-rail" }, [
            el("div", { class: `tl-node ${opts.sev || ""}` }, icon(opts.icon || "dot", 13)),
          ]),
          el("div", { class: "tl-body" }, [
            el("div", { class: "tl-title" }, opts.title),
            opts.sub ? el("div", { class: "tl-sub", text: opts.sub }) : null,
            opts.meta ? el("div", { class: "tl-meta", text: opts.meta }) : null,
          ]),
        ]);
      }
      function pushTimeline(node) {
        if (!timelineEl) return;
        timelineEl.appendChild(node);
        if (timelineScroll) timelineScroll.scrollTop = timelineScroll.scrollHeight;
      }
      function clearTimelinePlaceholder() {
        const ph = timelineEl && timelineEl.querySelector(".tl-empty");
        if (ph) ph.remove();
      }

      function roleChip(name, cls) {
        return el("span", { class: `tl-role ${cls || ""}`, text: name });
      }

      // ── Result panel ────────────────────────────────────────────────────
      function setResultState(text, kind) {
        if (!resultStateEl) return;
        CH.clear(resultStateEl);
        if (!text) return;
        resultStateEl.appendChild(
          el("span", { class: `result-state ${kind || ""}` }, [
            kind === "running" ? el("span", { class: "spinner" }) : icon(kind === "done" ? "check" : "dot", 12),
            el("span", { text }),
          ]),
        );
      }
      function renderResult() {
        if (!resultEl) return;
        const body = finalOutput || proseBuf.trim();
        if (!body) {
          CH.clear(resultEl);
          resultEl.appendChild(
            el("div", { class: "result-empty muted" }, [
              icon("sparkles", 22),
              el("div", { text: runActive ? "The crew is working…" : "The final answer will appear here." }),
            ]),
          );
          return;
        }
        resultEl.classList.add("md");
        mdInto(resultEl, body);
      }

      // ── Event ingestion ─────────────────────────────────────────────────
      function handleCrewEvent(ev) {
        switch (ev.kind) {
          case "role_start": {
            const r = ensureRole(ev.role);
            r.activations += 1;
            r.status = "active";
            if (activeRole && activeRole !== ev.role) {
              const prev = roles.get(activeRole);
              if (prev && prev.status === "active") prev.status = "done";
            }
            activeRole = ev.role;
            if (entryRole === null && ev.activation === 0) entryRole = ev.role;
            clearTimelinePlaceholder();
            pushTimeline(
              tlNode({
                icon: "user",
                sev: "info",
                title: el("span", null, [roleChip(ev.role, "live"), el("span", { class: "muted", text: " is now working" })]),
                meta: `activation #${ev.activation}`,
              }),
            );
            renderRoles();
            setResultState(`${ev.role} is working…`, "running");
            break;
          }
          case "role_end": {
            const r = ensureRole(ev.role);
            r.status = "done";
            r.lastDurationMs = ev.durationMs;
            r.lastBytes = ev.finalMessageBytes;
            pushTimeline(
              tlNode({
                icon: "check",
                sev: "muted",
                title: el("span", null, [roleChip(ev.role), el("span", { class: "muted", text: " finished its turn" })]),
                sub: `${fmtBytes(ev.finalMessageBytes)} produced`,
                meta: fmtMs(ev.durationMs),
              }),
            );
            renderRoles();
            break;
          }
          case "handoff": {
            handoffCount += 1;
            ensureRole(ev.from);
            ensureRole(ev.to);
            clearTimelinePlaceholder();
            pushTimeline(
              tlNode({
                kind: "handoff",
                icon: "arrowRight",
                sev: "accent",
                title: el("span", { class: "tl-handoff" }, [
                  roleChip(ev.from),
                  icon("arrowRight", 14),
                  roleChip(ev.to, "to"),
                ]),
                sub: ev.reason || "control handed off",
                meta: `handoff #${handoffCount} · depth ${ev.depth}`,
              }),
            );
            renderRoles();
            break;
          }
          case "crew_done": {
            finalRole = ev.finalRole;
            if (typeof ev.finalOutput === "string" && ev.finalOutput.length > 0) {
              finalOutput = ev.finalOutput;
            }
            const r = roles.get(ev.finalRole);
            if (r) r.status = "done";
            activeRole = null;
            pushTimeline(
              tlNode({
                kind: "done",
                icon: "check",
                sev: "accent",
                title: el("span", null, [
                  el("strong", { text: "Crew complete" }),
                ]),
                sub: `final role: ${ev.finalRole} · ${ev.totalActivations} activation${ev.totalActivations === 1 ? "" : "s"}`,
                meta: fmtMs(ev.durationMs),
              }),
            );
            renderRoles();
            renderResult();
            setResultState(`Complete — ${ev.totalActivations} activation${ev.totalActivations === 1 ? "" : "s"} · ${fmtMs(ev.durationMs)}`, "done");
            break;
          }
        }
      }

      function pushFeed(ev) {
        events.accrue(ev, stats);
        updateStats();
        handleCrewEvent(ev);
        const node = events.render(ev);
        if (node && feedEl) {
          feedEl.appendChild(node);
          if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
        }
      }

      // ── Run lifecycle ───────────────────────────────────────────────────
      function resetRun() {
        stats = events.newStats();
        roles.clear();
        activeRole = null;
        entryRole = null;
        finalRole = null;
        handoffCount = 0;
        finalOutput = "";
        proseBuf = "";
        if (feedEl) CH.clear(feedEl);
        if (timelineEl) {
          CH.clear(timelineEl);
          timelineEl.appendChild(
            el("div", { class: "tl-empty muted" }, "Waiting for the crew to start…"),
          );
        }
        if (crewBanner) CH.clear(crewBanner);
        renderRoles();
        renderResult();
        updateStats();
      }

      function launch() {
        if (!runInput) return;
        const task = runInput.value.trim();
        if (!task) {
          api.toast("Type a task for the crew first", "err");
          runInput.focus();
          return;
        }
        if (!api.isPresent()) {
          api.toast("Drop a compiled crew bundle into harness/ first", "err");
          return;
        }
        resetRun();
        started = true;
        runActive = true;
        setResultState("Dispatching task to the crew…", "running");
        if (crewBanner) {
          CH.clear(crewBanner);
          crewBanner.appendChild(
            el("div", { class: "task-echo" }, [
              el("span", { class: "icon" }, icon("send", 13)),
              el("span", { class: "txt", text: task }),
            ]),
          );
        }
        setRunEnabled(false);
        api.submit(task);
      }

      function setRunEnabled(enabled) {
        if (runBtn) {
          runBtn.disabled = !enabled;
          const lbl = runBtn.querySelector(".lbl");
          if (lbl) lbl.textContent = enabled ? "Run crew" : "Running…";
        }
        if (runInput) runInput.disabled = !enabled;
      }

      // ── WS handlers (attached once) ─────────────────────────────────────
      api.on("event", (m) => pushFeed(m.event));
      api.on("stdout", (m) => {
        const txt = stripAnsi(m.text);
        if (!txt) return;
        if (runActive) {
          proseBuf += txt;
          // Only surface prose in the result if no structured final output yet.
          if (!finalOutput) renderResult();
        } else {
          api.log(txt, "stdout");
        }
      });
      api.on("status", (m) => {
        if (m.state === "running") {
          runActive = true;
          setRunEnabled(false);
          setResultState("The crew is working…", "running");
        } else if (m.state === "starting" || m.state === "installing") {
          setRunEnabled(false);
        } else if (m.state === "exited") {
          runActive = false;
          setRunEnabled(api.isPresent());
          // If the crew finished cleanly, crew_done already set the result/state.
          if (!finalOutput && !proseBuf.trim()) {
            setResultState("Run exited with no output — check the raw output log.", "");
          } else if (!finalOutput) {
            // prose-only completion
            setResultState("Run complete.", "done");
            renderResult();
          }
        } else if (m.state === "error") {
          runActive = false;
          setRunEnabled(api.isPresent());
          setResultState("The crew could not start — check the raw output log.", "");
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
        rolesEl = timelineEl = timelineScroll = resultEl = resultStateEl = null;
        feedEl = feedScroll = statEls = runInput = runBtn = crewBanner = null;
        CH.clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "layers",
            title: "Drop in a compiled crew",
            subtitle:
              "This UI runs any bundle compiled from a CrewHaus spec with target: crew — a multi-role crew that hands off one task between roles.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy `daemon.ts`, `orchestrator.ts` and every `agent_<role>.ts` into this UI's `harness/` folder",
              "Type a task and press **Run** — dependencies install automatically on first run",
            ],
          }),
        );
      }

      function buildActive() {
        CH.clear(api.main);

        // ── Left / main column ───────────────────────────────────────────
        // Run bar
        runInput = el("textarea", {
          class: "field",
          rows: 1,
          placeholder: "Describe the task for the crew to complete…",
        });
        runInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            launch();
          }
        });
        runBtn = el("button", { class: "btn primary", onClick: launch }, [
          icon("play", 15),
          el("span", { class: "lbl", text: "Run crew" }),
        ]);
        const runBar = el("div", { class: "run-bar" }, [
          el("div", { class: "run-row" }, [runInput, runBtn]),
          el("div", { class: "composer-hint" }, [
            el("span", null, [CH.kbd("Cmd"), "+", CH.kbd("Enter"), " run"]),
            el("span", { class: "muted", text: "one task per run — the crew streams to EOF, then exits" }),
          ]),
        ]);
        crewBanner = el("div", { class: "crew-banner" });

        // Roles roster strip
        rolesEl = el("div", { class: "roles" });

        // Handoff timeline (hero)
        timelineEl = el("div", { class: "timeline" });
        timelineScroll = el("div", { class: "tl-scroll" }, timelineEl);

        // Result
        resultStateEl = el("div", { class: "grow result-statewrap" });
        resultEl = el("div", { class: "result" });

        const mainScroll = el("div", { class: "pane-scroll" }, [
          el("div", { class: "stack" }, [
            el("div", { class: "section-label", text: "Crew roster" }),
            rolesEl,
            el("div", { class: "subpane" }, [
              el("div", { class: "subpane-head" }, [
                el("span", { class: "icon" }, icon("workflow", 13)),
                el("span", { text: "Handoff timeline" }),
              ]),
              timelineScroll,
            ]),
            el("div", { class: "subpane" }, [
              el("div", { class: "subpane-head" }, [
                el("span", { class: "icon" }, icon("sparkles", 13)),
                el("span", { text: "Result" }),
                resultStateEl,
              ]),
              el("div", { class: "result-wrap" }, resultEl),
            ]),
          ]),
        ]);

        const left = el("div", { class: "pane" }, [
          paneHead("layers", "Crew run"),
          crewBanner,
          runBar,
          mainScroll,
        ]);

        // ── Right / activity column ──────────────────────────────────────
        const statsBar = el("div", { class: "stats" });
        statEls = {
          roles: stat(statsBar, "Roles", "0", "user"),
          handoffs: stat(statsBar, "Handoffs", "0", "arrowRight", true),
          tools: stat(statsBar, "Tool calls", "0", "wrench"),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          cost: stat(statsBar, "Cost", "$0.00", "coins"),
        };
        feedScroll = el("div", { class: "pane-scroll" });
        feedEl = el("div", { class: "feed" });
        feedScroll.appendChild(
          el("div", { class: "col" }, [statsBar, el("div", { class: "divider" }), feedEl]),
        );
        const right = el("div", { class: "pane" }, [paneHead("activity", "Activity"), feedScroll]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));

        // initial paint
        renderRoles();
        renderResult();
        updateStats();
        timelineEl.appendChild(
          el("div", { class: "tl-empty muted" }, "Type a task above and press Run to watch the crew hand off work."),
        );
        setRunEnabled(api.isPresent() && !api.isRunning());
        if (api.isRunning()) {
          runActive = true;
          setResultState("A run is already in progress…", "running");
        }
        injectStyles();
      }

      function stat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(
          el("div", { class: "stat" }, [
            v,
            el("div", { class: "k" }, [icon(ic, 11), el("span", { text: label })]),
          ]),
        );
        return v;
      }

      // ── Shape-local styles (compose on top of ui.css) ───────────────────
      let stylesInjected = false;
      function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;
        const css = `
.stack { display: flex; flex-direction: column; gap: 16px; }
.run-bar { flex: 0 0 auto; border-bottom: 1px solid var(--rule); background: var(--panel); padding: 12px 16px; }
.run-row { display: flex; gap: 10px; align-items: flex-end; }
.run-row .field { min-height: 42px; max-height: 160px; }
.crew-banner:empty { display: none; }
.task-echo { display: flex; gap: 9px; align-items: flex-start; padding: 10px 16px; border-bottom: 1px solid var(--rule);
  background: var(--accent-ghost); font-size: 13px; }
.task-echo .icon { color: var(--accent); flex: 0 0 auto; margin-top: 2px; }
.task-echo .txt { color: var(--ink); overflow-wrap: anywhere; }

.roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 9px; }
.role-card { display: grid; grid-template-columns: 30px 1fr; gap: 10px; align-items: center;
  padding: 10px 12px; border: 1px solid var(--rule); border-left: 2px solid var(--rule-2);
  border-radius: var(--radius-sm); background: var(--panel); transition: border-color .15s, background .15s; }
.role-card.active { border-left-color: var(--accent); background: var(--accent-ghost); box-shadow: 0 0 0 1px var(--accent-glow) inset; }
.role-card.done { border-left-color: var(--blue); }
.role-dot { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center;
  background: var(--panel-3); color: var(--ink-2); border: 1px solid var(--rule-2); }
.role-card.active .role-dot { background: var(--accent-ghost); color: var(--accent); border-color: var(--accent-glow); }
.role-card.done .role-dot { color: var(--blue); }
.role-dot svg { width: 14px; height: 14px; }
.role-body { min-width: 0; }
.role-name { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.role-meta { display: flex; gap: 12px; margin-top: 3px; font-family: var(--mono); font-size: 11px; color: var(--ink-3); }
.role-meta > span { display: inline-flex; align-items: center; gap: 4px; }
.role-meta svg { width: 11px; height: 11px; opacity: .7; }

.subpane { border: 1px solid var(--rule); border-radius: var(--radius); background: var(--panel-2); overflow: hidden; }
.subpane-head { display: flex; align-items: center; gap: 9px; padding: 9px 14px; border-bottom: 1px solid var(--rule);
  font-family: var(--mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); background: var(--panel); }
.subpane-head .icon { color: var(--accent); display: inline-grid; place-items: center; }
.subpane-head .icon svg { width: 13px; height: 13px; }

.tl-scroll { max-height: 340px; overflow: auto; padding: 14px 16px; }
.timeline { display: flex; flex-direction: column; }
.tl-empty { font-size: 12.5px; padding: 6px 2px; }
.tl-item { display: grid; grid-template-columns: 26px 1fr; gap: 12px; padding-bottom: 14px; position: relative; animation: rise .18s ease both; }
.tl-rail { display: flex; justify-content: center; position: relative; }
.tl-rail::before { content: ""; position: absolute; top: 24px; bottom: -14px; width: 2px; background: var(--rule); }
.tl-item:last-child .tl-rail::before { display: none; }
.tl-node { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; z-index: 1;
  background: var(--panel-3); color: var(--ink-2); border: 1px solid var(--rule-2); }
.tl-node svg { width: 13px; height: 13px; }
.tl-node.accent { background: var(--accent-ghost); color: var(--accent); border-color: var(--accent-glow); }
.tl-node.info { background: var(--blue-ghost); color: var(--blue); border-color: rgba(100,181,255,.3); }
.tl-body { min-width: 0; padding-top: 1px; }
.tl-title { font-size: 13px; color: var(--ink); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tl-title svg { width: 14px; height: 14px; color: var(--accent); }
.tl-handoff { display: inline-flex; align-items: center; gap: 7px; }
.tl-role { font-family: var(--mono); font-size: 12px; color: var(--ink); background: var(--panel-3);
  border: 1px solid var(--rule-2); border-radius: 100px; padding: 1px 9px; }
.tl-role.to { color: var(--accent); background: var(--accent-ghost); border-color: var(--accent-glow); }
.tl-role.live { color: var(--accent); background: var(--accent-ghost); border-color: var(--accent-glow); }
.tl-sub { font-size: 12px; color: var(--ink-2); margin-top: 3px; overflow-wrap: anywhere; }
.tl-meta { font-family: var(--mono); font-size: 10.5px; color: var(--ink-3); margin-top: 3px; }
.tl-item.handoff .tl-node { box-shadow: 0 0 0 4px var(--accent-glow); }
.tl-item.done .tl-title strong { color: var(--accent); }

.result-statewrap { display: flex; justify-content: flex-end; }
.result-state { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px;
  text-transform: none; letter-spacing: 0; color: var(--ink-3); }
.result-state svg { width: 12px; height: 12px; }
.result-state.running { color: var(--accent); }
.result-state.done { color: var(--accent); }
.result-wrap { padding: 16px; max-height: 460px; overflow: auto; }
.result { color: var(--ink); overflow-wrap: anywhere; }
.result-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
  padding: 28px 16px; font-size: 13px; }
.result-empty svg { color: var(--ink-4); width: 22px; height: 22px; }

.stat .k { display: flex; align-items: center; gap: 5px; }
.stat .k svg { width: 11px; height: 11px; opacity: .6; }
`;
        document.head.appendChild(el("style", { text: css }));
      }
    },
  });
})();
