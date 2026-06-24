/* CrewHaus — claude-plugin shape UI.
   A compiled Claude Code plugin bundle is INSPECTED, never run. The host parses
   the bundle's manifest (.claude-plugin/plugin.json, .mcp.json, README.md,
   CLAUDE_PLUGIN_NOTES.md) plus the full file listing and hands it to us via
   api.state.harness.manifest. We render a polished, marketplace-style package
   detail page: identity header, what-it-provides, MCP servers, README, file
   tree, and copy-paste install instructions for Claude Code. */
(function () {
  "use strict";
  const { el, icon, md, dropzone, copy, toast } = window.CH;

  // ── small DOM helpers ─────────────────────────────────────────────────────
  function paneHead(ic, label, right) {
    return el("div", { class: "pane-head" }, [
      el("span", { class: "icon" }, icon(ic, 14)),
      el("span", { text: label }),
      el("span", { class: "grow" }),
      right || null,
    ]);
  }

  function cardShell(ic, label, right, body) {
    return el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("span", { class: "ch-ci" }, icon(ic, 14)),
        el("span", { class: "label", text: label }),
        el("span", { class: "grow" }),
        right || null,
      ]),
      el("div", { class: "card-body" }, body),
    ]);
  }

  function chip(k, v) {
    return el("span", { class: "chip" }, [
      k ? el("span", { class: "k", text: k }) : null,
      el("span", { class: "v", text: v }),
    ]);
  }

  function copyBtn(text, label) {
    const b = el("button", { class: "btn ghost sm" }, [
      icon("copy", 14),
      el("span", { text: label || "Copy" }),
    ]);
    b.addEventListener("click", () => copy(text));
    return b;
  }

  function lastSeg(p) {
    const parts = p.split("/");
    return parts[parts.length - 1] || p;
  }

  // ── derive "what it provides" from the file listing ───────────────────────
  // The host only JSON-parses plugin.json + .mcp.json and reads README/notes;
  // skills/agents/commands are discovered from the manifest.files paths, which
  // mirror exactly what the emitter writes (skills/<name>/SKILL.md, etc.).
  function deriveProvides(files) {
    const skills = [];
    const agents = [];
    const commands = [];
    const hooks = [];
    const seenSkill = new Set();
    for (const f of files || []) {
      let m;
      if ((m = f.match(/^skills\/([^/]+)\/SKILL\.md$/))) {
        if (!seenSkill.has(m[1])) {
          seenSkill.add(m[1]);
          skills.push({ name: m[1], path: f });
        }
      } else if ((m = f.match(/^agents\/(.+)\.md$/))) {
        agents.push({ name: m[1], path: f });
      } else if ((m = f.match(/^commands\/(.+)\.md$/))) {
        commands.push({ name: m[1], path: f });
      } else if (/^hooks\//.test(f) || /hooks\.json$/.test(f)) {
        hooks.push({ name: lastSeg(f), path: f });
      }
    }
    return { skills, agents, commands, hooks };
  }

  function provideList(items, ic, emptyText) {
    if (!items.length) return el("div", { class: "muted small", text: emptyText });
    return el(
      "div",
      { class: "provide-list" },
      items.map((it) =>
        el("div", { class: "provide-item" }, [
          el("span", { class: "pi-ic" }, icon(ic, 13)),
          el("span", { class: "pi-name", text: it.name }),
          el("span", { class: "grow" }),
          el("span", { class: "pi-path", text: it.path }),
        ]),
      ),
    );
  }

  // ── MCP servers (raw .mcp.json == IR mcp_servers map) ─────────────────────
  function mcpServerRow(name, cfg) {
    cfg = cfg || {};
    const transport = cfg.transport || (cfg.url ? "sse" : cfg.command ? "stdio" : "—");
    const head = el("div", { class: "mcp-head" }, [
      el("span", { class: "mcp-ic" }, icon("plug", 13)),
      el("span", { class: "mcp-name", text: name }),
      el("span", { class: "badge info", text: transport }),
    ]);
    const rows = [];
    if (cfg.command !== undefined) {
      const cmd = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].join(" ");
      rows.push(kvRow("command", cmd, true));
    }
    if (cfg.url !== undefined) rows.push(kvRow("url", String(cfg.url), true));
    const env = cfg.env || cfg.headers;
    const envLabel = cfg.headers ? "headers" : "env";
    if (env && typeof env === "object") {
      const keys = Object.keys(env);
      if (keys.length) rows.push(kvRow(envLabel, keys.join(", "), false));
    }
    return el("div", { class: "mcp-server" }, [head, el("div", { class: "mcp-body" }, rows)]);
  }

  function kvRow(k, v, mono) {
    return el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: k }),
      el("span", { class: `kv-v ${mono ? "mono" : ""}`, text: v }),
    ]);
  }

  // ── install snippet ───────────────────────────────────────────────────────
  function installCard(name) {
    const projPath = `.claude/plugins/${name || "<plugin>"}`;
    const homePath = `~/.claude/plugins/${name || "<plugin>"}`;
    const cpCmd = `cp -r ${name || "<plugin>"} ~/.claude/plugins/`;

    const note = el("p", { class: "muted small" }, [
      "This plugin follows Anthropic's reference format. Drop the bundle into a ",
      el("code", { text: "plugins/" }),
      " directory Claude Code already scans — no build step.",
    ]);

    function target(scopeLabel, path, hint) {
      return el("div", { class: "install-target" }, [
        el("div", { class: "it-row" }, [
          el("span", { class: "it-scope", text: scopeLabel }),
          el("code", { class: "it-path", text: path }),
          el("span", { class: "grow" }),
          copyBtn(path, "Copy path"),
        ]),
        el("div", { class: "it-hint muted small", text: hint }),
      ]);
    }

    const cmdRow = el("div", { class: "cmd-line" }, [
      el("code", { class: "cmd", text: cpCmd }),
      copyBtn(cpCmd, "Copy"),
    ]);

    return cardShell("download", "Install in Claude Code", null, [
      note,
      el("div", { class: "section-label", text: "Install location" }),
      target("Global", homePath, "Available in every Claude Code project on this machine."),
      target("Project", projPath, "Scoped to one repository; commit it to share with your team."),
      el("div", { class: "section-label", style: { marginTop: "14px" }, text: "Or copy in one line" }),
      cmdRow,
      el("div", { class: "it-hint muted small", style: { marginTop: "8px" } }, [
        "Then run ",
        el("code", { text: "/plugins" }),
        " inside Claude Code to verify the plugin loaded and view its skills.",
      ]),
    ]);
  }

  // ── file tree ─────────────────────────────────────────────────────────────
  function fileTree(files) {
    const visible = (files || []).filter((f) => !/DROP_|node_modules/.test(f));
    return el(
      "div",
      { class: "filelist" },
      visible.map((f) =>
        el("div", { class: `f ${isEntry(f) ? "entry" : ""}` }, [
          icon(iconForFile(f), 13),
          el("span", { text: f }),
        ]),
      ),
    );
  }
  function isEntry(f) {
    return f === ".claude-plugin/plugin.json";
  }
  function iconForFile(f) {
    if (f.endsWith(".mcp.json") || f.includes(".mcp.json")) return "plug";
    if (f.endsWith("plugin.json")) return "package";
    if (/SKILL\.md$/.test(f)) return "sparkles";
    if (/^agents\//.test(f)) return "bot";
    if (/^commands\//.test(f)) return "terminal";
    if (/README/i.test(f)) return "book";
    if (/NOTES/.test(f)) return "alert";
    return "file";
  }

  CH.app({
    // plugin run-class hides lifecycle controls automatically.
    build(api) {
      let mode = null;

      api.onState((s) => {
        const present = s.harness && s.harness.present;
        const want = present ? "active" : "empty";
        // Plugin manifest can change as files are dropped; rebuild on every
        // state push while active so newly-added files appear.
        if (want === "empty" && mode === "empty") return;
        mode = want;
        want === "active" ? buildActive(s) : buildEmpty();
      });

      function buildEmpty() {
        CH.clear(api.main);
        api.main.appendChild(
          dropzone({
            icon: "plug",
            title: "Drop in a compiled Claude Code plugin",
            subtitle:
              "This inspector reads a Claude Code plugin emitted from any CrewHaus spec. Nothing runs — it's a package detail page.",
            steps: [
              "Emit a plugin from any CrewHaus spec with `@crewhaus/target-claude-plugin`",
              "Copy the plugin's contents into `harness/` (keep `.claude-plugin/` and `.mcp.json`)",
              "The inspector loads automatically — no **Start** needed for plugins",
            ],
          }),
        );
      }

      function buildActive(s) {
        const man = (s.harness && s.harness.manifest) || {};
        const plugin = man.plugin || {};
        const mcp = man.mcp || null;
        const readme = man.readme || "";
        const notes = man.notes || "";
        const files = man.files || [];
        const provides = deriveProvides(files);

        CH.clear(api.main);

        // ── LEFT: package overview ──────────────────────────────────────────
        const left = el("div", { class: "pane" }, [
          paneHead("package", "Plugin", null),
          el("div", { class: "pane-scroll" }, [
            heroCard(plugin, provides, mcp, files),
            provideSection(provides),
            mcpCard(mcp),
            notes ? notesCard(notes) : null,
            installCard(plugin.name),
            filesCard(files),
          ]),
        ]);

        // ── RIGHT: README ───────────────────────────────────────────────────
        const readmeScroll = el("div", { class: "pane-scroll" });
        if (readme.trim()) {
          const body = el("div", { class: "md readme-body" });
          body.appendChild(md(readme));
          readmeScroll.appendChild(body);
        } else {
          readmeScroll.appendChild(
            el("div", { class: "empty-mini muted" }, [
              icon("book", 22),
              el("p", { text: "This plugin ships no README.md." }),
            ]),
          );
        }
        const right = el("div", { class: "pane" }, [
          paneHead(
            "book",
            "README",
            readme.trim() ? copyBtn(readme, "Copy") : null,
          ),
          readmeScroll,
        ]);

        api.main.appendChild(el("div", { class: "split cols-2-wide" }, [left, right]));

        if (!plugin || !plugin.name) {
          toast("plugin.json missing or invalid — check .claude-plugin/plugin.json", "err");
        }
      }

      // ── hero / identity card ─────────────────────────────────────────────
      function heroCard(plugin, provides, mcp, files) {
        const name = plugin.name || "unknown-plugin";
        const desc = plugin.description || "No description provided in plugin.json.";
        const author = plugin.author || {};
        const version = plugin.version;

        const meta = el("div", { class: "chips", style: { marginTop: "12px" } }, [
          version ? chip("v", String(version)) : null,
          author.name ? chip("author", author.name) : null,
          author.email ? chip("", author.email) : null,
          chip("format", "claude-code"),
        ]);

        const skillN = provides.skills.length;
        const agentN = provides.agents.length;
        const cmdN = provides.commands.length;
        const mcpN = mcp ? Object.keys(mcp).length : 0;

        const statRow = el("div", { class: "stats hero-stats" }, [
          stat(String(skillN), skillN === 1 ? "Skill" : "Skills", true),
          stat(String(agentN), agentN === 1 ? "Sub-agent" : "Sub-agents"),
          stat(String(cmdN), cmdN === 1 ? "Command" : "Commands"),
          stat(String(mcpN), mcpN === 1 ? "MCP server" : "MCP servers"),
        ]);

        return el("div", { class: "card hero" }, [
          el("div", { class: "card-body" }, [
            el("div", { class: "hero-top" }, [
              el("div", { class: "hero-logo" }, icon("plug", 26)),
              el("div", { class: "hero-id" }, [
                el("div", { class: "hero-name", text: name }),
                el("div", { class: "hero-desc", text: desc }),
              ]),
            ]),
            meta,
            el("div", { class: "divider" }),
            statRow,
          ]),
        ]);
      }

      function provideSection(provides) {
        const hasAny =
          provides.skills.length ||
          provides.agents.length ||
          provides.commands.length ||
          provides.hooks.length;
        const body = [
          el("div", { class: "section-label", text: "Skills" }),
          provideList(provides.skills, "sparkles", "No skills in this bundle."),
        ];
        if (provides.agents.length) {
          body.push(el("div", { class: "section-label", style: { marginTop: "14px" }, text: "Sub-agents" }));
          body.push(provideList(provides.agents, "bot", ""));
        }
        if (provides.commands.length) {
          body.push(el("div", { class: "section-label", style: { marginTop: "14px" }, text: "Slash commands" }));
          body.push(provideList(provides.commands, "terminal", ""));
        }
        if (provides.hooks.length) {
          body.push(el("div", { class: "section-label", style: { marginTop: "14px" }, text: "Hooks" }));
          body.push(provideList(provides.hooks, "hook", ""));
        }
        if (!hasAny) {
          return cardShell("layers", "Provides", null, [
            el("div", { class: "muted small", text: "This bundle declares no skills, agents, or commands." }),
          ]);
        }
        return cardShell("layers", "Provides", null, body);
      }

      function mcpCard(mcp) {
        if (!mcp || !Object.keys(mcp).length) {
          return cardShell("plug", "MCP servers", null, [
            el("div", { class: "muted small", text: "No .mcp.json — this plugin declares no MCP servers." }),
          ]);
        }
        const keys = Object.keys(mcp);
        const count = el("span", { class: "badge", text: `${keys.length}` });
        return cardShell(
          "plug",
          "MCP servers",
          count,
          keys.map((k) => mcpServerRow(k, mcp[k])),
        );
      }

      function notesCard(notes) {
        const body = el("div", { class: "md" });
        body.appendChild(md(notes));
        return cardShell("alert", "Plugin notes", null, [body]);
      }

      function filesCard(files) {
        const visible = (files || []).filter((f) => !/DROP_|node_modules/.test(f));
        const count = el("span", { class: "badge", text: `${visible.length}` });
        return cardShell("folder", "Bundle files", count, [fileTree(files)]);
      }

      function stat(value, label, accent) {
        return el("div", { class: "stat" }, [
          el("div", { class: `v ${accent ? "accent" : ""}`, text: value }),
          el("div", { class: "k", text: label }),
        ]);
      }
    },
  });

  // ── shape-local styles (layout flourishes not in the shared sheet) ────────
  const style = document.createElement("style");
  style.textContent = [
    ".card-head .ch-ci{color:var(--accent);display:inline-grid;place-items:center}",
    ".card-head .ch-ci svg{width:14px;height:14px}",
    ".pane-scroll .card + .card{margin-top:14px}",
    ".small{font-size:12px}",
    ".card.hero{background:linear-gradient(180deg,var(--panel-2),var(--panel));border-color:var(--rule-2)}",
    ".hero-top{display:flex;gap:14px;align-items:flex-start}",
    ".hero-logo{width:52px;height:52px;flex:0 0 auto;border-radius:14px;display:grid;place-items:center;background:radial-gradient(circle at 30% 25%,var(--accent-glow),transparent 70%),var(--panel-3);border:1px solid var(--accent-glow);color:var(--accent)}",
    ".hero-logo svg{width:26px;height:26px}",
    ".hero-id{min-width:0}",
    ".hero-name{font-size:21px;font-weight:600;letter-spacing:-0.02em;font-family:var(--mono);color:var(--ink);overflow-wrap:anywhere}",
    ".hero-desc{margin-top:5px;color:var(--ink-2);font-size:13.5px;line-height:1.5}",
    ".hero-stats{margin-top:2px}",
    ".provide-list{display:flex;flex-direction:column;gap:6px}",
    ".provide-item{display:flex;align-items:center;gap:9px;padding:7px 10px;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--panel-2)}",
    ".provide-item .pi-ic{width:22px;height:22px;flex:0 0 auto;border-radius:6px;display:grid;place-items:center;background:var(--accent-ghost);color:var(--accent)}",
    ".provide-item .pi-ic svg{width:13px;height:13px}",
    ".provide-item .pi-name{font-family:var(--mono);font-size:13px;color:var(--ink);overflow-wrap:anywhere}",
    ".provide-item .pi-path{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);white-space:nowrap}",
    ".mcp-server{border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--panel-2);overflow:hidden}",
    ".mcp-server + .mcp-server{margin-top:10px}",
    ".mcp-head{display:flex;align-items:center;gap:9px;padding:9px 12px;border-bottom:1px solid var(--rule);background:var(--panel)}",
    ".mcp-head .mcp-ic{width:22px;height:22px;flex:0 0 auto;border-radius:6px;display:grid;place-items:center;background:var(--accent-ghost);color:var(--accent)}",
    ".mcp-head .mcp-ic svg{width:13px;height:13px}",
    ".mcp-head .mcp-name{font-family:var(--mono);font-size:13px;font-weight:600;color:var(--ink);flex:1;overflow-wrap:anywhere}",
    ".mcp-body{padding:10px 12px;display:flex;flex-direction:column;gap:7px}",
    ".kv{display:grid;grid-template-columns:80px 1fr;gap:10px;align-items:baseline}",
    ".kv-k{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-3)}",
    ".kv-v{font-size:12.5px;color:var(--ink-2);overflow-wrap:anywhere}",
    ".kv-v.mono{font-family:var(--mono);color:var(--ink)}",
    ".install-target{border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--panel-2);padding:10px 12px}",
    ".install-target + .install-target{margin-top:8px}",
    ".install-target .it-row{display:flex;align-items:center;gap:10px}",
    ".install-target .it-scope{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--accent);background:var(--accent-ghost);border:1px solid var(--accent-glow);border-radius:100px;padding:2px 9px;flex:0 0 auto}",
    ".install-target .it-path{font-family:var(--mono);font-size:12px;color:var(--ink);background:var(--bg-2);border:1px solid var(--rule);border-radius:6px;padding:3px 8px;overflow-wrap:anywhere}",
    ".install-target .it-hint{margin-top:6px}",
    ".cmd-line{display:flex;align-items:center;gap:10px}",
    ".cmd-line .cmd{flex:1;font-family:var(--mono);font-size:12px;color:var(--accent);background:var(--bg-2);border:1px solid var(--rule);border-radius:6px;padding:7px 10px;overflow-wrap:anywhere}",
    ".readme-body{max-width:760px}",
    ".empty-mini{height:100%;display:grid;place-content:center;justify-items:center;gap:10px;text-align:center;color:var(--ink-3)}",
    ".empty-mini svg{opacity:0.5}",
  ].join("\n");
  document.head.appendChild(style);
})();
