/**
 * DOM-less unit tests for the shared TraceEvent renderers (_shared/events.js).
 *
 * events.js is a classic browser IIFE attaching to window.CH; its per-kind
 * renderers in `R` are pure `(event) -> options` functions (no DOM — the DOM
 * is only built later by card()). Point `window`/`CH` at globalThis, stub the
 * formatters the module destructures at load, then assert the option objects
 * for the v0.3.0 routing/cache kinds that previously fell to a generic dot card.
 */
import { beforeAll, describe, expect, test } from "bun:test";

type Opts = Record<string, unknown>;
type EventsModule = {
  R: Record<string, (e: Record<string, unknown>) => Opts>;
  render: (e: Record<string, unknown>) => unknown;
  FEED_SKIP: Set<string>;
};

let events: EventsModule;

beforeAll(async () => {
  const g = globalThis as unknown as { window: unknown; CH: Record<string, unknown> };
  g.window = globalThis;
  const CH = (g.CH ||= {}) as Record<string, unknown>;
  // Stubs for what events.js destructures at import (never build real DOM here).
  CH.el = CH.el || (() => ({}));
  CH.icon = CH.icon || (() => ({}));
  CH.fmtBytes = CH.fmtBytes || ((n: number) => `${n}B`);
  CH.fmtMs = CH.fmtMs || ((n: number) => `${n}ms`);
  CH.fmtTokens = CH.fmtTokens || ((n: number) => String(n));
  CH.fmtUsd = CH.fmtUsd || ((n: number) => `$${n}`);
  await import("../_shared/events.js");
  events = (g.CH as { events: EventsModule }).events;
});

describe("v0.3.0 routing / cache renderers", () => {
  test("cache_rotation", () => {
    const o = events.R.cache_rotation({ kind: "cache_rotation", rotatedAt: 1_700_000_000_000 });
    expect(o.icon).toBe("refresh");
    expect(o.title).toBe("prompt cache rotated");
    expect(typeof o.meta).toBe("string");
  });

  test("cache_rotation tolerates a missing timestamp", () => {
    const o = events.R.cache_rotation({ kind: "cache_rotation" });
    expect(o.meta).toBe("");
  });

  test("model_route surfaces model, policy, reason, and exploration", () => {
    const o = events.R.model_route({
      kind: "model_route",
      routeKey: "chat",
      model: "claude-opus-4-8",
      policy: "learned",
      reason: "highest reward",
      explored: true,
    });
    expect(o.name).toBe("claude-opus-4-8");
    expect(String(o.title)).toContain("learned");
    expect(o.sub).toBe("highest reward");
    expect(o.badge).toBe("exploring");
  });

  test("model_tier_route flags a fast->default escalation", () => {
    const o = events.R.model_tier_route({
      kind: "model_tier_route",
      tier: "fast",
      model: "claude-haiku-4-5",
      reason: "short prompt",
      escalated: true,
    });
    expect(o.name).toBe("claude-haiku-4-5");
    expect(String(o.title)).toContain("fast");
    expect(o.sev).toBe("warn");
    expect(o.badge).toBe("escalated");
  });

  test("model_failover shows from -> to with the reason badge", () => {
    const o = events.R.model_failover({
      kind: "model_failover",
      from: "claude-opus-4-8",
      to: "claude-sonnet-5",
      reason: "breaker_open",
    });
    expect(o.title).toBe("failover claude-opus-4-8 -> claude-sonnet-5");
    expect(o.badge).toBe("breaker_open");
    expect(o.sev).toBe("warn");
  });

  test("all four kinds now have a renderer (no generic dot fallback)", () => {
    for (const k of ["cache_rotation", "model_route", "model_tier_route", "model_failover"]) {
      expect(typeof events.R[k]).toBe("function");
    }
  });

  test("render() returns a node for a newly-supported kind, null for skipped", () => {
    expect(
      events.render({ kind: "model_route", model: "x", policy: "static", reason: "r", routeKey: "k" }),
    ).not.toBeNull();
    expect(events.render({ kind: "model_stream_token" })).toBeNull(); // FEED_SKIP
  });
});

