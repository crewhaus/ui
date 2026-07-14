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
