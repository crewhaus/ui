/* CrewHaus — CLI shape UI.
   An interactive terminal agent rendered as a chat, with a live activity feed
   of structured TraceEvents (tools, sub-agents, permissions, cost) alongside. */
(function () {
  "use strict";
  const { el, icon, Chat, Composer, dropzone, stripAnsi, events } = window.CH;

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
      let chat = null;
      let composer = null;
      let feedScroll = null;
      let feedEl = null;
      let statEls = null;
      let turnActive = false;
      let turnStdout = ""; // raw stdout of the active turn (for permission-prompt detection)
      let promptsHandled = 0;
      const autoApprove = new Set(); // tools the user chose "always allow" for
      const stats = events.newStats();

      function resetTurn() {
        turnStdout = "";
        promptsHandled = 0;
      }

      // The compiled agent prints `approve <tool> <input> [y/N] >` and blocks on
      // stdin. Surface clickable buttons instead of making the user type.
      function maybePrompt() {
        if (!chat) return;
        const all = [...turnStdout.matchAll(/approve\s+(\S+)[\s\S]*?\[y\s*\/\s*N\]/gi)];
        if (all.length <= promptsHandled) return;
        promptsHandled = all.length;
        const tool = all[all.length - 1][1];
        if (autoApprove.has(tool)) {
          api.sendInput("y", { silent: true });
          chat.systemNote(`Auto-approved ${tool} (always allow)`);
          return;
        }
        chat.node(permissionCard(tool));
      }

      function permissionCard(tool) {
        const note = el("div", { class: "perm-note muted" });
        let done = false;
        const answer = (input, label, always) => {
          if (done) return;
          done = true;
          if (always) autoApprove.add(tool);
          api.sendInput(input, { silent: true });
          for (const b of actions.children) b.disabled = true;
          note.textContent = label;
        };
        const actions = el("div", { class: "perm-actions" }, [
          el("button", { class: "btn primary sm", onClick: () => answer("y", "✓ Approved") }, [
            icon("check", 14),
            el("span", { text: "Yes" }),
          ]),
          el("button", { class: "btn ghost sm", onClick: () => answer("n", "✗ Denied") }, [
            icon("x", 14),
            el("span", { text: "No" }),
          ]),
          el(
            "button",
            {
              class: "btn ghost sm",
              title: `Approve every ${tool} call for the rest of this session`,
              onClick: () => answer("y", `✓ Always allowing ${tool}`, true),
            },
            [icon("shield", 14), el("span", { text: `Always allow ${tool}` })],
          ),
        ]);
        return el("div", { class: "perm-card" }, [
          el("div", { class: "perm-q" }, [
            icon("shield", 15),
            el("span", { text: "Permission requested · " }),
            el("span", { class: "mono", text: tool }),
          ]),
          actions,
          note,
        ]);
      }

      function updateStats() {
        if (!statEls) return;
        statEls.turns.textContent = stats.turns;
        statEls.tools.textContent = stats.tools;
        statEls.tokens.textContent = CH.fmtTokens(stats.tokensIn + stats.tokensOut);
        statEls.cost.textContent = CH.fmtUsd(stats.costMicros);
        statEls.errors.textContent = stats.errors;
      }

      function pushEvent(ev) {
        events.accrue(ev, stats);
        updateStats();
        if (ev.kind === "turn_end" && chat) {
          chat.endTurn();
          turnActive = false;
          resetTurn();
        }
        const node = events.render(ev);
        if (node && feedEl) {
          feedEl.appendChild(node);
          if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
        }
      }

      // ── WS handlers (attached once) ───────────────────────────────────
      api.on("user", (m) => {
        if (chat) {
          chat.user(m.text);
          turnActive = true;
          resetTurn();
        }
      });
      api.on("stdout", (m) => {
        const txt = stripAnsi(m.text);
        if (turnActive && chat) {
          chat.assistant(txt);
          turnStdout += txt;
          maybePrompt();
        } else if (txt.trim() || txt.indexOf("\n") >= 0) {
          api.log(txt, "stdout");
        }
      });
      api.on("event", (m) => pushEvent(m.event));
      api.on("status", (m) => {
        if (composer) composer.setEnabled(m.state === "running");
        if (!chat) return;
        if (m.state === "running") chat.systemNote("Agent booted. Send a message to start the conversation.");
        else if (m.state === "exited") {
          chat.endTurn();
          turnActive = false;
          resetTurn();
          chat.systemNote("Agent process exited. Press Start to run it again.");
        } else if (m.state === "error") {
          chat.systemNote("The agent could not start — check the raw output log.");
          api.openLog();
        }
      });

      // ── View switching ────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      function buildEmpty() {
        chat = composer = feedEl = feedScroll = statEls = null;
        CH.clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "terminal",
            title: "Drop in a compiled CLI agent",
            subtitle: "This UI runs any bundle compiled from a CrewHaus spec with target: cli.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Click **Start** — dependencies install automatically on first run",
            ],
          }),
        );
      }

      function buildActive() {
        CH.clear(api.main);

        // left: conversation
        feedScroll = null;
        const leftScroll = el("div", { class: "pane-scroll" });
        const leftFoot = el("div");
        const left = el("div", { class: "pane" }, [
          paneHead("message", "Conversation"),
          leftScroll,
          leftFoot,
        ]);
        chat = Chat(leftScroll, { agentLabel: api.config.title });
        composer = Composer(leftFoot, (txt) => api.sendInput(txt), {
          placeholder: "Message the agent…",
        });
        composer.setEnabled(api.isRunning());

        // right: activity
        const statsBar = el("div", { class: "stats" });
        statEls = {
          turns: stat(statsBar, "Turns", "0", "play"),
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
        const right = el("div", { class: "pane" }, [paneHead("activity", "Activity"), feedScroll]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));
        updateStats();
        if (!api.isRunning())
          chat.systemNote("Press Start to boot the agent, then send a message.");
      }

      function stat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(el("div", { class: "stat" }, [v, el("div", { class: "k", text: label })]));
        return v;
      }
    },
  });
})();