describe("cost/token accrual (Phase 2 — decoupled from pricing)", () => {
  type Stats = ReturnType<
    (typeof events & { newStats: () => Record<string, number | boolean> })["newStats"]
  >;
  const mod = () => events as unknown as { newStats: () => Stats; accrue: (e: unknown, s: Stats) => Stats };

  test("tokens come from model_response.usage, not cost_accrual", () => {
    const { newStats, accrue } = mod();
    const s = newStats();
    accrue({ kind: "model_response", usage: { input: 100, output: 40, cacheRead: 10, cacheCreate: 5 } }, s);
    expect(s.tokensIn).toBe(100);
    expect(s.tokensOut).toBe(40);
    expect(s.cacheTokens).toBe(15);
  });

  test("a pricing miss (unpriced cost_accrual) still yields tokens + flags unpriced", () => {
    const { newStats, accrue } = mod();
    const s = newStats();
    // model_response carries the real tokens even when the model is unpriced…
    accrue({ kind: "model_response", usage: { input: 200, output: 60 } }, s);
    // …and the factory emits a $0 cost_accrual with unpriced:true on a miss.
    accrue({ kind: "cost_accrual", costUsdMicros: 0, inputTokens: 200, outputTokens: 60, unpriced: true }, s);
    expect(s.tokensIn).toBe(200); // NOT double-counted from cost_accrual
    expect(s.tokensOut).toBe(60);
    expect(s.costMicros).toBe(0);
    expect(s.unpriced).toBe(true);
  });

  test("a priced response accrues cost and is not flagged unpriced", () => {
    const { newStats, accrue } = mod();
    const s = newStats();
    accrue({ kind: "model_response", usage: { input: 50, output: 20 } }, s);
    accrue({ kind: "cost_accrual", costUsdMicros: 1500, inputTokens: 50, outputTokens: 20 }, s);
    expect(s.costMicros).toBe(1500);
    expect(s.tokensIn).toBe(50);
    expect(s.unpriced).toBe(false);
  });

  test("fallback unpriced signal (zero cost + real tokens) for pre-flag runtimes", () => {
    const { newStats, accrue } = mod();
    const s = newStats();
    accrue({ kind: "cost_accrual", costUsdMicros: 0, inputTokens: 10, outputTokens: 5 }, s);
    expect(s.unpriced).toBe(true);
  });

  test("aggregate summary cost_accrual is ignored", () => {
    const { newStats, accrue } = mod();
    const s = newStats();
    accrue({ kind: "cost_accrual", summary: true, costUsdMicros: 9999 }, s);
    expect(s.costMicros).toBe(0);
    expect(s.unpriced).toBe(false);
  });
});

// ── v0.6.0 — model attribution, hybrid stages, per-role/profile spend ───────
//
// The 0.6.0 runtime publishes two new trace kinds (`model_stage`,
// `model_directive`), routing detail on `model_route`, and optional
// `role`/`stage`/`profile`/`effectiveParams` on `model_request` /
// `model_response` / `cost_accrual`. Every one of those fields is optional on
// the wire, so the first test of each pair pins the UNCHANGED rendering of an
// event that carries none of them.

