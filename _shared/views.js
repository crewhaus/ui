/* ============================================================================
   CrewHaus Shape UI — live panel views (Phase 3b).

   The 6th shared browser IIFE. Loaded by every shape's index.html AFTER
   panels.js (the Phase-3a framework) and BEFORE app.js. It registers the
   "now-feasible" views — the ones whose data is already on the wire / on the
   host's read routes today — via `CH.panels.register(...)`:

     • tools      — active + recent tool/MCP calls (tool_call + mcp_call events)
     • tasks      — background sub-agents (sub_agent_*) + dream runs (.crewhaus)
     • files      — a file browser + viewer over /harness/ and /crewhaus/
     • artifacts  — harness output artifacts, deep-linked into the files viewer

   Each view declares its `feature` from CH.panels.VIEW_FEATURES so it mounts
   only on shapes whose config.features[] enables it; a shape that enables none
   of these stays pixel-identical (the framework hides the whole rail).

   Every view lazy-mounts, reads live state through `api`, and degrades to an
   empty-state (never an error) when its data is missing — a fresh harness with
   no `.crewhaus/` yet shows "nothing yet", not a stack trace.

   Phase 3c EXTENDS this same module with the memory views (focus/plan/context/
   wiki/skills); it is structured so those slot in as more `register(...)` calls.

   Pure, DOM-free helpers (tool/sub-agent pairing, file-tree build, artifact
   derivation, path→route + link matchers) are exported on `window.CH.views`
   for the unit tests in test/views.test.ts.
   ========================================================================== */
