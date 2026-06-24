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
      if (config.accent) {
        document.documentElement.style.setProperty("--accent", config.accent);
        document.documentElement.style.setProperty("--accent-2", config.accent);
        document.documentElement.style.setProperty("--accent-ghost", hexA(config.accent, 0.1));
        document.documentElement.style.setProperty("--accent-glow", hexA(config.accent, 0.2));
      }
    }
    function hexA(hex, a) {
      const h = hex.replace("#", "");
      const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
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
      sendInput: (text) => conn.send({ type: "input", text }),
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
