/* CrewHaus — onchain shape UI.
   A long-running, event-driven EVM agent rendered as an operations dashboard.
   The compiled daemon (agent.ts) declares chains, wallets, contracts, a
   transaction policy, and a set of triggers; on Start it builds an EVM adapter
   per chain, subscribes to every trigger, and runs one agent turn per inbound
   chain event. This UI makes the CONTRACTS and CHAIN ACTIVITY / TX log the
   heroes, alongside the live structured-trace feed. */
(function () {
  "use strict";
  const { el, icon, md, dropzone, stripAnsi, events, fmtMs, fmtTokens, fmtUsd } = window.CH;

  // ── small builders ────────────────────────────────────────────────────────
  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  function chip(ic, k, v, accent) {
    return el("div", { class: "chip" }, [
      ic ? icon(ic, 13) : null,
      k ? el("span", { class: "k", text: k }) : null,
      el("span", { class: accent ? "v accent" : "v", text: v }),
    ]);
  }

  function sectionLabel(t) {
    return el("div", { class: "section-label", text: t });
  }

  function shortAddr(a) {
    if (!a || typeof a !== "string") return "—";
    if (a.length <= 13 || a.indexOf("0x") !== 0) return a;
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
  }

  // Parse the compiled bundle's exported config out of the served agent.ts.
  // The emitter writes deterministic `export const NAME = <literal>;` blocks.
  // Scalars + the pure-JSON transaction policy parse via JSON.parse; the
  // chain/wallet/contract/trigger arrays are TypeScript object literals
  // (unquoted keys, trailing commas, embedded `process.env[…] ?? (…)`
  // fallbacks), so those are read field-by-field with tolerant string
  // scanning. We never eval — only locate and lift known fields.

  // Return the raw literal text for `export const NAME = <literal>;` (balanced
  // over [] {} "" so embedded braces/strings don't terminate it early).
  function sliceLiteral(src, name) {
    const marker = `export const ${name} = `;
    const at = src.indexOf(marker);
    if (at < 0) return null;
    let i = at + marker.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const open = src[i];
    if (open !== "[" && open !== "{" && open !== '"') {
      const semi = src.indexOf(";", i);
      return src.slice(i, semi < 0 ? src.length : semi).trim();
    }
    const close = open === "[" ? "]" : open === "{" ? "}" : '"';
    let depth = 0;
    let inStr = open === '"';
    let esc = false;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (open === '"') {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"' && i > start) {
          i++;
          break;
        }
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    return src.slice(start, i);
  }

  function jsonOrNull(text) {
    if (text == null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Split a top-level array literal into its element blocks (each a `{…}`),
  // respecting nested brackets/braces and strings.
  function splitObjects(arrayText) {
    if (!arrayText) return [];
    const out = [];
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    for (let i = 0; i < arrayText.length; i++) {
      const c = arrayText[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(arrayText.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return out;
  }

  // Lift a single field from an object-literal block. Returns the raw value
  // text (string contents unquoted) or undefined.
  function field(block, key) {
    // match `key:` (possibly quoted) — keys here are simple identifiers.
    const m = block.match(new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*`));
    if (!m) return undefined;
    let i = m.index + m[0].length;
    const c = block[i];
    if (c === '"') {
      let j = i + 1;
      let esc = false;
      let s = "";
      for (; j < block.length; j++) {
        const ch = block[j];
        if (esc) {
          s += ch;
          esc = false;
        } else if (ch === "\\") esc = true;
        else if (ch === '"') break;
        else s += ch;
      }
      return s;
    }
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < block.length; j++) {
        const ch = block[j];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === c) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) return block.slice(i, j + 1);
        }
      }
      return undefined;
    }
    // scalar (number / true / false / identifier) up to , or } or newline
    const tail = block.slice(i);
    const sm = tail.match(/^[^,}\n]+/);
    return sm ? sm[0].trim() : undefined;
  }

  function numField(block, key) {
    const v = field(block, key);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  function boolField(block, key) {
    return field(block, key) === "true";
  }

  function parseChains(text) {
    return splitObjects(text).map((b) => {
      const finBlock = field(b, "finality") || "";
      const finKind = (finBlock.match(/kind\s*:\s*"([^"]+)"/) || [])[1];
      const finCount = (finBlock.match(/count\s*:\s*(\d+)/) || [])[1];
      return {
        chainId: field(b, "chainId"),
        rpcPolicy: field(b, "rpcPolicy"),
        reorgTolerant: boolField(b, "reorgTolerant"),
        finality: finKind
          ? finKind === "confirmations"
            ? { kind: "confirmations", count: Number(finCount) }
            : { kind: finKind }
          : null,
      };
    });
  }

  function parseWallets(text) {
    return splitObjects(text).map((b) => {
      const keyBlock = b.match(/keyRef\s*:/) ? b.slice(b.search(/keyRef\s*:/)) : "";
      let keyRef = null;
      const envName = keyBlock.match(/process\.env\[\s*"([^"]+)"\s*\]/);
      const lit = keyBlock.match(/keyRef\s*:\s*"((?:kms|hsm):\/\/[^"]+)"/);
      if (envName) keyRef = { kind: "env", name: envName[1] };
      else if (lit) keyRef = { kind: "literal" };
      return {
        id: field(b, "id"),
        chainId: field(b, "chainId"),
        custody: field(b, "custody"),
        signingPolicy: field(b, "signingPolicy"),
        keyRef,
      };
    });
  }

  function parseContracts(text) {
    return splitObjects(text).map((b) => ({
      id: field(b, "id"),
      chainId: field(b, "chainId"),
      address: field(b, "address"),
      abiRef: field(b, "abiRef"),
    }));
  }

  function parseTriggers(text) {
    return splitObjects(text).map((b) => {
      const kind = field(b, "kind");
      const base = { kind, chainId: field(b, "chainId") };
      if (kind === "event") {
        base.contract = field(b, "contract");
        base.event = field(b, "event");
      } else if (kind === "block") {
        base.scanIntervalMs = numField(b, "scanIntervalMs");
      } else if (kind === "address") {
        base.address = field(b, "address");
        base.direction = field(b, "direction");
      }
      return base;
    });
  }

  function parseBundle(src) {
    const scalar = (name) => {
      const raw = sliceLiteral(src, name);
      if (raw == null) return null;
      const j = jsonOrNull(raw);
      if (j !== null) return j;
      return raw.replace(/^["']|["']$/g, "");
    };
    return {
      SPEC_NAME: scalar("SPEC_NAME"),
      AGENT_MODEL: scalar("AGENT_MODEL"),
      AGENT_INSTRUCTIONS: scalar("AGENT_INSTRUCTIONS"),
      IDEMPOTENCY_WINDOW_MS: scalar("IDEMPOTENCY_WINDOW_MS"),
      CHAINS: parseChains(sliceLiteral(src, "CHAINS")),
      WALLETS: parseWallets(sliceLiteral(src, "WALLETS")),
      CONTRACTS: parseContracts(sliceLiteral(src, "CONTRACTS")),
      TRANSACTION_POLICY: jsonOrNull(sliceLiteral(src, "TRANSACTION_POLICY")),
      TRIGGERS: parseTriggers(sliceLiteral(src, "TRIGGERS")),
    };
  }

  CH.app({
    controls: ["start", "stop", "restart"],
    build(api) {
      const stats = events.newStats();
      let bundle = null; // parsed agent.ts config (ground truth)
      let bundleTried = false;

      // active-view refs
      let feedScroll = null;
      let feedEl = null;
      let activityScroll = null;
      let activityEl = null;
      let statEls = null;
      let triggerState = null; // trigger key -> count element
      let txCount = 0;
      let eventCount = 0;
      let lastBlock = null;

      // ── stats ───────────────────────────────────────────────────────────
      function updateStats() {
        if (!statEls) return;
        statEls.events.textContent = String(eventCount);
        statEls.turns.textContent = String(stats.turns);
        statEls.tx.textContent = String(txCount);
        statEls.tokens.textContent = fmtTokens(stats.tokensIn + stats.tokensOut);
        statEls.cost.textContent = fmtUsd(stats.costMicros);
        statEls.errors.textContent = String(stats.errors);
      }

      // ── chain-activity log ──────────────────────────────────────────────
      function activity(opts) {
        if (!activityEl) return;
        const row = el("div", { class: `event ${opts.sev || ""}` }, [
          el("div", { class: "ev-icon" }, icon(opts.icon || "dot", 13)),
          el("div", { class: "ev-main" }, [
            el("div", { class: "ev-title" }, [
              opts.name ? el("span", { class: "ev-name", text: opts.name }) : null,
              opts.title ? el("span", { text: opts.title }) : null,
              opts.badge ? el("span", { class: `badge ${opts.badgeKind || ""}`, text: opts.badge }) : null,
            ]),
            opts.sub ? el("div", { class: "ev-sub", text: opts.sub }) : null,
          ]),
          opts.meta ? el("div", { class: "ev-meta", text: opts.meta }) : null,
        ]);
        const empty = activityEl.querySelector(".activity-empty");
        if (empty) empty.remove();
        activityEl.appendChild(row);
        if (activityScroll) activityScroll.scrollTop = activityScroll.scrollHeight;
      }

      // Map structured trace events into the chain-activity log when they are
      // chain-relevant (tx-shaped tool calls, turns, decisions, errors).
      const TX_TOOL_RE = /evm[-_]?tx|tx|broadcast|send|sign|transfer|swap|contract/i;
      function chainActivityFromEvent(ev) {
        switch (ev.kind) {
          case "turn_start":
            activity({
              icon: "zap",
              sev: "info",
              name: "trigger",
              title: "agent run started",
              sub: `turn ${ev.turn} · ${ev.messageCount} msgs`,
            });
            break;
          case "tool_call_start":
            if (TX_TOOL_RE.test(ev.toolName)) {
              activity({
                icon: "send",
                sev: "accent",
                name: ev.toolName,
                title: "chain call",
                sub: `input ${window.CH.fmtBytes(ev.inputBytes)}`,
              });
            }
            break;
          case "tool_call_end":
            if (TX_TOOL_RE.test(ev.toolName)) {
              if (!ev.isError) txCount++;
              activity({
                icon: ev.isError ? "alert" : "check",
                sev: ev.isError ? "error" : "accent",
                name: ev.toolName,
                title: ev.isError ? "call reverted" : "call confirmed",
                sub: `output ${window.CH.fmtBytes(ev.outputBytes)}`,
                meta: fmtMs(ev.durationMs),
              });
            }
            break;
          case "permission_decision":
            activity({
              icon: "shield",
              sev: ev.decision === "deny" ? "error" : ev.decision === "ask" ? "warn" : "accent",
              name: ev.toolName,
              title: `signing ${ev.decision}`,
              badge: ev.mode,
              sub: ev.reason || "",
            });
            break;
          case "turn_end":
            activity({
              icon: "check",
              sev: "muted",
              title: `run complete`,
              sub: ev.stopReason ? `stop: ${ev.stopReason}` : "",
              meta: fmtMs(ev.durationMs),
            });
            break;
        }
      }

      function bumpTrigger() {
        // Heuristic: each turn_start corresponds to one accepted trigger fire.
        eventCount++;
        if (triggerState && triggerState.total) {
          triggerState.total.textContent = String(eventCount);
        }
      }

      function pushEvent(ev) {
        events.accrue(ev, stats);
        if (ev.kind === "turn_start") bumpTrigger();
        chainActivityFromEvent(ev);
        updateStats();
        const node = events.render(ev);
        if (node && feedEl) {
          feedEl.appendChild(node);
          if (feedScroll) feedScroll.scrollTop = feedScroll.scrollHeight;
        }
      }

      // Sniff raw stdout for block numbers / tx hashes the daemon logs before
      // a turn (banner + subscription lines arrive here, not as TraceEvents).
      function sniffStdout(text) {
        const blk = text.match(/block\s*#?\s*(\d{4,})/i);
        if (blk && blk[1] !== lastBlock) {
          lastBlock = blk[1];
          if (statEls && statEls.block) statEls.block.textContent = `#${lastBlock}`;
        }
        const tx = text.match(/0x[0-9a-fA-F]{64}/);
        if (tx) {
          activity({
            icon: "git",
            sev: "info",
            name: "tx",
            title: "hash observed",
            sub: `${tx[0].slice(0, 10)}…${tx[0].slice(-8)}`,
          });
        }
      }

      // ── WS handlers (attached once) ───────────────────────────────────────
      api.on("stdout", (m) => {
        const txt = stripAnsi(m.text);
        if (!txt.trim()) return;
        sniffStdout(txt);
        api.log(txt, "stdout");
      });
      api.on("event", (m) => pushEvent(m.event));
      api.on("status", (m) => {
        if (m.state === "running") {
          activity({
            icon: "play",
            sev: "accent",
            title: "daemon booted",
            sub: "adapters built · subscriptions live — waiting for chain events",
          });
        } else if (m.state === "exited") {
          activity({ icon: "square", sev: "muted", title: "daemon stopped", sub: "press Start to resubscribe" });
        } else if (m.state === "error") {
          activity({ icon: "alert", sev: "error", title: "daemon failed to boot", sub: "check the raw output log" });
          api.openLog();
        }
      });

      // ── View switching ────────────────────────────────────────────────────
      let mode = null;
      api.onState((s) => {
        const present = s.harness && s.harness.present;
        const want = present ? "active" : "empty";
        if (present && !bundleTried) {
          bundleTried = true;
          loadBundle();
        }
        if (want === mode) return;
        mode = want;
        want === "active" ? buildActive() : buildEmpty();
      });

      // Fetch the served bundle and parse its declared config (ground truth).
      function loadBundle() {
        fetch("/harness/agent.ts")
          .then((r) => (r.ok ? r.text() : null))
          .then((src) => {
            if (!src) return;
            bundle = parseBundle(src);
            if (mode === "active") renderConfigPanels();
          })
          .catch(() => {});
      }

      // ── EMPTY STATE ───────────────────────────────────────────────────────
      function buildEmpty() {
        feedEl = feedScroll = activityEl = activityScroll = statEls = triggerState = null;
        CH.clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "link",
            title: "Drop in a compiled on-chain agent",
            subtitle:
              "This UI runs any bundle compiled from a CrewHaus spec with target: onchain — an event-driven EVM daemon.",
            steps: [
              "Compile your spec: `crewhaus compile crewhaus.yaml -o build`",
              "Copy the emitted `agent.ts` into this UI's `harness/` folder",
              "Export your RPC URLs + wallet key handles, then click **Start**",
            ],
          }),
        );
      }

      // ── ACTIVE LAYOUT ─────────────────────────────────────────────────────
      // left  : configuration (chains/wallet chips, contracts, policy, triggers)
      // right : run stats + chain-activity/tx log + structured trace feed
      let leftScroll = null;
      let configMounts = null;

      function buildActive() {
        CH.clear(api.main);

        // ---- LEFT: configuration ----
        leftScroll = el("div", { class: "pane-scroll" });
        const chainBar = el("div", { class: "chips", style: { marginBottom: "14px" } });
        const contractsWrap = el("div");
        const triggersWrap = el("div");
        const policyWrap = el("div");
        const walletsWrap = el("div");
        const agentWrap = el("div");

        configMounts = {
          chainBar,
          contracts: contractsWrap,
          triggers: triggersWrap,
          policy: policyWrap,
          wallets: walletsWrap,
          agent: agentWrap,
        };

        leftScroll.appendChild(
          el("div", { class: "col", style: { gap: "16px" } }, [
            chainBar,
            sectionLabel("Contracts"),
            contractsWrap,
            el("div", { class: "divider" }),
            sectionLabel("Triggers"),
            triggersWrap,
            el("div", { class: "divider" }),
            sectionLabel("Wallets"),
            walletsWrap,
            el("div", { class: "divider" }),
            sectionLabel("Transaction policy"),
            policyWrap,
            el("div", { class: "divider" }),
            sectionLabel("Agent"),
            agentWrap,
          ]),
        );
        const left = el("div", { class: "pane" }, [
          paneHead("layers", "Configuration"),
          leftScroll,
        ]);

        // ---- RIGHT: stats + activity + trace feed ----
        const statsBar = el("div", { class: "stats" });
        statEls = {
          events: stat(statsBar, "Events", "0", "zap"),
          turns: stat(statsBar, "Agent runs", "0", "play"),
          tx: stat(statsBar, "Tx calls", "0", "send", true),
          tokens: stat(statsBar, "Tokens", "0", "cpu"),
          cost: stat(statsBar, "Cost", "$0.00", "coins"),
          block: stat(statsBar, "Block", "—", "cpu"),
          errors: stat(statsBar, "Errors", "0", "alert"),
        };

        activityScroll = el("div", { class: "pane-scroll" });
        activityEl = el("div", { class: "feed" });
        activityEl.appendChild(
          el("div", { class: "activity-empty muted", style: { padding: "8px 2px", fontSize: "12.5px" } }, [
            "No chain activity yet. Press ",
            window.CH.kbd("Start"),
            " to boot the daemon — events, transactions, and signing decisions land here as triggers fire.",
          ]),
        );
        const activityPane = el("div", { class: "pane", style: { flex: "1 1 0", minHeight: "0" } }, [
          paneHead("activity", "Chain activity", el("span", { class: "badge", text: "tx · events" })),
          activityScroll,
        ]);
        activityScroll.appendChild(
          el("div", { class: "col" }, [statsBar, el("div", { class: "divider" }), activityEl]),
        );

        feedScroll = el("div", { class: "pane-scroll" });
        feedEl = el("div", { class: "feed" });
        feedScroll.appendChild(feedEl);
        const feedPane = el("div", { class: "pane", style: { flex: "1 1 0", minHeight: "0", borderTop: "1px solid var(--rule)" } }, [
          paneHead("eye", "Trace feed"),
          feedScroll,
        ]);

        const right = el("div", { class: "pane", style: { display: "flex", flexDirection: "column" } }, [
          activityPane,
          feedPane,
        ]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));
        updateStats();
        renderConfigPanels();
      }

      // Render the left configuration panels from the parsed bundle (or
      // graceful placeholders while it loads / if parsing failed).
      function renderConfigPanels() {
        if (!configMounts) return;
        const b = bundle || {};
        const loaded = bundle != null;
        const note = (declared) => (loaded ? declared : "Reading agent.ts…");

        // chain chips
        CH.clear(configMounts.chainBar);
        const chains = Array.isArray(b.CHAINS) ? b.CHAINS : [];
        if (chains.length) {
          for (const c of chains) {
            const fin = c.finality
              ? c.finality.kind === "confirmations"
                ? `${c.finality.count} conf`
                : c.finality.kind
              : "—";
            configMounts.chainBar.appendChild(chip("link", "chain", String(c.chainId), true));
            configMounts.chainBar.appendChild(chip("network", "rpc", c.rpcPolicy || "single"));
            configMounts.chainBar.appendChild(chip("shield", "finality", fin));
            if (c.reorgTolerant) configMounts.chainBar.appendChild(chip("refresh", "", "reorg-tolerant"));
          }
        } else {
          configMounts.chainBar.appendChild(chip("link", "chain", "evm"));
        }

        // contracts (the hero)
        CH.clear(configMounts.contracts);
        const contracts = Array.isArray(b.CONTRACTS) ? b.CONTRACTS : [];
        if (contracts.length) {
          for (const c of contracts) {
            configMounts.contracts.appendChild(contractCard(c));
          }
        } else {
          configMounts.contracts.appendChild(
            placeholder(note("No contracts declared in this spec.")),
          );
        }

        // triggers
        CH.clear(configMounts.triggers);
        triggerState = { total: null };
        const triggers = Array.isArray(b.TRIGGERS) ? b.TRIGGERS : [];
        if (triggers.length) {
          for (const t of triggers) configMounts.triggers.appendChild(triggerCard(t));
        } else {
          configMounts.triggers.appendChild(
            placeholder(note("No triggers declared.")),
          );
        }

        // wallets
        CH.clear(configMounts.wallets);
        const wallets = Array.isArray(b.WALLETS) ? b.WALLETS : [];
        if (wallets.length) {
          for (const w of wallets) configMounts.wallets.appendChild(walletCard(w));
        } else {
          configMounts.wallets.appendChild(
            placeholder(note("No wallets — this agent is read-only (no signing).")),
          );
        }

        // transaction policy
        CH.clear(configMounts.policy);
        const p = b.TRANSACTION_POLICY;
        if (p && typeof p === "object") {
          configMounts.policy.appendChild(policyCard(p));
        } else {
          configMounts.policy.appendChild(placeholder(note("No policy declared.")));
        }

        // agent identity + idempotency
        CH.clear(configMounts.agent);
        configMounts.agent.appendChild(agentCard(b));
      }

      // ── config cards ──────────────────────────────────────────────────────
      function placeholder(text) {
        return el("div", { class: "muted", style: { fontSize: "12.5px", padding: "2px" }, text });
      }

      function abiLabel(ref) {
        if (!ref) return "abi";
        const m = String(ref).match(/abi:\/\/(\w+)/);
        if (m) return m[1].toUpperCase();
        if (String(ref).indexOf("file://") === 0) return "custom ABI";
        return ref;
      }

      function contractCard(c) {
        const head = el("div", { class: "card-head" }, [
          el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("package", 14)),
          el("span", { class: "label", text: c.id || "contract" }),
          el("span", { class: "grow" }),
          el("span", { class: "badge ok", text: abiLabel(c.abiRef) }),
        ]);
        const copyBtn = el(
          "button",
          {
            class: "btn ghost sm icon-only",
            title: "Copy address",
            onClick: () => window.CH.copy(c.address),
          },
          icon("copy", 13),
        );
        const body = el("div", { class: "card-body" }, [
          el("div", { class: "row", style: { justifyContent: "space-between", gap: "8px" } }, [
            el("span", { class: "mono", style: { fontSize: "12.5px", color: "var(--accent)" }, text: shortAddr(c.address) }),
            copyBtn,
          ]),
          el("div", { class: "chips", style: { marginTop: "10px" } }, [
            chip("link", "chain", String(c.chainId)),
            chip("file", "ref", c.abiRef || "—"),
          ]),
        ]);
        return el("div", { class: "card" }, [head, body]);
      }

      function triggerCard(t) {
        let ic = "zap";
        let title = t.kind;
        let sub = "";
        let badge = "";
        if (t.kind === "event") {
          ic = "zap";
          title = t.event;
          sub = `on ${t.contract}`;
          badge = "event";
        } else if (t.kind === "block") {
          ic = "cpu";
          title = "new block";
          sub = `scan every ${fmtMs(t.scanIntervalMs)}`;
          badge = "block";
        } else if (t.kind === "address") {
          ic = "user";
          title = shortAddr(t.address);
          sub = `transfers ${t.direction}`;
          badge = "address";
        }
        return el("div", { class: "event accent", style: { borderLeftColor: "var(--accent)" } }, [
          el("div", { class: "ev-icon" }, icon(ic, 13)),
          el("div", { class: "ev-main" }, [
            el("div", { class: "ev-title" }, [
              el("span", { class: "ev-name", text: title }),
              el("span", { class: "badge", text: badge }),
            ]),
            el("div", { class: "ev-sub", text: `chain ${t.chainId}${sub ? " · " + sub : ""}` }),
          ]),
        ]);
      }

      function custodyBadge(custody) {
        const map = {
          "user-controlled": "warn",
          kms: "ok",
          hsm: "ok",
          local: "warn",
        };
        return el("span", { class: `badge ${map[custody] || ""}`, text: custody || "—" });
      }

      function walletCard(w) {
        return el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("shield", 14)),
            el("span", { class: "label", text: w.id || "wallet" }),
            el("span", { class: "grow" }),
            custodyBadge(w.custody),
          ]),
          el("div", { class: "card-body" }, [
            el("div", { class: "chips" }, [
              chip("link", "chain", String(w.chainId)),
              chip("wrench", "signing", w.signingPolicy || "—"),
              w.keyRef ? chip("plug", "key", w.keyRef.kind === "env" ? `env:${w.keyRef.name}` : "handle") : null,
            ]),
          ]),
        ]);
      }

      function policyCard(p) {
        const approval = p.defaultWriteApproval || "required";
        const approvalKind = approval === "none" ? "err" : approval === "policy" ? "warn" : "ok";
        const allowed = Array.isArray(p.allowedContracts) ? p.allowedContracts : [];
        return el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("shield", 14)),
            el("span", { class: "label", text: "Safety floor" }),
            el("span", { class: "grow" }),
            el("span", { class: `badge ${approvalKind}`, text: `write: ${approval}` }),
          ]),
          el("div", { class: "card-body" }, [
            el("div", { class: "chips" }, [
              chip("flask", "simulate", p.simulationRequired ? "required" : "off"),
              p.maxValueWei != null ? chip("coins", "max wei", String(p.maxValueWei)) : null,
              p.maxValueUsd != null ? chip("coins", "max usd", String(p.maxValueUsd)) : null,
            ]),
            allowed.length
              ? el("div", { style: { marginTop: "10px" } }, [
                  el("div", { class: "section-label", text: "Allowed contracts" }),
                  el(
                    "div",
                    { class: "chips" },
                    allowed.map((id) => chip("package", "", id)),
                  ),
                ])
              : el("div", { class: "muted", style: { marginTop: "10px", fontSize: "12px" }, text: "Destructive calls restricted to declared contracts only." }),
          ]),
        ]);
      }

      function agentCard(b) {
        const card = el("div", { class: "card" }, [
          el("div", { class: "card-head" }, [
            el("span", { class: "icon", style: { color: "var(--accent)" } }, icon("bot", 14)),
            el("span", { class: "label", text: b.SPEC_NAME || api.config.title }),
            el("span", { class: "grow" }),
            b.AGENT_MODEL ? el("span", { class: "badge info", text: b.AGENT_MODEL }) : null,
          ]),
        ]);
        const body = el("div", { class: "card-body" });
        body.appendChild(
          el("div", { class: "chips", style: { marginBottom: b.AGENT_INSTRUCTIONS ? "10px" : "0" } }, [
            b.IDEMPOTENCY_WINDOW_MS != null
              ? chip("clock", "dedup", fmtMs(b.IDEMPOTENCY_WINDOW_MS))
              : null,
            chip("layers", "kind", "event-driven daemon"),
          ]),
        );
        if (b.AGENT_INSTRUCTIONS) {
          const instr = String(b.AGENT_INSTRUCTIONS);
          const preview = instr.length > 600 ? `${instr.slice(0, 600)}…` : instr;
          const mdWrap = el("div", { class: "md", style: { fontSize: "12.5px", color: "var(--ink-2)" } });
          mdWrap.appendChild(md(preview));
          body.appendChild(mdWrap);
        }
        card.appendChild(body);
        return card;
      }

      // ── stat tile ───────────────────────────────────────────────────────
      function stat(mount, label, value, ic, accent) {
        const v = el("div", { class: `v ${accent ? "accent" : ""}`, text: value });
        mount.appendChild(el("div", { class: "stat" }, [v, el("div", { class: "k", text: label })]));
        return v;
      }
    },
  });
})();
