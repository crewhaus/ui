/* ============================================================================
   CrewHaus Shape UI — panel system (CH.panels).

   The 5th shared browser IIFE (loaded after app-kit.js, before a shape's
   app.js). It adds a tasteful right-side viewer — a Claude-desktop-style slim
   icon rail plus a collapsible content pane — on top of the existing layout
   vocabulary (.split/.pane in ui.css). Chat/main stays primary; the rail opens
   on demand and never pops up unbidden.

   This module is the FRAMEWORK only (Phase 3a). The real views (files, plan,
   focus, wiki, tools, …) land in Phase 3b/3c; here we ship the registry, the
   features[]-driven gating, the chat-link routing hook, the light/dark theme
   helper, and two trivial built-in demo views so the framework is
   demonstrably working end-to-end.

   Public surface (attached as window.CH.panels):
     init(api, hostEl)                     — called once by app-kit
     register({ id, title, icon, order?, feature?, mount(el,api),
                update?(el,api,msg), badge?() })
     open(id, arg?)  close()  toggle()
     isOpen()  active()  recent(type?)
     linkify(regexpOrFn, resolver?)        — add a chat-link matcher
     theme.{normalize,next,read,save,apply,set,toggle,KEY,DEFAULT}
     gateViews(defs, features)             — pure gating (exported for tests)
     scanLinks(text, matchers?)            — pure link scan (exported for tests)
     VIEW_FEATURES                         — the planned-view → features[] map

   A view mounts only when one of its declared `feature` keys is present in the
   shape's config.features[]; a shape whose features enable zero views renders
   exactly as before (the whole host stays display:none, no rail, no toggle).
   ========================================================================== */
