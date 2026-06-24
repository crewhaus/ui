/* CrewHaus — onchain-game shape UI.
   An autonomous perceive -> decide -> act loop played against a game contract.
   The agent reads game state via a view function, proposes a move, signs and
   broadcasts it as a transaction, waits for confirmation, then re-reads state.
   The loop visualization + live game state are the heroes; a moves log and the
   structured TraceEvent feed sit alongside. */
(function () {
  "use strict";
  const { el, icon, md, mdInto, dropzone, stripAnsi, events, fmtMs, fmtUsd, fmtTokens } = window.CH;

  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  // ── stdout markers the loop narrates ──────────────────────────────────────
  // Slice 2 ships the codegen surface; the run loop narrates each phase on
  // stdout. We sniff those lines to drive the stage indicator + moves log even
  // before the end-to-end TraceEvent wiring for game markers lands.
  const PHASE_RE = {
    perceive: /\b(perceiv|read(ing)?\s+state|state\s*reader|eth_call|fetch(ing)?\s+state)\b/i,
    decide: /\b(decid|propos|think|reason|agent\s+turn|choose|select(ing)?\s+move|plan)\b/i,
    act: /\b(broadcast|sign(ing)?|submit(ting)?|sent\s+tx|dispatch|requestSignAndBroadcast)\b/i,
    confirm: /\b(confirm|mined|included|receipt|finaliz)\b/i,
  };
  const MOVE_RE = /\b(move|tx|0x[0-9a-fA-F]{6,})\b/;
  const OVER_RE = /\b(game[\s_-]?over|objective\s+(met|reached|complete)|you\s+win|defeat|checkmate|won|lost)\b/i;

  const STAGES = [
    { key: "perceive", icon: "eye", label: "Perceive", sub: "read game state" },
    { key: "decide", icon: "cpu", label: "Decide", sub: "agent proposes a move" },
    { key: "act", icon: "zap", label: "Act", sub: "sign & broadcast tx" },
  ];

  CH.app({
    controls: ["start", "stop", "restart"],
    build(api) {
      // active-layout refs (null until built)
      let feedScroll = null,
        feedEl = null,
        statEls = null,
        stageEls = null,
        movesEl = null,
        movesScroll = null,
        movesEmpty = null,
        narrateEl = null,
        narrateScroll = null,
        gameMetaEl = null,
        tickBadge = null,
        confirmBadge = null;

      let tick = 0;
      let moveCount = 0;
      let confirmCount = 0;
      let gameOver = false;
      let lastStage = null;
      let movedThisTick = false; // de-dupe stdout-marker vs tool_call move sources
      let confirmedThisTick = false;
      const stats = events.newStats();
      const stG = { moves: 0, confirmed: 0 };

      // ── stats ───────────────────────────────────────────────────────────
      function updateStats() {
        if (!statEls) return;
        statEls.ticks.textContent = String(tick);
        statEls.moves.textContent = String(stG.moves);
        statEls.confirmed.textContent = String(stG.confirmed);
        statEls.tools.textContent = String(stats.tools);
        statEls.cost.textContent = fmtUsd(stats.costMicros);
        statEls.tokens.textContent = fmtTokens(stats.tokensIn + stats.tokensOut);
        if (tickBadge) tickBadge.textContent = `tick ${tick}`;
      }

      // ── loop stage indicator ──────────────────────────────────────────────
      function setStage(key) {
        lastStage = key;
        if (!stageEls) return;
        for (const s of STAGES) {
          const on = s.key === key;
          stageEls[s.key].classList.toggle("on", on);
          stageEls[s.key].classList.toggle("done", !on && key === null ? false : false);
        }
      }
      function pulseFlow() {
        if (!stageEls || !stageEls._flow) return;
        const f = stageEls._flow;
        f.classList.remove("flowing");
        // reflow to restart the animation
        void f.offsetWidth;
        f.classList.add("flowing");
      }

      // ── moves log ─────────────────────────────────────────────────────────
      function logMove(kind, title, sub, meta) {
        if (!movesEl) return;
        if (movesEmpty && movesEmpty.parentNode) movesEmpty.remove();
        const ic = { broadcast: "send", confirmed: "check", over: "shield", state: "eye" }[kind] || "dot";
        const sev = { broadcast: "info", confirmed: "accent", over: "warn", state: "muted" }[kind] || "";
        const row = el("div", { class: `event ${sev}` }, [
          el("div", { class: "ev-icon" }, icon(ic, 13)),
          el("div", { class: "ev-main" }, [
            el("div", { class: "ev-title" }, [
              el("span", { class: "ev-name", text: `#${moveCount}` }),
              el("span", { text: title }),
            ]),
            sub ? el("div", { class: "ev-sub", text: sub }) : null,
          ]),
          meta ? el("div", { class: "ev-meta", text: meta }) : null,
        ]);
        movesEl.appendChild(row);
        if (movesScroll) movesScroll.scrollTop = movesScroll.scrollHeight;
      }

      // ── narration (the loop's prose) ──────────────────────────────────────
      function narrate(text) {
        if (!narrateEl) return;
        const cur = narrateEl.dataset.buf ? narrateEl.dataset.buf + text : text;
        narrateEl.dataset.buf = cur.slice(-8000); // cap memory
        mdInto(narrateEl, narrateEl.dataset.buf);
        if (narrateScroll) narrateScroll.scrollTop = narrateScroll.scrollHeight;
      }

      // ── interpret a line of stdout ────────────────────────────────────────
      function interpretLine(line) {
        const l = line.trim();
        if (!l) return;
        if (OVER_RE.test(l)) {
          gameOver = true;
          moveCount++;
          logMove("over", "Game over", l.slice(0, 120), `tick ${tick}`);
          setStage(null);
          if (confirmBadge) {
            confirmBadge.textContent = "complete";
            confirmBadge.className = "badge ok";
          }
          return;
        }
        if (PHASE_RE.act.test(l)) {
          setStage("act");
          pulseFlow();
          if (MOVE_RE.test(l) && !movedThisTick) {
            movedThisTick = true;
            moveCount++;
            stG.moves++;
            const txm = l.match(/0x[0-9a-fA-F]{6,}/);
            logMove("broadcast", "Move broadcast", l.slice(0, 120), txm ? txm[0].slice(0, 12) + "…" : `tick ${tick}`);
            updateStats();
          }
          return;
        }
        if (PHASE_RE.confirm.test(l)) {
          if (!confirmedThisTick) {
            confirmedThisTick = true;
            confirmCount++;
            stG.confirmed++;
            logMove("confirmed", "Move confirmed", l.slice(0, 120), `tick ${tick}`);
          }
          if (confirmBadge && !gameOver) {
            confirmBadge.textContent = "confirmed";
            confirmBadge.className = "badge ok";
          }
          updateStats();
          return;
        }
        if (PHASE_RE.perceive.test(l)) {
          setStage("perceive");
          logMove("state", "Perceived state", l.slice(0, 120), `tick ${tick}`);
          return;
        }
        if (PHASE_RE.decide.test(l)) {
          setStage("decide");
          pulseFlow();
        }
      }

      // ── TraceEvent ingestion ──────────────────────────────────────────────
      function pushEvent(ev) {
        events.accrue(ev, stats);

        if (ev.kind === "turn_start") {
          tick++;
          gameOver = false;
          movedThisTick = false;
          confirmedThisTick = false;
          setStage("perceive");
          if (confirmBadge) {
            confirmBadge.textContent = "in flight";
            confirmBadge.className = "badge";
          }
        } else if (ev.kind === "model_response") {
          // the agent decided; a move proposal follows
          setStage("decide");
          pulseFlow();
        } else if (ev.kind === "tool_call_start") {
          // a contract write is the "act" phase
          setStage("act");
          pulseFlow();
        } else if (ev.kind === "tool_call_end") {
          if (
            !ev.isError &&
            !movedThisTick &&
            /broadcast|send|write|submit|sign|move|action|tx/i.test(ev.toolName || "")
          ) {
            movedThisTick = true;
            moveCount++;
            stG.moves++;
            logMove("broadcast", `${ev.toolName} broadcast`, `output ${ev.outputBytes ?? 0} B`, fmtMs(ev.durationMs));
          }
        } else if (ev.kind === "turn_end") {
          setStage(null);
          if (gameMetaEl) updateGameMeta();
        } else if (ev.kind === "model_request") {
          if (gameMetaEl) updateGameMetaFromModel(ev);
        }

        updateStats();
        const node = events.render(ev);
        if (node && feedEl) {
          feedEl.appendChild(node);
          if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
        }
      }

      // ── game meta (filled from observed events) ───────────────────────────
      const meta = { model: null, runId: null, session: null };
      function updateGameMetaFromModel(ev) {
        if (ev.model && !meta.model) {
          meta.model = ev.model;
          updateGameMeta();
        }
      }
      function updateGameMeta() {
        if (!gameMetaEl) return;
        CH.clear(gameMetaEl);
        const rows = [
          ["Loop", api.isRunning() ? (gameOver ? "objective met" : "playing") : "stopped"],
          ["Tick", String(tick)],
          ["Stage", lastStage ? lastStage : "idle"],
          ["Moves broadcast", String(stG.moves)],
          ["Moves confirmed", String(stG.confirmed)],
          meta.model ? ["Agent model", meta.model] : null,
        ].filter(Boolean);
        for (const [k, v] of rows) {
          gameMetaEl.appendChild(
            el("div", { class: "chip" }, [
              el("span", { class: "k", text: k }),
              el("span", { class: "v", text: v }),
            ]),
          );
        }
      }

      // ── WS handlers (attached once) ───────────────────────────────────────
      api.on("stdout", (m) => {
        const txt = stripAnsi(m.text);
        if (!txt) return;
        // pre-run banners (before first tick) go to the raw log; loop prose to
        // the narration panel + line interpreter.
        if (tick === 0 && !api.isRunning()) {
          api.log(txt, "stdout");
          return;
        }
        narrate(txt);
        for (const line of txt.split("\n")) interpretLine(line);
      });
      api.on("event", (m) => pushEvent(m.event));
      api.on("status", (m) => {
        if (m.state === "running") {
          if (narrateEl && !narrateEl.dataset.buf) narrate("*Loop booted. Waiting for the first perceive → decide → act tick…*\n");
        } else if (m.state === "exited") {
          setStage(null);
          if (confirmBadge && !gameOver) {
            confirmBadge.textContent = "stopped";
            confirmBadge.className = "badge";
          }
          narrate("\n\n*Loop process exited. Press **Restart** to play again.*\n");
          updateGameMeta();
        } else if (m.state === "error") {
          narrate("\n\n*The loop could not start — check the raw output log.*\n");
          api.openLog();
        }
      });

      // ── view switching ────────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive(s) : buildEmpty();
      });

      function buildEmpty() {
        feedScroll = feedEl = statEls = stageEls = movesEl = movesScroll = null;
        narrateEl = narrateScroll = gameMetaEl = tickBadge = confirmBadge = movesEmpty = null;
        CH.clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "gamepad",
            title: "Drop in a compiled on-chain game",
            subtitle:
              "This UI plays any bundle compiled from a CrewHaus spec with target: onchain-game — an autonomous perceive → decide → act loop against a game contract.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Set the chain `RPC URL` + wallet key env vars the spec references",
              "Click **Start** — deps install on first run, then the loop plays itself",
            ],
          }),
        );
      }

      function buildActive(s) {
        CH.clear(api.main);

        // ============ LEFT: the game (heroes) ============
        const left = el("div", { class: "pane" }, [paneHead("gamepad", "Game loop")]);
        const leftScroll = el("div", { class: "pane-scroll" });
        left.appendChild(leftScroll);

        // -- loop visualization --
        stageEls = {};
        const stageNodes = STAGES.map((st) => {
          const node = el("div", { class: "loop-stage", dataset: { k: st.key } }, [
            el("div", { class: "loop-ic" }, icon(st.icon, 18)),
            el("div", { class: "loop-txt" }, [
              el("div", { class: "loop-label", text: st.label }),
              el("div", { class: "loop-sub", text: st.sub }),
            ]),
          ]);
          stageEls[st.key] = node;
          return node;
        });
        const flow = el("div", { class: "loop-flow" }, [
          el("i"),
          el("i"),
          el("i"),
        ]);
        stageEls._flow = flow;
        const loopRow = el("div", { class: "loop-row" }, [
          stageNodes[0],
          el("div", { class: "loop-arrow" }, icon("arrowRight", 16)),
          stageNodes[1],
          el("div", { class: "loop-arrow" }, icon("arrowRight", 16)),
          stageNodes[2],
        ]);
        tickBadge = el("span", { class: "badge", text: "tick 0" });
        confirmBadge = el("span", { class: "badge", text: "idle" });
        const loopWrap = el("div", { class: "loop-wrap" }, [
          el("div", { class: "loop-head" }, [
            el("span", { class: "section-label", text: "Perceive · Decide · Act" }),
            el("span", { class: "grow" }),
            tickBadge,
            confirmBadge,
          ]),
          loopRow,
          flow,
          el("div", {
            class: "loop-note muted",
            text: "Each tick: read state from the view function → agent proposes a move → sign & broadcast a transaction → confirm.",
          }),
        ]);

        // -- game state / meta --
        gameMetaEl = el("div", { class: "chips" });
        const gamePanel = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("activity", 14)),
            el("span", { class: "label", text: "Game state" }),
          ]),
          el("div", { class: "card-body" }, [gameMetaEl]),
        ]);

        // -- contract / chain harness facts --
        const harnessCard = buildHarnessCard(s);

        // -- narration (the loop's reasoning prose) --
        narrateScroll = el("div", { class: "pane-scroll", style: { maxHeight: "240px", padding: "0", border: "1px solid var(--rule)", borderRadius: "var(--radius-sm)", background: "var(--panel)" } });
        narrateEl = el("div", { class: "md", style: { padding: "12px 14px" } });
        narrateScroll.appendChild(narrateEl);
        const narratePanel = el("div", null, [
          el("div", { class: "section-label", text: "Loop narration" }),
          narrateScroll,
        ]);

        leftScroll.appendChild(
          el("div", { class: "col", style: { gap: "16px" } }, [
            loopWrap,
            gamePanel,
            harnessCard,
            narratePanel,
          ]),
        );

        // ============ RIGHT: telemetry ============
        const statsBar = el("div", { class: "stats" });
        statEls = {
          ticks: stat(statsBar, "Ticks", "0", "refresh"),
          moves: stat(statsBar, "Moves", "0", "send", true),
          confirmed: stat(statsBar, "Confirmed", "0", "check", true),
          tools: stat(statsBar, "Tool calls", "0", "wrench"),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          cost: stat(statsBar, "Cost", "$0.00", "coins", true),
        };

        // moves log
        movesScroll = el("div", { style: { maxHeight: "220px", overflow: "auto" } });
        movesEl = el("div", { class: "feed" });
        movesEmpty = el("div", { class: "muted", style: { fontSize: "12px", padding: "4px 2px" }, text: "No moves yet — broadcasts appear here as the loop plays." });
        movesEl.appendChild(movesEmpty);
        movesScroll.appendChild(movesEl);

        feedScroll = el("div", { class: "pane-scroll" });
        feedEl = el("div", { class: "feed" });
        feedScroll.appendChild(
          el("div", { class: "col" }, [
            statsBar,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Moves" }),
            movesScroll,
            el("div", { class: "divider" }),
            el("div", { class: "section-label", text: "Activity" }),
            feedEl,
          ]),
        );
        const right = el("div", { class: "pane" }, [paneHead("activity", "Telemetry"), feedScroll]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));

        injectStyles();
        setStage(null);
        updateStats();
        updateGameMeta();
        if (!api.isRunning())
          narrate("*Press **Start** to boot the loop. It plays itself — perceive, decide, act — until the objective is met.*\n");
      }

      function buildHarnessCard(s) {
        const files = (s.harness && s.harness.files) || [];
        const entry = s.harness && s.harness.entry;
        const list = el("div", { class: "filelist" });
        const shown = files.filter((f) => !/DROP_|README/i.test(f));
        if (!shown.length) shown.push("agent.ts");
        for (const f of shown) {
          list.appendChild(
            el("div", { class: `f ${f === entry ? "entry" : ""}` }, [
              icon(f === entry ? "play" : "file", 13),
              el("span", { text: f }),
            ]),
          );
        }
        return el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("link", 14)),
            el("span", { class: "label", text: "Bundle" }),
            el("span", { class: "grow" }),
            el("span", {
              class: `badge ${s.harness && s.harness.depsInstalled ? "ok" : "warn"}`,
              text: s.harness && s.harness.depsInstalled ? "deps ready" : "deps pending",
            }),
          ]),
          el("div", { class: "card-body" }, [
            list,
            el("div", {
              class: "muted",
              style: { fontSize: "11.5px", marginTop: "10px" },
              text: "agent.ts binds the chain adapter, the player wallet, and the game contract, then runs the move loop. Chain, wallet, and transaction policy are baked into the bundle.",
            }),
          ]),
        ]);
      }

      function stat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(
          el("div", { class: "stat" }, [
            el("div", { class: "row", style: { gap: "6px", alignItems: "center" } }, [
              el("span", { class: "stat-ic" }, icon(ic, 12)),
              el("div", { class: "k", text: label }),
            ]),
            v,
          ]),
        );
        return v;
      }

      // ── shape-specific styles (loop viz) ──────────────────────────────────
      let stylesInjected = false;
      function injectStyles() {
        if (stylesInjected) return;
        stylesInjected = true;
        const css = `
.loop-wrap{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--rule);border-radius:var(--radius-lg);padding:16px 18px;}
.loop-head{display:flex;align-items:center;gap:8px;margin-bottom:14px;}
.loop-head .section-label{margin:0;}
.loop-row{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:stretch;gap:8px;}
.loop-arrow{display:grid;place-items:center;color:var(--ink-4);}
.loop-stage{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:14px 10px;border:1px solid var(--rule);border-radius:var(--radius);background:var(--panel);transition:border-color .2s,background .2s,box-shadow .2s,transform .2s;}
.loop-stage .loop-ic{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:var(--panel-3);color:var(--ink-3);border:1px solid var(--rule-2);transition:all .2s;}
.loop-stage .loop-label{font-weight:600;font-size:13px;color:var(--ink-2);}
.loop-stage .loop-sub{font-size:10.5px;color:var(--ink-3);font-family:var(--mono);}
.loop-stage.on{border-color:var(--accent);background:var(--accent-ghost);box-shadow:0 0 0 1px var(--accent-glow),0 8px 24px rgba(0,0,0,.3);transform:translateY(-2px);}
.loop-stage.on .loop-ic{background:var(--accent);color:#1a0d05;border-color:transparent;box-shadow:0 0 18px var(--accent-glow);}
.loop-stage.on .loop-label{color:var(--ink);}
.loop-flow{height:3px;border-radius:100px;background:var(--panel-3);margin:14px 2px 0;overflow:hidden;position:relative;display:flex;}
.loop-flow i{flex:1;}
.loop-flow.flowing::after{content:"";position:absolute;top:0;left:-30%;width:30%;height:100%;border-radius:100px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:loopflow 1.1s ease-in-out;}
@keyframes loopflow{to{left:100%;}}
.loop-note{font-size:11.5px;margin-top:12px;line-height:1.5;}
.stat-ic{color:var(--ink-3);display:inline-grid;place-items:center;}
.stat-ic svg{width:12px;height:12px;}
@media (max-width:640px){.loop-row{grid-template-columns:1fr;}.loop-arrow{transform:rotate(90deg);}}
`;
        document.head.appendChild(el("style", { text: css }));
      }
    },
  });
})();
