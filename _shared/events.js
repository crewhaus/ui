/* ============================================================================
   CrewHaus Shape UI — TraceEvent renderer.

   The host streams CrewHaus `TraceEvent` objects (CREWHAUS_TRACE=json) over the
   WebSocket as { type:"event", event }. This module turns each event into a
   rich `.event` feed card and accumulates run-level stats (cost, tokens, turns,
   tool calls, errors). Shared by every shape; shapes may also read raw events
   for shape-specific panels (graph nodes, crew roles, eval verdicts, …).

   Exposes CH.events = { render(ev) -> Node|null, accrue(ev, stats), newStats(),
                         card(opts), failureCard(ev), stderrTailCard(lines),
                         FEED_SKIP:Set }
   ========================================================================== */
(function () {
  "use strict";
  const { el, icon, fmtBytes, fmtMs, fmtTokens, fmtUsd } = window.CH;

  function card(o) {
    const main = el("div", { class: "ev-main" }, [
      el("div", { class: "ev-title" }, [
        o.name ? el("span", { class: "ev-name", text: o.name }) : null,
        o.title ? el("span", { text: o.title }) : null,
        o.badge ? el("span", { class: `badge ${o.badgeKind || ""}`, text: o.badge }) : null,
      ]),
      o.sub ? el("div", { class: "ev-sub", text: o.sub }) : null,
    ]);
    return el("div", { class: `event ${o.sev || ""}` }, [
      el("div", { class: "ev-icon" }, icon(o.icon || "dot", 13)),
      main,
      o.meta ? el("div", { class: "ev-meta", text: o.meta }) : null,
    ]);
  }

  // Events not shown in the timeline feed (used elsewhere / too noisy).
  const FEED_SKIP = new Set(["model_stream_token", "tool_stream_chunk", "model_request"]);

  // Per-kind renderers. Each returns the options object passed to card().
  const R = {
    turn_start: (e) => ({
      icon: "play",
      sev: "muted",
      title: `Turn ${e.turn} started`,
      meta: `${e.messageCount} msgs`,
    }),
    turn_end: (e) => ({
      icon: "check",
      sev: "muted",
      title: `Turn ${e.turn} ended`,
      sub: e.stopReason ? `stop: ${e.stopReason}` : "",
      meta: fmtMs(e.durationMs),
    }),
    model_response: (e) => ({
      icon: "cpu",
      sev: "info",
      name: e.model,
      title: "responded",
      sub: e.usage
        ? `${fmtTokens(e.usage.input)} in · ${fmtTokens(e.usage.output)} out${
            e.usage.cacheRead ? ` · ${fmtTokens(e.usage.cacheRead)} cached` : ""
          } · ${e.stopReason}`
        : e.stopReason,
      meta: fmtMs(e.durationMs),
    }),
    tool_call_start: (e) => ({
      icon: "wrench",
      sev: "accent",
      name: e.toolName,
      title: "called",
      sub: `input ${fmtBytes(e.inputBytes)}`,
    }),
    tool_call_end: (e) => ({
      icon: e.isError ? "alert" : "check",
      sev: e.isError ? "error" : "accent",
      name: e.toolName,
      title: e.isError ? "failed" : "returned",
      sub: `output ${fmtBytes(e.outputBytes)}`,
      meta: fmtMs(e.durationMs),
    }),
    mcp_call_start: (e) => ({
      icon: "plug",
      sev: "info",
      name: `${e.server}.${e.toolName}`,
      title: "MCP call",
    }),
    mcp_call_end: (e) => ({
      icon: e.isError ? "alert" : "plug",
      sev: e.isError ? "error" : "info",
      name: `${e.server}.${e.toolName}`,
      title: e.isError ? "MCP error" : "MCP done",
      meta: fmtMs(e.durationMs),
    }),
    permission_decision: (e) => ({
      icon: "shield",
      sev: e.decision === "deny" ? "error" : e.decision === "ask" ? "warn" : "accent",
      name: e.toolName,
      title: `permission ${e.decision}`,
      badge: e.mode,
      sub: e.reason || "",
    }),
    hook_fired: (e) => ({
      icon: "hook",
      sev: e.allowed ? "info" : "warn",
      name: e.event,
      title: e.allowed ? "hook allowed" : "hook blocked",
      sub: e.reason || (e.matcher ? `matcher: ${e.matcher}` : ""),
      meta: fmtMs(e.durationMs),
    }),
    compaction_fired: (e) => ({
      icon: "scissors",
      sev: "warn",
      title: `compaction (${e.subKind})`,
      sub: `${fmtTokens(e.before)} -> ${fmtTokens(e.after)} tokens · ${e.phase}`,
    }),
    // `fail` and `halt` are TERMINAL — the run is over, nothing was recovered.
    // (`halt` is v0.3.0's classified stop: billing/auth/rate-limit; the
    // accompanying `run_failed` event carries the human-readable report.)
    error_recovered: (e) =>
      e.action === "halt" || e.action === "fail"
        ? {
            icon: "alert",
            sev: "error",
            name: e.errorName,
            title: e.action === "halt" ? "halted — terminal failure" : "recovery failed",
            meta: `depth ${e.depth}`,
          }
        : {
            icon: "refresh",
            sev: "warn",
            name: e.errorName,
            title: `recovered: ${e.action}`,
            meta: `depth ${e.depth}`,
          },
    sub_agent_start: (e) => ({
      icon: "bot",
      sev: "info",
      name: e.name,
      title: "sub-agent spawned",
      sub: `${e.toolCount} tools · prompt ${fmtBytes(e.promptBytes)}`,
    }),
    sub_agent_end: (e) => ({
      icon: e.isError ? "alert" : "bot",
      sev: e.isError ? "error" : "accent",
      name: e.name,
      title: e.isError ? "sub-agent failed" : "sub-agent done",
      sub: `${e.toolCallCount} tool calls · ${fmtBytes(e.finalMessageBytes)} out`,
      meta: fmtMs(e.durationMs),
    }),
    role_start: (e) => ({
      icon: "user",
      sev: "info",
      name: e.role,
      title: "role active",
      meta: `#${e.activation}`,
    }),
    role_end: (e) => ({
      icon: "user",
      sev: "info",
      name: e.role,
      title: "role done",
      sub: `${fmtBytes(e.finalMessageBytes)} out`,
      meta: fmtMs(e.durationMs),
    }),
    handoff: (e) => ({
      icon: "arrowRight",
      sev: "accent",
      title: `${e.from} -> ${e.to}`,
      sub: e.reason || "",
      meta: `depth ${e.depth}`,
    }),
    a2a_message: (e) => ({
      icon: "network",
      sev: "info",
      title: `${e.from} -> ${e.to}`,
      badge: e.messageKind,
      sub: `${fmtBytes(e.payloadBytes)}`,
    }),
    crew_done: (e) => ({
      icon: "check",
      sev: "accent",
      title: "crew complete",
      sub: `final role: ${e.finalRole} · ${e.totalActivations} activations`,
      meta: fmtMs(e.durationMs),
    }),
    cost_accrual: (e) =>
      e.summary
        ? {
            icon: "coins",
            sev: "accent",
            title: "run cost total",
            sub: `${fmtTokens(e.inputTokens)} in · ${fmtTokens(e.outputTokens)} out`,
            meta: fmtUsd(e.costUsdMicros),
          }
        : {
            icon: "coin",
            sev: "muted",
            name: e.modelId,
            title: "cost",
            sub: `${fmtTokens(e.inputTokens)} in · ${fmtTokens(e.outputTokens)} out${
              e.cachedReadTokens ? ` · ${fmtTokens(e.cachedReadTokens)} cached` : ""
            }`,
            meta: fmtUsd(e.costUsdMicros),
          },
    test_verdict: (e) => ({
      icon: e.verdict === "pass" ? "check" : e.verdict === "fail" ? "x" : "dot",
      sev: e.verdict === "pass" ? "accent" : e.verdict === "fail" ? "error" : "muted",
      name: e.testId,
      title: e.verdict,
      sub: e.reason || "",
      meta: fmtMs(e.durationMs),
    }),
    program_output: (e) => ({
      icon: "terminal",
      sev: e.exitCode === 0 ? "info" : "error",
      name: e.programId,
      title: `exit ${e.exitCode}`,
      sub: `out ${fmtBytes(e.stdoutBytes)} · err ${fmtBytes(e.stderrBytes)}`,
      meta: fmtMs(e.durationMs),
    }),
    coverage_report: (e) => ({
      icon: "activity",
      sev: "info",
      name: e.programId,
      title: "coverage",
      sub: `lines ${pct(e.linesCovered, e.linesTotal)} · branches ${pct(
        e.branchesCovered,
        e.branchesTotal,
      )}`,
    }),
    sanitizer_report: (e) => ({
      icon: "shield",
      sev: e.isError ? "error" : "warn",
      name: e.sanitizer,
      title: e.isError ? "sanitizer fault" : "sanitizer ok",
      sub: e.summary || "",
    }),
    circuit_state_changed: (e) => ({
      icon: "zap",
      sev: e.toState === "open" ? "error" : e.toState === "half_open" ? "warn" : "accent",
      name: e.adapter,
      title: `circuit ${e.fromState} -> ${e.toState}`,
      sub: e.reason || "",
    }),
  };

  function pct(a, b) {
    if (!b) return "—";
    return `${Math.round((a / b) * 100)}%`;
  }

  // ── Run-failure cards (v0.3.0 honest failure messaging) ───────────────────

  /** "Show raw output" — app-kit points CH.openRawLog at the drawer toggle. */
  function showRawButton() {
    return el(
      "button",
      {
        class: "btn ghost sm",
        onClick: () => window.CH.openRawLog && window.CH.openRawLog(),
      },
      [icon("terminal", 13), el("span", { text: "Show raw output" })],
    );
  }

  /**
   * The rich card for a `run_failed` trace event: class-styled (billing /
   * auth / rate_limit get distinct treatment via CSS), a title line, the
   * provider's raw message, the remediation line, and a "Show raw output"
   * affordance. Returns a fresh node each call (usable in feed AND chat).
   */
  function failureCard(ev) {
    const split = window.CH.failure
      ? window.CH.failure.splitMessage(ev.message)
      : { title: String(ev.message || ""), detail: "" };
    const cls = typeof ev.class === "string" ? ev.class : "unknown";
    const exitCode = typeof ev.exitCode === "number" ? ev.exitCode : null;
    return el("div", { class: `failure-card failure-${cls}` }, [
      el("div", { class: "failure-title" }, [
        icon("alert", 15),
        el("span", { text: `Run stopped — ${split.title || "unexpected error"}` }),
        el("span", { class: "grow" }),
        el("span", {
          class: "badge err",
          text: exitCode === null ? cls : `${cls} · exit ${exitCode}`,
        }),
      ]),
      split.detail ? el("div", { class: "failure-raw", text: split.detail }) : null,
      ev.remediation ? el("div", { class: "failure-fix", text: `Fix: ${ev.remediation}` }) : null,
      el("div", { class: "failure-actions" }, [showRawButton()]),
    ]);
  }

  /**
   * Fallback card when the process died WITHOUT a structured `run_failed`
   * event: the host attaches the last few stderr lines to the exit broadcast
   * (`status.stderrTail`) and this renders them.
   */
  function stderrTailCard(lines) {
    return el("div", { class: "failure-card failure-unknown" }, [
      el("div", { class: "failure-title" }, [
        icon("alert", 15),
        el("span", { text: "Run stopped — last stderr lines" }),
      ]),
      el("div", { class: "failure-raw", text: (lines || []).join("\n") }),
      el("div", { class: "failure-actions" }, [showRawButton()]),
    ]);
  }

  function render(ev) {
    if (!ev || !ev.kind || FEED_SKIP.has(ev.kind)) return null;
    if (ev.kind === "run_failed") return failureCard(ev);
    const fn = R[ev.kind];
    const opts = fn ? fn(ev) : { icon: "dot", sev: "muted", title: ev.kind };
    return card(opts);
  }

  function newStats() {
    return { turns: 0, tools: 0, errors: 0, costMicros: 0, tokensIn: 0, tokensOut: 0, subAgents: 0 };
  }

  function accrue(ev, s) {
    switch (ev.kind) {
      case "turn_start":
        s.turns++;
        break;
      case "tool_call_start":
        s.tools++;
        break;
      case "tool_call_end":
        if (ev.isError) s.errors++;
        break;
      // Model/terminal failures count too — exactly one run_failed is
      // published per terminal failure (the paired error_recovered
      // fail/halt is NOT counted, to avoid double counting).
      case "run_failed":
        s.errors++;
        break;
      case "sub_agent_start":
        s.subAgents++;
        break;
      case "cost_accrual":
        if (!ev.summary) {
          s.costMicros += ev.costUsdMicros || 0;
          s.tokensIn += ev.inputTokens || 0;
          s.tokensOut += ev.outputTokens || 0;
        }
        break;
    }
    return s;
  }

  window.CH.events = { render, accrue, newStats, card, failureCard, stderrTailCard, FEED_SKIP, R };
})();
