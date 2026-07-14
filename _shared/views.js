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
    /* Reconciliation: the Phase-3a default file-link matcher targets the view
       id "file"; we register a hidden "file" alias that redirects to "files"
       so those links open the (plural) files viewer. Hide its rail button. */
    .panel-rail-btn[data-view="file"]{display:none !important;}
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

  // Reconciliation alias: the Phase-3a default file-link matcher (in panels.js,
  // pinned by test/panels.test.ts) resolves to the view id "file" (singular),
  // while this view + CH.panels.VIEW_FEATURES use "files" (plural). Rather than
  // edit the frozen framework, register a hidden "file" alias that forwards to
  // "files" so every default file-path chat link opens the real viewer. Its
  // rail button is hidden via CSS (ensureStyles).
  P.register({
    id: "file",
    title: "Files",
    icon: "folder",
    order: 999,
    feature: P.VIEW_FEATURES.files,
    mount(el) {
      ensureStyles();
      el.appendChild(empty("Opening files…"));
    },
    update(el, api, msg) {
      if (msg.type === "open") P.open("files", msg.arg);
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

  // Inject the view + alias-hiding styles now (guarded for the DOM-less test
  // env) rather than lazily on first mount, so the hidden "file" alias rail
  // button never flashes before a view is opened.
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
    _taskNames: taskNames,
  };
})();