(function () {
  "use strict";
  const CH = window.CH;

  // ── Persistence keys ─────────────────────────────────────────────────────
  const OPEN_KEY = "crewhaus-ui-panel-open";
  const VIEW_KEY = "crewhaus-ui-panel-view";
  const THEME_KEY = "crewhaus-ui-theme";
  const RING_MAX = 200;

  function readLS(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function writeLS(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  }

  // ── Light / dark theme (decision §10.5) ──────────────────────────────────
  // A `[data-theme]` layer over the dark :root tokens, opt-in and persisted —
  // never a prefers-color-scheme auto-switch (mirrors the accent model). The
  // pure bits (normalize/next/read) are DOM-free so they unit-test cleanly;
  // apply() is the only part that touches documentElement.
  const theme = {
    KEY: THEME_KEY,
    DEFAULT: "dark",
    normalize(v) {
      return v === "light" ? "light" : "dark";
    },
    next(v) {
      return theme.normalize(v) === "light" ? "dark" : "light";
    },
    read() {
      return theme.normalize(readLS(THEME_KEY) || theme.DEFAULT);
    },
    apply(v) {
      const t = theme.normalize(v);
      document.documentElement.setAttribute("data-theme", t);
      return t;
    },
    save(v) {
      const t = theme.normalize(v);
      writeLS(THEME_KEY, t);
      return t;
    },
    set(v) {
      return theme.apply(theme.save(v));
    },
    toggle() {
      return theme.set(theme.next(theme.read()));
    },
  };

  // ── The planned-view → features[] mapping (requirement 3) ────────────────
  // This is what finally makes the declared-but-inert config.features[] arrays
  // load-bearing. Each of the ~11 planned Phase-3b/3c view ids maps to the set
  // of features[] keys that enable it; a view is shown when ANY of its keys is
  // in the shape's features[]. Phase-3b/3c views should register with
  // `feature: CH.panels.VIEW_FEATURES[id]`. The keys reuse the vocabulary
  // already present across the 18 shapes' config.json (e.g. crew has "roles",
  // graph "nodes", research "branches" → all light up the "plan" view).
  const VIEW_FEATURES = {
    tools: ["tools"],
    "background-tasks": ["subagents", "jobs", "loop", "runs", "orchestration"],
    files: ["files"],
    artifacts: ["report", "artifacts", "screenshots", "sources"],
    focus: ["focus"],
    plan: ["plan", "steps", "branches", "nodes", "roles", "graph", "workflow"],
    context: ["context", "cost"],
    wiki: ["wiki", "citations"],
    skills: ["skills"],
    upload: ["upload", "attach"],
    diff: ["diff"],
    // `settings` (Phase 4) lands on nearly every shape; documented here for
    // completeness even though it is not one of the 11 "view catalog" rows.
    settings: ["settings"],
  };

  // ── Gating (pure) ────────────────────────────────────────────────────────
  function featureKeys(def) {
    if (def.feature == null) return null; // always-on
    return Array.isArray(def.feature) ? def.feature : [def.feature];
  }
  /** A view is enabled if it declares no feature, or any of its feature keys
      is in the shape's features[]. */
  function viewEnabled(def, features) {
    const keys = featureKeys(def);
    if (keys == null) return true;
    if (!Array.isArray(features)) return false;
    return keys.some((k) => features.includes(k));
  }
  /** Pure: the subset of `defs` enabled by `features`. Exported for tests. */
  function gateViews(defs, features) {
    return (defs || []).filter((d) => viewEnabled(d, features));
  }

  // ── Chat-link routing (requirement 4) ────────────────────────────────────
  const matchers = [];
  /**
   * Register a linkify matcher. Phase-3b/3c views call this to make their
   * references clickable without every pattern being hard-coded here.
   *   linkify(regexp, (match) => ({ view, arg, text? }) | null)
   *   linkify(fn)  where fn(text) -> [{ index, length, view, arg, text? }]
   * Returns an unregister function.
   */
  function linkify(matcher, resolver) {
    const entry = { matcher, resolver };
    matchers.push(entry);
    return () => {
      const i = matchers.indexOf(entry);
      if (i >= 0) matchers.splice(i, 1);
    };
  }

  /**
   * Pure: scan `text` with the given matchers (defaults to the registered
   * ones) and return non-overlapping, index-sorted hits:
   *   [{ index, length, text, view, arg }]
   * On overlap the earlier position wins, and at the same position the longer
   * (more specific) match wins. Exported for tests.
   */
  function scanLinks(text, ms) {
    if (!text) return [];
    ms = ms || matchers;
    const hits = [];
    for (const { matcher, resolver } of ms) {
      if (matcher instanceof RegExp) {
        const flags = matcher.flags.includes("g") ? matcher.flags : matcher.flags + "g";
        const re = new RegExp(matcher.source, flags);
        for (const m of text.matchAll(re)) {
          if (m[0] === "") continue;
          const t = resolver ? resolver(m) : null;
          if (t && t.view)
            hits.push({
              index: m.index,
              length: m[0].length,
              text: t.text != null ? t.text : m[0],
              view: t.view,
              arg: t.arg,
            });
        }
      } else if (typeof matcher === "function") {
        const raw = matcher(text) || [];
        for (const h of raw) {
          if (h && h.view && typeof h.index === "number" && h.length > 0)
            hits.push({
              index: h.index,
              length: h.length,
              text: h.text != null ? h.text : text.slice(h.index, h.index + h.length),
              view: h.view,
              arg: h.arg,
            });
        }
      }
    }
    hits.sort((a, b) => a.index - b.index || b.length - a.length);
    const out = [];
    let end = -1;
    for (const h of hits) {
      if (h.index >= end) {
        out.push(h);
        end = h.index + h.length;
      }
    }
    return out;
  }

  const SKIP_LINK_TAGS = { A: 1, CODE: 1, PRE: 1, BUTTON: 1, TEXTAREA: 1 };
  /**
   * Walk the text nodes under `root` and turn scanLinks() hits into real
   * anchor nodes (innerHTML-free — we only replace text nodes). A hit is only
   * linked if its target view is currently openable, so mentions stay plain
   * text until the relevant Phase-3b/3c view is registered+enabled. Called by
   * ui.js `mdInto` on every feed/chat render.
   */
  function applyLinks(root) {
    if (!root || !matchers.length || typeof document === "undefined") return root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let p = n.parentNode;
        while (p && p !== root) {
          if (SKIP_LINK_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const tn of nodes) {
      const hits = scanLinks(tn.nodeValue).filter((h) => isOpenable(h.view));
      if (!hits.length) continue;
      const frag = document.createDocumentFragment();
      const s = tn.nodeValue;
      let pos = 0;
      for (const h of hits) {
        if (h.index > pos) frag.appendChild(document.createTextNode(s.slice(pos, h.index)));
        frag.appendChild(makeLink(h));
        pos = h.index + h.length;
      }
      if (pos < s.length) frag.appendChild(document.createTextNode(s.slice(pos)));
      if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
    }
    return root;
  }
  function makeLink(h) {
    return CH.el(
      "a",
      {
        class: "ch-link",
        href: "#",
        title: `Open ${h.view}`,
        dataset: { chView: h.view },
        onClick: (e) => {
          e.preventDefault();
          open(h.view, h.arg);
        },
      },
      h.text,
    );
  }

  // The three canonical default patterns (requirement 4). They stay inert
  // until a shape registers+enables the matching view (Phase 3b/3c), at which
  // point every feed/chat mention becomes a live link with no extra wiring.
  linkify(
    /(?:[\w.\-]+\/)*[\w.\-]+\.(?:ts|tsx|js|jsx|json|md|ya?ml|toml|txt|py|css|html|sh|lock)\b/g,
    (m) => ({ view: "files", arg: { path: m[0] } }),
  );
  linkify(/\bplan-\d{3,4}(?:-[a-z0-9-]+)?\b/g, (m) => ({ view: "plan", arg: { id: m[0] } }));
  linkify(/\[\[([a-z0-9][a-z0-9/_-]*)\]\]/gi, (m) => ({
    view: "wiki",
    arg: { slug: m[1] },
    text: m[1],
  }));

  // ── Registry + host state ────────────────────────────────────────────────
  let apiRef = null;
  let host = null; // the .panel-host element app-kit supplies
  let railEl = null;
  let paneEl = null;
  let paneTitleEl = null;
  let paneBody = null;
  let backdropEl = null;
  let toggleBtn = null; // header toggle (hidden until ≥1 view enabled)
  let inited = false;
  let restored = false;

  let seq = 0;
  const views = []; // records: { def, seq, el, mounted, railBtn, badgeEl }
  let enabled = []; // gated subset of `views`
  let activeId = null;
  let openState = false;
  const ring = []; // recent messages, for late-mount backfill + badges

  function pushRing(type, msg) {
    ring.push({ type, msg });
    if (ring.length > RING_MAX) ring.shift();
  }
  /** Recent messages (optionally filtered by type). Views use this to backfill
      on mount and to compute badges without being mounted. */
  function recent(type) {
    const items = type ? ring.filter((r) => r.type === type) : ring.slice();
    return items.map((r) => r.msg);
  }

  function byId(id) {
    return views.find((r) => r.def.id === id) || null;
  }
  function isOpenable(id) {
    return !!enabled.find((r) => r.def.id === id);
  }

  // ── Registration ─────────────────────────────────────────────────────────
  function register(def) {
    if (!def || !def.id) throw new Error("CH.panels.register: a view needs an id");
    if (typeof def.mount !== "function") throw new Error(`view "${def.id}" needs a mount(el, api)`);
    let rec = byId(def.id);
    if (rec) {
      rec.def = def; // re-register replaces definition
    } else {
      rec = { def, seq: seq++, el: null, mounted: false, railBtn: null, badgeEl: null };
      views.push(rec);
    }
    views.sort((a, b) => (a.def.order ?? 100) - (b.def.order ?? 100) || a.seq - b.seq);
    if (inited) refreshGating();
    return rec;
  }

  // ── Mount / open / close ─────────────────────────────────────────────────
  function ensureMounted(rec) {
    if (rec.mounted) return;
    rec.el = CH.el("div", { class: "panel-view" });
    try {
      rec.def.mount(rec.el, apiRef);
    } catch (e) {
      rec.el.appendChild(CH.el("div", { class: "panel-empty", text: `view error: ${e.message}` }));
    }
    rec.mounted = true;
  }
  function dispatchTo(rec, msg) {
    if (rec.mounted && typeof rec.def.update === "function") {
      try {
        rec.def.update(rec.el, apiRef, msg);
      } catch {}
    }
  }

  function open(id, arg) {
    const rec = enabled.find((r) => r.def.id === id);
    if (!rec) {
      if (apiRef && apiRef.toast) apiRef.toast(`The ${id} panel isn't available in this shape.`);
      return;
    }
    ensureMounted(rec);
    activeId = id;
    openState = true;
    CH.clear(paneBody);
    paneBody.appendChild(rec.el);
    paneTitleEl.textContent = rec.def.title || id;
    dispatchTo(rec, { type: "open", arg }); // deliver open arg (e.g. {path})
    host.classList.add("open");
    updateRailActive();
    persistState();
  }
  function close() {
    openState = false;
    host.classList.remove("open");
    updateRailActive();
    persistState();
  }
  function toggle() {
    if (openState) close();
    else open(activeId || (enabled[0] && enabled[0].def.id));
  }

  function persistState() {
    writeLS(OPEN_KEY, openState ? "1" : "0");
    if (activeId) writeLS(VIEW_KEY, activeId);
  }

  // ── Rail + badges ────────────────────────────────────────────────────────
  function renderRail() {
    if (!railEl) return;
    CH.clear(railEl);
    for (const rec of enabled) {
      const btn = CH.el(
        "button",
        {
          class: "panel-rail-btn",
          title: rec.def.title || rec.def.id,
          "aria-label": rec.def.title || rec.def.id,
          dataset: { view: rec.def.id },
          onClick: () => (activeId === rec.def.id && openState ? close() : open(rec.def.id)),
        },
        CH.icon(rec.def.icon || "layers", 17),
      );
      const badge = CH.el("span", { class: "panel-rail-badge", style: { display: "none" } });
      btn.appendChild(badge);
      rec.railBtn = btn;
      rec.badgeEl = badge;
      railEl.appendChild(btn);
    }
    updateRailActive();
    refreshBadges();
  }
  function updateRailActive() {
    for (const rec of enabled) {
      if (rec.railBtn)
        rec.railBtn.classList.toggle("active", openState && rec.def.id === activeId);
    }
  }
  function refreshBadges() {
    for (const rec of enabled) {
      if (!rec.badgeEl || typeof rec.def.badge !== "function") continue;
      let v = null;
      try {
        v = rec.def.badge();
      } catch {}
      if (v == null || v === false || v === 0 || v === "") {
        rec.badgeEl.style.display = "none";
        rec.badgeEl.textContent = "";
      } else {
        rec.badgeEl.style.display = "";
        rec.badgeEl.textContent = typeof v === "number" && v > 99 ? "99+" : String(v);
      }
    }
  }

  // ── Gating (live) ────────────────────────────────────────────────────────
  function currentFeatures() {
    const cfg =
      (apiRef && apiRef.config) || (apiRef && apiRef.state && apiRef.state.config) || {};
    return Array.isArray(cfg.features) ? cfg.features : [];
  }
  function refreshGating() {
    const features = currentFeatures();
    enabled = views.filter((r) => viewEnabled(r.def, features));
    const has = enabled.length > 0;
    host.classList.toggle("has-views", has);
    if (toggleBtn) toggleBtn.style.display = has ? "" : "none";
    renderRail();
    if (activeId && !isOpenable(activeId)) {
      activeId = null;
      close();
    }
    restoreOnce();
  }
  // Restore the user's persisted open/active choice once the matching view is
  // enabled. This honours a prior explicit choice — it is NOT an auto-pop (the
  // rail never opens in response to an incoming event/message).
  function restoreOnce() {
    if (restored || !enabled.length) return;
    restored = true;
    const savedView = readLS(VIEW_KEY);
    const savedOpen = readLS(OPEN_KEY) === "1";
    const target = isOpenable(savedView) ? savedView : null;
    if (target) activeId = target;
    if (savedOpen && target) open(target);
  }

  // ── Message fan-out ──────────────────────────────────────────────────────
  function onMsg(type, msg) {
    pushRing(type, msg);
    for (const rec of views) if (rec.mounted) dispatchTo(rec, msg);
    refreshBadges();
  }

  // ── Host DOM (built inside the app-kit-supplied .panel-host) ─────────────
  function buildHostDom() {
    railEl = CH.el("div", { class: "panel-rail" });
    paneTitleEl = CH.el("span", { class: "panel-pane-title", text: "" });
    paneBody = CH.el("div", { class: "panel-pane-body" });
    const paneHead = CH.el("div", { class: "panel-pane-head" }, [
      paneTitleEl,
      CH.el("span", { class: "grow" }),
      CH.el(
        "button",
        { class: "btn ghost sm icon-only", title: "Close panel", onClick: () => close() },
        CH.icon("x", 14),
      ),
    ]);
    const paneInner = CH.el("div", { class: "panel-pane-inner" }, [paneHead, paneBody]);
    paneEl = CH.el("div", { class: "panel-pane" }, paneInner);
    backdropEl = CH.el("div", { class: "panel-backdrop", onClick: () => close() });
    // order left→right: backdrop (overlay only), pane, rail
    host.appendChild(backdropEl);
    host.appendChild(paneEl);
    host.appendChild(railEl);
  }

  function addHeaderToggle() {
    if (!apiRef || typeof apiRef.addAction !== "function") return;
    toggleBtn = CH.el("button", {
      class: "btn ghost sm icon-only",
      title: "Toggle side panel",
      "aria-label": "Toggle side panel",
      style: { display: "none" },
      onClick: () => toggle(),
    });
    toggleBtn.appendChild(CH.icon("panelRight", 15));
    apiRef.addAction(toggleBtn);
  }

  // ── Init (called once by app-kit) ────────────────────────────────────────
  function init(api, hostEl) {
    if (inited) return; // one app per page
    inited = true;
    apiRef = api;
    host = hostEl;
    buildHostDom();
    addHeaderToggle();
    api.on("event", (m) => onMsg("event", m));
    api.on("memory", (m) => onMsg("memory", m));
    api.on("user", (m) => onMsg("user", m));
    api.on("status", (m) => onMsg("status", m));
    api.onState(() => refreshGating());
    registerBuiltins();
    refreshGating();
  }

  // ── Built-in demo views (Phase-3a proof; real views ship in 3b/3c) ───────
  // Gated on features that only the cli reference shape declares ("tools" and
  // "chat"), so all 17 other shapes enable zero views and stay pixel-identical.
  function registerBuiltins() {
    // Activity: mirror the last handful of trace events, reusing the shared
    // event-card renderer. Proves update(msg) + badge() + recent() backfill.
    register({
      id: "activity",
      title: "Activity",
      icon: "activity",
      order: 10,
      feature: "tools",
      mount(el) {
        const list = CH.el("div", { class: "panel-list" });
        el.appendChild(
          CH.el("div", { class: "panel-section" }, [
            CH.el("div", { class: "panel-hint", text: "Recent trace events" }),
            list,
          ]),
        );
        for (const m of recent("event").slice(-8)) appendEv(list, m.event);
        if (!list.firstChild)
          list.appendChild(CH.el("div", { class: "panel-empty", text: "No events yet." }));
      },
      update(el, api, msg) {
        if (msg.type !== "event") return;
        const list = el.querySelector(".panel-list");
        const empty = list.querySelector(".panel-empty");
        if (empty) empty.remove();
        appendEv(list, msg.event);
        while (list.childElementCount > 12) list.removeChild(list.firstChild);
      },
      badge() {
        const n = recent("event").filter(
          (m) => m.event && !CH.events.FEED_SKIP.has(m.event.kind),
        ).length;
        return n || null;
      },
    });

    // Session: the latched identity + live run state from Phase 1. Proves a
    // view that reads api.state (identity {sessionId, specName}) and reacts to
    // state/status messages.
    register({
      id: "session",
      title: "Session",
      icon: "eye",
      order: 20,
      feature: "chat",
      mount(el) {
        el.appendChild(CH.el("dl", { class: "panel-dl" }));
        renderSession(el);
      },
      update(el, api, msg) {
        if (msg.type === "state" || msg.type === "status" || msg.type === "memory")
          renderSession(el);
      },
    });
  }

  function appendEv(list, ev) {
    if (!ev) return;
    const node = CH.events.render(ev);
    if (node) list.appendChild(node);
  }
  function row(dl, k, v) {
    dl.appendChild(CH.el("dt", { text: k }));
    dl.appendChild(CH.el("dd", { text: v == null || v === "" ? "—" : String(v) }));
  }
  function renderSession(el) {
    const dl = el.querySelector(".panel-dl");
    if (!dl) return;
    CH.clear(dl);
    const st = (apiRef && apiRef.state) || {};
    const id = st.identity || {};
    const h = st.harness || {};
    row(dl, "State", st.state || "offline");
    row(dl, "Session", id.sessionId || "not started");
    row(dl, "Spec", id.specName);
    row(dl, "Harness", h.present ? h.entry || "present" : "not dropped");
    if (typeof h.depsInstalled === "boolean")
      row(dl, "Deps", h.depsInstalled ? "installed" : "missing");
    row(dl, "Shape", (apiRef && apiRef.config && apiRef.config.shape) || "");
  }

  // ── Export ───────────────────────────────────────────────────────────────
  window.CH.panels = {
    init,
    register,
    open,
    close,
    toggle,
    isOpen: () => openState,
    active: () => activeId,
    recent,
    linkify,
    theme,
    // internal hook called by ui.js mdInto
    _applyLinks: applyLinks,
    // pure helpers (exported for tests + Phase-3b/3c authors)
    gateViews,
    scanLinks,
    viewEnabled,
    VIEW_FEATURES,
  };
})();
