/* ============================================================================
   CrewHaus Shape UI — app kit.

   Builds the chrome every shape shares (header w/ brand + status + lifecycle
   controls + raw-output drawer), opens the WebSocket, and exposes a small API
   so each shape's app.js only writes its distinctive main panel.

   Usage (in a shape's app.js):
     CH.app({
       controls: ["start", "stop", "restart"],   // optional; sensible default
       build(api) {
         // api.main      -> the main content element to render into
         // api.config    -> shape config.json
         // api.state     -> live { state, harness, daemonPort, running, config }
         // api.conn      -> CH.Connection (already connecting)
         // api.on(t, cb) -> ws messages: event, stdout, stderr, log, status,
         //                  state, user, open, close, "*"
         // api.onState(cb)  -> fires on every state/status/harness change
         // api.start(text?), api.stop(), api.restart(), api.install()
         // api.sendInput(text), api.submit(text)
         // api.log(line, cls), api.addAction(node), api.stat(...)
       },
     });
   ========================================================================== */
(function () {
  "use strict";
  const { el, icon, setStatus, toast } = window.CH;

  const LOGO =
    '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5"/><path d="M12 12v9"/>';

  function app(spec) {
    const root = document.getElementById("app") || document.body;
    const conn = window.CH.Connection();
    const handlers = {};
    const stateHandlers = [];
    let live = { state: "offline", harness: { present: false, files: [], entry: null }, config: {} };
    let config = {};

    const on = (type, cb) => ((handlers[type] = handlers[type] || []).push(cb), undefined);
    const emit = (type, msg) => (handlers[type] || []).forEach((cb) => cb(msg));

    // ── Theme accent chooser ─────────────────────────────────────────────
    // The four site themes (mint / amber / sky / paper) plus extras. The pick
    // is persisted and overrides the shape's own default accent. Lives in the
    // header so every shape gets it for free.
    const THEME_KEY = "crewhaus-ui-accent";
    const THEMES = [
      { name: "Mint", hex: "#2ECC8B" }, // site default
      { name: "Emerald", hex: "#5CD6A8" },
      { name: "Teal", hex: "#2BC4B4" },
      { name: "Sky", hex: "#64B5FF" }, // site blue
      { name: "Indigo", hex: "#5B8CFF" },
      { name: "Violet", hex: "#B08CFF" },
      { name: "Pink", hex: "#FF6FB5" },
      { name: "Coral", hex: "#FF7A5B" },
      { name: "Orange", hex: "#F6821F" },
      { name: "Amber", hex: "#E6B450" }, // site amber
      { name: "Lime", hex: "#9BD64A" },
      { name: "Paper", hex: "#E8EFE9" }, // site white
    ];
    function hexA(hex, a) {
      const h = hex.replace("#", "");
      const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    }
    function darken(hex, f) {
      const h = hex.replace("#", "");
      const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
      const d = (c) => Math.max(0, Math.round(c * (1 - f)));
      const v = (d((n >> 16) & 255) << 16) | (d((n >> 8) & 255) << 8) | d(n & 255);
      return `#${v.toString(16).padStart(6, "0")}`;
    }
    function toHex(hex) {
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
      if (/^#[0-9a-fA-F]{3}$/.test(hex))
        return `#${hex.slice(1).replace(/(.)/g, "$1$1").toLowerCase()}`;
      return "#2ecc8b";
    }
    function readSaved() {
      try {
        return localStorage.getItem(THEME_KEY);
      } catch {
        return null;
      }
    }

    const accentDot = el("span", { class: "accent-dot" });
    const paletteBtn = el(
      "button",
      { class: "btn ghost sm icon-only", title: "Theme color", "aria-label": "Theme color" },
      accentDot,
    );
    const swatchGrid = el("div", { class: "swatch-grid" });
    const swatchNodes = [];
    for (const t of THEMES) {
      const sw = el("button", {
        class: "swatch",
        title: t.name,
        style: { background: t.hex },
        dataset: { hex: t.hex },
        onClick: () => chooseAccent(t.hex),
      });
      swatchNodes.push(sw);
      swatchGrid.appendChild(sw);
    }
    const customInput = el("input", {
      type: "color",
      class: "swatch-custom",
      title: "Custom color",
      value: "#2ecc8b",
      onInput: (e) => chooseAccent(e.target.value),
    });
    const resetBtn = el(
      "button",
      {
        class: "btn ghost sm",
        onClick: () => {
          try {
            localStorage.removeItem(THEME_KEY);
          } catch {}
          applyAccent(config.accent || "#2ECC8B");
        },
      },
      "Shape default",
    );
    const palettePop = el("div", { class: "palette-pop", style: { display: "none" } }, [
      el("div", { class: "palette-title", text: "Theme color" }),
      swatchGrid,
      el("div", { class: "palette-row" }, [customInput, resetBtn]),
    ]);
    document.body.appendChild(palettePop);

    function markActive(hex) {
      const want = toHex(hex);
      swatchNodes.forEach((s) => s.classList.toggle("active", toHex(s.dataset.hex) === want));
      customInput.value = want;
    }
    function applyAccent(hex) {
      const s = document.documentElement.style;
      s.setProperty("--accent", hex);
      s.setProperty("--accent-2", darken(hex, 0.14));
      s.setProperty("--accent-ghost", hexA(hex, 0.1));
      s.setProperty("--accent-glow", hexA(hex, 0.2));
      accentDot.style.background = hex;
      markActive(hex);
    }
    function chooseAccent(hex) {
      try {
        localStorage.setItem(THEME_KEY, hex);
      } catch {}
      applyAccent(hex);
    }
    function togglePalette() {
      palettePop.style.display = palettePop.style.display === "none" ? "block" : "none";
    }
    paletteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePalette();
    });
    document.addEventListener("click", (e) => {
      if (e.target !== paletteBtn && !paletteBtn.contains(e.target) && !palettePop.contains(e.target))
        palettePop.style.display = "none";
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") palettePop.style.display = "none";
    });
    // Apply a saved pick immediately (pre-paint) to avoid an accent flash.
    {
      const s0 = readSaved();
      if (s0) applyAccent(s0);
    }

    // ── Header ───────────────────────────────────────────────────────────
    const statusEl = el("div", { class: "status", dataset: { state: "offline" } });
    setStatus(statusEl, "offline");

    const actions = el("div", { class: "header-actions" });
    const logBtn = el("button", {
      class: "btn ghost sm icon-only",
      title: "Toggle raw output log",
      onClick: () => toggleLog(),
    });
    logBtn.appendChild(icon("terminal", 15));

    const brandLogo = (function () {
      const span = el("span", { class: "logo" });
      const svg = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LOGO}</svg>`,
        "image/svg+xml",
      ).documentElement;
      svg.setAttribute("width", 18);
      svg.setAttribute("height", 18);
      span.appendChild(svg);
      return span;
    })();

    const titleEl = el("span", { text: "CrewHaus" });
    const shapeTag = el("span", { class: "shape-tag", text: "" });
    const taglineEl = el("div", { class: "tagline", text: "" });
    const header = el("header", { class: "app-header" }, [
      el("div", { class: "brand" }, [
        brandLogo,
        el("div", { class: "titles" }, [
          el("div", { class: "title" }, [titleEl, shapeTag]),
          taglineEl,
        ]),
      ]),
      el("div", { class: "header-spacer" }),
      actions,
      statusEl,
      paletteBtn,
      logBtn,
    ]);

    // ── Lifecycle controls ───────────────────────────────────────────────
    const ctlWrap = el("div", { class: "row" });
    const btnStart = ctlBtn("play", "Start", "primary", () => api.start());
    const btnStop = ctlBtn("square", "Stop", "ghost", () => api.stop());
    const btnRestart = ctlBtn("refresh", "Restart", "ghost", () => api.restart());
    const btnInstall = ctlBtn("download", "Install deps", "ghost", () => api.install());
    function ctlBtn(ic, label, cls, fn) {
      const b = el("button", { class: `btn ${cls} sm`, onClick: fn }, [
        icon(ic, 14),
        el("span", { text: label }),
      ]);
      return b;
    }

    // ── Main + raw output drawer ─────────────────────────────────────────
    const main = el("div", { class: "app-body" });
    const logPre = el("div", { class: "pane-scroll flush" });
    const term = window.CH.Terminal(logPre);
    let logOpen = false;
    const drawer = el("div", { class: "pane", style: { display: "none", height: "200px", flex: "0 0 auto" } }, [
      el("div", { class: "pane-head" }, [
        el("span", { class: "icon" }, icon("terminal", 14)),
        el("span", { text: "Raw output" }),
        el("span", { class: "grow" }),
        el("button", { class: "btn ghost sm", onClick: () => term.clear() }, "Clear"),
        el("button", { class: "btn ghost sm icon-only", onClick: () => toggleLog() }, icon("x", 14)),
      ]),
      logPre,
    ]);
    function toggleLog() {
      logOpen = !logOpen;
      drawer.style.display = logOpen ? "flex" : "none";
    }

    const shell = el("div", { class: "app" }, [header, main, drawer]);
    window.CH.clear(root);
    root.appendChild(shell);

    // ── WS plumbing ──────────────────────────────────────────────────────
    conn.on("*", (msg) => emit(msg.type, msg));
    conn.on("state", (msg) => {
      config = msg.config || config;
      live = { ...msg, config };
      applyConfig();
      setStatus(statusEl, live.state || "idle", msg.detail || "");
      refreshControls();
      stateHandlers.forEach((cb) => cb(live));
    });
    conn.on("status", (msg) => {
      live.state = msg.state;
      setStatus(statusEl, msg.state, msg.detail || "");
      refreshControls();
      stateHandlers.forEach((cb) => cb(live));
    });
    conn.on("log", (m) => term.system(m.line));
    conn.on("stderr", (m) => term.stderr(m.line));
    conn.on("open", () => setStatus(statusEl, live.state || "idle"));
    conn.on("close", () => setStatus(statusEl, "offline"));

    function applyConfig() {
      document.title = `${config.title || "CrewHaus"} · CrewHaus`;
      titleEl.textContent = config.title || "CrewHaus";
      shapeTag.textContent = config.shape || "";
      taglineEl.textContent = config.tagline || "";
      // A saved theme pick wins; otherwise fall back to the shape's default.
      applyAccent(readSaved() || config.accent || "#2ECC8B");
    }

    function refreshControls() {
      const rc = config.runClass;
      const present = live.harness && live.harness.present;
      const running = live.state === "running";
      const busy = live.state === "installing" || live.state === "starting";
      if (rc === "plugin" || rc === "cf-worker") {
        ctlWrap.style.display = "none";
        return;
      }
      ctlWrap.style.display = "flex";
      const wanted = spec.controls || ["start", "stop", "restart", "install"];
      const map = { start: btnStart, stop: btnStop, restart: btnRestart, install: btnInstall };
      window.CH.clear(ctlWrap);
      for (const w of wanted) if (map[w]) ctlWrap.appendChild(map[w]);
      btnStart.disabled = !present || running || busy;
      btnStop.disabled = !running;
      btnRestart.disabled = !present || busy;
      btnInstall.disabled = !present || busy;
      const startLabel = btnStart.querySelector("span");
      if (startLabel) startLabel.textContent = running ? "Running" : "Start";
    }
    actions.appendChild(ctlWrap);

    // ── Public API ───────────────────────────────────────────────────────
    const api = {
      conn,
      main,
      header,
      statusEl,
      get config() {
        return config;
      },
      get state() {
        return live;
      },
      on,
      onState: (cb) => (stateHandlers.push(cb), cb(live)),
      addAction: (node) => actions.insertBefore(node, ctlWrap),
      start: (text) => conn.send({ type: "start", text }),
      submit: (text) => conn.send({ type: "submit", text }),
      stop: () => conn.send({ type: "stop" }),
      restart: () => conn.send({ type: "restart" }),
      install: () => conn.send({ type: "install" }),
      sendInput: (text, opts) => conn.send({ type: "input", text, silent: !!(opts && opts.silent) }),
      // Record a human rating on an assistant turn. `payload` carries the
      // sessionId + turnNumber the rating bar stamped, plus one of
      // thumbs/stars/score and/or comment/correction. The host writes it to
      // .crewhaus/feedback/ — it is never fed back into the agent's stdin.
      sendFeedback: (payload) => conn.send({ type: "feedback", ...payload }),
      log: (line, cls) => term.write(line, cls),
      openLog: () => {
        if (!logOpen) toggleLog();
      },
      term,
      toast,
      isPresent: () => live.harness && live.harness.present,
      isRunning: () => live.state === "running",
    };

    spec.build(api);
    conn.connect();
    return api;
  }

  window.CH.app = app;
})();
