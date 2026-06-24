/* ============================================================================
   CrewHaus Shape UI — shared frontend runtime.

   Exposes a `CH` namespace. Rendering is 100% DOM-based (createElement /
   textContent / DOMParser for static SVG) — no innerHTML, no HTML-string
   injection — so agent output can never inject script. No build step.

   API contract used by every shape's app.js and by events.js:
     CH.el(tag, attrs, children)   -> HTMLElement
        attrs: { class, text, dataset:{}, style:{}, on<Event>: fn, <attr>: val }
        children: Node | string | array (nested) | null
     CH.icon(name, size=18)        -> SVGElement (a fresh clone)
     CH.md(src)                    -> DocumentFragment (safe markdown)
     CH.mdInto(node, src)          -> clears node, appends md(src)
     CH.fmt*(...)                  -> formatting helpers (strings)
     CH.Connection()               -> WebSocket client { on, send, connect }
     CH.Chat / Terminal / Composer / dropzone -> UI components
   ========================================================================== */
(function () {
  "use strict";

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "dataset") for (const d in v) node.dataset[d] = v[d];
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k.startsWith("on") && typeof v === "function")
          node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? "" : v);
      }
    }
    add(node, children);
    return node;
  }
  function add(node, children) {
    if (children == null) return;
    if (Array.isArray(children)) children.forEach((c) => add(node, c));
    else if (children instanceof Node) node.appendChild(children);
    else node.appendChild(document.createTextNode(String(children)));
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // ── Icons (Lucide-style). Static SVG strings parsed once via DOMParser. ───
  const SVGNS = "http://www.w3.org/2000/svg";
  const ICONS = {
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    wrench:
      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
    coins:
      '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
    shield:
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    refresh:
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert:
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    git: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
    layers:
      '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
    network:
      '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8"/>',
    flask:
      '<path d="M10 2v7.31"/><path d="M14 9.3V1.99"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
    globe:
      '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    gamepad:
      '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><rect width="20" height="12" x="2" y="6" rx="2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    workflow:
      '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    package:
      '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    database:
      '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
    sparkles:
      '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/>',
    message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    hook: '<path d="M18 6.5a2.5 2.5 0 0 0-5 0v9a3.5 3.5 0 1 1-7 0V8"/>',
    scissors:
      '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
    arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M15 9h0M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5"/>',
    coin: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10.5h3.5a1.5 1.5 0 0 1 0 3H9.5"/>',
  };
  const _iconCache = {};
  function iconTemplate(name) {
    if (_iconCache[name]) return _iconCache[name];
    const body = ICONS[name] || ICONS.dot;
    const str = `<svg xmlns="${SVGNS}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    const doc = new DOMParser().parseFromString(str, "image/svg+xml");
    const svg = doc.documentElement;
    _iconCache[name] = svg;
    return svg;
  }
  function icon(name, size) {
    const s = size || 18;
    const svg = iconTemplate(name).cloneNode(true);
    svg.setAttribute("width", s);
    svg.setAttribute("height", s);
    return svg;
  }

  // ── Formatting ────────────────────────────────────────────────────────────
  function fmtBytes(n) {
    if (n == null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }
  function fmtMs(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }
  function fmtTokens(n) {
    if (n == null) return "0";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  function fmtUsd(micros) {
    if (micros == null) return "$0.00";
    const d = micros / 1e6;
    return d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
  }

  // ── Markdown -> DOM (safe; never parses dynamic HTML) ─────────────────────
  function inlineNodes(s) {
    const frag = document.createDocumentFragment();
    let rest = s;
    const patterns = [
      { re: /`([^`]+)`/, tag: "code" },
      { re: /\*\*([^*]+)\*\*/, tag: "strong" },
      { re: /__([^_]+)__/, tag: "strong" },
      { re: /\*([^*\n]+)\*/, tag: "em" },
      { re: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/, tag: "a" },
      { re: /(https?:\/\/[^\s)]+)/, tag: "autolink" },
    ];
    while (rest) {
      let best = null;
      for (const p of patterns) {
        const m = rest.match(p.re);
        if (m && (!best || m.index < best.m.index)) best = { p, m };
      }
      if (!best) {
        frag.appendChild(document.createTextNode(rest));
        break;
      }
      const { p, m } = best;
      if (m.index > 0) frag.appendChild(document.createTextNode(rest.slice(0, m.index)));
      if (p.tag === "a") {
        frag.appendChild(el("a", { href: m[2], target: "_blank", rel: "noopener", text: m[1] }));
      } else if (p.tag === "autolink") {
        frag.appendChild(el("a", { href: m[1], target: "_blank", rel: "noopener", text: m[1] }));
      } else if (p.tag === "code") {
        frag.appendChild(el("code", { text: m[1] }));
      } else {
        frag.appendChild(el(p.tag, null, inlineNodes(m[1])));
      }
      rest = rest.slice(m.index + m[0].length);
    }
    return frag;
  }

  function md(src) {
    const frag = document.createDocumentFragment();
    if (!src) return frag;
    const lines = src.replace(/\r/g, "").split("\n");
    let i = 0;
    let para = [];
    const flushPara = () => {
      if (para.length) {
        frag.appendChild(el("p", null, inlineNodes(para.join(" "))));
        para = [];
      }
    };
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^```/.test(line)) {
        flushPara();
        const lang = line.replace(/^```/, "").trim();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++; // closing fence
        const c = el("code", { text: code.join("\n") });
        if (lang) c.className = `lang-${lang}`;
        frag.appendChild(el("pre", null, c));
        continue;
      }
      if (/^\s*$/.test(line)) {
        flushPara();
        i++;
        continue;
      }
      if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
        flushPara();
        frag.appendChild(el(`h${m[1].length}`, null, inlineNodes(m[2])));
        i++;
        continue;
      }
      if (/^\s*([-*+])\s+/.test(line)) {
        flushPara();
        const ul = el("ul");
        while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i])) {
          ul.appendChild(el("li", null, inlineNodes(lines[i].replace(/^\s*([-*+])\s+/, ""))));
          i++;
        }
        frag.appendChild(ul);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        flushPara();
        const ol = el("ol");
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          ol.appendChild(el("li", null, inlineNodes(lines[i].replace(/^\s*\d+\.\s+/, ""))));
          i++;
        }
        frag.appendChild(ol);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        const bq = el("blockquote");
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          if (bq.firstChild) bq.appendChild(el("br"));
          add(bq, inlineNodes(lines[i].replace(/^\s*>\s?/, "")));
          i++;
        }
        frag.appendChild(bq);
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flushPara();
        frag.appendChild(el("hr"));
        i++;
        continue;
      }
      para.push(line);
      i++;
    }
    flushPara();
    return frag;
  }
  function mdInto(node, src) {
    clear(node);
    node.appendChild(md(src));
    return node;
  }

  // ── WebSocket client ──────────────────────────────────────────────────────
  function Connection() {
    const handlers = {};
    let ws = null;
    let retry = 0;
    const emit = (type, msg) => (handlers[type] || []).forEach((cb) => cb(msg));
    const api = {
      on(type, cb) {
        (handlers[type] = handlers[type] || []).push(cb);
        return api;
      },
      send(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
      },
      connect() {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/ws`);
        ws.onopen = () => {
          retry = 0;
          emit("open", {});
        };
        ws.onclose = () => {
          emit("close", {});
          retry++;
          setTimeout(() => api.connect(), Math.min(retry * 500, 4000));
        };
        ws.onmessage = (e) => {
          let msg;
          try {
            msg = JSON.parse(e.data);
          } catch {
            return;
          }
          emit(msg.type, msg);
          emit("*", msg);
        };
        return api;
      },
    };
    return api;
  }

  // ── Status pill ───────────────────────────────────────────────────────────
  const STATE_LABELS = {
    idle: "idle",
    installing: "installing",
    starting: "starting",
    running: "running",
    exited: "exited",
    error: "error",
    ready: "ready",
    offline: "offline",
  };
  function setStatus(node, state, detail) {
    node.dataset.state = state;
    let dot = node.querySelector(".dot");
    let txt = node.querySelector(".st-text");
    if (!dot) {
      dot = el("span", { class: "dot" });
      node.appendChild(dot);
    }
    if (!txt) {
      txt = el("span", { class: "st-text" });
      node.appendChild(txt);
    }
    txt.textContent = (STATE_LABELS[state] || state) + (detail ? ` · ${detail}` : "");
  }

  // ── Toasts ────────────────────────────────────────────────────────────────
  let toastWrap = null;
  function toast(msg, kind) {
    if (!toastWrap) {
      toastWrap = el("div", { class: "toast-wrap" });
      document.body.appendChild(toastWrap);
    }
    const t = el("div", { class: `toast ${kind === "err" ? "err" : ""}`, text: msg });
    toastWrap.appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      t.style.transition = "opacity .3s";
      setTimeout(() => t.remove(), 300);
    }, 3600);
  }
  function copy(text) {
    navigator.clipboard?.writeText(text).then(
      () => toast("Copied to clipboard"),
      () => toast("Copy failed", "err"),
    );
  }

  // ── Terminal component ────────────────────────────────────────────────────
  function Terminal(mount) {
    const pre = el("div", { class: "terminal" });
    mount.appendChild(pre);
    let atBottom = true;
    mount.addEventListener("scroll", () => {
      atBottom = mount.scrollHeight - mount.scrollTop - mount.clientHeight < 40;
    });
    function write(text, cls) {
      pre.appendChild(el("span", { class: `line ${cls ? "t-" + cls : ""}`, text }));
      if (atBottom) mount.scrollTop = mount.scrollHeight;
    }
    return {
      write,
      stdout: (t) => write(t, "stdout"),
      stderr: (t) => write(t + "\n", "stderr"),
      system: (t) => write(t + "\n", "system"),
      clear: () => clear(pre),
    };
  }

  // ── Chat component ────────────────────────────────────────────────────────
  function Chat(mount, opts) {
    opts = opts || {};
    const list = el("div", { class: "transcript" });
    mount.appendChild(list);
    let current = null; // active assistant content node
    let buffer = "";
    let atBottom = true;
    mount.addEventListener("scroll", () => {
      atBottom = mount.scrollHeight - mount.scrollTop - mount.clientHeight < 60;
    });
    const scroll = () => {
      if (atBottom) mount.scrollTop = mount.scrollHeight;
    };
    function bubble(role, label) {
      const content = el("div", { class: "content" });
      list.appendChild(
        el("div", { class: `msg ${role}` }, [
          el("div", { class: "avatar" }, icon(role === "user" ? "user" : "bot", 15)),
          el("div", { class: "bubble" }, [
            el("div", { class: "who", text: label || (role === "user" ? "you" : "agent") }),
            content,
          ]),
        ]),
      );
      scroll();
      return content;
    }
    return {
      user(text) {
        const c = bubble("user");
        c.textContent = text;
        current = null;
        buffer = "";
      },
      assistant(text) {
        if (!current) {
          current = bubble("assistant", opts.agentLabel);
          current.classList.add("md");
          buffer = "";
        }
        buffer += text;
        mdInto(current, buffer);
        current.classList.add("cursor-blink");
        scroll();
      },
      endTurn() {
        if (current) current.classList.remove("cursor-blink");
        current = null;
        buffer = "";
      },
      node(n) {
        list.appendChild(n);
        current = null;
        scroll();
      },
      systemNote(text) {
        list.appendChild(
          el("div", { class: "msg assistant" }, [
            el("div", { class: "avatar" }, icon("sparkles", 15)),
            el("div", { class: "bubble" }, el("div", { class: "content muted", text })),
          ]),
        );
        current = null;
        scroll();
      },
      clear() {
        clear(list);
        current = null;
        buffer = "";
      },
    };
  }

  // ── Composer ──────────────────────────────────────────────────────────────
  function Composer(mount, onSubmit, opts) {
    opts = opts || {};
    const ta = el("textarea", {
      class: "field",
      rows: 1,
      placeholder: opts.placeholder || "Message the agent…",
    });
    const btn = el("button", { class: "btn primary" }, [
      icon("send", 15),
      el("span", { text: "Send" }),
    ]);
    const autosize = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    };
    ta.addEventListener("input", autosize);
    const fire = () => {
      const v = ta.value.trim();
      if (!v) return;
      onSubmit(v);
      ta.value = "";
      autosize();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        fire();
      }
    });
    btn.addEventListener("click", fire);
    const hint = el("div", { class: "composer-hint" }, [
      el("span", null, [kbd("Enter"), " send"]),
      el("span", null, [kbd("Shift"), "+", kbd("Enter"), " newline"]),
      opts.hint ? el("span", { class: "muted", text: opts.hint }) : null,
    ]);
    mount.appendChild(
      el("div", { class: "composer" }, [el("div", { class: "composer-row" }, [ta, btn]), hint]),
    );
    return {
      focus: () => ta.focus(),
      setEnabled: (b) => {
        ta.disabled = !b;
        btn.disabled = !b;
      },
    };
  }
  function kbd(text) {
    return el("kbd", { text });
  }

  // Strip ANSI escape sequences (raw bundle stdout may carry colour codes).
  function stripAnsi(s) {
    return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  }

  // ── Dropzone / onboarding empty state ─────────────────────────────────────
  function dropzone(opts) {
    return el("div", { class: "empty" }, [
      el("div", { class: "empty-inner" }, [
        el("div", { class: "dropzone" }, [
          el("div", { class: "big-icon" }, icon(opts.icon || "package", 28)),
          el("h2", { text: opts.title || "Drop in a compiled harness" }),
          opts.subtitle ? el("p", { class: "muted", text: opts.subtitle }) : null,
          el(
            "div",
            { class: "steps" },
            (opts.steps || []).map((s, i) =>
              el("div", { class: "step" }, [
                el("div", { class: "n", text: String(i + 1) }),
                el("div", { class: "txt" }, typeof s === "string" ? inlineNodes(s) : s),
              ]),
            ),
          ),
        ]),
      ]),
    ]);
  }

  window.CH = {
    el,
    add,
    clear,
    $,
    $$,
    icon,
    ICONS,
    kbd,
    stripAnsi,
    fmtBytes,
    fmtMs,
    fmtTokens,
    fmtUsd,
    md,
    mdInto,
    inlineNodes,
    Connection,
    setStatus,
    toast,
    copy,
    Terminal,
    Chat,
    Composer,
    dropzone,
  };
})();
