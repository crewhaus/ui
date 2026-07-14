/* ============================================================================
   CrewHaus Shape UI — run-failure vocabulary (v0.3.0 honest failure messaging).

   Pure, DOM-free helpers shared by every shape frontend:
     - the CrewHaus exit-code table (documented in factory's CLI-REFERENCE),
     - `exitInfo(statusMsg)` — everything a frontend needs to explain a
       `{ type:"status", state:"exited" }` broadcast (code, label, one-liner,
       plus the host-attached `failure` event / `stderrTail`),
     - `splitMessage(message)` — split a `run_failed.message` ("<title>: <detail>")
       back into its title and raw-provider-text halves.

   DOM-free by design so it can be unit-tested without a browser (see
   test/failure.test.ts). Card RENDERING lives in events.js, which has DOM.

   Exposes CH.failure = { EXIT_LABELS, exitCodeOf, exitInfo, splitMessage }
   ========================================================================== */
(function () {
  "use strict";

  /**
   * Exit-code table from `@crewhaus/errors` (factory v0.3.0):
   *   0 ok · 1 generic · 20 spec · 21 config/missing-env · 30 auth ·
   *   31 provider funding · 32 quota/rate-limit · 33 crewhaus budget · 40 tool/MCP.
   * Code 0 and unknown codes carry no label (generic rendering).
   */
  const EXIT_LABELS = {
    1: "unclassified error",
    20: "spec error",
    21: "config / missing env",
    30: "provider rejected the credentials (auth)",
    31: "out of funding (provider billing)",
    32: "provider rate/quota limit",
    33: "budget cap reached",
    40: "tool/MCP failure",
  };

  /**
   * Extract the numeric exit code from a status broadcast. Prefers the
   * structured `exitCode` field (hosts >= this change attach it); falls back
   * to parsing the human `detail` string ("exit code 31" / "exit 31") so the
   * frontend still labels exits from an older host.
   */
  function exitCodeOf(msg) {
    if (msg && typeof msg.exitCode === "number" && Number.isFinite(msg.exitCode)) {
      return msg.exitCode;
    }
    const m = /exit(?:\s+code)?\s+(-?\d+)/i.exec((msg && msg.detail) || "");
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * Everything a frontend needs to render an exit:
   *   code       number|null  — exit code, if known
   *   failed     boolean      — true only for a known NONZERO exit
   *   label      string|null  — short human label from EXIT_LABELS
   *   line       string|null  — "out of funding (provider billing) · exit 31",
   *                             or "exit 5" when the code is unlabeled
   *   failure    object|null  — the run's last `run_failed` event (host-attached)
   *   stderrTail string[]|null — last stderr lines (host-attached fallback)
   */
  function exitInfo(msg) {
    const code = exitCodeOf(msg);
    const label = code !== null && EXIT_LABELS[code] ? EXIT_LABELS[code] : null;
    const failed = code !== null && code !== 0;
    const line = code === null ? null : label ? `${label} · exit ${code}` : `exit ${code}`;
    const failure = msg && msg.failure && typeof msg.failure === "object" ? msg.failure : null;
    const stderrTail = msg && Array.isArray(msg.stderrTail) && msg.stderrTail.length > 0 ? msg.stderrTail : null;
    return { code, failed, label, line, failure, stderrTail };
  }

  /**
   * `run_failed.message` is "<title>: <detail>" (the same text
   * RunFailedError.message carries after its "run stopped — " prefix). The
   * title never contains ": ", so splitting at the FIRST occurrence recovers
   * both halves; `detail` may itself contain colons (`Anthropic said: "…"`).
   */
  function splitMessage(message) {
    const s = typeof message === "string" ? message : "";
    const i = s.indexOf(": ");
    if (i < 0) return { title: s, detail: "" };
    return { title: s.slice(0, i), detail: s.slice(i + 2) };
  }

  const failure = { EXIT_LABELS, exitCodeOf, exitInfo, splitMessage };

  if (typeof window !== "undefined") {
    window.CH = window.CH || {};
    window.CH.failure = failure;
  }
})();