(function () {
  "use strict";
  const CH = window.CH;
  const P = CH && CH.panels;
  if (!P) return; // panels.js must load first; nothing to do without it.

  // ── Pure helpers (DOM-free; unit-tested) ─────────────────────────────────

  /** Correlate a tool/MCP event to its pair. tool_call_* carry a `toolUseId`;
      mcp_call_* do not, so fall back to the envelope `spanId`, then to
      `server.toolName`. */
  function toolKey(ev) {
    if (ev.kind === "tool_call_start" || ev.kind === "tool_call_end") {
      return "t:" + (ev.toolUseId || ev.spanId || ev.toolName || "?");
    }
    return "m:" + (ev.spanId || `${ev.server}.${ev.toolName}`);
  }

  /**
   * Pair tool/MCP start+end events into ordered records. Concurrent calls that
   * share a fallback key are matched LIFO; an end with no matching start
   * synthesizes a completed record so nothing is silently dropped.
   * Record: { key, kind:"tool"|"mcp", name, status:"running"|"ok"|"error",
   *           inputBytes, outputBytes, durationMs, seq }
   */
  function pairTools(events) {
    const records = [];
    const open = new Map(); // key -> stack of record indices still running
    let seq = 0;
    for (const ev of events || []) {
      if (!ev || typeof ev.kind !== "string") continue;
      const k = ev.kind;
      if (k === "tool_call_start" || k === "mcp_call_start") {
        const isMcp = k === "mcp_call_start";
        const rec = {
          key: toolKey(ev),
          kind: isMcp ? "mcp" : "tool",
          name: isMcp ? `${ev.server}.${ev.toolName}` : ev.toolName,
          status: "running",
          inputBytes: isMcp ? null : ev.inputBytes ?? null,
          outputBytes: null,
          durationMs: null,
          seq: seq++,
        };
        records.push(rec);
        const arr = open.get(rec.key) || [];
        arr.push(records.length - 1);
        open.set(rec.key, arr);
      } else if (k === "tool_call_end" || k === "mcp_call_end") {
        const isMcp = k === "mcp_call_end";
        const key = toolKey(ev);
        const arr = open.get(key);
        let rec;
        if (arr && arr.length) {
          rec = records[arr.pop()];
        } else {
          rec = {
            key,
            kind: isMcp ? "mcp" : "tool",
            name: isMcp ? `${ev.server}.${ev.toolName}` : ev.toolName,
            status: "running",
            inputBytes: null,
            outputBytes: null,
            durationMs: null,
            seq: seq++,
          };
          records.push(rec);
        }
        rec.status = ev.isError ? "error" : "ok";
        if (!isMcp) rec.outputBytes = ev.outputBytes ?? null;
        rec.durationMs = ev.durationMs ?? null;
      }
    }
    return records;
  }

  /**
   * Pair sub_agent_start/end into ordered records, keyed by childRunId.
   * Record: { childRunId, childSessionId, name, status, toolCount,
   *           toolCallCount, finalMessageBytes, durationMs, seq }
   */
  function pairSubAgents(events) {
    const records = [];
    const byRun = new Map();
    let seq = 0;
    for (const ev of events || []) {
      if (!ev || typeof ev.kind !== "string") continue;
      if (ev.kind === "sub_agent_start") {
        const rec = {
          childRunId: ev.childRunId ?? null,
          childSessionId: ev.childSessionId ?? null,
          name: ev.name,
          status: "running",
          toolCount: ev.toolCount ?? null,
          toolCallCount: null,
          finalMessageBytes: null,
          durationMs: null,
          seq: seq++,
        };
        records.push(rec);
        if (ev.childRunId) byRun.set(ev.childRunId, rec);
      } else if (ev.kind === "sub_agent_end") {
        let rec = ev.childRunId ? byRun.get(ev.childRunId) : null;
        if (!rec) {
          rec = {
            childRunId: ev.childRunId ?? null,
            childSessionId: ev.childSessionId ?? null,
            name: ev.name,
            status: "running",
            toolCount: null,
            toolCallCount: null,
            finalMessageBytes: null,
            durationMs: null,
            seq: seq++,
          };
          records.push(rec);
        }
        rec.status = ev.isError ? "error" : "ok";
        rec.toolCallCount = ev.toolCallCount ?? null;
        rec.finalMessageBytes = ev.finalMessageBytes ?? null;
        rec.durationMs = ev.durationMs ?? null;
        rec.childSessionId = rec.childSessionId || ev.childSessionId || null;
      }
    }
    return records;
  }

  /** Build a nested folder tree from a flat list of "a/b/c.ts" paths.
      Returns top-level nodes: { name, path, dir, children[] } (dirs first,
      then case-insensitive name order). */
  function buildFileTree(paths) {
    const root = { children: [], _map: new Map() };
    for (const p of paths || []) {
      const parts = String(p).split("/").filter(Boolean);
      let node = root;
      let acc = "";
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        acc = acc ? `${acc}/${part}` : part;
        const leaf = i === parts.length - 1;
        let child = node._map.get(part);
        if (!child) {
          child = { name: part, path: acc, dir: !leaf, children: [], _map: new Map() };
          node._map.set(part, child);
          node.children.push(child);
        }
        if (!leaf) child.dir = true;
        node = child;
      }
    }
    const sort = (n) => {
      n.children.sort((a, b) =>
        a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
      );
      delete n._map;
      n.children.forEach(sort);
    };
    sort(root);
    return root.children;
  }

  const ART_BASENAMES = {
    "grades.json": "eval",
    "results.json": "eval",
    "transcript.jsonl": "eval",
    "events.jsonl": "eval",
  };
  const IMG_RE = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;
  const OUT_DIR_RE = /(^|\/)(out|outputs|output|artifacts|screenshots|results|reports)\//i;
  const EXCLUDE_DIR_RE = /(^|\/)(node_modules|dist|build|\.git|\.crewhaus)\//;

  /** Derive the output-artifact list from a flat harness file list. Matches
      eval bundle outputs (grades/results/transcript/events), research-style
      report*.md, generated images, and anything under an out/outputs/artifacts/
      screenshots/results/reports dir. Bundle/deps dirs are excluded. */
  function deriveArtifacts(files) {
    const out = [];
    const seen = new Set();
    for (const f of files || []) {
      if (typeof f !== "string" || EXCLUDE_DIR_RE.test(`/${f}`)) continue;
      const base = f.split("/").pop();
      let kind = null;
      if (ART_BASENAMES[base]) kind = ART_BASENAMES[base];
      else if (/^report[\w.\-]*\.md$/i.test(base)) kind = "report";
      else if (IMG_RE.test(base)) kind = "image";
      else if (OUT_DIR_RE.test(`/${f}`)) kind = "output";
      if (!kind || seen.has(f)) continue;
      seen.add(f);
      const icon =
        kind === "image" ? "eye" : kind === "report" ? "book" : kind === "eval" ? "flask" : "package";
      out.push({ path: f, label: base, kind, icon, dir: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "" });
    }
    return out;
  }

  /** Map a mentioned path to the read route that serves it. `.crewhaus/…`
      (or `crewhaus/…`) → the allowlisted memory route; everything else → the
      harness static route (a leading `harness/` is stripped). */
  function resolvePathRoute(path) {
    let p = String(path || "").replace(/^\.?\//, "");
    if (/^\.?crewhaus\//.test(p)) {
      const sub = p.replace(/^\.?crewhaus\//, "");
      return { route: "crewhaus", subpath: sub, url: `/crewhaus/${sub}` };
    }
    const sub = p.replace(/^harness\//, "");
    return { route: "harness", subpath: sub, url: `/harness/${sub}` };
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  /** Find whole-word mentions of any known sub-agent name (≥4 chars) in text.
      Returns scanLinks-style hits routing to the background-tasks view. */
  function matchTaskNames(text, names) {
    const hits = [];
    if (!text || !names) return hits;
    for (const name of names) {
      if (typeof name !== "string" || name.length < 4) continue;
      const re = new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`, "g");
      for (const m of text.matchAll(re)) {
        hits.push({ index: m.index, length: name.length, view: "tasks", arg: { name } });
      }
    }
    return hits;
  }

  // File-path extensions the Phase-3a default linkify (source/config/md/lock)
  // does NOT cover — images and data files — routed to the files viewer. This
  // stays disjoint from the default matcher so it never shadows it.
  const EXTRA_FILE_RE =
    /(?:[\w.\-]+\/)*[\w.\-]+\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?|pdf|jsonl|ndjson|csv|tsv|log|xml|wasm|ipynb|parquet)\b/g;

  // ── Memory-file parsers (Phase 3c; DOM-free, unit-tested) ────────────────
  // These mirror the EXACT factory v0.3.0 grammars so the browser can parse the
  // RAW `.crewhaus/` files the host serves (the host never imports @crewhaus/*).
  // Verified against factory tag v0.3.0 (a609f23):
  //   continuity-store/src/index.ts  (renderFocusFile/parseFocusFile,
  //   renderPlanFile/parsePlanFile, REQ_LINE_REGEX, STEP_LINE_REGEX, goals),
  //   continuity-store/src/handoff.ts (renderHandoff / renderStatus).

  const FOCUS_MARKER = "<!-- crewhaus:focus -->";
  const ACTIVE_PLAN_MARKER = "<!-- crewhaus:active-plan -->";
  const REQUIREMENTS_MARKER = "<!-- crewhaus:requirements -->";
  const NONE_LINE = "_none_";
  const LEDGER_TRUNCATED_LINE = "[ledger truncated]";
  const PLAN_ID_RE = /^plan-\d{4}$/;
  // Factory REQ_LINE_REGEX — group 3 keeps the surrounding quotes and is
  // JSON.parse()'d to recover the verbatim (possibly escaped) user text.
  const REQ_LINE_RE =
    /^- (REQ-\d{3,}) \[(open|confirmed|dropped)\] (".*") \(user, (sess_[0-9a-f]{16}), turn (\d+)\)$/;
  // Factory STEP_LINE_REGEX, applied to a trimmed line.
  const STEP_LINE_RE = /^(\d+)\. \[(open|in_progress|claimed|proven)\] (.+)$/;
  const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

  /**
   * Parse `focus.md` → { body, activePlan, requirements[], ledgerTruncated,
   * present }. Byte-for-byte the inverse of factory `parseFocusFile`: the file
   * MUST open with the focus marker (else it is a user-authored file we don't
   * own → present:false); the body is everything between `# Focus` and the
   * Active-plan header; `_none_` maps to a null active plan; each requirement is
   * a REQ ledger line whose verbatim text is JSON-decoded and presented as-is.
   */
  function parseFocus(raw) {
    raw = String(raw == null ? "" : raw);
    if (!raw.trimStart().startsWith(FOCUS_MARKER)) {
      return { body: "", activePlan: null, requirements: [], ledgerTruncated: false, present: false };
    }
    const activeHeader = `## Active plan\n${ACTIVE_PLAN_MARKER}`;
    const reqHeader = `## Requirements\n${REQUIREMENTS_MARKER}`;
    const activeIdx = raw.indexOf(activeHeader);
    const reqIdx = raw.indexOf(reqHeader);
    const afterMarker = raw.indexOf(FOCUS_MARKER) + FOCUS_MARKER.length;
    const bodyEnd = activeIdx >= 0 ? activeIdx : reqIdx >= 0 ? reqIdx : raw.length;
    const body = raw.slice(afterMarker, bodyEnd).replace(/^\s*# Focus\s*\n/, "").trim();

    let activePlan = null;
    if (activeIdx >= 0) {
      const start = activeIdx + activeHeader.length;
      const end = reqIdx >= 0 ? reqIdx : raw.length;
      const line = (raw.slice(start, end).trim().split("\n")[0] || "").trim();
      if (PLAN_ID_RE.test(line)) activePlan = line;
    }

    const requirements = [];
    let ledgerTruncated = false;
    if (reqIdx >= 0) {
      for (const l of raw.slice(reqIdx + reqHeader.length).split("\n").map((s) => s.trim())) {
        if (l === LEDGER_TRUNCATED_LINE) {
          ledgerTruncated = true;
          continue;
        }
        const m = l.match(REQ_LINE_RE);
        if (!m) continue;
        let text;
        try {
          text = JSON.parse(m[3]); // verbatim user words — never a re-render
        } catch {
          continue; // hand-mangled line — skip rather than mis-attribute
        }
        requirements.push({ id: m[1], status: m[2], text, sessionId: m[4], turn: Number(m[5]) });
      }
    }
    return { body, activePlan, requirements, ledgerTruncated, present: true };
  }

  /** Count requirements by ledger status. Pure; unit-tested. */
  function summarizeRequirements(reqs) {
    const s = { open: 0, confirmed: 0, dropped: 0, total: 0 };
    for (const r of reqs || []) {
      if (!r || typeof r.status !== "string") continue;
      if (Object.prototype.hasOwnProperty.call(s, r.status)) s[r.status]++;
      s.total++;
    }
    return s;
  }

  // A tiny YAML scalar reader for the small, machine-generated documents
  // CrewHaus writes (plan frontmatter + goals.yaml). Handles plain, "double"
  // and 'single' quoted scalars, numbers, booleans and null — the only shapes
  // the `yaml` lib emits here. NOT a general YAML parser (no flow collections).
  function yScalar(s) {
    s = String(s == null ? "" : s).trim();
    if (s === "" || s === "~" || s === "null") return null;
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d*\.\d+$/.test(s)) return Number(s);
    if (s[0] === '"') {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1).replace(/"$/, "");
      }
    }
    if (s[0] === "'") return s.slice(1).replace(/'$/, "").replace(/''/g, "'");
    return s;
  }

  /** Read the top-level `key: value` scalars from a YAML frontmatter block
      (nested blocks like `proofs:` are indented and skipped here). */
  function frontmatterScalars(fmText) {
    const fm = {};
    for (const line of String(fmText || "").split("\n")) {
      if (line === "" || /^\s/.test(line)) continue; // indent-0 lines only
      const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (m && m[2] !== "") fm[m[1]] = yScalar(m[2]);
    }
    return fm;
  }

  /** Best-effort extract of the plan frontmatter `proofs` map
      ({ "<stepIndex>": FrozenProof[] }) → { <stepIndex>: [toolUseId, …] }.
      A focused line scanner (not a full YAML parser) keyed off `proofs:` →
      `"<n>":` → `toolUseId:` lines; tolerant of indentation. */
  function extractProofs(fmText) {
    const out = {};
    let inProofs = false;
    let proofsIndent = -1;
    let curStep = null;
    for (const line of String(fmText || "").split("\n")) {
      if (/^\s*$/.test(line)) continue;
      const indent = line.length - line.replace(/^ +/, "").length;
      const text = line.slice(indent);
      if (!inProofs) {
        if (/^proofs\s*:\s*$/.test(text)) {
          inProofs = true;
          proofsIndent = indent;
        }
        continue;
      }
      if (indent <= proofsIndent) {
        inProofs = false;
        curStep = null;
        continue;
      }
      const stepKey = text.match(/^(?:"(\d+)"|'(\d+)'|(\d+))\s*:\s*$/);
      if (stepKey) {
        curStep = stepKey[1] || stepKey[2] || stepKey[3];
        out[curStep] = out[curStep] || [];
        continue;
      }
      if (curStep != null) {
        const m = text.match(/^-?\s*toolUseId\s*:\s*(.+)$/);
        if (m) out[curStep].push(yScalar(m[1]));
      }
    }
    return out;
  }

  /**
   * Parse a `plan-NNNN-*.md` file → { frontmatter:{id,slug,title,createdAt,
   * updatedAt}, steps:[{n,status,text,proofs[]}] }. Mirrors factory
   * `parsePlanFile`: steps come from the body via STEP_LINE_REGEX and are
   * numbered by POSITION (not the literal digit); a step's proofs come from the
   * frontmatter `proofs` map keyed by that position. The claimed↔proven
   * distinction is preserved verbatim: `claimed` carries no proofs (a free,
   * UNVERIFIED claim); `proven` carries the machine-verified evidence toolUseId.
   */
  function parsePlan(raw) {
    raw = String(raw == null ? "" : raw);
    const fmMatch = raw.match(FRONTMATTER_RE);
    const fmText = fmMatch ? fmMatch[1] : "";
    const fm = frontmatterScalars(fmText);
    const proofs = extractProofs(fmText);
    const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    const steps = [];
    for (const line of body.split("\n")) {
      const m = line.trim().match(STEP_LINE_RE);
      if (!m) continue;
      const n = steps.length + 1; // position-based, like factory
      steps.push({ n, status: m[2], text: m[3].trim(), proofs: proofs[String(n)] || [] });
    }
    const id = typeof fm.id === "string" ? fm.id : "";
    return {
      frontmatter: {
        id,
        slug: typeof fm.slug === "string" ? fm.slug : "",
        title: typeof fm.title === "string" ? fm.title : id,
        createdAt: typeof fm.createdAt === "string" ? fm.createdAt : "",
        updatedAt: typeof fm.updatedAt === "string" ? fm.updatedAt : "",
      },
      steps,
    };
  }

  /**
   * Parse `goals.yaml` (`{version, goals:[{id,title,status,target?,current?,
   * unit?,…}]}`) → the goals array. A focused block reader for the `yaml`-lib
   * output (block sequence of mappings, 2-space indent); returns only
   * well-shaped goals (string id/title/status). Malformed input → [].
   */
  function parseGoals(raw) {
    const lines = String(raw == null ? "" : raw).replace(/\r/g, "").split("\n");
    const goals = [];
    let inGoals = false;
    let cur = null;
    let itemIndent = -1;
    for (const line of lines) {
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
      const indent = line.length - line.replace(/^ +/, "").length;
      const text = line.slice(indent);
      if (!inGoals) {
        if (/^goals\s*:/.test(text) && indent === 0) inGoals = true;
        continue;
      }
      if (text[0] === "-") {
        if (cur) goals.push(cur);
        cur = {};
        itemIndent = indent;
        const rest = text.slice(1).replace(/^ +/, "");
        const kv = rest.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (kv) cur[kv[1]] = yScalar(kv[2]);
        continue;
      }
      if (cur && indent > itemIndent) {
        const kv = text.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (kv && kv[2] !== "") cur[kv[1]] = yScalar(kv[2]);
      } else if (indent === 0) {
        break; // left the goals block, back to a top-level key
      }
    }
    if (cur) goals.push(cur);
    return goals.filter(
      (g) => g && typeof g.id === "string" && typeof g.title === "string" && typeof g.status === "string",
    );
  }

  /** Presentation metadata for a ladder status. Pinning the claimed↔proven
      distinction here (claimed = amber, UNVERIFIED; proven = green, VERIFIED)
      keeps it unit-testable without a DOM. */
  function statusMeta(status) {
    switch (status) {
      case "proven":
        return { cls: "st-proven", label: "proven", note: "verified", verified: true };
      case "claimed":
        return { cls: "st-claimed", label: "claimed", note: "unverified", verified: false };
      case "in_progress":
        return { cls: "st-in-progress", label: "in progress", note: "", verified: false };
      case "confirmed":
        return { cls: "st-confirmed", label: "confirmed", note: "", verified: false };
      case "dropped":
        return { cls: "st-dropped", label: "dropped", note: "", verified: false };
      case "open":
        return { cls: "st-open", label: "open", note: "", verified: false };
      default:
        return { cls: "st-open", label: status || "—", note: "", verified: false };
    }
  }

  /** The `## Next actions` list items from a rendered `handoff.md` (factory
      handoff.ts derives these; `_none_` yields none). */
  function parseHandoffNextActions(raw) {
    raw = String(raw == null ? "" : raw);
    const idx = raw.indexOf("## Next actions");
    if (idx < 0) return [];
    const after = raw.slice(idx + "## Next actions".length);
    const stop = after.search(/\n## /);
    const section = stop >= 0 ? after.slice(0, stop) : after;
    const out = [];
    for (const l of section.split("\n")) {
      const m = l.match(/^\s*-\s+(.*\S)\s*$/);
      if (m && m[1] !== NONE_LINE) out.push(m[1]);
    }
    return out;
  }

  /** Normalize a wiki `index.json` (array of WikiRef) → a stable, defensive
      list. Accepts a parsed array or a raw JSON string. */
  function parseWikiIndex(json) {
    let arr = json;
    if (typeof json === "string") {
      try {
        arr = JSON.parse(json);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e === "object" && typeof e.slug === "string")
      .map((e) => ({
        slug: e.slug,
        title: typeof e.title === "string" ? e.title : e.slug,
        tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === "string") : [],
        confidence: typeof e.confidence === "number" ? e.confidence : null,
        verified: !!e.verified,
        version: typeof e.version === "number" ? e.version : null,
        updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "",
        status: typeof e.status === "string" ? e.status : "",
      }));
  }
  /** Case-insensitive filter over slug/title/tags. */
  function filterWiki(list, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return list || [];
    return (list || []).filter(
      (r) =>
        r.slug.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  /** Most-recently-updated first, then title. */
  function sortWiki(list) {
    return (list || [])
      .slice()
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.title.localeCompare(b.title));
  }

  /** Strip a leading YAML frontmatter block from an article body for rendering. */
  function stripFrontmatter(md) {
    const m = String(md == null ? "" : md).match(FRONTMATTER_RE);
    return m ? String(md).slice(m[0].length) : String(md == null ? "" : md);
  }

  // ── Session-JSONL + live-event derivations (context / skills) ────────────
  /** Parse a `.jsonl` blob into records, skipping blank/malformed lines. */
  function parseJsonl(text) {
    const out = [];
    for (const line of String(text == null ? "" : text).split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* torn / partial line — skip */
      }
    }
    return out;
  }
  /** `context_evicted` records (durable, verbatim) → [{role,text,turnNumber}]. */
  function sessionEvictions(records) {
    const out = [];
    for (const r of records || []) {
      if (!r || r.kind !== "context_evicted") continue;
      const p = r.payload || {};
      out.push({
        role: typeof p.role === "string" ? p.role : "",
        text: typeof p.text === "string" ? p.text : "",
        turnNumber: typeof p.turnNumber === "number" ? p.turnNumber : null,
      });
    }
    return out;
  }
  /**
   * Skills USED this session, aggregated from durable session-JSONL `tool_use`
   * records where the tool name is "Skill" (factory logs the full input JSON,
   * so `payload.input.name` names the skill — the LIVE trace `tool_call_start`
   * carries only byte counts, no args, so it can't name the skill).
   * → [{name,count}] desc by count.
   *
   * NOTE: the "available skills" list (vs used) has no host route or event —
   * skills are discovered at runtime (`discoverSkills` over dirs + builtins);
   * surfacing them needs a future host `discoverSkills` endpoint.
   */
  function aggregateSkills(records) {
    const counts = new Map();
    for (const r of records || []) {
      if (!r || r.kind !== "tool_use") continue;
      const p = r.payload || {};
      if (p.name !== "Skill") continue;
      const name =
        p.input && typeof p.input === "object" && typeof p.input.name === "string"
          ? p.input.name
          : "(unnamed)";
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  /** Live count of Skill tool invocations from the trace ring (no names). */
  function countSkillCalls(events) {
    let n = 0;
    for (const ev of events || []) {
      if (ev && ev.kind === "tool_call_start" && ev.toolName === "Skill") n++;
    }
    return n;
  }

  const NOMINAL_CONTEXT_WINDOW = 200000; // nominal reference only — see §10.4
  /**
   * Accumulate the client-side context proxy from `model_response.usage`
   * (the only live signal — there is NO true window-size event; §10.4). Returns
   * the cumulative input running-total across the session PLUS the last/peak
   * per-turn input and the output total. Honest estimate: cumulative input is
   * not live window occupancy (context is re-sent each turn).
   */
  function accumulateContext(events) {
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let lastInput = 0;
    let peakInput = 0;
    let turns = 0;
    let lastCacheRead = 0;
    for (const ev of events || []) {
      if (!ev || ev.kind !== "model_response" || !ev.usage) continue;
      const u = ev.usage;
      const inp = typeof u.input === "number" ? u.input : 0;
      const out = typeof u.output === "number" ? u.output : 0;
      cumulativeInput += inp;
      cumulativeOutput += out;
      lastInput = inp;
      if (inp > peakInput) peakInput = inp;
      if (typeof u.cacheRead === "number") lastCacheRead = u.cacheRead;
      turns++;
    }
    return { cumulativeInput, cumulativeOutput, lastInput, peakInput, turns, lastCacheRead };
  }
  /** Compaction markers from the LIVE trace (`compaction_fired`: message
      counts + phase). Eviction detail comes from the durable JSONL instead. */
  function collectCompactions(events) {
    const out = [];
    for (const ev of events || []) {
      if (!ev || ev.kind !== "compaction_fired") continue;
      out.push({
        subKind: ev.subKind || "",
        before: typeof ev.before === "number" ? ev.before : null,
        after: typeof ev.after === "number" ? ev.after : null,
        phase: ev.phase || "",
      });
    }
    return out;
  }

  // ── DOM utilities (browser-only; guarded for the DOM-less test env) ──────
  let API = null; // captured on first mount; lets badge() read live state
  const taskNames = new Set(); // sub-agent names learned from the event ring

  const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "ico"]);
  function extOf(name) {
    const i = String(name).lastIndexOf(".");
    return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
  }
  function iconForFile(name) {
    const e = extOf(name);
    if (IMG_EXT.has(e)) return "eye";
    if (e === "md") return "book";
    if (e === "json" || e === "jsonl" || e === "ndjson") return "database";
    return "file";
  }

  function eventsOf() {
    return P.recent("event")
      .map((m) => m && m.event)
      .filter(Boolean);
  }
  function section(title, children) {
    return CH.el("div", { class: "panel-section" }, [
      CH.el("div", { class: "panel-hint", text: title }),
      CH.el("div", { class: "panel-list" }, children),
    ]);
  }
  function empty(text) {
    return CH.el("div", { class: "panel-empty", text });
  }
  function drow(dl, k, v) {
    dl.appendChild(CH.el("dt", { text: k }));
    dl.appendChild(CH.el("dd", { text: v == null || v === "" ? "—" : String(v) }));
  }

  let stylesDone = false;
  function ensureStyles() {
    if (stylesDone || typeof document === "undefined") return;
    stylesDone = true;
    const css = `
    .v-row{display:flex;gap:9px;align-items:flex-start;padding:6px 8px;border:1px solid var(--rule);
      border-radius:var(--radius-sm);background:var(--panel-2);}
    .v-row.is-run{border-color:var(--accent-glow);}
    .v-row.is-err{border-color:rgba(220,90,90,.4);}
    .v-row-ic{flex:0 0 auto;width:16px;height:16px;display:grid;place-items:center;color:var(--ink-2);margin-top:1px;}
    .v-row.is-err .v-row-ic{color:var(--red,#e05a5a);}
    .v-row-main{min-width:0;flex:1;}
    .v-row-title{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink);}
    .v-row-title svg{color:var(--ink-3);}
    .v-row-name{font-family:var(--mono);word-break:break-all;}
    .v-row-sub{font-size:11px;color:var(--ink-3);margin-top:2px;word-break:break-all;}
    .v-row-sub.mono{font-family:var(--mono);}
    .v-tag{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.05em;
      padding:0 4px;border-radius:4px;background:var(--panel-4);color:var(--ink-3);}
    .v-tasks,.v-tasks-agents,.v-tasks-dream{display:flex;flex-direction:column;gap:12px;}
    /* files */
    .v-files{display:flex;flex-direction:column;gap:10px;min-height:0;}
    .v-files-tree{max-height:44vh;overflow:auto;border:1px solid var(--rule);border-radius:var(--radius-sm);
      background:var(--panel-2);padding:4px;}
    .v-tree-row{display:flex;align-items:center;gap:5px;padding:3px 4px;border-radius:4px;cursor:pointer;
      font-size:12.5px;color:var(--ink);white-space:nowrap;}
    .v-tree-row:hover{background:var(--panel-3);}
    .v-tree-row.active{background:var(--accent-ghost);color:var(--accent);}
    .v-tree-row svg{flex:0 0 auto;color:var(--ink-3);}
    .v-tree-row.active svg{color:var(--accent);}
    .v-tree-caret{flex:0 0 auto;width:12px;height:12px;display:inline-grid;place-items:center;color:var(--ink-3);
      transition:transform .12s ease;}
    .v-tree-dir.open>.v-tree-caret{transform:rotate(90deg);}
    .v-tree-name{overflow:hidden;text-overflow:ellipsis;font-family:var(--mono);}
    .v-tree-children{padding-left:13px;border-left:1px solid var(--rule);margin-left:8px;}
    .v-tree-loading{font-size:11px;color:var(--ink-3);padding:2px 6px;}
    .v-files-viewer{flex:1;min-height:120px;display:flex;flex-direction:column;gap:8px;}
    .v-file-head{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink);}
    .v-file-name{font-family:var(--mono);word-break:break-all;}
    .v-file-body{min-width:0;}
    .v-file-pre{margin:0;padding:10px;background:var(--panel-2);border:1px solid var(--rule);
      border-radius:var(--radius-sm);font-family:var(--mono);font-size:11.5px;line-height:1.5;
      color:var(--ink);white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:56vh;}
    .v-file-img{max-width:100%;height:auto;border:1px solid var(--rule);border-radius:var(--radius-sm);background:#fff;}
    .v-art .v-row{cursor:default;}
    /* memory views (Phase 3c) */
    .panel-view .md{font-size:13px;line-height:1.55;color:var(--ink);}
    .panel-view .md h1,.panel-view .md h2,.panel-view .md h3{font-size:13.5px;margin:8px 0 4px;}
    .panel-view .md p{margin:4px 0;}
    /* ladder / requirement status chips */
    .v-chip{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:9.5px;
      text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:999px;border:1px solid var(--rule);
      color:var(--ink-2);background:var(--panel-3);white-space:nowrap;}
    .v-chip.st-open{color:var(--ink-3);}
    .v-chip.st-in-progress{color:var(--accent);border-color:var(--accent-glow);background:var(--accent-ghost);}
    .v-chip.st-claimed{color:#d9982b;border-color:rgba(217,152,43,.5);background:rgba(217,152,43,.12);}
    .v-chip.st-proven{color:#3fa46b;border-color:rgba(63,164,107,.5);background:rgba(63,164,107,.13);}
    .v-chip.st-confirmed{color:#3fa46b;border-color:rgba(63,164,107,.45);background:rgba(63,164,107,.1);}
    .v-chip.st-dropped{color:var(--ink-3);text-decoration:line-through;opacity:.75;}
    .v-chip-note{font-size:9px;opacity:.85;text-transform:none;letter-spacing:0;}
    /* focus view */
    .v-focus{display:flex;flex-direction:column;gap:12px;}
    .v-focus-body{padding:2px 0;}
    .v-active-plan{display:flex;align-items:center;gap:7px;}
    .v-req{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border:1px solid var(--rule);
      border-radius:var(--radius-sm);background:var(--panel-2);}
    .v-req-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
    .v-req-id{font-family:var(--mono);font-size:11px;color:var(--ink-3);}
    .v-req-text{font-size:12.5px;color:var(--ink);line-height:1.45;}
    .v-req-quote{border-left:2px solid var(--accent-glow);padding-left:8px;color:var(--ink);font-style:italic;}
    .v-req-src{font-family:var(--mono);font-size:10px;color:var(--ink-3);}
    .v-counts{display:flex;gap:6px;flex-wrap:wrap;}
    /* plan view */
    .v-plan{display:flex;flex-direction:column;gap:12px;}
    .v-plan-switch{display:flex;gap:6px;flex-wrap:wrap;}
    .v-plan-tab{font-family:var(--mono);font-size:11px;padding:3px 8px;border-radius:999px;cursor:pointer;
      border:1px solid var(--rule);background:var(--panel-2);color:var(--ink-2);}
    .v-plan-tab:hover{background:var(--panel-3);}
    .v-plan-tab.active{border-color:var(--accent);color:var(--accent);background:var(--accent-ghost);}
    .v-plan-title{font-size:14px;color:var(--ink);font-weight:600;}
    .v-plan-meta{font-size:11px;color:var(--ink-3);margin-top:2px;}
    .v-step{display:flex;gap:8px;align-items:flex-start;padding:6px 8px;border:1px solid var(--rule);
      border-radius:var(--radius-sm);background:var(--panel-2);}
    .v-step-n{flex:0 0 auto;width:18px;height:18px;display:grid;place-items:center;border-radius:50%;
      font-family:var(--mono);font-size:10px;color:var(--ink-3);background:var(--panel-4);margin-top:1px;}
    .v-step.is-proven{border-color:rgba(63,164,107,.35);}
    .v-step.is-claimed{border-color:rgba(217,152,43,.35);}
    .v-step-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px;}
    .v-step-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
    .v-step-text{font-size:12.5px;color:var(--ink);line-height:1.45;}
    .v-proof{font-family:var(--mono);font-size:10px;color:#3fa46b;word-break:break-all;}
    .v-goal{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border:1px solid var(--rule);
      border-radius:var(--radius-sm);background:var(--panel-2);}
    .v-goal-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
    .v-goal-title{font-size:12.5px;color:var(--ink);}
    .v-bar{height:6px;border-radius:999px;background:var(--panel-4);overflow:hidden;}
    .v-bar-fill{height:100%;background:var(--accent);border-radius:999px;}
    /* context view */
    .v-context{display:flex;flex-direction:column;gap:12px;}
    .v-meter-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}
    .v-meter-big{font-family:var(--mono);font-size:18px;color:var(--ink);}
    .v-meter-sub{font-size:11px;color:var(--ink-3);}
    .v-meter{height:9px;border-radius:999px;background:var(--panel-4);overflow:hidden;margin-top:5px;}
    .v-meter-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-glow));border-radius:999px;}
    .v-note{font-size:11px;color:var(--ink-3);line-height:1.5;}
    .v-evict{border-left:2px solid var(--rule);padding:2px 0 2px 8px;font-size:11.5px;color:var(--ink-2);}
    .v-evict-role{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;color:var(--ink-3);}
    /* wiki view */
    .v-wiki{display:flex;flex-direction:column;gap:10px;min-height:0;}
    .v-wiki-search{width:100%;box-sizing:border-box;padding:6px 9px;border:1px solid var(--rule);
      border-radius:var(--radius-sm);background:var(--panel-2);color:var(--ink);font-size:12.5px;font-family:inherit;}
    .v-wiki-list{display:flex;flex-direction:column;gap:6px;max-height:52vh;overflow:auto;}
    .v-wiki-item{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border:1px solid var(--rule);
      border-radius:var(--radius-sm);background:var(--panel-2);cursor:pointer;}
    .v-wiki-item:hover{border-color:var(--accent-glow);}
    .v-wiki-title{font-size:13px;color:var(--ink);display:flex;align-items:center;gap:6px;}
    .v-wiki-tags{display:flex;gap:4px;flex-wrap:wrap;}
    .v-tag-sm{font-family:var(--mono);font-size:9px;padding:0 4px;border-radius:4px;background:var(--panel-4);color:var(--ink-3);}
    .v-verified{color:#3fa46b;}
    .v-wiki-back{align-self:flex-start;}
    .v-skills{display:flex;flex-direction:column;gap:10px;}
    /* settings view (Phase 4) */
    .v-settings{display:flex;flex-direction:column;gap:10px;min-height:0;}
    .v-set-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
    .v-set-tag{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;
      padding:1px 6px;border-radius:999px;border:1px solid var(--rule);color:var(--ink-2);background:var(--panel-3);}
    .v-set-tag.mode-interpreter{color:#3fa46b;border-color:rgba(63,164,107,.5);background:rgba(63,164,107,.12);}
    .v-set-tag.mode-compiled{color:#d9982b;border-color:rgba(217,152,43,.5);background:rgba(217,152,43,.12);}
    .v-set-groups{display:flex;flex-direction:column;gap:8px;}
    .v-group{border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--panel-2);overflow:hidden;}
    .v-group-head{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;user-select:none;}
    .v-group-head:hover{background:var(--panel-3);}
    .v-group-head svg{flex:0 0 auto;color:var(--ink-3);}
    .v-group-title{font-size:12.5px;color:var(--ink);font-weight:600;}
    .v-group-caret{margin-left:auto;transition:transform .12s ease;color:var(--ink-3);}
    .v-group.open>.v-group-head .v-group-caret{transform:rotate(90deg);}
    .v-group-body{display:none;flex-direction:column;gap:9px;padding:9px;border-top:1px solid var(--rule);}
    .v-group.open>.v-group-body{display:flex;}
    .v-field{display:flex;flex-direction:column;gap:3px;}
    .v-field-label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-2);}
    .v-field-key{font-family:var(--mono);}
    .v-field-def{font-size:8.5px;color:var(--ink-3);border:1px solid var(--rule);border-radius:4px;padding:0 4px;text-transform:uppercase;letter-spacing:.04em;}
    .v-input,.v-select,.v-textarea{width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid var(--rule);
      border-radius:var(--radius-sm);background:var(--panel);color:var(--ink);font-size:12.5px;font-family:inherit;}
    .v-textarea{font-family:var(--mono);font-size:11.5px;line-height:1.5;resize:vertical;min-height:56px;}
    .v-input:focus,.v-select:focus,.v-textarea:focus{outline:none;border-color:var(--accent);}
    .v-check{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--ink);cursor:pointer;}
    .v-sub{border-left:1px solid var(--rule);margin-left:3px;padding-left:9px;display:flex;flex-direction:column;gap:9px;}
    .v-sub-label{font-family:var(--mono);font-size:11px;color:var(--ink-2);}
    .v-tags{display:flex;flex-wrap:wrap;gap:5px;align-items:center;}
    .v-tagchip{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:11px;padding:2px 6px;
      border-radius:6px;border:1px solid var(--rule);background:var(--panel-3);color:var(--ink);}
    .v-tagchip button{background:none;border:none;color:var(--ink-3);cursor:pointer;padding:0;display:inline-grid;place-items:center;line-height:1;}
    .v-tagchip button:hover{color:#e05a5a;}
    .v-tag-add{flex:1;min-width:90px;}
    .v-cred{display:flex;flex-direction:column;gap:5px;}
    .v-cred-row{display:flex;align-items:center;gap:6px;}
    .v-cred-row .v-input{flex:1;}
    .v-cred-badge{font-family:var(--mono);font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;padding:1px 5px;border-radius:4px;white-space:nowrap;}
    .v-cred-badge.set{color:#3fa46b;border:1px solid rgba(63,164,107,.5);background:rgba(63,164,107,.12);}
    .v-cred-badge.unset{color:var(--ink-3);border:1px solid var(--rule);background:var(--panel-3);}
    .v-cred-set{display:flex;flex-direction:column;gap:6px;padding:7px 8px;border:1px dashed var(--accent-glow);border-radius:var(--radius-sm);}
    .v-set-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--rule);}
    .v-set-dirty{font-size:11px;color:var(--accent);}
    .v-set-err{font-size:11px;color:#e05a5a;word-break:break-word;flex-basis:100%;}
    .v-rule-row{display:flex;gap:6px;align-items:center;}
    .v-rule-row .v-select{flex:0 0 36%;}
    .v-rule-row .v-input{flex:1;}
    .v-raw-note{font-size:10.5px;color:var(--ink-3);}
    `;
    const style = document.createElement("style");
    style.id = "ch-views-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Tools view ───────────────────────────────────────────────────────────
  function toolRow(r) {
    const ic =
      r.status === "running"
        ? CH.el("span", { class: "spinner" })
        : CH.icon(r.status === "error" ? "alert" : "check", 13);
    const sub = [];
    if (r.status === "running") {
      if (r.inputBytes != null) sub.push(`in ${CH.fmtBytes(r.inputBytes)}`);
      sub.push("running");
    } else {
      if (r.outputBytes != null) sub.push(`out ${CH.fmtBytes(r.outputBytes)}`);
      if (r.durationMs != null) sub.push(CH.fmtMs(r.durationMs));
    }
    return CH.el(
      "div",
      { class: `v-row ${r.status === "error" ? "is-err" : r.status === "running" ? "is-run" : ""}` },
      [
        CH.el("span", { class: "v-row-ic" }, ic),
        CH.el("div", { class: "v-row-main" }, [
          CH.el("div", { class: "v-row-title" }, [
            CH.icon(r.kind === "mcp" ? "plug" : "wrench", 13),
            CH.el("span", { class: "v-row-name", text: r.name || "tool" }),
            r.kind === "mcp" ? CH.el("span", { class: "v-tag", text: "mcp" }) : null,
          ]),
          sub.length ? CH.el("div", { class: "v-row-sub", text: sub.join(" · ") }) : null,
        ]),
      ],
    );
  }
  function renderTools(wrap) {
    const recs = pairTools(eventsOf());
    const active = recs.filter((r) => r.status === "running");
    const done = recs.filter((r) => r.status !== "running").slice(-24).reverse();
    CH.clear(wrap);
    wrap.appendChild(
      section("Running", active.length ? active.map(toolRow) : [empty("No tools running.")]),
    );
    wrap.appendChild(
      section("Recent", done.length ? done.map(toolRow) : [empty("No tool calls yet.")]),
    );
  }

  P.register({
    id: "tools",
    title: "Tools",
    icon: "wrench",
    order: 12,
    feature: P.VIEW_FEATURES.tools,
    mount(el, api) {
      API = api;
      ensureStyles();
      const wrap = CH.el("div", { class: "v-tools panel-view" });
      el.appendChild(wrap);
      renderTools(wrap);
    },
    update(el, api, msg) {
      if (msg.type !== "event" || !msg.event) return;
      if (!/^(tool_call_|mcp_call_)/.test(msg.event.kind)) return;
      const wrap = el.querySelector(".v-tools");
      if (wrap) renderTools(wrap);
    },
    badge() {
      const n = pairTools(eventsOf()).filter((r) => r.status === "running").length;
      return n || null;
    },
  });

  // ── Background tasks view ────────────────────────────────────────────────
  function taskRow(r) {
    const ic =
      r.status === "running"
        ? CH.el("span", { class: "spinner" })
        : CH.icon(r.status === "error" ? "alert" : "check", 13);
    const sub = [];
    if (r.status === "running") {
      if (r.toolCount != null) sub.push(`${r.toolCount} tools`);
      sub.push("running");
    } else {
      if (r.toolCallCount != null) sub.push(`${r.toolCallCount} tool calls`);
      if (r.finalMessageBytes != null) sub.push(CH.fmtBytes(r.finalMessageBytes));
      if (r.durationMs != null) sub.push(CH.fmtMs(r.durationMs));
    }
    return CH.el(
      "div",
      {
        class: `v-row ${r.status === "error" ? "is-err" : r.status === "running" ? "is-run" : ""}`,
        dataset: { task: r.name || "" },
      },
      [
        CH.el("span", { class: "v-row-ic" }, ic),
        CH.el("div", { class: "v-row-main" }, [
          CH.el("div", { class: "v-row-title" }, [
            CH.icon("bot", 13),
            CH.el("span", { class: "v-row-name", text: r.name || "sub-agent" }),
          ]),
          sub.length ? CH.el("div", { class: "v-row-sub", text: sub.join(" · ") }) : null,
          r.childSessionId ? CH.el("div", { class: "v-row-sub mono", text: r.childSessionId }) : null,
        ]),
      ],
    );
  }
  function renderTasks(wrap) {
    const box = wrap.querySelector(".v-tasks-agents");
    if (!box) return;
    const recs = pairSubAgents(eventsOf());
    for (const r of recs) if (r.name) taskNames.add(r.name);
    const running = recs.filter((r) => r.status === "running");
    const done = recs.filter((r) => r.status !== "running").slice(-24).reverse();
    CH.clear(box);
    box.appendChild(
      section(
        "Running",
        running.length ? running.map(taskRow) : [empty("No background tasks running.")],
      ),
    );
    if (done.length) box.appendChild(section("Finished", done.map(taskRow)));
  }
  function fetchDream(wrap, api) {
    const box = wrap.querySelector(".v-tasks-dream");
    if (!box) return;
    const spec = api.state && api.state.identity && api.state.identity.specName;
    if (!spec) {
      CH.clear(box);
      return;
    }
    fetch(`/crewhaus/dream/${encodeURIComponent(spec)}/state.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((st) => {
        CH.clear(box);
        if (!st || typeof st !== "object") return;
        const dl = CH.el("dl", { class: "panel-dl" });
        drow(dl, "Outcome", st.lastOutcome);
        drow(dl, "Last run", st.lastRunAt ? new Date(st.lastRunAt).toLocaleString() : null);
        if (st.phase1Counts && typeof st.phase1Counts === "object") {
          const parts = Object.entries(st.phase1Counts).map(([k, v]) => `${k}:${v}`);
          drow(dl, "Phase 1", parts.join("  "));
        }
        if (Array.isArray(st.lastEvidence) && st.lastEvidence.length)
          drow(dl, "Evidence", `${st.lastEvidence.length} refs`);
        box.appendChild(section("Dream", [dl]));
      })
      .catch(() => {
        CH.clear(box);
      });
  }

  P.register({
    id: "tasks",
    title: "Background tasks",
    icon: "layers",
    order: 14,
    feature: P.VIEW_FEATURES["background-tasks"],
    mount(el, api) {
      API = api;
      ensureStyles();
      const wrap = CH.el("div", { class: "v-tasks panel-view" }, [
        CH.el("div", { class: "v-tasks-agents" }),
        CH.el("div", { class: "v-tasks-dream" }),
      ]);
      el.appendChild(wrap);
      renderTasks(wrap);
      fetchDream(wrap, api);
      api.onState(() => renderTasks(wrap));
    },
    update(el, api, msg) {
      const wrap = el.querySelector(".v-tasks");
      if (!wrap) return;
      if (msg.type === "event" && msg.event && /^sub_agent_/.test(msg.event.kind)) {
        if (msg.event.kind === "sub_agent_start" && msg.event.name) taskNames.add(msg.event.name);
        renderTasks(wrap);
      } else if (msg.type === "memory" && msg.surface === "dream") {
        fetchDream(wrap, api);
      } else if (msg.type === "open" && msg.arg && msg.arg.name) {
        const row = wrap.querySelector(`.v-task[data-task="${(window.CSS && CSS.escape) ? CSS.escape(msg.arg.name) : msg.arg.name}"]`);
        if (row) {
          row.classList.add("is-run");
          row.scrollIntoView({ block: "nearest" });
        }
      }
    },
    badge() {
      const n = pairSubAgents(eventsOf()).filter((r) => r.status === "running").length;
      return n || null;
    },
  });

  // ── Files view ───────────────────────────────────────────────────────────
  function prettyJson(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  function jsonlPretty(text) {
    const lines = text.split("\n").filter((l) => l.trim());
    const shown = lines.slice(0, 500).map((l) => {
      try {
        return JSON.stringify(JSON.parse(l));
      } catch {
        return l;
      }
    });
    return shown.join("\n") + (lines.length > 500 ? `\n… (${lines.length - 500} more lines)` : "");
  }
  function preBlock(text) {
    return CH.el("pre", { class: "v-file-pre", text });
  }
  function viewFile(viewer, node) {
    CH.clear(viewer);
    const head = CH.el("div", { class: "v-file-head" }, [
      CH.icon(iconForFile(node.name), 13),
      CH.el("span", { class: "v-file-name", text: node.name }),
      CH.el("span", { class: "grow" }),
      CH.el(
        "a",
        { class: "btn ghost sm icon-only", href: node.url, target: "_blank", rel: "noopener", title: "Open raw" },
        CH.icon("download", 13),
      ),
    ]);
    const body = CH.el("div", { class: "v-file-body" });
    viewer.appendChild(head);
    viewer.appendChild(body);

    const ext = extOf(node.name);
    if (IMG_EXT.has(ext)) {
      body.appendChild(CH.el("img", { class: "v-file-img", src: node.url, alt: node.name }));
      return;
    }
    body.appendChild(empty("Loading…"));
    fetch(node.url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((text) => {
        CH.clear(body);
        const truncated = text.length > 400000;
        const capped = truncated ? text.slice(0, 400000) : text;
        if (ext === "md") {
          const md = CH.el("div", { class: "md" });
          CH.mdInto(md, capped);
          body.appendChild(md);
        } else if (ext === "json") {
          body.appendChild(preBlock(prettyJson(capped)));
        } else if (ext === "jsonl" || ext === "ndjson") {
          body.appendChild(preBlock(jsonlPretty(capped)));
        } else {
          body.appendChild(preBlock(CH.stripAnsi(capped)));
        }
        if (truncated) body.appendChild(CH.el("div", { class: "panel-hint", text: "truncated at 400 KB" }));
      })
      .catch((err) => {
        CH.clear(body);
        body.appendChild(empty(`Could not load this file (${err.message}).`));
      });
  }

  function mountFiles(el, api) {
    API = api;
    ensureStyles();
    const tree = CH.el("div", { class: "v-files-tree" });
    const viewer = CH.el("div", { class: "v-files-viewer" }, empty("Select a file to view it."));
    el.appendChild(CH.el("div", { class: "v-files panel-view" }, [tree, viewer]));
    let lastSig = null;

    function selectRow(row) {
      tree.querySelectorAll(".v-tree-row.active").forEach((r) => r.classList.remove("active"));
      if (row) row.classList.add("active");
    }

    // Render one node (recursively). Harness nodes ship their children inline;
    // crewhaus nodes are `lazy` and fetch their listing on first expand.
    function renderNode(node, container, open) {
      if (node.dir) {
        const caret = CH.el("span", { class: "v-tree-caret" }, node.children || node.lazy ? CH.icon("chevron", 11) : null);
        const rowEl = CH.el("div", { class: "v-tree-row v-tree-dir" }, [
          caret,
          CH.icon("folder", 13),
          CH.el("span", { class: "v-tree-name", text: node.name }),
        ]);
        const childBox = CH.el("div", { class: "v-tree-children", style: { display: "none" } });
        let expanded = false;
        let loaded = !node.lazy;
        const load = async () => {
          if (loaded) return;
          loaded = true;
          childBox.appendChild(CH.el("div", { class: "v-tree-loading", text: "listing…" }));
          try {
            const res = await fetch(`/crewhaus/${node.path}`);
            const data = res.ok ? await res.json() : null;
            CH.clear(childBox);
            const kids = ((data && data.entries) || []).map((e) => ({
              name: e.name,
              dir: !!e.dir,
              path: `${node.path}/${e.name}`,
              url: `/crewhaus/${node.path}/${e.name}`,
              lazy: !!e.dir,
            }));
            if (!kids.length) childBox.appendChild(empty("(empty)"));
            for (const k of kids) renderNode(k, childBox, false);
          } catch {
            CH.clear(childBox);
            childBox.appendChild(empty("Could not list this folder."));
          }
        };
        const toggle = (force) => {
          expanded = force == null ? !expanded : force;
          childBox.style.display = expanded ? "block" : "none";
          rowEl.classList.toggle("open", expanded);
          if (expanded) load();
        };
        rowEl.addEventListener("click", () => toggle());
        container.appendChild(rowEl);
        container.appendChild(childBox);
        if (!node.lazy && node.children) for (const c of node.children) renderNode(c, childBox, false);
        if (open) toggle(true);
      } else {
        const rowEl = CH.el("div", { class: "v-tree-row v-tree-file", dataset: { url: node.url } }, [
          CH.el("span", { class: "v-tree-caret" }),
          CH.icon(iconForFile(node.name), 13),
          CH.el("span", { class: "v-tree-name", text: node.name }),
        ]);
        rowEl.addEventListener("click", () => {
          selectRow(rowEl);
          viewFile(viewer, node);
        });
        container.appendChild(rowEl);
      }
    }

    function renderTree() {
      CH.clear(tree);
      const files = (api.state && api.state.harness && api.state.harness.files) || [];
      const keep = files.filter((f) => !/(^|\/)(DROP_|README)/i.test(f) && !/\.env(\.|$)/.test(f));
      if (keep.length) {
        const nodes = decorate(buildFileTree(keep), "harness");
        renderNode({ name: "harness/", dir: true, children: nodes, lazy: false }, tree, true);
      }
      // The four allowlisted .crewhaus/ subtrees (state|wiki|dream|sessions),
      // lazily listed via the host's read route.
      const subs = ["state", "wiki", "dream", "sessions"].map((s) => ({
        name: s,
        dir: true,
        path: s,
        url: `/crewhaus/${s}`,
        lazy: true,
      }));
      renderNode({ name: ".crewhaus/", dir: true, children: subs, lazy: false }, tree, false);
      if (!keep.length && !tree.firstChild)
        tree.appendChild(empty("No harness files yet."));
    }

    renderTree();
    api.onState(() => {
      const files = (api.state && api.state.harness && api.state.harness.files) || [];
      const sig = files.join("|");
      if (sig !== lastSig) {
        lastSig = sig;
        renderTree();
      }
    });

    // Give the open handler access to the viewer.
    el._openFile = (path) => {
      const r = resolvePathRoute(path);
      viewFile(viewer, { name: r.subpath.split("/").pop() || r.subpath, url: r.url, route: r.route, path: r.subpath });
    };
  }
  // Turn buildFileTree nodes into rend{name,dir,path,url,children} for a route.
  function decorate(nodes, route) {
    return (nodes || []).map((n) => ({
      name: n.name,
      dir: n.dir,
      path: n.path,
      url: `/${route}/${n.path}`,
      lazy: false,
      children: n.dir ? decorate(n.children, route) : null,
    }));
  }

  P.register({
    id: "files",
    title: "Files",
    icon: "folder",
    order: 30,
    feature: P.VIEW_FEATURES.files,
    mount: mountFiles,
    update(el, api, msg) {
      if (msg.type === "open" && msg.arg && msg.arg.path && typeof el._openFile === "function") {
        el._openFile(msg.arg.path);
      }
    },
  });

  // ── Artifacts view ───────────────────────────────────────────────────────
  function groupBy(arr, keyFn) {
    const out = {};
    for (const x of arr) {
      const k = keyFn(x);
      (out[k] = out[k] || []).push(x);
    }
    return out;
  }
  function mountArtifacts(el, api) {
    API = api;
    ensureStyles();
    const box = CH.el("div", { class: "v-artifacts panel-view" });
    el.appendChild(box);
    let lastSig = null;

    function artRow(a) {
      return CH.el("div", { class: "v-row v-art", title: a.path }, [
        CH.el("span", { class: "v-row-ic" }, CH.icon(a.icon, 13)),
        CH.el("div", { class: "v-row-main" }, [
          CH.el("div", { class: "v-row-title" }, [
            CH.el("a", {
              class: "ch-link",
              href: "#",
              text: a.label,
              onClick: (e) => {
                e.preventDefault();
                P.open("files", { path: a.path });
              },
            }),
          ]),
          a.dir ? CH.el("div", { class: "v-row-sub", text: a.dir }) : null,
        ]),
      ]);
    }
    function render() {
      const files = (api.state && api.state.harness && api.state.harness.files) || [];
      const arts = deriveArtifacts(files);
      CH.clear(box);
      if (!arts.length) {
        box.appendChild(
          empty("No artifacts yet. Reports, eval outputs and generated images appear here after a run."),
        );
        return;
      }
      const groups = groupBy(arts, (a) => a.kind);
      const labels = { report: "Reports", eval: "Eval outputs", image: "Images", output: "Other outputs" };
      for (const g of ["report", "eval", "image", "output"]) {
        if (groups[g]) box.appendChild(section(labels[g], groups[g].map(artRow)));
      }
    }
    render();
    api.onState(() => {
      const files = (api.state && api.state.harness && api.state.harness.files) || [];
      const sig = files.join("|");
      if (sig !== lastSig) {
        lastSig = sig;
        render();
      }
    });
    // TODO(host allowlist): the `.crewhaus/tool-results/<runId>/<toolUseId>.txt`
    // spill dir is NOT in CREWHAUS_READ_SUBTREES (host.ts), so tool-result
    // artifacts are unreachable today. Surfacing them needs a host allowlist
    // addition + a /crewhaus/tool-results read path; deferred out of Phase 3b.
  }

  P.register({
    id: "artifacts",
    title: "Artifacts",
    icon: "package",
    order: 32,
    feature: P.VIEW_FEATURES.artifacts,
    mount: mountArtifacts,
    badge() {
      const files = (API && API.state && API.state.harness && API.state.harness.files) || [];
      const n = deriveArtifacts(files).length;
      return n || null;
    },
  });

  // ══ Memory views (Phase 3c) ══════════════════════════════════════════════
  // All read RAW `.crewhaus/` files via the host's `/crewhaus/` route and parse
  // in the browser (never import @crewhaus/*). They refetch when a
  // `{type:"memory", surface, …}` WS message for their surface arrives, and on
  // first mount / when the latched identity (spec, sessionId) becomes known.
  // Every fetch degrades to an empty-state, never an error.

  function identityOf(api) {
    const id = (api && api.state && api.state.identity) || {};
    return { spec: id.specName || null, sessionId: id.sessionId || null };
  }
  function memUrl(path) {
    return encodeURI("/crewhaus/" + String(path).replace(/^\/+/, ""));
  }
  function fetchText(url) {
    return fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))));
  }
  function fetchJson(url) {
    return fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
  }
  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s);
  }
  function hint(text) {
    return CH.el("div", { class: "panel-hint", text });
  }
  function truncate(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function normalizePlanId(id) {
    const m = String(id || "").match(/plan-\d{4}/);
    return m ? m[0] : String(id || "");
  }
  /** A ladder-status pill (open/in_progress/claimed/proven/confirmed/dropped).
      claimed and proven are visibly distinct — the whole point of the ladder. */
  function statusChip(status) {
    const meta = statusMeta(status);
    const kids = [CH.el("span", { text: meta.label })];
    if (meta.note) kids.push(CH.el("span", { class: "v-chip-note", text: `· ${meta.note}` }));
    return CH.el("span", { class: `v-chip ${meta.cls}` }, kids);
  }

  // ── Focus view ───────────────────────────────────────────────────────────
  function reqRow(r) {
    return CH.el("div", { class: "v-req", dataset: { req: r.id } }, [
      CH.el("div", { class: "v-req-head" }, [
        CH.el("span", { class: "v-req-id", text: r.id }),
        statusChip(r.status),
      ]),
      // The user's own verbatim words (survive compaction) — textContent only,
      // never markdown/innerHTML, so they render faithfully and safely.
      CH.el("div", { class: "v-req-text v-req-quote", text: r.text }),
      CH.el("div", { class: "v-req-src", text: `${r.sessionId} · turn ${r.turn}` }),
    ]);
  }
  function renderFocus(wrap, api) {
    const { spec } = identityOf(api);
    CH.clear(wrap);
    if (!spec) {
      wrap.appendChild(empty("No focus yet — the agent hasn't started a session."));
      return;
    }
    wrap.appendChild(empty("Loading focus…"));
    const base = `state/${spec}`;
    Promise.allSettled([
      fetchText(memUrl(`${base}/focus.md`)),
      fetchText(memUrl(`${base}/handoff.md`)),
    ]).then(([f, h]) => {
      const focus =
        f.status === "fulfilled"
          ? parseFocus(f.value)
          : { present: false, body: "", activePlan: null, requirements: [], ledgerTruncated: false };
      const nextActions = h.status === "fulfilled" ? parseHandoffNextActions(h.value) : [];
      CH.clear(wrap);
      if (!focus.present || (!focus.body && !focus.requirements.length && !focus.activePlan)) {
        wrap.appendChild(
          empty(
            "No focus set yet. The agent records its current focus, the active plan, and the requirements it's tracking here.",
          ),
        );
        return;
      }
      if (focus.body) {
        const body = CH.el("div", { class: "md v-focus-body" });
        CH.mdInto(body, focus.body); // model-influenced → safe markdown, never innerHTML
        wrap.appendChild(section("Focus", [body]));
      }
      const ap = focus.activePlan
        ? CH.el("div", { class: "v-active-plan" }, [
            CH.icon("list", 13),
            CH.el("a", {
              class: "ch-link",
              href: "#",
              text: focus.activePlan,
              onClick: (e) => {
                e.preventDefault();
                P.open("plan", { id: focus.activePlan });
              },
            }),
          ])
        : empty("No active plan.");
      wrap.appendChild(section("Active plan", [ap]));

      const counts = summarizeRequirements(focus.requirements);
      const countRow = CH.el("div", { class: "v-counts" }, [
        CH.el("span", { class: "v-chip st-open", text: `${counts.open} open` }),
        CH.el("span", { class: "v-chip st-confirmed", text: `${counts.confirmed} confirmed` }),
        CH.el("span", { class: "v-chip st-dropped", text: `${counts.dropped} dropped` }),
      ]);
      const rows = focus.requirements.length
        ? focus.requirements.map(reqRow)
        : [empty("No requirements tracked yet.")];
      const reqKids = [countRow].concat(rows);
      if (focus.ledgerTruncated) reqKids.push(hint("ledger truncated — oldest requirements dropped"));
      wrap.appendChild(section("Requirements", reqKids));

      if (nextActions.length) {
        const ul = CH.el(
          "ul",
          { class: "panel-list" },
          nextActions.map((a) => CH.el("li", { text: a })),
        );
        wrap.appendChild(section("Next actions", [ul]));
      }
    });
  }

  P.register({
    id: "focus",
    title: "Focus",
    icon: "star",
    order: 16,
    feature: P.VIEW_FEATURES.focus,
    mount(el, api) {
      API = api;
      ensureStyles();
      const wrap = CH.el("div", { class: "v-focus panel-view" });
      el.appendChild(wrap);
      renderFocus(wrap, api);
      let sig = identityOf(api).spec;
      api.onState(() => {
        const s = identityOf(api).spec;
        if (s !== sig) {
          sig = s;
          renderFocus(wrap, api);
        }
      });
    },
    update(el, api, msg) {
      const wrap = el.querySelector(".v-focus");
      if (!wrap) return;
      if (
        msg.type === "memory" &&
        (msg.surface === "focus" || msg.surface === "handoff" || msg.surface === "plan")
      ) {
        renderFocus(wrap, api);
      } else if (msg.type === "open" && msg.arg && msg.arg.req) {
        const row = wrap.querySelector(`.v-req[data-req="${cssEscape(msg.arg.req)}"]`);
        if (row) row.scrollIntoView({ block: "nearest" });
      }
    },
  });

  // ── Plan view ────────────────────────────────────────────────────────────
  function stepRow(s) {
    const main = [
      CH.el("div", { class: "v-step-head" }, [statusChip(s.status)]),
      CH.el("div", { class: "v-step-text", text: s.text }),
    ];
    if (s.status === "proven" && s.proofs && s.proofs.length) {
      // proven = machine-verified; show the evidence toolUseId(s).
      main.push(CH.el("div", { class: "v-proof", text: `proof: ${s.proofs.join(", ")}` }));
    } else if (s.status === "claimed") {
      // claimed ≠ proven: a free, unverified claim — say so plainly.
      main.push(CH.el("div", { class: "v-note", text: "claimed but not machine-verified" }));
    }
    return CH.el(
      "div",
      {
        class: `v-step ${s.status === "proven" ? "is-proven" : s.status === "claimed" ? "is-claimed" : ""}`,
      },
      [
        CH.el("span", { class: "v-step-n", text: String(s.n) }),
        CH.el("div", { class: "v-step-main" }, main),
      ],
    );
  }
  function goalRow(g) {
    const kids = [
      CH.el("div", { class: "v-goal-head" }, [
        statusChip(g.status),
        CH.el("span", { class: "v-goal-title", text: g.title }),
      ]),
    ];
    if (typeof g.target === "number") {
      const cur = typeof g.current === "number" ? g.current : 0;
      const pct = g.target > 0 ? Math.max(0, Math.min(1, cur / g.target)) : 0;
      kids.push(hint(`${cur}/${g.target}${g.unit ? " " + g.unit : ""}`));
      kids.push(
        CH.el(
          "div",
          { class: "v-bar" },
          CH.el("div", { class: "v-bar-fill", style: { width: `${Math.round(pct * 100)}%` } }),
        ),
      );
    }
    return CH.el("div", { class: "v-goal" }, kids);
  }
  function planCard(plan, isActive) {
    const fm = plan.frontmatter;
    const proven = plan.steps.filter((s) => s.status === "proven").length;
    const head = CH.el("div", {}, [
      CH.el("div", { class: "v-plan-title", text: fm.title || fm.id }),
      CH.el("div", {
        class: "v-plan-meta",
        text: `${fm.id}${isActive ? " · active" : ""} · ${proven}/${plan.steps.length} steps proven`,
      }),
    ]);
    const steps = plan.steps.length ? plan.steps.map(stepRow) : [empty("No steps yet.")];
    return CH.el("div", {}, [
      head,
      CH.el("div", { class: "panel-list", style: { marginTop: "8px" } }, steps),
    ]);
  }
  function mountPlan(el, api) {
    API = api;
    ensureStyles();
    const wrap = CH.el("div", { class: "v-plan panel-view" });
    el.appendChild(wrap);
    const state = { plans: [], activeId: null, selectedId: null, requestedId: null, goals: [] };

    function render() {
      CH.clear(wrap);
      if (!identityOf(api).spec) {
        wrap.appendChild(empty("No plan yet — the agent hasn't started a session."));
        return;
      }
      if (!state.plans.length) {
        wrap.appendChild(
          empty(
            "No plans yet. When the agent creates a plan, its step ladder — open → in progress → claimed → proven — appears here.",
          ),
        );
      } else {
        if (state.plans.length > 1) {
          const tabs = state.plans.map((p) => {
            const id = p.frontmatter.id;
            return CH.el("button", {
              class: `v-plan-tab ${id === state.selectedId ? "active" : ""}`,
              text: id + (id === state.activeId ? " ●" : ""),
              title: p.frontmatter.title,
              onClick: () => {
                state.selectedId = id;
                render();
              },
            });
          });
          wrap.appendChild(CH.el("div", { class: "v-plan-switch" }, tabs));
        }
        const cur = state.plans.find((p) => p.frontmatter.id === state.selectedId) || state.plans[0];
        wrap.appendChild(planCard(cur, cur.frontmatter.id === state.activeId));
      }
      const openGoals = state.goals.filter((g) => g.status !== "proven");
      if (openGoals.length) wrap.appendChild(section("Goals", openGoals.map(goalRow)));
    }

    function refresh() {
      const spec = identityOf(api).spec;
      if (!spec) {
        render();
        return;
      }
      const base = `state/${spec}`;
      Promise.allSettled([
        fetchText(memUrl(`${base}/focus.md`)),
        fetchText(memUrl(`${base}/goals.yaml`)),
        fetchJson(memUrl(`${base}/plans`)),
      ]).then(async ([f, g, listing]) => {
        state.activeId = f.status === "fulfilled" ? parseFocus(f.value).activePlan : null;
        state.goals = g.status === "fulfilled" ? parseGoals(g.value) : [];
        const entries =
          listing.status === "fulfilled" && listing.value && Array.isArray(listing.value.entries)
            ? listing.value.entries
            : [];
        const files = entries.filter((e) => !e.dir && /^plan-\d{4}.*\.md$/.test(e.name));
        const plans = [];
        for (const e of files) {
          try {
            const txt = await fetchText(memUrl(`${base}/plans/${e.name}`));
            const p = parsePlan(txt);
            p.file = e.name;
            if (p.frontmatter.id) plans.push(p);
          } catch {
            /* skip an unreadable plan */
          }
        }
        plans.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
        state.plans = plans;
        const want = state.requestedId || state.activeId;
        const found =
          want && plans.find((p) => normalizePlanId(p.frontmatter.id) === normalizePlanId(want));
        state.selectedId =
          (found && found.frontmatter.id) ||
          state.activeId ||
          (plans[0] && plans[0].frontmatter.id) ||
          null;
        render();
      });
    }

    render();
    refresh();
    let sig = identityOf(api).spec;
    api.onState(() => {
      const s = identityOf(api).spec;
      if (s !== sig) {
        sig = s;
        refresh();
      }
    });
    el._planRefresh = refresh;
    el._planSelect = (id) => {
      state.requestedId = id;
      const norm = normalizePlanId(id);
      const found = state.plans.find((p) => normalizePlanId(p.frontmatter.id) === norm);
      if (found) {
        state.selectedId = found.frontmatter.id;
        render();
      } else {
        refresh();
      }
    };
  }

  P.register({
    id: "plan",
    title: "Plan",
    icon: "list",
    order: 18,
    feature: P.VIEW_FEATURES.plan,
    mount: mountPlan,
    update(el, api, msg) {
      if (
        msg.type === "memory" &&
        (msg.surface === "plan" || msg.surface === "goals" || msg.surface === "focus")
      ) {
        if (typeof el._planRefresh === "function") el._planRefresh();
      } else if (msg.type === "open" && msg.arg && msg.arg.id && typeof el._planSelect === "function") {
        el._planSelect(msg.arg.id);
      }
    },
  });

  // ── Context view (MVP §10.4) ─────────────────────────────────────────────
  function renderContextMeter(box, api) {
    const evs = eventsOf();
    const acc = accumulateContext(evs);
    const comps = collectCompactions(evs);
    CH.clear(box);
    const pct = Math.max(0, Math.min(1, acc.cumulativeInput / NOMINAL_CONTEXT_WINDOW));
    const meter = CH.el("div", {}, [
      CH.el("div", { class: "v-meter-head" }, [
        CH.el("span", { class: "v-meter-big", text: CH.fmtTokens(acc.cumulativeInput) }),
        CH.el("span", { class: "v-meter-sub", text: `of ~${CH.fmtTokens(NOMINAL_CONTEXT_WINDOW)} nominal` }),
      ]),
      CH.el(
        "div",
        { class: "v-meter" },
        CH.el("div", { class: "v-meter-fill", style: { width: `${(pct * 100).toFixed(1)}%` } }),
      ),
      CH.el("div", {
        class: "v-note",
        text:
          "Estimate. Cumulative input tokens sent across the session — there is no true context-window event yet, so this is a proxy, not live window occupancy.",
      }),
    ]);
    box.appendChild(section("Context (cumulative input)", [meter]));

    const dl = CH.el("dl", { class: "panel-dl" });
    drow(dl, "Last turn input", acc.turns ? CH.fmtTokens(acc.lastInput) : null);
    drow(dl, "Peak turn input", acc.turns ? CH.fmtTokens(acc.peakInput) : null);
    drow(dl, "Output total", CH.fmtTokens(acc.cumulativeOutput));
    drow(dl, "Model turns", acc.turns);
    if (acc.lastCacheRead) drow(dl, "Last cache read", CH.fmtTokens(acc.lastCacheRead));
    box.appendChild(section("This session", [dl]));

    if (comps.length) {
      const rows = comps
        .slice(-8)
        .reverse()
        .map((c) =>
          CH.el("div", { class: "v-row" }, [
            CH.el("span", { class: "v-row-ic" }, CH.icon("scissors", 13)),
            CH.el("div", { class: "v-row-main" }, [
              CH.el("div", { class: "v-row-title" }, [
                CH.el("span", { class: "v-row-name", text: c.subKind || "compaction" }),
              ]),
              CH.el("div", {
                class: "v-row-sub",
                text: `${c.before == null ? "?" : c.before} → ${c.after == null ? "?" : c.after} messages${c.phase ? " · " + c.phase : ""}`,
              }),
            ]),
          ]),
        );
      box.appendChild(section(`Compactions (${comps.length})`, rows));
    }
  }
  function fetchEvictions(box, api) {
    const { sessionId } = identityOf(api);
    if (!sessionId) {
      CH.clear(box);
      return;
    }
    fetchText(memUrl(`sessions/${sessionId}.jsonl`))
      .then((t) => sessionEvictions(parseJsonl(t)))
      .then((ev) => {
        CH.clear(box);
        if (!ev.length) return;
        const rows = ev
          .slice(-8)
          .reverse()
          .map((e) =>
            CH.el("div", { class: "v-evict" }, [
              CH.el("span", {
                class: "v-evict-role",
                text: e.role + (e.turnNumber != null ? ` · turn ${e.turnNumber}` : ""),
              }),
              CH.el("div", { text: truncate(e.text, 240) }),
            ]),
          );
        box.appendChild(section(`Evicted from context (${ev.length})`, rows));
      })
      .catch(() => {
        CH.clear(box);
      });
  }

  P.register({
    id: "context",
    title: "Context",
    icon: "cpu",
    order: 22,
    feature: P.VIEW_FEATURES.context,
    mount(el, api) {
      API = api;
      ensureStyles();
      const meterBox = CH.el("div", { class: "v-context-meter" });
      const evictBox = CH.el("div", { class: "v-context-evict" });
      el.appendChild(CH.el("div", { class: "v-context panel-view" }, [meterBox, evictBox]));
      renderContextMeter(meterBox, api);
      fetchEvictions(evictBox, api);
      let sig = identityOf(api).sessionId;
      api.onState(() => {
        const s = identityOf(api).sessionId;
        if (s !== sig) {
          sig = s;
          fetchEvictions(evictBox, api);
        }
      });
    },
    update(el, api, msg) {
      const meterBox = el.querySelector(".v-context-meter");
      const evictBox = el.querySelector(".v-context-evict");
      if (!meterBox) return;
      if (
        msg.type === "event" &&
        msg.event &&
        (msg.event.kind === "model_response" || msg.event.kind === "compaction_fired")
      ) {
        renderContextMeter(meterBox, api);
      } else if (msg.type === "memory" && msg.surface === "session") {
        fetchEvictions(evictBox, api);
      }
    },
  });

  // ── Wiki view ────────────────────────────────────────────────────────────
  function mountWiki(el, api) {
    API = api;
    ensureStyles();
    const wrap = CH.el("div", { class: "v-wiki panel-view" });
    el.appendChild(wrap);
    const state = { list: [], query: "", pendingSlug: null };

    function wikiItem(r) {
      const titleKids = [CH.el("span", { text: r.title })];
      if (r.verified)
        titleKids.push(CH.el("span", { class: "v-verified", title: "verified" }, CH.icon("check", 12)));
      const meta = [];
      if (r.version != null) meta.push(CH.el("span", { class: "v-tag-sm", text: `v${r.version}` }));
      if (r.confidence != null)
        meta.push(CH.el("span", { class: "v-tag-sm", text: `conf ${r.confidence.toFixed(2)}` }));
      if (r.status) meta.push(CH.el("span", { class: "v-tag-sm", text: r.status }));
      const tags = r.tags.slice(0, 6).map((t) => CH.el("span", { class: "v-tag-sm", text: `#${t}` }));
      return CH.el("div", { class: "v-wiki-item", onClick: () => openArticle(r.slug) }, [
        CH.el("div", { class: "v-wiki-title" }, titleKids),
        meta.length || tags.length
          ? CH.el("div", { class: "v-wiki-tags" }, meta.concat(tags))
          : null,
      ]);
    }
    function renderList() {
      CH.clear(wrap);
      if (!identityOf(api).spec) {
        wrap.appendChild(empty("No wiki yet — the agent hasn't started a session."));
        return;
      }
      const search = CH.el("input", {
        class: "v-wiki-search",
        type: "search",
        placeholder: "Search articles…",
        value: state.query,
      });
      const listBox = CH.el("div", { class: "v-wiki-list" });
      function drawItems() {
        CH.clear(listBox);
        const rows = sortWiki(filterWiki(state.list, state.query));
        if (!rows.length) {
          listBox.appendChild(empty(state.list.length ? "No articles match." : "No wiki articles yet."));
          return;
        }
        for (const r of rows) listBox.appendChild(wikiItem(r));
      }
      search.addEventListener("input", () => {
        state.query = search.value;
        drawItems();
      });
      wrap.appendChild(search);
      wrap.appendChild(listBox);
      drawItems();
    }
    function loadInto(body, url) {
      CH.clear(body);
      body.appendChild(empty("Loading…"));
      fetchText(url)
        .then((txt) => {
          CH.clear(body);
          CH.mdInto(body, stripFrontmatter(txt)); // model-authored → safe md
        })
        .catch(() => {
          CH.clear(body);
          body.appendChild(empty("Could not load this article."));
        });
    }
    function openArticle(slug) {
      const spec = identityOf(api).spec;
      if (!spec) return;
      CH.clear(wrap);
      const back = CH.el(
        "button",
        { class: "btn ghost sm v-wiki-back", onClick: renderList },
        [CH.el("span", { text: "← Back to articles" })],
      );
      const body = CH.el("div", { class: "md" });
      const histBox = CH.el("div", {});
      wrap.appendChild(back);
      wrap.appendChild(body);
      wrap.appendChild(histBox);
      loadInto(body, memUrl(`wiki/${spec}/articles/${slug}.md`));
      fetchJson(memUrl(`wiki/${spec}/versions/${slug}`))
        .then((listing) => {
          const entries =
            listing && Array.isArray(listing.entries) ? listing.entries.filter((e) => !e.dir) : [];
          if (!entries.length) return;
          const links = entries
            .slice()
            .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
            .map((e) =>
              CH.el("a", {
                class: "ch-link",
                href: "#",
                text: e.name.replace(/\.md$/, ""),
                onClick: (ev) => {
                  ev.preventDefault();
                  loadInto(body, memUrl(`wiki/${spec}/versions/${slug}/${e.name}`));
                },
              }),
            );
          histBox.appendChild(section("Version history", [CH.el("div", { class: "v-wiki-tags" }, links)]));
        })
        .catch(() => {
          /* no versions dir — fine */
        });
    }
    function refresh() {
      const spec = identityOf(api).spec;
      if (!spec) {
        renderList();
        return;
      }
      fetchJson(memUrl(`wiki/${spec}/index.json`))
        .then((j) => {
          state.list = parseWikiIndex(j);
        })
        .catch(() => {
          state.list = [];
        })
        .then(() => {
          if (state.pendingSlug) {
            const s = state.pendingSlug;
            state.pendingSlug = null;
            openArticle(s);
          } else {
            renderList();
          }
        });
    }

    renderList();
    refresh();
    let sig = identityOf(api).spec;
    api.onState(() => {
      const s = identityOf(api).spec;
      if (s !== sig) {
        sig = s;
        refresh();
      }
    });
    el._wikiRefresh = refresh;
    el._wikiOpen = (slug) => {
      if (identityOf(api).spec) openArticle(slug);
      else state.pendingSlug = slug;
    };
  }

  P.register({
    id: "wiki",
    title: "Wiki",
    icon: "book",
    order: 24,
    feature: P.VIEW_FEATURES.wiki,
    mount: mountWiki,
    update(el, api, msg) {
      if (msg.type === "memory" && msg.surface === "wiki" && typeof el._wikiRefresh === "function") {
        el._wikiRefresh();
      } else if (msg.type === "open" && msg.arg && msg.arg.slug && typeof el._wikiOpen === "function") {
        el._wikiOpen(msg.arg.slug);
      }
    },
  });

  // ── Skills view ──────────────────────────────────────────────────────────
  // Skills IN USE this session. The authoritative names come from the durable
  // session JSONL (`tool_use` with name "Skill" → input.name); the live trace
  // only gives a count (tool_call_start carries no args). The list of AVAILABLE
  // skills has no host route/event today (skills are discovered at runtime via
  // `discoverSkills`), so surfacing them needs a future host discoverSkills
  // endpoint — flagged in-view, not faked here.
  function renderSkills(wrap, api) {
    const { sessionId } = identityOf(api);
    const liveCount = countSkillCalls(eventsOf());
    CH.clear(wrap);
    if (!sessionId) {
      wrap.appendChild(empty("No skills used yet this session."));
      if (liveCount) wrap.appendChild(hint(`${liveCount} Skill call(s) seen live`));
      return;
    }
    wrap.appendChild(empty("Loading skills…"));
    fetchText(memUrl(`sessions/${sessionId}.jsonl`))
      .then((t) => aggregateSkills(parseJsonl(t)))
      .then((skills) => {
        CH.clear(wrap);
        if (!skills.length) {
          wrap.appendChild(
            empty(
              "No skills used this session yet. Skills the agent invokes via the Skill tool appear here.",
            ),
          );
          if (liveCount)
            wrap.appendChild(hint(`${liveCount} Skill call(s) seen live (names load from the session log)`));
          return;
        }
        const rows = skills.map((s) =>
          CH.el("div", { class: "v-row" }, [
            CH.el("span", { class: "v-row-ic" }, CH.icon("sparkles", 13)),
            CH.el("div", { class: "v-row-main" }, [
              CH.el("div", { class: "v-row-title" }, [
                CH.el("span", { class: "v-row-name", text: s.name }),
              ]),
            ]),
            CH.el("span", { class: "v-tag", text: `×${s.count}` }),
          ]),
        );
        wrap.appendChild(section("Skills used this session", rows));
        wrap.appendChild(hint('“Available skills” needs host support (discoverSkills) — not surfaced yet.'));
      })
      .catch(() => {
        CH.clear(wrap);
        wrap.appendChild(empty("No skills used this session yet."));
      });
  }

  P.register({
    id: "skills",
    title: "Skills",
    icon: "sparkles",
    order: 26,
    feature: P.VIEW_FEATURES.skills,
    mount(el, api) {
      API = api;
      ensureStyles();
      const wrap = CH.el("div", { class: "v-skills panel-view" });
      el.appendChild(wrap);
      renderSkills(wrap, api);
      let sig = identityOf(api).sessionId;
      api.onState(() => {
        const s = identityOf(api).sessionId;
        if (s !== sig) {
          sig = s;
          renderSkills(wrap, api);
        }
      });
    },
    update(el, api, msg) {
      const wrap = el.querySelector(".v-skills");
      if (!wrap) return;
      if (msg.type === "memory" && msg.surface === "session") renderSkills(wrap, api);
      else if (
        msg.type === "event" &&
        msg.event &&
        msg.event.kind === "tool_call_end" &&
        msg.event.toolName === "Skill"
      )
        renderSkills(wrap, api);
    },
    badge() {
      const n = countSkillCalls(eventsOf());
      return n || null;
    },
  });

  // ══ Settings view (Phase 4) ══════════════════════════════════════════════
  // A schema-driven, editable form of the harness's `crewhaus.yaml` spec. The
  // host reads the spec + `zodToJsonSchema(Spec)` and sends both; this view
  // renders grouped, collapsible blocks (agent / tools / permissions /
  // mcp_servers / memory / continuity / budget / observability / …). Credential-
  // shaped fields render as `$VAR` refs with a separate "set value" affordance —
  // the real value goes to `.env` via `secret_set`, never into the spec or the
  // browser. `tool_config` is opaque → raw JSON. Edits are collected as a delta
  // and sent as `spec_patch`; the host applies + validates + writes back, then
  // recompiles/resumes.

  const SET_BLOCKS = [
    { key: "agent", title: "Agent", icon: "bot", open: true },
    { key: "tools", title: "Tools", icon: "wrench" },
    { key: "tool_config", title: "Tool config", icon: "wrench" },
    { key: "permissions", title: "Permissions", icon: "shield" },
    { key: "mcp_servers", title: "MCP servers", icon: "plug" },
    { key: "memory", title: "Memory", icon: "database" },
    { key: "continuity", title: "Continuity", icon: "git" },
    { key: "thredz", title: "Thredz", icon: "network" },
    { key: "learning", title: "Learning", icon: "sparkles" },
    { key: "budget", title: "Budget", icon: "coins" },
    { key: "compaction", title: "Compaction", icon: "scissors" },
    { key: "security", title: "Security", icon: "shield" },
    { key: "failure_taxonomy", title: "Failure taxonomy", icon: "alert" },
    { key: "observability", title: "Observability", icon: "activity" },
    { key: "feedback", title: "Feedback", icon: "thumbsUp" },
  ];
  // Top-level keys shown read-only in the header (or never edited via the form).
  const SET_HEADER_KEYS = new Set(["name", "version", "target"]);
  const LONG_TEXT_RE = /(instruction|prompt|description|justification|readme|note)/i;
  const CRED_KEY_RE = /(^|[._-])(api[_-]?key|apikey|secret|token|password|passwd|authorization|bearer|access[_-]?key|private[_-]?key)$/i;

  // ── Pure helpers (DOM-free) ──────────────────────────────────────────────
  function isRef(v) {
    return typeof v === "string" && /^\$[A-Z_][A-Z0-9_]*$/.test(v);
  }
  /** A credential-shaped leaf: a `$VAR` ref, a secret-ish key name, or a value
      sitting under an mcp `env`/`headers` map. Such fields never carry a raw
      value in the spec/browser — only a ref + a separate "set value". */
  function isCredentialField(path, key, value) {
    if (isRef(value)) return true;
    if (typeof value !== "string") return false;
    if (CRED_KEY_RE.test(String(key))) return true;
    return path.some((seg) => seg === "env" || seg === "headers");
  }
  function getAtPath(obj, path) {
    let cur = obj;
    for (const seg of path) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[seg];
    }
    return cur;
  }
  function hasAtPath(obj, path) {
    let cur = obj;
    for (const seg of path) {
      if (cur == null || typeof cur !== "object" || !(seg in cur)) return false;
      cur = cur[seg];
    }
    return true;
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === "object") {
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every((k) => deepEqual(a[k], b[k]));
    }
    return false;
  }
  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }
  /** Best-effort walk of a `zodToJsonSchema` output to the node at `path`, so a
      leaf can pick up an `enum`/`description`/`type`. Tolerant of the union/
      properties/items/additionalProperties shapes; null → value inference. */
  function pickTargetSchema(schema, target) {
    if (!schema || typeof schema !== "object") return null;
    const branches = schema.anyOf || schema.oneOf;
    if (Array.isArray(branches)) {
      const found = branches.find(
        (b) =>
          b &&
          b.properties &&
          b.properties.target &&
          ((b.properties.target.const === target) ||
            (Array.isArray(b.properties.target.enum) && b.properties.target.enum.includes(target))),
      );
      return found || null;
    }
    return schema.properties ? schema : null;
  }
  function schemaAt(node, path) {
    let cur = node;
    for (const seg of path) {
      if (!cur || typeof cur !== "object") return null;
      const branches = cur.anyOf || cur.oneOf;
      if (cur.properties && cur.properties[seg]) cur = cur.properties[seg];
      else if (Array.isArray(branches)) {
        const b = branches.find((x) => x && x.properties && x.properties[seg]);
        cur = b ? b.properties[seg] : null;
      } else if (cur.additionalProperties && typeof cur.additionalProperties === "object")
        cur = cur.additionalProperties;
      else if (cur.items) cur = cur.items;
      else return null;
    }
    return cur || null;
  }
  function enumOf(schemaNode) {
    if (!schemaNode) return null;
    if (Array.isArray(schemaNode.enum)) return schemaNode.enum.filter((v) => typeof v === "string");
    const branches = schemaNode.anyOf || schemaNode.oneOf;
    if (Array.isArray(branches)) {
      const consts = branches.map((b) => b && b.const).filter((c) => typeof c === "string");
      if (consts.length === branches.length && consts.length) return consts;
    }
    return null;
  }

  // ── The view ─────────────────────────────────────────────────────────────
  function mountSettings(el, api) {
    API = api;
    ensureStyles();
    const wrap = CH.el("div", { class: "v-settings panel-view" });
    el.appendChild(wrap);
    const st = {
      orig: null,
      written: null,
      schema: null,
      target: "cli",
      refs: {},
      envPath: "",
      launch: { mode: "compiled", canResume: false },
      dirty: new Map(),
      saving: false,
      openGroups: new Set(),
    };
    let footEls = null;

    function pathKey(path) {
      return path.join(" ");
    }
    function setChange(path, value) {
      const key = pathKey(path);
      if (deepEqual(value, getAtPath(st.orig, path))) st.dirty.delete(key);
      else st.dirty.set(key, { path, value });
      refreshFoot();
    }
    function setRemove(path) {
      st.dirty.set(pathKey(path), { path, remove: true });
      refreshFoot();
    }
    function save() {
      const changes = [...st.dirty.values()];
      if (!changes.length || st.saving) return;
      st.saving = true;
      refreshFoot();
      api.conn.send({ type: "spec_patch", target: st.target, changes });
    }

    // ── Reload / responses ───────────────────────────────────────────────
    function reload() {
      CH.clear(wrap);
      wrap.appendChild(empty("Loading settings…"));
      footEls = null;
      api.conn.send({ type: "spec_get" });
    }
    function onSpecData(m) {
      if (!m || m.ok === false) return renderUnavailable(m || {});
      st.orig = m.spec || {};
      st.written = m.written || null;
      st.schema = m.schema ? pickTargetSchema(m.schema, m.target) : null;
      st.target = m.target || "cli";
      st.refs = m.refs || {};
      st.envPath = m.envPath || "";
      st.launch = m.launch || { mode: "compiled", canResume: false };
      st.dirty = new Map();
      render();
    }
    function onPatchResult(m) {
      st.saving = false;
      if (m && m.ok) {
        const note =
          m.recompile === "interpreter"
            ? m.resumed
              ? "Saved — recompiled and resumed the session."
              : "Saved — the interpreter will pick up the change on next run."
            : m.note || "Saved.";
        CH.toast(note);
        reload(); // re-fetch the now-canonical spec + clear dirty
      } else {
        if (footEls) {
          footEls.err.textContent = (m && m.error) || "The edit was rejected.";
          refreshFoot();
        } else {
          CH.toast((m && m.error) || "The edit was rejected.", "err");
        }
      }
    }
    function onSecretResult(m) {
      if (!m || !m.key) return;
      if (m.ok) {
        st.refs[m.key] = true;
        CH.toast(`Secret ${m.key} written${m.refWritten ? " and referenced" : ""}.`);
        // Reflect the new set/unset state without a full reload.
        wrap.querySelectorAll(`[data-refkey="${cssEscape(m.key)}"]`).forEach((b) => {
          b.className = "v-cred-badge set";
          b.textContent = "set";
        });
      } else {
        CH.toast(m.error || "Could not write the secret.", "err");
      }
    }

    api.on("spec_data", onSpecData);
    api.on("spec_patch_result", onPatchResult);
    api.on("secret_set_result", onSecretResult);

    function renderUnavailable(m) {
      CH.clear(wrap);
      wrap.appendChild(empty(m.error || "Settings are unavailable for this harness."));
      if (m.needsInstall) {
        wrap.appendChild(
          CH.el(
            "button",
            { class: "btn ghost sm", onClick: reload },
            [CH.icon("download", 13), CH.el("span", { text: "Install spec tooling & retry" })],
          ),
        );
      } else {
        wrap.appendChild(
          CH.el("button", { class: "btn ghost sm", onClick: reload }, [
            CH.icon("refresh", 13),
            CH.el("span", { text: "Retry" }),
          ]),
        );
      }
    }

    // ── Rendering ─────────────────────────────────────────────────────────
    function render() {
      CH.clear(wrap);
      const spec = st.orig || {};
      // Header
      const head = CH.el("div", { class: "v-set-head" }, [
        CH.el("span", { class: "v-set-tag", text: st.target }),
        CH.el("span", {
          class: `v-set-tag mode-${st.launch.mode}`,
          text: st.launch.mode === "interpreter" ? "live edit · resume" : "compiled",
          title:
            st.launch.mode === "interpreter"
              ? "Interpreter launch: edits recompile-free and the session resumes on save."
              : "Compiled bundle: install the crewhaus CLI for live edit + seamless resume.",
        }),
        typeof spec.name === "string" ? CH.el("span", { class: "v-field-key", text: spec.name }) : null,
        CH.el("span", { class: "grow" }),
        CH.el("button", { class: "btn ghost sm icon-only", title: "Reload spec", onClick: reload }, CH.icon("refresh", 13)),
      ]);
      wrap.appendChild(head);

      const groups = CH.el("div", { class: "v-set-groups" });
      wrap.appendChild(groups);

      const rendered = new Set(SET_HEADER_KEYS);
      for (const b of SET_BLOCKS) {
        if (!(b.key in spec)) continue;
        rendered.add(b.key);
        groups.appendChild(blockGroup(b, spec[b.key]));
      }
      // Any remaining top-level keys the curated list didn't cover.
      for (const k of Object.keys(spec)) {
        if (rendered.has(k)) continue;
        groups.appendChild(blockGroup({ key: k, title: k, icon: "dot" }, spec[k]));
      }
      if (!groups.firstChild) groups.appendChild(empty("This spec has no editable blocks."));

      // Footer (save bar)
      const dirtyLabel = CH.el("span", { class: "v-set-dirty" });
      const saveBtn = CH.el("button", { class: "btn primary sm", onClick: save }, [
        CH.icon("check", 13),
        CH.el("span", { text: "Save changes" }),
      ]);
      const err = CH.el("span", { class: "v-set-err" });
      wrap.appendChild(CH.el("div", { class: "v-set-foot" }, [saveBtn, dirtyLabel, err]));
      footEls = { saveBtn, dirtyLabel, err };
      refreshFoot();
    }

    function refreshFoot() {
      if (!footEls) return;
      const n = st.dirty.size;
      footEls.dirtyLabel.textContent = n ? `${n} unsaved change${n === 1 ? "" : "s"}` : "";
      const sp = footEls.saveBtn.querySelector("span");
      if (sp) sp.textContent = st.saving ? "Saving…" : "Save changes";
      footEls.saveBtn.disabled = st.saving || n === 0;
      if (n === 0) footEls.err.textContent = "";
    }

    function blockGroup(meta, value) {
      const body = CH.el("div", { class: "v-group-body" });
      const caret = CH.el("span", { class: "v-group-caret" }, CH.icon("chevron", 13));
      const groupEl = CH.el("div", { class: "v-group" }, [
        CH.el("div", { class: "v-group-head" }, [
          CH.icon(meta.icon || "dot", 14),
          CH.el("span", { class: "v-group-title", text: meta.title }),
          caret,
        ]),
        body,
      ]);
      const openKey = meta.key;
      const startOpen = meta.open || st.openGroups.has(openKey);
      if (startOpen) groupEl.classList.add("open");
      groupEl.querySelector(".v-group-head").addEventListener("click", () => {
        const nowOpen = groupEl.classList.toggle("open");
        if (nowOpen) st.openGroups.add(openKey);
        else st.openGroups.delete(openKey);
      });
      // Body content by block kind.
      if (meta.key === "permissions" && value && typeof value === "object" && !Array.isArray(value)) {
        renderPermissions(body, value);
      } else if (meta.key === "tools" && Array.isArray(value)) {
        renderStringArray(body, ["tools"], value);
      } else if (meta.key === "tool_config") {
        renderRawJson(body, ["tool_config"], value, "Opaque per-tool config — edited as raw JSON.");
      } else if (Array.isArray(value)) {
        // Whole-array blocks (failure_taxonomy, model_tiers, …).
        if (value.every((x) => typeof x === "string")) renderStringArray(body, [meta.key], value);
        else renderRawJson(body, [meta.key], value, "Edited as a whole array (no per-item paths in spec-patch).");
      } else if (value && typeof value === "object") {
        renderObject(body, [meta.key], value, 0);
      } else {
        renderLeaf(body, [meta.key], meta.key, value);
      }
      return groupEl;
    }

    // Recursive object renderer (depth-guarded; deep/opaque → raw JSON).
    function renderObject(container, basePath, obj, depth) {
      const keys = Object.keys(obj || {});
      if (!keys.length) {
        container.appendChild(hint("(empty)"));
        return;
      }
      for (const k of keys) {
        const path = basePath.concat(k);
        const v = obj[k];
        if (isCredentialField(path, k, v)) {
          renderCredential(container, path, k, v);
        } else if (Array.isArray(v)) {
          const label = CH.el("div", { class: "v-field-label" }, [CH.el("span", { class: "v-field-key", text: k })]);
          container.appendChild(label);
          if (v.every((x) => typeof x === "string")) renderStringArray(container, path, v);
          else renderRawJson(container, path, v, "whole-array replace");
        } else if (v && typeof v === "object") {
          if (depth >= 3) {
            const label = CH.el("div", { class: "v-field-label" }, [CH.el("span", { class: "v-field-key", text: k })]);
            container.appendChild(label);
            renderRawJson(container, path, v, "nested — edited as raw JSON");
          } else {
            const sub = CH.el("div", { class: "v-sub" });
            container.appendChild(CH.el("div", { class: "v-sub-label", text: k }));
            container.appendChild(sub);
            renderObject(sub, path, v, depth + 1);
          }
        } else {
          renderLeaf(container, path, k, v);
        }
      }
    }

    function fieldLabel(path, key) {
      const kids = [CH.el("span", { class: "v-field-key", text: key })];
      // Mark a value that isn't in the as-written spec (i.e. a Zod default).
      if (st.written && !hasAtPath(st.written, path)) kids.push(CH.el("span", { class: "v-field-def", text: "default" }));
      return CH.el("div", { class: "v-field-label" }, kids);
    }

    function renderLeaf(container, path, key, value) {
      const schemaNode = st.schema ? schemaAt(st.schema, path) : null;
      const field = CH.el("div", { class: "v-field" });
      field.appendChild(fieldLabel(path, key));
      const en = enumOf(schemaNode);
      if (typeof value === "boolean") {
        const cb = CH.el("input", { type: "checkbox" });
        cb.checked = value;
        cb.addEventListener("change", () => setChange(path, cb.checked));
        field.appendChild(CH.el("label", { class: "v-check" }, [cb, CH.el("span", { text: "enabled" })]));
      } else if (en) {
        const sel = CH.el("select", { class: "v-select" });
        for (const opt of en) sel.appendChild(CH.el("option", { value: opt, text: opt }));
        sel.value = value == null ? "" : String(value);
        sel.addEventListener("change", () => setChange(path, sel.value));
        field.appendChild(sel);
      } else if (typeof value === "number") {
        const inp = CH.el("input", { class: "v-input", type: "number", value: String(value) });
        inp.addEventListener("change", () => {
          const n = inp.value.trim() === "" ? null : Number(inp.value);
          setChange(path, Number.isNaN(n) ? inp.value : n);
        });
        field.appendChild(inp);
      } else if (typeof value === "string" && (LONG_TEXT_RE.test(key) || value.length > 80)) {
        const ta = CH.el("textarea", { class: "v-textarea", rows: 4 });
        ta.value = value;
        ta.addEventListener("change", () => setChange(path, ta.value));
        field.appendChild(ta);
      } else if (value == null || typeof value === "string" || typeof value === "number") {
        const inp = CH.el("input", { class: "v-input", type: "text", value: value == null ? "" : String(value) });
        inp.addEventListener("change", () => setChange(path, inp.value));
        field.appendChild(inp);
      } else {
        renderRawJson(field, path, value, "raw JSON");
      }
      container.appendChild(field);
    }

    function renderCredential(container, path, key, value) {
      const field = CH.el("div", { class: "v-field v-cred" });
      field.appendChild(fieldLabel(path, key));
      const refInput = CH.el("input", {
        class: "v-input",
        type: "text",
        placeholder: "$VAR_NAME",
        value: typeof value === "string" ? value : "",
      });
      const refName = () => (isRef(refInput.value.trim()) ? refInput.value.trim().slice(1) : "");
      const badge = CH.el("span", { class: "v-cred-badge unset", text: "unset" });
      function syncBadge() {
        const rn = refName();
        const set = !!(rn && st.refs[rn]);
        badge.className = `v-cred-badge ${set ? "set" : "unset"}`;
        badge.textContent = set ? "set" : rn ? "unset" : "no ref";
        badge.dataset.refkey = rn || "";
      }
      refInput.addEventListener("input", () => {
        setChange(path, refInput.value.trim());
        syncBadge();
      });
      const setBtn = CH.el(
        "button",
        { class: "btn ghost sm", title: "Write the real value to .env" },
        [CH.icon("shield", 12), CH.el("span", { text: "Set value" })],
      );
      const setterHost = CH.el("div", {});
      setBtn.addEventListener("click", () => {
        if (setterHost.firstChild) {
          CH.clear(setterHost);
          return;
        }
        const rn = refName();
        if (!rn) {
          CH.toast("Enter a $VAR reference first (e.g. $OPENAI_API_KEY).", "err");
          return;
        }
        const valInput = CH.el("input", { class: "v-input", type: "password", placeholder: `value for ${rn}`, autocomplete: "off" });
        const pathInput = CH.el("input", { class: "v-input", type: "text", value: st.envPath, title: ".env target path" });
        const saveVal = CH.el("button", { class: "btn primary sm" }, "Save to .env");
        saveVal.addEventListener("click", () => {
          const v = valInput.value;
          if (!v) {
            CH.toast("Enter a value.", "err");
            return;
          }
          api.conn.send({
            type: "secret_set",
            key: rn,
            value: v,
            path: pathInput.value.trim() || undefined,
            specPath: path,
          });
          valInput.value = ""; // never keep the secret around in the DOM
          CH.clear(setterHost);
        });
        CH.clear(setterHost);
        setterHost.appendChild(
          CH.el("div", { class: "v-cred-set" }, [
            CH.el("div", { class: "v-field-label" }, [CH.el("span", { class: "v-field-key", text: `value → ${rn}` })]),
            valInput,
            CH.el("div", { class: "v-field-label" }, [CH.el("span", { text: ".env path" })]),
            pathInput,
            saveVal,
            CH.el("div", { class: "v-raw-note", text: "Stored in .env (0600), never in the spec or shown here." }),
          ]),
        );
      });
      field.appendChild(CH.el("div", { class: "v-cred-row" }, [refInput, badge, setBtn]));
      field.appendChild(setterHost);
      syncBadge();
      container.appendChild(field);
    }

    // Editable list of strings → a whole-array replace at `path`.
    function renderStringArray(container, path, arr) {
      const work = Array.isArray(arr) ? arr.slice() : [];
      const box = CH.el("div", { class: "v-tags" });
      const addInput = CH.el("input", { class: "v-input v-tag-add", type: "text", placeholder: "add…" });
      function commit() {
        setChange(path, work.slice());
      }
      function draw() {
        CH.clear(box);
        work.forEach((item, i) => {
          box.appendChild(
            CH.el("span", { class: "v-tagchip" }, [
              CH.el("span", { text: String(item) }),
              CH.el(
                "button",
                {
                  title: "remove",
                  onClick: () => {
                    work.splice(i, 1);
                    draw();
                    commit();
                  },
                },
                CH.icon("x", 11),
              ),
            ]),
          );
        });
        box.appendChild(addInput);
      }
      addInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const v = addInput.value.trim();
          if (v) {
            work.push(v);
            addInput.value = "";
            draw();
            commit();
          }
        }
      });
      draw();
      container.appendChild(box);
    }

    // Structured permissions editor (mode select + whole-array rules).
    function renderPermissions(container, perms) {
      const modeSchema = st.schema ? schemaAt(st.schema, ["permissions", "mode"]) : null;
      const modes = enumOf(modeSchema) || ["default", "plan", "auto"];
      const modeField = CH.el("div", { class: "v-field" });
      modeField.appendChild(fieldLabel(["permissions", "mode"], "mode"));
      const sel = CH.el("select", { class: "v-select" });
      for (const mopt of modes) sel.appendChild(CH.el("option", { value: mopt, text: mopt }));
      sel.value = typeof perms.mode === "string" ? perms.mode : "default";
      sel.addEventListener("change", () => setChange(["permissions", "mode"], sel.value));
      modeField.appendChild(sel);
      container.appendChild(modeField);

      // rules — whole-array replace on any edit.
      const rules = Array.isArray(perms.rules) ? clone(perms.rules) : [];
      const listBox = CH.el("div", { class: "v-sub" });
      container.appendChild(CH.el("div", { class: "v-sub-label", text: "rules" }));
      container.appendChild(listBox);
      const RULE_TYPES = ["alwaysAllow", "alwaysAsk", "alwaysDeny"];
      function commitRules() {
        setChange(["permissions", "rules"], clone(rules));
      }
      function drawRules() {
        CH.clear(listBox);
        rules.forEach((r, i) => {
          const typeSel = CH.el("select", { class: "v-select" });
          for (const t of RULE_TYPES) typeSel.appendChild(CH.el("option", { value: t, text: t }));
          typeSel.value = r.type || "alwaysAsk";
          typeSel.addEventListener("change", () => {
            rules[i].type = typeSel.value;
            commitRules();
          });
          const pat = CH.el("input", { class: "v-input", type: "text", placeholder: "pattern", value: r.pattern || "" });
          pat.addEventListener("change", () => {
            rules[i].pattern = pat.value;
            commitRules();
          });
          const del = CH.el(
            "button",
            { class: "btn ghost sm icon-only", title: "remove rule", onClick: () => {
              rules.splice(i, 1);
              drawRules();
              commitRules();
            } },
            CH.icon("x", 12),
          );
          listBox.appendChild(CH.el("div", { class: "v-rule-row" }, [typeSel, pat, del]));
        });
        listBox.appendChild(
          CH.el("button", { class: "btn ghost sm", onClick: () => {
            rules.push({ type: "alwaysAsk", pattern: "" });
            drawRules();
          } }, [CH.icon("check", 12), CH.el("span", { text: "Add rule" })]),
        );
      }
      drawRules();

      // Any other permissions keys (rarely present) rendered generically.
      for (const k of Object.keys(perms)) {
        if (k === "mode" || k === "rules") continue;
        renderObject(container, ["permissions"], { [k]: perms[k] }, 1);
      }
    }

    function renderRawJson(container, path, value, note) {
      const wrapEl = CH.el("div", { class: "v-field" });
      const ta = CH.el("textarea", { class: "v-textarea", rows: 6, spellcheck: "false" });
      ta.value = JSON.stringify(value == null ? null : value, null, 2);
      const errEl = CH.el("div", { class: "v-set-err" });
      ta.addEventListener("input", () => {
        try {
          const parsed = JSON.parse(ta.value);
          errEl.textContent = "";
          setChange(path, parsed);
        } catch (e) {
          errEl.textContent = `invalid JSON: ${e.message}`;
        }
      });
      wrapEl.appendChild(ta);
      if (note) wrapEl.appendChild(CH.el("div", { class: "v-raw-note", text: note }));
      wrapEl.appendChild(errEl);
      container.appendChild(wrapEl);
    }

    reload();
    el._settingsReload = reload;
  }

  P.register({
    id: "settings",
    title: "Settings",
    icon: "shield",
    order: 40,
    feature: P.VIEW_FEATURES.settings,
    mount: mountSettings,
  });

  // ── Chat-link matchers (requirement 4) ───────────────────────────────────
  // Images/data files the default matcher misses → the files viewer.
  P.linkify(EXTRA_FILE_RE, (m) => ({ view: "files", arg: { path: m[0] } }));
  // Sub-agent names mentioned in chat → the background-tasks view. Names are
  // learned from the live event ring on each scan so links appear as soon as a
  // task is seen, whether or not the tasks view is mounted.
  P.linkify(function (text) {
    for (const m of P.recent("event")) {
      const ev = m && m.event;
      if (ev && ev.kind === "sub_agent_start" && typeof ev.name === "string") taskNames.add(ev.name);
    }
    return matchTaskNames(text, taskNames);
  });
  // REQ ledger ids mentioned in chat → the focus view (where the ledger lives).
  // Inert until the focus view is registered+enabled (applyLinks gates on that).
  P.linkify(/\bREQ-\d{3,}\b/g, (m) => ({ view: "focus", arg: { req: m[0] } }));

  // Inject the view styles now (guarded for the DOM-less test env) rather than
  // lazily on first mount, so panel styling is present before the first open.
  ensureStyles();

  // ── Export pure helpers for the unit tests ───────────────────────────────
  window.CH.views = {
    pairTools,
    pairSubAgents,
    buildFileTree,
    deriveArtifacts,
    resolvePathRoute,
    matchTaskNames,
    toolKey,
    EXTRA_FILE_RE,
    // Phase 3c memory-file parsers + derivations (all DOM-free, unit-tested).
    parseFocus,
    summarizeRequirements,
    parsePlan,
    parseGoals,
    statusMeta,
    parseHandoffNextActions,
    parseWikiIndex,
    filterWiki,
    sortWiki,
    stripFrontmatter,
    parseJsonl,
    sessionEvictions,
    aggregateSkills,
    countSkillCalls,
    accumulateContext,
    collectCompactions,
    normalizePlanId,
    NOMINAL_CONTEXT_WINDOW,
    // Phase 4 settings helpers (DOM-free).
    isRef,
    isCredentialField,
    getAtPath,
    hasAtPath,
    deepEqual,
    pickTargetSchema,
    schemaAt,
    enumOf,
    _taskNames: taskNames,
  };
})();