describe("v0.6.0 model_stage — the branches a turn took", () => {
  // The shipped `model_stage` families: `escalate` (strategy `cascade` or
  // `model_directed`), `guide`, `shadow`, `committee`, `member`, `tie-break`
  // and `consult`. The default here is the cascade's escalation rung.
  const stage = (over: Record<string, unknown>) =>
    events.R.model_stage({
      kind: "model_stage",
      stage: "escalate",
      strategy: "cascade",
      role: "escalation",
      model: "claude-opus-4-8",
      outcome: "started",
      ...over,
    });

  test("a started stage names the strategy and the stage", () => {
    const o = stage({});
    expect(o.name).toBe("cascade · escalate");
    expect(o.title).toBe("started");
    expect(o.icon).toBe("play");
    expect(o.sub).toBe("claude-opus-4-8");
    expect(o.badge).toBe("escalation");
  });

  test("a done stage carries its own spend", () => {
    const o = stage({ outcome: "done", profile: "strong", costUsdMicros: 1200 });
    expect(o.title).toBe("done");
    expect(o.sev).toBe("accent");
    expect(o.sub).toBe("claude-opus-4-8 · profile strong");
    expect(o.meta).toBe("$1200");
  });

  test("a skipped stage says WHY through `cause`, and is not an error", () => {
    const o = stage({ outcome: "skipped", cause: "max_escalations" });
    expect(o.name).toBe("cascade · escalate");
    expect(o.title).toBe("skipped — max_escalations");
    expect(o.sev).toBe("muted"); // a cascade that never needed its strong rung is the GOOD case
  });

  test("a failed stage reads as an error", () => {
    const o = stage({ outcome: "failed", cause: "upstream 529" });
    expect(o.icon).toBe("alert");
    expect(o.sev).toBe("error");
    expect(o.title).toBe("failed — upstream 529");
  });

  test("a side-call stage renders under its own strategy", () => {
    const o = stage({ stage: "guide", strategy: "guide", role: "guide", model: "claude-haiku-4-5" });
    expect(o.name).toBe("guide · guide");
    expect(o.badge).toBe("guide");
  });

  // The runtime publishes a stage line only for the rungs and side calls that
  // BRANCH a turn. A cascade's draft rung and its judge call are attribution on
  // `model_response` / `cost_accrual` (`role: "draft"` + `stage draft`,
  // `role: "judge"` + `stage verify`), never `model_stage` — so the escalation
  // pair below is the whole stage story a failing cascade tells.
  test("an escalating cascade reads as the draft's badge then one escalate pair", () => {
    const draft = events.R.model_response({
      kind: "model_response",
      model: "claude-haiku-4-5",
      usage: { input: 100, output: 40 },
      stopReason: "end_turn",
      durationMs: 400,
      role: "draft",
      stage: "draft",
    });
    // `role: "draft"` and `stage: "draft"` are the same word, so attribution()
    // says it once. The judge's differ, so both show.
    expect(draft.badge).toBe("draft");
    expect(String(draft.sub)).toContain("role draft");

    const judge = events.R.cost_accrual({
      kind: "cost_accrual",
      modelId: "claude-haiku-4-5",
      inputTokens: 200,
      outputTokens: 20,
      costUsdMicros: 300,
      role: "judge",
      stage: "verify",
    });
    expect(judge.badge).toBe("judge");
    expect(String(judge.sub)).toContain("role judge · stage verify");

    const story = [
      stage({ stage: "escalate", role: "escalation", outcome: "started" }),
      stage({ stage: "escalate", role: "escalation", outcome: "done", costUsdMicros: 8000 }),
    ].map((o) => `${o.name} ${o.title}`);
    expect(story).toEqual(["cascade · escalate started", "cascade · escalate done"]);
  });

  test("a cascade the draft satisfied publishes only the skipped escalation", () => {
    const o = stage({
      stage: "escalate",
      role: "escalation",
      outcome: "skipped",
      cause: "max_escalations",
    });
    expect(`${o.name} ${o.title}`).toBe("cascade · escalate skipped — max_escalations");
  });

  test("a self-escalation is the `model_directed` strategy, not `cascade`", () => {
    const o = stage({
      strategy: "model_directed",
      stage: "escalate",
      role: "escalation",
      outcome: "started",
      cause: "self",
    });
    expect(o.name).toBe("model_directed · escalate");
    expect(o.title).toBe("started — self");
  });

  test("no cost is not $0 — the meta stays empty when the stage reports none", () => {
    expect(stage({ outcome: "done" }).meta).toBe("");
  });

  test("an unknown outcome still renders (forward-compatible)", () => {
    const o = stage({ outcome: "cancelled" as unknown as string });
    expect(o.title).toBe("cancelled");
    expect(o.icon).toBe("layers");
  });

  test("a primary-role stage shows no role badge", () => {
    expect(stage({ role: "primary" }).badge).toBe("");
  });
});

