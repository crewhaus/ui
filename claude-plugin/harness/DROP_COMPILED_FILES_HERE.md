# Drop your compiled Claude Code plugin here

This UI is an **inspector** for a Claude Code plugin bundle. The
`@crewhaus/target-claude-plugin` emitter turns **any** CrewHaus spec into an
Anthropic reference-format plugin directory. Nothing is executed — the host
parses the bundle's manifest files and the UI renders a package-detail page.

## 1. Emit the plugin

Run `@crewhaus/target-claude-plugin`'s `emitClaudePlugin(ir)` over your spec's
lowered IR (the CrewHaus plugin-emit path), which produces an Anthropic
reference-format plugin directory:

```
<plugin-name>/
├── .claude-plugin/
│   └── plugin.json          # required: name, description, author
├── .mcp.json                # optional: MCP server config (when the spec has MCP)
├── README.md                # documentation
├── skills/<name>/SKILL.md   # one per skill (per step/node/role for workflow/graph/crew)
├── agents/<name>.md         # optional sub-agent definitions
└── CLAUDE_PLUGIN_NOTES.md   # present for channel-target plugins
```

## 2. Copy the bundle into this folder

Copy the **contents** of the emitted plugin directory directly into this
`harness/` folder, so the paths are exactly:

- `harness/.claude-plugin/plugin.json`
- `harness/.mcp.json` (if present)
- `harness/README.md`
- `harness/skills/…`, `harness/agents/…`, etc.

(The dotted `.claude-plugin/` and `.mcp.json` are intentionally kept by the host.)

## 3. Run the inspector

```
bun ../serve.ts
```

Open the printed URL. There are **no Start/Stop controls** — plugin bundles are
inspected, never run. The inspector shows the manifest, what the plugin
provides (skills, sub-agents, commands), its MCP servers, the rendered README,
and copy-paste install instructions for Claude Code.
