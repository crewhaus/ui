/* ============================================================================
   CrewHaus Shape UI — TraceEvent renderer.

   The host streams CrewHaus `TraceEvent` objects (CREWHAUS_TRACE=json) over the
   WebSocket as { type:"event", event }. This module turns each event into a
   rich `.event` feed card and accumulates run-level stats (cost, tokens, turns,
   tool calls, errors). Shared by every shape; shapes may also read raw events
   for shape-specific panels (graph nodes, crew roles, eval verdicts, …).

   Exposes CH.events = { render(ev) -> Node|null, accrue(ev, stats), newStats(),
                         card(opts), failureCard(ev), stderrTailCard(lines),
                         FEED_SKIP:Set,
                         spendByRole(stats), spendByProfile(stats),
                         spendTitle(stats) }

   v0.6.0 adds model attribution: the run's spend is accumulated per ROLE
   (primary / draft / judge / escalation / guide / …) and per `models:` PROFILE
   alongside the flat totals, and the hybrid strategies publish `model_stage` /
   `model_directive` so the side calls and rungs a turn took are legible in the
   feed. All of it is additive — an event carrying none of the new fields
   renders exactly as it always did.
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

  // ── 0.6.0 model attribution (design §8.1) ─────────────────────────────────
  // `model_request` / `model_response` / `cost_accrual` may carry `role`,
  // `stage`, `profile`, `paramsFingerprint` and `effectiveParams`; `model_route`
  // carries the routing detail behind the pick; `model_stage` and
  // `model_directive` are new kinds. EVERY one of those fields is optional on
  // the wire, and an absent `role` means the main-turn call — so an event from a
  // run with no `models:` registry and no `model_pool` renders here exactly as
  // it did before this release.
  const PRIMARY_ROLE = "primary";

  // The profile bucket for a call that resolved no `models:` profile. Matches
  // factory's own fold (hangar-server's `NO_PROFILE`): a per-profile table
  // whose rows do not sum to the total is worse than one that says where the
  // remainder went, so an unattributed call is grouped, never dropped.
  const NO_PROFILE = "(none)";

  // The AUXILIARY roles: model calls made in service of the run's answer rather
  // than as the answer itself. Mirrors the runtime's own AUXILIARY_MODEL_ROLES
  // — `primary`, `draft` and `escalation` are the answer's own rungs and
  // `subagent` is a child's re-published answer work, so none of those is
  // auxiliary.
  const AUXILIARY_ROLES = new Set([
    "judge",
    "guide",
    "classifier",
    "consult",
    "committee",
    "shadow",
    "compaction",
  ]);

  /** The event's role, with the reader contract applied: absent ⇒ primary. */
  function roleOf(ev) {
    return typeof ev.role === "string" && ev.role ? ev.role : PRIMARY_ROLE;
  }

  /** Join non-empty detail fragments into one card sub-line. */
  function joinParts(parts) {
    return parts.filter((p) => typeof p === "string" && p !== "").join(" · ");
  }

  /**
   * Attribution suffix for a model card: the role (when it is not the main
   * turn), the strategy stage, the profile, and — the first time it has ever
   * been visible — the parameters the serving adapter silently dropped.
   * Empty string for an unattributed event.
   */
  function attribution(e) {
    const dropped = e.effectiveParams && e.effectiveParams.dropped;
    return joinParts([
      e.role && e.role !== PRIMARY_ROLE ? `role ${e.role}` : "",
      e.stage && e.stage !== e.role ? `stage ${e.stage}` : "",
      e.profile ? `profile ${e.profile}` : "",
      Array.isArray(dropped) && dropped.length ? `dropped ${dropped.join(", ")}` : "",
    ]);
  }

  /**
   * The routing detail a 0.6.0 `model_route` carries beyond `policy`/`reason`:
   * which strategy stage it served, the profile and spec arm it resolved to,
   * the rule or classifier label that steered it, how many arms were eligible,
   * the quality floor's verdict and the route key a scoped arm backed off to.
   */
  function routeDetail(e) {
    const floor = e.floor;
    const verdict = e.classifierVerdict;
    return joinParts([
      e.strategy
        ? e.stage
          ? `${e.strategy} · ${e.stage}`
          : e.strategy
        : e.stage
          ? `stage ${e.stage}`
          : "",
      e.profile ? `profile ${e.profile}` : "",
      e.specModel && e.specModel !== e.model ? `spec ${e.specModel}` : "",
      e.ruleId ? `rule ${e.ruleId}` : "",
      verdict && verdict.label ? `label ${verdict.label}` : "",
      e.hint && e.hint.source && e.hint.source !== "none" ? `hint ${e.hint.source}` : "",
      e.scope && e.scope !== "main" ? `scope ${e.scope}` : "",
      Array.isArray(e.eligible) && e.eligible.length ? `${e.eligible.length} eligible` : "",
      // `ModelRouteFloor.arm` is the FLOOR arm — on `blocked` it is the arm
      // that SERVED (nothing cheaper was exploitable), and `blocked` is the
      // set the floor kept out. Name both, in that order: a reader who sees
      // only one arm id here will read it as the refused one.
      floor && floor.status === "blocked"
        ? joinParts([
            `floor served ${floor.arm}`,
            Array.isArray(floor.blocked) && floor.blocked.length
              ? `refused ${floor.blocked.join(", ")}`
              : "",
          ])
        : "",
      floor && floor.status === "unavailable" ? "floor unavailable" : "",
      e.backedOffTo ? `backed off to ${e.backedOffTo}` : "",
    ]);
  }

  // One row per `model_stage.outcome`. `skipped` is not a failure — a cascade
  // that never needed its escalation rung is the good case — so it stays muted
  // and explains itself through `cause`.
  const STAGE_OUTCOME = {
    started: { icon: "play", sev: "muted", verb: "started" },
    done: { icon: "check", sev: "accent", verb: "done" },
    failed: { icon: "alert", sev: "error", verb: "failed" },
    skipped: { icon: "x", sev: "muted", verb: "skipped" },
  };

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
      sub: joinParts([
        e.usage
          ? `${fmtTokens(e.usage.input)} in · ${fmtTokens(e.usage.output)} out${
              e.usage.cacheRead ? ` · ${fmtTokens(e.usage.cacheRead)} cached` : ""
            } · ${e.stopReason}`
          : e.stopReason,
        attribution(e),
      ]),
      // A judge, draft or shadow call otherwise looks exactly like the answer's
      // own turn; the badge is what tells them apart at a glance.
      badge: e.role && e.role !== PRIMARY_ROLE ? e.role : "",
      badgeKind: "info",
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
            sub: joinParts([
              `${fmtTokens(e.inputTokens)} in · ${fmtTokens(e.outputTokens)} out${
                e.cachedReadTokens ? ` · ${fmtTokens(e.cachedReadTokens)} cached` : ""
              }`,
              attribution(e),
            ]),
            badge: e.role && e.role !== PRIMARY_ROLE ? e.role : "",
            badgeKind: "info",
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
    // ── Routing / cache infrastructure (v0.3.0) ──────────────────────────────
    cache_rotation: (e) => ({
      icon: "refresh",
      sev: "muted",
      title: "prompt cache rotated",
      meta: Number.isFinite(e.rotatedAt) ? new Date(e.rotatedAt).toLocaleTimeString() : "",
    }),
    model_route: (e) => ({
      icon: "git",
      // A floor-blocked exploit is the one route decision worth a colour: the
      // learned policy wanted a cheaper arm and the quality floor refused it.
      sev: e.floor && e.floor.status === "blocked" ? "warn" : "info",
      name: e.model,
      title: `route · ${e.policy}`,
      sub: joinParts([e.reason || "", routeDetail(e)]),
      badge: e.explored ? "exploring" : e.routeKey || "",
      meta: e.explored ? e.routeKey || "" : "",
    }),
    model_tier_route: (e) => ({
      icon: "layers",
      sev: e.escalated ? "warn" : "muted",
      name: e.model,
      title: `tier · ${e.tier}`,
      sub: e.reason || "",
      badge: e.escalated ? "escalated" : "",
    }),
    model_failover: (e) => ({
      icon: "refresh",
      sev: "warn",
      title: `failover ${e.from} -> ${e.to}`,
      badge: e.reason || "",
    }),
    // ── Hybrid strategies (v0.6.0) ───────────────────────────────────────────
    // One stage transition of a hybrid turn. The runtime publishes a stage
    // line for the rungs and side calls that BRANCH the turn — `escalate`
    // (strategy `cascade` or `model_directed`), `guide`, `shadow`,
    // `committee`, `member`, `tie-break` and `consult` — as a started/done or
    // started/failed pair. The cascade's own draft rung and its judge call are
    // NOT stage events: they are attribution (`role: "draft"` / `role:
    // "judge"`, `stage draft` / `stage verify`) riding the `model_response`
    // and `cost_accrual` cards, so a turn the draft satisfied publishes no
    // stage line at all. A stage that never ran says WHY through `cause`
    // ("max_escalations", "judge_share_exhausted", …), which is the difference
    // between "the cheap arm was good enough" and "we ran out of judge budget".
    model_stage: (e) => {
      const o = STAGE_OUTCOME[e.outcome] || { icon: "layers", sev: "info" };
      const verb = o.verb || String(e.outcome || "stage");
      return {
        icon: o.icon,
        sev: o.sev,
        name: e.strategy ? `${e.strategy} · ${e.stage}` : e.stage,
        title: e.cause ? `${verb} — ${e.cause}` : verb,
        sub: joinParts([e.model || "", e.profile ? `profile ${e.profile}` : ""]),
        badge: e.role && e.role !== PRIMARY_ROLE ? e.role : "",
        badgeKind: "info",
        meta: Number.isFinite(e.costUsdMicros) ? fmtUsd(e.costUsdMicros) : "",
      };
    },
    // A per-message `/model …` directive, parsed at a typed input seam. An
    // accepted one pins the arm; a refused one is the interesting case, so it
    // carries the runtime's own `reason` rather than a generic "ignored".
    model_directive: (e) => ({
      icon: "wand",
      sev: e.accepted ? "accent" : "warn",
      name: `/model ${e.requested}`,
      title: e.accepted
        ? e.resolved && e.resolved !== e.requested
          ? `pinned -> ${e.resolved}`
          : "pinned"
        : "refused",
      sub: e.reason || "",
      badge: e.source || "",
      badgeKind: e.accepted ? "ok" : "warn",
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
    return {
      turns: 0,
      tools: 0,
      errors: 0,
      costMicros: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheTokens: 0,
      subAgents: 0,
      // true once a model_response was billed against an unpriced model (the
      // pricing table missed it); lets the display say "unpriced" instead of a
      // misleading $0.00.
      unpriced: false,
      // ── v0.6.0 spend attribution ──────────────────────────────────────────
      // Same totals, split by WHY the call was made and by which `models:`
      // profile served it: role -> { calls, costMicros, tokensIn, tokensOut }.
      // Null-prototype maps so a role/profile name off the wire can never
      // reach Object.prototype. A run with no attribution on its events lands
      // entirely in byRole.primary / byProfile["(none)"], so both maps always
      // sum to the flat totals and every existing tile keeps reading those
      // unchanged.
      byRole: Object.create(null),
      byProfile: Object.create(null),
      // Spend in the AUXILIARY roles (judge, guide, classifier, consult,
      // committee, shadow, compaction) — the answer's overhead, which is what
      // `budget.judge_share` bounds. Always a subset of costMicros.
      auxCostMicros: 0,
    };
  }

  /** Fetch (creating on first sight) one bucket of a null-prototype map. */
  function bucketOf(map, key) {
    let b = map[key];
    if (!b) {
      b = { calls: 0, costMicros: 0, tokensIn: 0, tokensOut: 0 };
      map[key] = b;
    }
    return b;
  }

  /**
   * A spend map as a display-ordered array: dearest first, ties broken by call
   * count then name, so a re-render never reshuffles equal rows.
   * Record: { key, calls, costMicros, tokensIn, tokensOut }.
   */
  function breakdown(map) {
    const rows = Object.keys(map || {}).map((key) => Object.assign({ key }, map[key]));
    rows.sort(
      (a, b) =>
        b.costMicros - a.costMicros ||
        b.calls - a.calls ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    return rows;
  }

  /** Run spend by role (`primary`, `draft`, `judge`, …). */
  function spendByRole(s) {
    return breakdown(s && s.byRole);
  }

  /** Run spend by `models:` profile — empty until a profile-bearing run. */
  function spendByProfile(s) {
    return breakdown(s && s.byProfile);
  }

  /**
   * One-line-per-grouping summary of where a run's money went, for the cost
   * tile's tooltip. Returns "" when there is nothing to break down (a run whose
   * every call is the unattributed main turn), so an unattributed run shows no
   * tooltip at all rather than a tooltip that says "primary" and nothing else.
   */
  function spendTitle(s) {
    if (!s) return "";
    const roles = spendByRole(s);
    const profiles = spendByProfile(s);
    const lines = [];
    if (roles.length > 1) {
      lines.push(`By role: ${roles.map((r) => `${r.key} ${fmtUsd(r.costMicros)}`).join(" · ")}`);
    }
    // A run that resolved no profile at all lands wholly in `(none)`, which is
    // a row saying nothing — the profile analogue of the single-`primary`
    // case the role guard above suppresses.
    if (profiles.length && !(profiles.length === 1 && profiles[0].key === NO_PROFILE)) {
      lines.push(`By profile: ${profiles.map((r) => `${r.key} ${fmtUsd(r.costMicros)}`).join(" · ")}`);
    }
    return lines.join("\n");
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
      // Tokens come from model_response.usage — always present and
      // pricing-INDEPENDENT, so the token tile survives an unpriced model (a
      // pricing-table miss suppresses/zeroes the cost of cost_accrual). Cost is
      // still summed from cost_accrual below. Sourcing tokens here (not from
      // cost_accrual) also avoids double-counting the same response.
      case "model_response": {
        // Per-role/profile tokens are split HERE for the same reason the run
        // totals are: model_response.usage survives a pricing-table miss.
        const rb = bucketOf(s.byRole, roleOf(ev));
        rb.calls++;
        const pb = bucketOf(s.byProfile, ev.profile || NO_PROFILE);
        pb.calls++;
        if (ev.usage) {
          const inTok = ev.usage.input || 0;
          const outTok = ev.usage.output || 0;
          s.tokensIn += inTok;
          s.tokensOut += outTok;
          s.cacheTokens += (ev.usage.cacheRead || 0) + (ev.usage.cacheCreate || 0);
          rb.tokensIn += inTok;
          rb.tokensOut += outTok;
          pb.tokensIn += inTok;
          pb.tokensOut += outTok;
        }
        break;
      }
      case "cost_accrual":
        // `summary: true` wears one flag over two different lines, and this
        // stream's scope decides which to fold — the same call
        // @crewhaus/cost-tracker makes on the live parent bus.
        //
        //   ROLE-LESS  — the optimizer orchestrator's run total, a sum over
        //                per-call accruals already folded here. Ignored, or
        //                the run's spend doubles.
        //   ROLE-BEARING — a NESTED run's roll-up re-published on this bus
        //                (@crewhaus/sub-agent-spawner's `role: "subagent"`
        //                total). The child runs on its OWN event bus, which
        //                carries no printer, so its per-call lines never reach
        //                this stream at all: the roll-up is the only record of
        //                that spend here, and dropping it puts the Cost tile
        //                a whole child run behind the runtime's budget meter.
        if (!ev.summary || ev.role !== undefined) {
          const cost = ev.costUsdMicros || 0;
          s.costMicros += cost;
          // cost-tracker copies role/stage/profile verbatim from the response
          // onto the accrual, so the split needs no pairing on this side.
          const role = roleOf(ev);
          bucketOf(s.byRole, role).costMicros += cost;
          bucketOf(s.byProfile, ev.profile || NO_PROFILE).costMicros += cost;
          if (AUXILIARY_ROLES.has(role)) s.auxCostMicros += cost;
          // Unpriced model: factory sets `unpriced:true` on a pricing miss;
          // fall back to the robust signal (zero cost but real tokens) for
          // older runtimes that predate the flag.
          if (ev.unpriced || (!(ev.costUsdMicros > 0) && (ev.inputTokens || ev.outputTokens))) {
            s.unpriced = true;
          }
        }
        break;
    }
    return s;
  }

  window.CH.events = {
    render,
    accrue,
    newStats,
    card,
    failureCard,
    stderrTailCard,
    FEED_SKIP,
    R,
    // v0.6.0 spend attribution (pure; unit-tested in test/events.test.ts).
    spendByRole,
    spendByProfile,
    spendTitle,
    AUXILIARY_ROLES,
  };
})();