describe("v0.6.0 model_directive — a /model pin", () => {
  test("an accepted directive names what it resolved to", () => {
    const o = events.R.model_directive({
      kind: "model_directive",
      source: "repl",
      requested: "fast",
      resolved: "claude-haiku-4-5",
      accepted: true,
    });
    expect(o.name).toBe("/model fast");
    expect(o.title).toBe("pinned -> claude-haiku-4-5");
    expect(o.sev).toBe("accent");
    expect(o.badge).toBe("repl");
    expect(o.badgeKind).toBe("ok");
  });

  test("a directive that resolves to itself does not repeat itself", () => {
    const o = events.R.model_directive({
      kind: "model_directive",
      source: "seed",
      requested: "fast",
      resolved: "fast",
      accepted: true,
    });
    expect(o.title).toBe("pinned");
  });

  test("a refused directive carries the runtime's reason", () => {
    const o = events.R.model_directive({
      kind: "model_directive",
      source: "repl",
      requested: "opus",
      accepted: false,
      reason: "unknown arm",
    });
    expect(o.title).toBe("refused");
    expect(o.sub).toBe("unknown arm");
    expect(o.sev).toBe("warn");
    expect(o.badgeKind).toBe("warn");
  });
});

describe("v0.6.0 model_route — the routing detail behind the pick", () => {
  test("a 0.5.x route line renders exactly as before", () => {
    const o = events.R.model_route({
      kind: "model_route",
      routeKey: "hard",
      model: "claude-opus-4-8",
      policy: "learned",
      reason: "highest reward",
    });
    expect(o.sub).toBe("highest reward"); // no trailing separator, no empty detail
    expect(o.sev).toBe("info");
    expect(o.badge).toBe("hard");
  });

  test("strategy, profile, rule, scope and eligibility land on the detail line", () => {
    const o = events.R.model_route({
      kind: "model_route",
      routeKey: "hard",
      model: "claude-haiku-4-5",
      specModel: "anthropic/claude-haiku-4-5",
      policy: "rule",
      reason: "matched",
      strategy: "cascade",
      stage: "draft",
      profile: "fast",
      ruleId: "short-prompts",
      scope: "step:summarise",
      eligible: ["fast", "strong"],
    });
    expect(o.sub).toBe(
      "matched · cascade · draft · profile fast · spec anthropic/claude-haiku-4-5 · " +
        "rule short-prompts · scope step:summarise · 2 eligible",
    );
  });

  test("a floor-blocked exploit is the one route worth a colour", () => {
    const o = events.R.model_route({
      kind: "model_route",
      routeKey: "easy",
      model: "claude-sonnet-5",
      policy: "learned",
      reason: "floor-blocked",
      floor: { arm: "strong", status: "blocked", blocked: ["fast"] },
      backedOffTo: "easy",
    });
    expect(o.sev).toBe("warn");
    // `floor.arm` is the FLOOR arm — on `blocked` it is the arm that SERVED,
    // and `floor.blocked` is the set it kept out. Naming only one of them
    // reads as "strong was blocked", which is the opposite of what happened.
    expect(String(o.sub)).toContain("floor served strong");
    expect(String(o.sub)).toContain("refused fast");
    expect(String(o.sub)).toContain("backed off to easy");
  });

  test("a classifier verdict and a preRoute hint are named", () => {
    const o = events.R.model_route({
      kind: "model_route",
      routeKey: "hard",
      model: "claude-opus-4-8",
      policy: "classifier",
      reason: "labelled",
      classifierVerdict: { label: "code", model: "claude-haiku-4-5" },
      hint: { source: "directive" },
    });
    expect(String(o.sub)).toContain("label code");
    expect(String(o.sub)).toContain("hint directive");
  });
});

