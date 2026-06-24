/* CrewHaus — Managed Runtime shape UI.

   An operator dashboard for a multi-tenant agent gateway compiled from a
   `target: managed` spec. The harness is a `@crewhaus/gateway-server` daemon
   (daemon.ts) booted on an internal PORT and reverse-proxied at `/proxy/`.

   The gateway speaks the `crewhaus.v1` JSON-over-HTTP protocol: every request
   is a single POST of an envelope `{protocol,id,method,params}` to the daemon
   root, authenticated with an HS256 JWT bearer token carrying a `tenant_id`
   claim. Methods (from @crewhaus/gateway-protocol): runs.create, runs.continue,
   runs.cancel, audit.tail, sessions.list.

   The daemon never mints tokens. On boot with no CREWHAUS_GATEWAY_JWT_SECRET it
   auto-generates a one-shot dev secret and logs it; this dashboard reads that
   line, mints short-lived tenant tokens in the browser (crypto.subtle HMAC), and
   drives the gateway end-to-end. Operators can also paste a secret/token. */
(function () {
  "use strict";
  const { el, icon, md, mdInto, clear, events, fmtTokens, toast, copy } = window.CH;

  const PROTOCOL = "crewhaus.v1";

  // Methods the emitted daemon handler actually services, with field schemas.
  const METHODS = [
    {
      id: "runs.create",
      label: "runs.create",
      desc: "Start a new run for a tenant",
      fields: ["spec", "input"],
      reply: true,
    },
    {
      id: "runs.continue",
      label: "runs.continue",
      desc: "Append a turn to an existing session",
      fields: ["sessionId", "input"],
      reply: true,
    },
    {
      id: "audit.tail",
      label: "audit.tail",
      desc: "Read the tenant's audit log",
      fields: ["tenantId"],
      reply: false,
    },
    {
      id: "runs.cancel",
      label: "runs.cancel",
      desc: "Abort an in-flight run",
      fields: ["runId"],
      reply: false,
    },
  ];

  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  function sectionLabel(t) {
    return el("div", { class: "section-label", text: t });
  }

  // ── HS256 JWT minting (browser) ───────────────────────────────────────────
  function b64url(bytes) {
    let s = "";
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlStr(str) {
    return b64url(new TextEncoder().encode(str));
  }
  async function mintJwt(tenantId, secret, ttlSeconds) {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + (ttlSeconds || 3600);
    const header = b64urlStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64urlStr(JSON.stringify({ tenant_id: tenantId, iat, exp }));
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return `${data}.${b64url(sig)}`;
  }

  CH.app({
    controls: ["start", "stop", "restart"],
    build(api) {
      // ── Shared state ────────────────────────────────────────────────────
      let mode = null;
      let jwtSecret = null; // discovered dev secret OR operator-pasted
      let pastedToken = null; // operator-supplied full token (overrides minting)
      let tenants = ["tenant-a"]; // operator-managed tenant list
      let lastSessionId = null; // surfaced from a runs.create reply
      let reqCounter = 0;
      let healthTimer = null;

      const stats = events.newStats();
      let counters = { requests: 0, ok: 0, errors: 0, denied: 0 };

      // Active-view element refs (rebuilt by buildActive).
      let ui = null;

      // ── WS handlers (attached once) ─────────────────────────────────────
      api.on("event", (m) => pushEvent(m.event));

      // The daemon prints its auto-generated dev secret to stderr; capture it.
      api.on("stderr", (m) => harvestSecret(m.line));
      api.on("log", (m) => harvestSecret(m.line));

      api.on("status", (m) => {
        if (m.state === "running") {
          startHealthPoll();
        } else {
          stopHealthPoll();
          if (ui) setHealth("down", m.state === "starting" ? "Booting daemon…" : "Daemon not running");
        }
        refreshConsoleEnabled();
      });

      function harvestSecret(line) {
        if (!line || jwtSecret) return;
        // Matches: "export CREWHAUS_GATEWAY_JWT_SECRET=<hex>"
        const m = String(line).match(/CREWHAUS_GATEWAY_JWT_SECRET=([0-9a-fA-F]{16,})/);
        if (m) {
          jwtSecret = m[1];
          if (ui) {
            refreshAuthState();
            toast("Dev JWT secret captured from daemon log");
          }
        }
      }

      function pushEvent(ev) {
        events.accrue(ev, stats);
        if (ui) {
          updateStats();
          const node = events.render(ev);
          if (node) {
            ui.feed.appendChild(node);
            ui.feedScroll.scrollTop = ui.feedScroll.scrollHeight;
          }
        }
      }

      // ── View switching ──────────────────────────────────────────────────
      api.onState((s) => {
        const want = s.harness && s.harness.present ? "active" : "empty";
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
        if (want === "active") {
          if (api.isRunning()) startHealthPoll();
          else setHealth("down", "Daemon not running");
          refreshConsoleEnabled();
        }
      });

      // ── Empty state ─────────────────────────────────────────────────────
      function buildEmpty() {
        ui = null;
        stopHealthPoll();
        clear(api.main);
        api.main.appendChild(
          CH.dropzone({
            icon: "cloud",
            title: "Drop in a compiled managed gateway",
            subtitle:
              "This dashboard operates any multi-tenant gateway compiled from a CrewHaus spec with target: managed.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `daemon.ts` **and** `agent.ts` into this UI's `harness/` folder",
              "Click **Start** — the daemon boots on an internal port and deps install on first run",
              "Send protocol requests from the **Request console** — tokens are minted for you",
            ],
          }),
        );
      }

      // ── Active dashboard ────────────────────────────────────────────────
      function buildActive() {
        clear(api.main);
        ui = {};

        // LEFT: request console + response.
        const left = buildConsole();

        // RIGHT: gateway status, auth, tenants, activity feed.
        const right = buildOps();

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));

        refreshAuthState();
        refreshConsoleEnabled();
        updateStats();
        onMethodChange();
        renderTenants();
      }

      // ── Request console (left pane) ─────────────────────────────────────
      function buildConsole() {
        // method select
        const methodSel = el(
          "select",
          { class: "field", style: { width: "auto", minWidth: "180px", flex: "0 0 auto" }, onChange: onMethodChange },
          METHODS.map((mth) => el("option", { value: mth.id, text: mth.label })),
        );
        ui.methodSel = methodSel;

        const methodDesc = el("div", { class: "muted mono", style: { fontSize: "11px" } });
        ui.methodDesc = methodDesc;

        // tenant select (for the bearer token)
        const tenantSel = el("select", {
          class: "field",
          style: { width: "auto", minWidth: "150px", flex: "0 0 auto" },
        });
        ui.tenantSel = tenantSel;

        const topRow = el("div", { class: "row wrap", style: { gap: "10px", alignItems: "flex-start" } }, [
          el("div", { class: "col", style: { gap: "4px", flex: "0 0 auto" } }, [
            el("label", { class: "section-label", text: "Method" }),
            methodSel,
          ]),
          el("div", { class: "col", style: { gap: "4px", flex: "0 0 auto" } }, [
            el("label", { class: "section-label", text: "Tenant (token)" }),
            tenantSel,
          ]),
        ]);

        // dynamic fields container
        const fieldsWrap = el("div", { class: "col", style: { gap: "12px" } });
        ui.fieldsWrap = fieldsWrap;
        ui.fields = {};

        // send button + envelope preview toggle
        const sendBtn = el("button", { class: "btn primary" }, [
          icon("send", 15),
          el("span", { text: "Send request" }),
        ]);
        sendBtn.addEventListener("click", sendRequest);
        ui.sendBtn = sendBtn;

        const copyEnvBtn = el(
          "button",
          { class: "btn ghost sm", title: "Copy the request envelope as JSON", onClick: copyEnvelope },
          [icon("copy", 13), el("span", { text: "Copy envelope" })],
        );

        const actionRow = el("div", { class: "row", style: { gap: "10px", marginTop: "4px" } }, [
          sendBtn,
          copyEnvBtn,
          el("span", { class: "grow" }),
          (ui.latency = el("span", { class: "muted mono", style: { fontSize: "11px" } })),
        ]);

        const form = el("div", { class: "col", style: { gap: "14px" } }, [
          topRow,
          methodDesc,
          el("div", { class: "divider", style: { margin: "2px 0" } }),
          fieldsWrap,
          actionRow,
        ]);

        // response area
        const respScroll = el("div", { class: "pane-scroll", style: { borderTop: "1px solid var(--rule)" } });
        ui.respScroll = respScroll;
        ui.respBody = el("div", { class: "col", style: { gap: "12px" } });
        respScroll.appendChild(ui.respBody);
        renderResponsePlaceholder();

        const formScroll = el("div", { class: "pane-scroll", style: { flex: "0 0 auto", maxHeight: "52%" } }, form);

        return el("div", { class: "pane" }, [
          paneHead(
            "send",
            "Request console",
            el("span", { class: "badge", text: PROTOCOL }),
          ),
          formScroll,
          el("div", { class: "pane-head", style: { borderTop: "1px solid var(--rule)" } }, [
            el("span", { class: "icon" }, icon("eye", 14)),
            el("span", { text: "Response" }),
            el("span", { class: "grow" }),
            el("button", { class: "btn ghost sm", onClick: renderResponsePlaceholder }, "Clear"),
          ]),
          respScroll,
        ]);
      }

      function currentMethod() {
        return METHODS.find((m) => m.id === ui.methodSel.value) || METHODS[0];
      }

      function onMethodChange() {
        const m = currentMethod();
        ui.methodDesc.textContent = m.desc;
        clear(ui.fieldsWrap);
        ui.fields = {};
        for (const f of m.fields) ui.fieldsWrap.appendChild(buildField(f));
        // Default a sensible spec + prefill session continuity.
        if (ui.fields.spec) ui.fields.spec.value = "crewhaus.yaml";
        if (ui.fields.sessionId && lastSessionId) ui.fields.sessionId.value = lastSessionId;
        if (ui.fields.tenantId) ui.fields.tenantId.value = ui.tenantSel.value || tenants[0] || "";
      }

      const FIELD_META = {
        spec: { label: "Spec id", placeholder: "crewhaus.yaml", hint: "Logical spec name the gateway runs" },
        input: { label: "Input", placeholder: "Ask the agent something…", area: true },
        sessionId: { label: "Session id", placeholder: "sess_…" },
        tenantId: { label: "Tenant id", placeholder: "tenant-a" },
        runId: { label: "Run id", placeholder: "run_…" },
      };

      function buildField(name) {
        const meta = FIELD_META[name] || { label: name };
        const input = meta.area
          ? el("textarea", { class: "field", rows: 4, placeholder: meta.placeholder || "" })
          : el("input", { class: "field", type: "text", placeholder: meta.placeholder || "" });
        ui.fields[name] = input;
        return el("div", { class: "col", style: { gap: "4px" } }, [
          el("label", { class: "section-label", text: meta.label }),
          input,
          meta.hint ? el("div", { class: "muted mono", style: { fontSize: "10.5px" }, text: meta.hint }) : null,
        ]);
      }

      function buildEnvelope() {
        const m = currentMethod();
        const params = {};
        for (const f of m.fields) {
          const v = ui.fields[f] ? ui.fields[f].value : "";
          params[f] = v;
        }
        reqCounter++;
        return { protocol: PROTOCOL, id: `ui-${reqCounter}`, method: m.id, params };
      }

      function copyEnvelope() {
        copy(JSON.stringify(buildEnvelope(), null, 2));
      }

      async function resolveBearer(tenantId) {
        if (pastedToken) return pastedToken;
        if (jwtSecret) return await mintJwt(tenantId, jwtSecret, 3600);
        return null;
      }

      async function sendRequest() {
        if (!api.isRunning()) {
          toast("Start the daemon first", "err");
          return;
        }
        const tenantId = ui.tenantSel.value || tenants[0] || "tenant-a";
        const envelope = buildEnvelope();
        const bearer = await resolveBearer(tenantId);

        ui.sendBtn.disabled = true;
        const spin = el("span", { class: "spinner" });
        const sendLabel = ui.sendBtn.querySelector("span");
        const prevLabel = sendLabel ? sendLabel.textContent : "Send request";
        if (sendLabel) sendLabel.textContent = "Sending…";
        ui.sendBtn.insertBefore(spin, ui.sendBtn.firstChild);

        const headers = { "content-type": "application/json" };
        if (bearer) headers.authorization = `Bearer ${bearer}`;

        const t0 = performance.now();
        counters.requests++;
        let resp, raw, dt;
        try {
          resp = await fetch("/proxy/", {
            method: "POST",
            headers,
            body: JSON.stringify(envelope),
          });
          raw = await resp.text();
          dt = Math.round(performance.now() - t0);
        } catch (err) {
          dt = Math.round(performance.now() - t0);
          counters.errors++;
          renderTransportError(err, dt);
          restoreSend();
          updateStats();
          return;
        }
        ui.latency.textContent = `${dt} ms · HTTP ${resp.status}`;
        renderResponse(resp, raw, dt, tenantId, envelope, bearer);
        restoreSend();

        function restoreSend() {
          spin.remove();
          if (sendLabel) sendLabel.textContent = prevLabel;
          ui.sendBtn.disabled = !api.isRunning();
        }
      }

      function renderResponse(resp, raw, dt, tenantId, envelope, bearer) {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* non-JSON (e.g. proxy text error) */
        }
        clear(ui.respBody);

        const isErr = parsed && parsed.error;
        const result = parsed && parsed.result;

        // Status banner
        let sev = "ok";
        let title = `HTTP ${resp.status} · ${envelope.method}`;
        if (resp.status === 503) {
          sev = "err";
          title = "Daemon not running (503)";
        } else if (resp.status === 401) {
          sev = "warn";
          title = "Unauthorized (401)";
        } else if (resp.status === 429) {
          sev = "warn";
          title = "Budget exceeded (429)";
        } else if (isErr || resp.status >= 400) {
          sev = "err";
        }

        if (resp.ok && !isErr) counters.ok++;
        else if (isErr && parsed.error.code === "forbidden") counters.denied++;
        else counters.errors++;
        updateStats();

        ui.respBody.appendChild(statusBanner(sev, title, `${dt} ms`));

        // Auth hint when unauthorized and we lack a secret.
        if (resp.status === 401 && !jwtSecret && !pastedToken) {
          ui.respBody.appendChild(
            infoCard(
              "shield",
              "No token available",
              "The gateway is up but rejected the request — no JWT secret has been captured yet. " +
                "Either set CREWHAUS_GATEWAY_JWT_SECRET before Start, or paste a token/secret in the Auth panel.",
            ),
          );
        }

        // Error envelope detail
        if (isErr) {
          const e = parsed.error;
          ui.respBody.appendChild(
            kvCard("Error", [
              ["code", e.code],
              ["message", e.message],
              ["request id", parsed.id],
            ]),
          );
        }

        // runs.create / runs.continue reply -> render as markdown.
        if (result && typeof result === "object") {
          if (typeof result.reply === "string") {
            if (result.sessionId) lastSessionId = result.sessionId;
            const meta = [];
            if (result.runId) meta.push(["run id", result.runId]);
            if (result.sessionId) meta.push(["session id", result.sessionId]);
            if (result.tenantId) meta.push(["tenant", result.tenantId]);
            if (meta.length) ui.respBody.appendChild(kvCard("Run", meta));
            const replyCard = el("div", { class: "card" }, [
              el("div", { class: "card-head" }, [
                el("span", { class: "icon" }, icon("bot", 14)),
                el("span", { class: "label", text: "Agent reply" }),
              ]),
              el("div", { class: "card-body md" }),
            ]);
            mdInto(replyCard.querySelector(".card-body"), result.reply);
            ui.respBody.appendChild(replyCard);
            // session continuity: offer a quick continue
            if (result.sessionId) {
              ui.respBody.appendChild(continueChip(result.sessionId, result.tenantId));
            }
          } else if (Array.isArray(result.rows)) {
            ui.respBody.appendChild(auditTable(result.rows));
          }
        }

        // Always show the raw envelope for operators.
        ui.respBody.appendChild(rawCard(parsed ? JSON.stringify(parsed, null, 2) : raw));
        ui.respScroll.scrollTop = 0;
      }

      function renderTransportError(err, dt) {
        clear(ui.respBody);
        ui.latency.textContent = `${dt} ms · failed`;
        ui.respBody.appendChild(statusBanner("err", "Request failed", `${dt} ms`));
        ui.respBody.appendChild(
          infoCard("alert", "Transport error", String(err && err.message ? err.message : err)),
        );
      }

      function renderResponsePlaceholder() {
        if (!ui || !ui.respBody) return;
        clear(ui.respBody);
        ui.respBody.appendChild(
          el("div", { class: "empty", style: { minHeight: "160px" } }, [
            el("div", { class: "empty-inner" }, [
              el("div", { class: "muted", style: { display: "grid", gap: "8px", placeItems: "center" } }, [
                icon("eye", 26),
                el(
                  "div",
                  { class: "muted" },
                  "Send a request to inspect the gateway's response, the run reply, and the raw envelope.",
                ),
              ]),
            ]),
          ]),
        );
      }

      function continueChip(sessionId, tenantId) {
        const b = el("button", { class: "btn ghost sm" }, [
          icon("arrowRight", 13),
          el("span", { text: "Continue this session" }),
        ]);
        b.addEventListener("click", () => {
          ui.methodSel.value = "runs.continue";
          onMethodChange();
          if (tenantId) ui.tenantSel.value = tenantId;
          if (ui.fields.sessionId) ui.fields.sessionId.value = sessionId;
          if (ui.fields.input) ui.fields.input.focus();
        });
        return el("div", { class: "row", style: { marginTop: "2px" } }, b);
      }

      // ── Operations column (right pane) ──────────────────────────────────
      function buildOps() {
        // Health card
        ui.healthDot = el("span", { class: "dot" });
        ui.healthText = el("span", { text: "Unknown", class: "mono" });
        ui.healthPill = el(
          "div",
          { class: "status", dataset: { state: "offline" }, style: { fontSize: "11px" } },
          [ui.healthDot, ui.healthText],
        );
        ui.healthMeta = el("div", { class: "chips", style: { marginTop: "10px" } });

        const healthCard = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("activity", 14)),
            el("span", { class: "label", text: "Gateway status" }),
            el("span", { class: "grow" }),
            ui.healthPill,
          ]),
          el("div", { class: "card-body" }, [
            el("div", { class: "muted", style: { fontSize: "12px" } }, [
              "Single JSON-over-HTTP endpoint at ",
              el("code", { text: "POST /" }),
              ". Health is probed live over ",
              el("code", { text: "/proxy/" }),
              ".",
            ]),
            ui.healthMeta,
          ]),
        ]);

        // Auth card
        const authCard = buildAuthCard();

        // Tenants card
        ui.tenantList = el("div", { class: "chips" });
        const addTenantInput = el("input", {
          class: "field",
          type: "text",
          placeholder: "tenant id…",
          style: { flex: "1" },
        });
        const addTenantBtn = el("button", { class: "btn ghost sm" }, [icon("user", 13), el("span", { text: "Add" })]);
        const addTenant = () => {
          const v = addTenantInput.value.trim();
          if (!v) return;
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v)) {
            toast("Invalid tenant id (alphanumeric / - / _, max 64)", "err");
            return;
          }
          if (!tenants.includes(v)) tenants.push(v);
          addTenantInput.value = "";
          renderTenants();
        };
        addTenantBtn.addEventListener("click", addTenant);
        addTenantInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTenant();
          }
        });

        const tenantsCard = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("layers", 14)),
            el("span", { class: "label", text: "Tenants" }),
          ]),
          el("div", { class: "card-body col", style: { gap: "12px" } }, [
            el(
              "div",
              { class: "muted", style: { fontSize: "11.5px" } },
              "Each tenant gets a path-rebased store and a per-tenant token budget. Tokens are scoped to one tenant.",
            ),
            ui.tenantList,
            el("div", { class: "row", style: { gap: "8px" } }, [addTenantInput, addTenantBtn]),
          ]),
        ]);

        // Stats bar
        const statsBar = el("div", { class: "stats" });
        ui.statEls = {
          requests: stat(statsBar, "Requests", "0", "send"),
          ok: stat(statsBar, "OK", "0", "check", true),
          errors: stat(statsBar, "Errors", "0", "alert"),
          runs: stat(statsBar, "Runs", "0", "play"),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          cost: stat(statsBar, "Cost", "$0.00", "coins"),
        };

        // Activity feed
        ui.feed = el("div", { class: "feed" });
        ui.feedScroll = el("div", { class: "pane-scroll" });
        ui.feedScroll.appendChild(
          el("div", { class: "col" }, [
            statsBar,
            el("div", { class: "divider" }),
            healthCard,
            authCard,
            tenantsCard,
            el("div", { class: "divider" }),
            sectionLabel("Gateway activity"),
            ui.feed,
            (ui.feedEmpty = el(
              "div",
              { class: "muted mono", style: { fontSize: "11.5px", padding: "4px 2px" } },
              "Trace events from runs stream here.",
            )),
          ]),
        );

        return el("div", { class: "pane" }, [paneHead("cloud", "Operations"), ui.feedScroll]);
      }

      function buildAuthCard() {
        ui.authState = el("span", { class: "badge", text: "no token" });

        const tokenInput = el("input", {
          class: "field",
          type: "text",
          placeholder: "Paste a JWT, or the dev secret hex…",
          style: { fontFamily: "var(--mono)", fontSize: "11.5px" },
        });
        ui.tokenInput = tokenInput;

        const applyBtn = el("button", { class: "btn ghost sm" }, [icon("check", 13), el("span", { text: "Apply" })]);
        applyBtn.addEventListener("click", () => {
          const v = tokenInput.value.trim();
          if (!v) {
            pastedToken = null;
            // leave any harvested jwtSecret in place
            refreshAuthState();
            return;
          }
          // A JWT has 3 dot-separated segments; a bare secret is hex.
          if (v.split(".").length === 3) {
            pastedToken = v;
            toast("Bearer token set — will be sent verbatim");
          } else {
            jwtSecret = v;
            pastedToken = null;
            toast("Secret set — tokens will be minted per tenant");
          }
          refreshAuthState();
        });

        const clearBtn = el("button", { class: "btn ghost sm icon-only", title: "Clear", onClick: () => {
          pastedToken = null;
          jwtSecret = null;
          tokenInput.value = "";
          refreshAuthState();
        } }, icon("x", 13));

        return el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("shield", 14)),
            el("span", { class: "label", text: "Auth" }),
            el("span", { class: "grow" }),
            ui.authState,
          ]),
          el("div", { class: "card-body col", style: { gap: "10px" } }, [
            el(
              "div",
              { class: "muted", style: { fontSize: "11.5px" } },
              [
                "HS256 bearer tokens with a ",
                el("code", { text: "tenant_id" }),
                " claim. The daemon's dev secret is captured from its log automatically; otherwise paste a token or secret.",
              ],
            ),
            el("div", { class: "row", style: { gap: "8px" } }, [tokenInput, applyBtn, clearBtn]),
          ]),
        ]);
      }

      function refreshAuthState() {
        if (!ui || !ui.authState) return;
        let label = "no token";
        let cls = "badge";
        if (pastedToken) {
          label = "token pasted";
          cls = "badge ok";
        } else if (jwtSecret) {
          label = "minting · dev secret";
          cls = "badge ok";
        }
        ui.authState.textContent = label;
        ui.authState.className = cls;
        refreshConsoleEnabled();
      }

      function renderTenants() {
        if (!ui) return;
        // tenant select for the token
        const prev = ui.tenantSel.value;
        clear(ui.tenantSel);
        for (const t of tenants) ui.tenantSel.appendChild(el("option", { value: t, text: t }));
        if (tenants.includes(prev)) ui.tenantSel.value = prev;

        // chips
        clear(ui.tenantList);
        for (const t of tenants) {
          const chip = el("span", { class: "chip" }, [
            el("span", { class: "icon", style: { color: "var(--accent)", display: "inline-grid" } }, icon("user", 12)),
            el("span", { class: "v", text: t }),
          ]);
          if (tenants.length > 1) {
            const rm = el("span", {
              style: { cursor: "pointer", color: "var(--ink-3)", display: "inline-grid" },
              title: `Remove ${t}`,
              onClick: () => {
                tenants = tenants.filter((x) => x !== t);
                renderTenants();
              },
            }, icon("x", 11));
            chip.appendChild(rm);
          }
          ui.tenantList.appendChild(chip);
        }
        if (ui.fields && ui.fields.tenantId && !ui.fields.tenantId.value) {
          ui.fields.tenantId.value = ui.tenantSel.value;
        }
      }

      function refreshConsoleEnabled() {
        if (!ui || !ui.sendBtn) return;
        ui.sendBtn.disabled = !api.isRunning();
      }

      // ── Health polling via the proxy ────────────────────────────────────
      function startHealthPoll() {
        if (!ui) return;
        stopHealthPoll();
        probeHealth();
        healthTimer = setInterval(probeHealth, 4000);
      }
      function stopHealthPoll() {
        if (healthTimer) {
          clearInterval(healthTimer);
          healthTimer = null;
        }
      }

      async function probeHealth() {
        if (!api.isRunning()) {
          setHealth("down", "Daemon not running");
          return;
        }
        // Unauthenticated probe: a live gateway answers with a 401 'unauthorized'
        // envelope (proves it's up); a dead one yields a 503 from the proxy.
        const t0 = performance.now();
        try {
          const resp = await fetch("/proxy/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocol: PROTOCOL, id: "health", method: "sessions.list", params: {} }),
          });
          const dt = Math.round(performance.now() - t0);
          if (resp.status === 503) {
            setHealth("down", "Unreachable (503)");
          } else {
            // 200 or 401 both mean the gateway process is serving requests.
            setHealth("up", resp.status === 401 ? "Serving · auth required" : "Serving", dt);
          }
        } catch {
          setHealth("down", "Probe failed");
        }
      }

      function setHealth(kind, text, dt) {
        if (!ui || !ui.healthPill) return;
        const up = kind === "up";
        ui.healthPill.dataset.state = up ? "running" : "error";
        ui.healthText.textContent = text;
        clear(ui.healthMeta);
        ui.healthMeta.appendChild(metaChip("protocol", PROTOCOL));
        const port = api.state && api.state.daemonPort;
        ui.healthMeta.appendChild(metaChip("port", port ? String(port) : "—"));
        ui.healthMeta.appendChild(metaChip("transport", "JSON / HTTP"));
        if (dt != null) ui.healthMeta.appendChild(metaChip("latency", `${dt} ms`));
        ui.healthMeta.appendChild(metaChip("auth", "HS256 · bearer"));
      }

      // ── Stats ────────────────────────────────────────────────────────────
      function updateStats() {
        if (!ui || !ui.statEls) return;
        ui.statEls.requests.textContent = String(counters.requests);
        ui.statEls.ok.textContent = String(counters.ok);
        ui.statEls.errors.textContent = String(counters.errors);
        ui.statEls.runs.textContent = String(stats.turns);
        ui.statEls.tokens.textContent = fmtTokens(stats.tokensIn + stats.tokensOut);
        ui.statEls.cost.textContent = CH.fmtUsd(stats.costMicros);
        if (ui.feedEmpty) ui.feedEmpty.style.display = ui.feed.childNodes.length ? "none" : "block";
      }

      function stat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(
          el("div", { class: "stat" }, [
            el("div", { class: "row", style: { gap: "6px", alignItems: "center" } }, [
              el("span", { class: "icon", style: { color: "var(--ink-3)", display: "inline-grid" } }, icon(ic, 12)),
              v,
            ]),
            el("div", { class: "k", text: label }),
          ]),
        );
        return v;
      }

      // ── Small render helpers ───────────────────────────────────────────
      function statusBanner(sev, title, meta) {
        const icName = sev === "ok" ? "check" : sev === "warn" ? "alert" : "x";
        return el("div", { class: `event ${sev === "ok" ? "accent" : sev === "warn" ? "warn" : "error"}` }, [
          el("div", { class: "ev-icon" }, icon(icName, 13)),
          el("div", { class: "ev-main" }, el("div", { class: "ev-title" }, el("span", { text: title }))),
          meta ? el("div", { class: "ev-meta", text: meta }) : null,
        ]);
      }

      function infoCard(ic, title, body) {
        return el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon" }, icon(ic, 14)),
            el("span", { class: "label", text: title }),
          ]),
          el("div", { class: "card-body muted", style: { fontSize: "12.5px" }, text: body }),
        ]);
      }

      function kvCard(title, rows) {
        return el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon" }, icon("layers", 14)),
            el("span", { class: "label", text: title }),
          ]),
          el(
            "div",
            { class: "card-body chips" },
            rows.map(([k, v]) =>
              el("span", { class: "chip" }, [
                el("span", { class: "k", text: `${k}:` }),
                el("span", { class: "v", text: String(v) }),
              ]),
            ),
          ),
        ]);
      }

      function auditTable(rows) {
        const card = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon" }, icon("book", 14)),
            el("span", { class: "label", text: "Audit log" }),
            el("span", { class: "grow" }),
            el("span", { class: "badge", text: `${rows.length} rows` }),
          ]),
        ]);
        const body = el("div", { class: "card-body col", style: { gap: "8px" } });
        if (!rows.length) {
          body.appendChild(el("div", { class: "muted", style: { fontSize: "12px" }, text: "No audit rows yet." }));
        }
        for (const r of rows.slice(-50)) {
          const kind = (r && r.kind) || "row";
          body.appendChild(
            el("div", { class: "event info" }, [
              el("div", { class: "ev-icon" }, icon("dot", 13)),
              el("div", { class: "ev-main" }, [
                el("div", { class: "ev-title" }, el("span", { class: "ev-name", text: kind })),
                el("div", { class: "ev-sub", text: JSON.stringify(r && r.payload ? r.payload : r) }),
              ]),
            ]),
          );
        }
        card.appendChild(body);
        return card;
      }

      function rawCard(text) {
        const card = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon" }, icon("file", 14)),
            el("span", { class: "label", text: "Raw response" }),
            el("span", { class: "grow" }),
            el("button", { class: "btn ghost sm", onClick: () => copy(text) }, [icon("copy", 13), el("span", { text: "Copy" })]),
          ]),
        ]);
        const pre = el("pre", { style: { margin: "0" } }, el("code", { text }));
        card.appendChild(el("div", { class: "card-body md" }, pre));
        return card;
      }

      function metaChip(k, v) {
        return el("span", { class: "chip" }, [
          el("span", { class: "k", text: `${k}:` }),
          el("span", { class: "v", text: v }),
        ]);
      }
    },
  });
})();