describe("v0.6.0 attribution on model_response / cost_accrual", () => {
  test("an unattributed response renders exactly as before", () => {
    const o = events.R.model_response({
      kind: "model_response",
      model: "claude-sonnet-5",
      usage: { input: 100, output: 40 },
      stopReason: "end_turn",
      durationMs: 900,
    });
    expect(o.sub).toBe("100 in · 40 out · end_turn");
    expect(o.badge).toBe("");
  });

  test("a judge response is badged and labelled", () => {
    const o = events.R.model_response({
      kind: "model_response",
      model: "claude-haiku-4-5",
      role: "judge",
      stage: "verify",
      profile: "cheap-judge",
      usage: { input: 10, output: 5 },
      stopReason: "end_turn",
      durationMs: 200,
    });
    expect(o.badge).toBe("judge");
    expect(o.sub).toBe("10 in · 5 out · end_turn · role judge · stage verify · profile cheap-judge");
  });

  test("the adapter's silent parameter drop is finally visible", () => {
    const o = events.R.model_response({
      kind: "model_response",
      model: "claude-opus-4-8",
      usage: { input: 1, output: 1 },
      stopReason: "end_turn",
      durationMs: 1,
      effectiveParams: { model: "claude-opus-4-8", maxTokens: 4096, dropped: ["temperature"] },
    });
    expect(String(o.sub)).toContain("dropped temperature");
  });

  test("an adapter that dropped nothing says nothing", () => {
    const o = events.R.model_response({
      kind: "model_response",
      model: "claude-sonnet-5",
      usage: { input: 1, output: 1 },
      stopReason: "end_turn",
      durationMs: 1,
      effectiveParams: { model: "claude-sonnet-5", maxTokens: 4096, dropped: [] },
    });
    expect(o.sub).toBe("1 in · 1 out · end_turn");
  });

  test("an unattributed cost line renders exactly as before", () => {
    const o = events.R.cost_accrual({
      kind: "cost_accrual",
      modelId: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 40,
      costUsdMicros: 1500,
    });
    expect(o.sub).toBe("100 in · 40 out");
    expect(o.badge).toBe("");
  });

  test("an escalation's cost line says whose spend it is", () => {
    const o = events.R.cost_accrual({
      kind: "cost_accrual",
      modelId: "claude-opus-4-8",
      role: "escalation",
      profile: "strong",
      inputTokens: 100,
      outputTokens: 40,
      costUsdMicros: 9000,
    });
    expect(o.badge).toBe("escalation");
    expect(o.sub).toBe("100 in · 40 out · role escalation · profile strong");
  });

  test("both new kinds have a renderer and reach the feed", () => {
    for (const k of ["model_stage", "model_directive"]) {
      expect(typeof events.R[k]).toBe("function");
      expect(events.FEED_SKIP.has(k)).toBe(false);
    }
    expect(
      events.render({
        kind: "model_stage",
        stage: "draft",
        strategy: "cascade",
        role: "draft",
        model: "m",
        outcome: "done",
      }),
    ).not.toBeNull();
    expect(
      events.render({ kind: "model_directive", source: "repl", requested: "fast", accepted: true }),
    ).not.toBeNull();
  });
});

describe("v0.6.0 spend by role and by profile", () => {
  type Row = { key: string; calls: number; costMicros: number; tokensIn: number; tokensOut: number };
  type Stats = Record<string, never>;
  const mod = () =>
    events as unknown as {
      newStats: () => Stats;
      accrue: (e: unknown, s: Stats) => Stats;
      spendByRole: (s: Stats) => Row[];
      spendByProfile: (s: Stats) => Row[];
      spendTitle: (s: Stats) => string;
    };

  /** One model call: the response (tokens) and the accrual (cost) it produces. */
  function call(s: Stats, over: Record<string, unknown>, cost: number, tokens: [number, number]) {
    const { accrue } = mod();
    accrue({ kind: "model_response", usage: { input: tokens[0], output: tokens[1] }, ...over }, s);
    accrue(
      {
        kind: "cost_accrual",
        modelId: "m",
        costUsdMicros: cost,
        inputTokens: tokens[0],
        outputTokens: tokens[1],
        ...over,
      },
      s,
    );
    return s;
  }

  test("an unattributed run lands entirely in `primary`", () => {
    const { newStats, spendByRole, spendByProfile, spendTitle } = mod();
    const s = call(newStats(), {}, 1500, [100, 40]);
    expect(spendByRole(s)).toEqual([
      { key: "primary", calls: 1, costMicros: 1500, tokensIn: 100, tokensOut: 40 },
    ]);
    // A call that resolved no profile is GROUPED, never dropped — the rows
    // must always sum to the tile's own number.
    expect(spendByProfile(s)).toEqual([
      { key: "(none)", calls: 1, costMicros: 1500, tokensIn: 100, tokensOut: 40 },
    ]);
    // Nothing to break down ⇒ no tooltip at all, rather than one that says
    // "primary" / "(none)" and nothing else.
    expect(spendTitle(s)).toBe("");
  });

  test("a cascade splits by role and by profile without disturbing the totals", () => {
    const { newStats, spendByRole, spendByProfile } = mod();
    const s = newStats();
    call(s, { role: "draft", profile: "fast" }, 1000, [100, 20]);
    call(s, { role: "judge", profile: "fast" }, 500, [50, 10]);
    call(s, { role: "escalation", profile: "strong" }, 8000, [100, 60]);
    const flat = s as unknown as { costMicros: number; tokensIn: number; tokensOut: number };
    expect(flat.costMicros).toBe(9500);
    expect(flat.tokensIn).toBe(250);
    expect(flat.tokensOut).toBe(90);

    const roles = spendByRole(s);
    expect(roles.map((r) => r.key)).toEqual(["escalation", "draft", "judge"]); // dearest first
    expect(roles.reduce((n, r) => n + r.costMicros, 0)).toBe(flat.costMicros);
    expect(roles.reduce((n, r) => n + r.tokensIn, 0)).toBe(flat.tokensIn);

    const profiles = spendByProfile(s);
    expect(profiles).toEqual([
      { key: "strong", calls: 1, costMicros: 8000, tokensIn: 100, tokensOut: 60 },
      { key: "fast", calls: 2, costMicros: 1500, tokensIn: 150, tokensOut: 30 },
    ]);
  });

  test("a run with unattributed calls still has profile rows that sum to the total", () => {
    const { newStats, spendByProfile, spendTitle } = mod();
    const s = newStats();
    call(s, {}, 5_000_000, [100, 40]); // the main turn, on no `models:` profile
    call(s, { role: "judge", profile: "cheap" }, 500_000, [50, 10]);
    const flat = s as unknown as { costMicros: number; tokensIn: number };
    const profiles = spendByProfile(s);
    expect(profiles.map((r) => r.key)).toEqual(["(none)", "cheap"]);
    expect(profiles.reduce((n, r) => n + r.costMicros, 0)).toBe(flat.costMicros);
    expect(profiles.reduce((n, r) => n + r.tokensIn, 0)).toBe(flat.tokensIn);
    // …and the tooltip says where the remainder went rather than hiding 91%.
    expect(spendTitle(s)).toContain("By profile: (none) $5000000 · cheap $500000");
  });

  test("auxiliary spend (judge/guide/…) is tracked apart from the answer's own rungs", () => {
    const { newStats } = mod();
    const s = newStats();
    call(s, { role: "draft" }, 1000, [10, 10]);
    call(s, { role: "escalation" }, 4000, [10, 10]);
    call(s, { role: "judge" }, 300, [10, 10]);
    call(s, { role: "compaction" }, 200, [10, 10]);
    call(s, {}, 700, [10, 10]);
    const flat = s as unknown as { auxCostMicros: number; costMicros: number };
    expect(flat.auxCostMicros).toBe(500); // judge + compaction only
    expect(flat.costMicros).toBe(6200);
  });

  test("the optimizer's ROLE-LESS run total is still ignored by the split", () => {
    const { newStats, accrue, spendByRole } = mod();
    const s = newStats();
    // A sum over per-call accruals already folded here — counting it doubles
    // the run's spend.
    accrue({ kind: "cost_accrual", summary: true, costUsdMicros: 9999 }, s);
    expect(spendByRole(s)).toEqual([]);
    expect((s as unknown as { costMicros: number }).costMicros).toBe(0);
  });

  test("a nested run's ROLE-BEARING roll-up is folded", () => {
    const { newStats, accrue, spendByRole, spendByProfile } = mod();
    const s = newStats();
    // @crewhaus/sub-agent-spawner re-publishes the child's whole spend on the
    // PARENT bus as one summary accrual. The child ran on its own event bus,
    // which carries no printer, so its per-call lines never reach this stream
    // — drop this and the Cost tile is a whole child run behind the runtime's
    // budget meter.
    accrue(
      {
        kind: "cost_accrual",
        summary: true,
        role: "subagent",
        profile: "fast",
        modelId: "claude-haiku-4-5",
        costUsdMicros: 7_000_000,
        inputTokens: 900,
        outputTokens: 300,
      },
      s,
    );
    expect((s as unknown as { costMicros: number }).costMicros).toBe(7_000_000);
    expect(spendByRole(s).map((r) => [r.key, r.costMicros])).toEqual([["subagent", 7_000_000]]);
    expect(spendByProfile(s).map((r) => [r.key, r.costMicros])).toEqual([["fast", 7_000_000]]);
  });

  test("a roll-up in an auxiliary role lands in the auxiliary total too", () => {
    const { newStats, accrue } = mod();
    const s = newStats();
    accrue(
      { kind: "cost_accrual", summary: true, role: "guide", costUsdMicros: 4000, inputTokens: 10, outputTokens: 5 },
      s,
    );
    expect((s as unknown as { auxCostMicros: number }).auxCostMicros).toBe(4000);
  });

  test("spendTitle summarises both groupings", () => {
    const { newStats, spendTitle } = mod();
    const s = newStats();
    call(s, { role: "draft", profile: "fast" }, 1000, [10, 10]);
    call(s, { role: "judge", profile: "fast" }, 500, [10, 10]);
    expect(spendTitle(s)).toBe("By role: draft $1000 · judge $500\nBy profile: fast $1500");
  });

  test("a role name off the wire cannot reach Object.prototype", () => {
    const { newStats, accrue, spendByRole } = mod();
    const s = newStats();
    accrue({ kind: "cost_accrual", role: "__proto__", costUsdMicros: 5, inputTokens: 1, outputTokens: 1 }, s);
    expect(({} as Record<string, unknown>).costMicros).toBeUndefined();
    expect(spendByRole(s).map((r) => r.key)).toEqual(["__proto__"]);
  });

  test("newStats() hands back fresh maps (a re-run does not inherit the last one)", () => {
    const { newStats, spendByRole } = mod();
    const first = call(newStats(), { role: "judge" }, 100, [1, 1]);
    const second = newStats();
    expect(spendByRole(first)).toHaveLength(1);
    expect(spendByRole(second)).toEqual([]);
  });
});
