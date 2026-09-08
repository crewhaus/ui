# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The hybrid run is legible.** factory 0.6.0 publishes two new trace kinds,
  and the feed renders both: `model_stage` (a stage transition of the rungs and
  side calls that branch a turn — `cascade · escalate`, `model_directed ·
  escalate`, `guide`, `shadow`, `committee`, `member`, `tie-break`, `consult`)
  and `model_directive` (a `/model` pin typed at the composer). Stage cards
  name the strategy and stage, badge the role, carry the stage's own spend when
  the runtime reports it, and — for a stage that never ran — say why through
  `cause`, so *skipped — max_escalations* is distinguishable from *skipped —
  judge_share_exhausted*. The cascade's draft rung and its judge call publish
  no stage line (a draft that passes never branches); they read as attribution
  — the role badge and `stage draft` / `stage verify` — on the model and cost
  cards.
- **Routing detail on `model_route`.** Beyond policy and reason, the card now
  names the strategy stage, profile and spec arm it resolved to, the rule id or
  classifier label that steered it, the `preRoute` hint, the pool scope, how
  many arms were eligible, the quality floor's verdict — naming both the arm
  the floor served and the arms it refused, since `ModelRouteFloor.arm` is the
  floor arm rather than a blocked one — and the route key a scoped arm backed
  off to. A floor-blocked exploit is the one route decision rendered as a
  warning.
- **Spend by role and by profile.** `accrue()` splits the run's cost and tokens
  into `byRole` (primary / draft / judge / escalation / guide / classifier /
  consult / committee / shadow / compaction / subagent) and `byProfile`
  (`models:` profile) beside the flat totals it already kept, and tracks
  `auxCostMicros` — the auxiliary spend `budget.judge_share` bounds. Every
  shape's **Cost** tile gained a hover breakdown; new pure helpers
  `CH.events.spendByRole()`, `spendByProfile()` and `spendTitle()` expose the
  same data to shape apps. Tokens still come from `model_response` and cost
  from `cost_accrual`, so the split survives a pricing-table miss exactly as
  the totals do.

  Both splits sum to the flat total. A call that resolved no profile is grouped
  under `(none)` rather than dropped (matching factory's own fold), and a
  `summary: true` accrual that carries a role — a nested run's roll-up, such as
  `@crewhaus/sub-agent-spawner`'s `subagent` total — is folded, because the
  child runs on its own event bus and its per-call lines never reach this
  stream. The optimizer's role-less run total stays ignored: it is a sum over
  accruals already counted here.
- **Attribution on the model and cost cards.** A `model_response` or
  `cost_accrual` that carries a role is badged with it and names its stage,
  profile and — the first time this has been visible anywhere — the request
  parameters the serving adapter silently dropped (`dropped temperature` for a
  Claude 5 profile).

  All of the above is additive: an event carrying none of the new fields
  renders exactly as it did before, and an absent role reads as `primary`.

### Fixed

- The workflow shape's between-runs reset cleared its stats field by field and
  missed `cacheTokens` and `unpriced` (and would have missed the new spend
  maps), so those carried over into the next run. It now assigns a fresh
  `newStats()`.

## [0.2.0] - 2026-08-08

The first cut since 0.1.3 (2026-07-01). Everything from the 0.3.0 UI refresh
(#10) plus two host fixes that were only ever available from a git checkout.

### Fixed

- **Ten of the eighteen shapes could not start with `crewhaus` on PATH.** The
  host's launch selector offered the interpreter path (`crewhaus run <spec>`)
  whenever a spec and a resolvable `crewhaus` binary were present, gated only
  on the *run class* being stdio — never on the *shape*. But `crewhaus run`
  executes `cli` and `browser` targets only; every other target is compile-only
  and `crewhaus run` exits 1 on it. So on a default install, pressing **Start**
  in the graph, workflow, crew, pipeline, research, batch, voice, eval, onchain,
  or onchain-game UI selected a launch that immediately died, instead of the
  `bun <entry>` that would have worked.

  The interpreter path is now offered for `cli` and `browser` only; every other
  shape falls through to the compiled bundle. All three places that made this
  decision independently now share one gate:

  - the launch selector itself (the failing spawn),
  - the post-settings-edit restart, which previously latched a sticky "live
    edit" preference that pinned *every* later start to the failing interpreter,
  - the settings view's launch badge, which was gated on nothing but a
    `crewhaus` on PATH and so promised "edits recompile-free and the session
    resumes on save" on shapes that could do neither.

  An explicit `CREWHAUS_UI_LAUNCH=interpreter` (or `"launch": "interpreter"`) on
  a compile-only shape is **ignored with a warning in the run log** rather than
  refused — the compiled path is a working launch, so failing the start over a
  preference would be strictly worse. The full eighteen-shape launch matrix is
  now pinned by `test/launch-mode.test.ts`.

- **`--resume` was passed to a target that refuses it.** `browser` is runnable
  by `crewhaus run`, so it correctly takes the interpreter — but `runRunBrowser`
  rejects the flag outright (`--resume and --continue are not supported for
  target: browser (single-turn)`), so the post-settings-edit restart of a
  running browser harness exited 1 instead of restarting. Being *runnable* and
  being *resumable* are now separate gates (`canInterpretShape` vs
  `canResumeShape`): `browser` relaunches bare, and neither the settings badge
  nor the save confirmation claims a resume that will not happen.

- **The harness ran with the wrong working directory** (`21a4bca`, in the repo
  since 0.1.3 but never published). The scaffolded runner points `harnessDir` at
  the compiled bundle (e.g. `dist/`), and the host spawned the agent with
  `cwd = harnessDir`. For a standalone harness whose spec references siblings by
  root-relative path — MCP server commands, `retrieve` data roots, the
  `.crewhaus/` session store, `.env` — that cwd is wrong, and the agent exited on
  boot the moment you pressed Start. The agent now runs with `cwd` = the harness
  **root** (the directory holding `crewhaus.yaml`), found by walking up from the
  bundle dir; entry detection also finds a bundle in a `dist/`/`build/` subdir.

### Added

- **Right-rail panel system.** A shared viewer whose views are gated per shape by
  `config.features[]`: `tools`, background `tasks`, `files`, `artifacts`, plus
  the memory views `focus`, `plan`, `context`, `wiki`, and `skills`. The
  per-shape view matrix is pinned by `test/shape-features.test.ts`, which also
  fails on a features[] key that no view consumes (so a typo can't silently drop
  a panel).

- **`.crewhaus/` bridge.** The host reads the harness's own memory surfaces —
  continuity, wiki, dream, skills — and streams them to the browser, latching
  the run identity (spec name + `sessionId`) so `sessionId`-keyed panels populate
  mid-run rather than after it.

- **Settings view with write-back.** Read and edit the spec from the UI. Edits
  are validated with the harness's own `@crewhaus/spec` + `@crewhaus/spec-patch`
  before anything touches disk, then applied seamlessly: on `cli` the
  interpreter re-reads the spec and resumes the session in place; elsewhere the
  bundle is recompiled. Secrets are written to `.env` at mode `0600` and the
  spec's `$VAR` reference is set for you; the UI only ever shows whether a
  referenced variable is *set*, never its value.

- **File attach in the composer** (paperclip + drag-and-drop). The file is
  written to a local path the agent can read — `<harnessRoot>/uploads/` by
  default — and the path is returned for the next turn. Nothing leaves the
  machine; both the destination directory and the filename are traversal-guarded.

- **Honest failure messaging.** A `run_failed` trace event (factory ≥ 0.3.0)
  renders as a class-styled failure card — billing, auth, and rate-limit get
  distinct treatment — with the provider's raw message, the remediation line, and
  a raw-output drawer. Nonzero exits are labeled from the CrewHaus exit-code
  table instead of a bare "agent exited", and the host attaches the last
  `run_failed` (or trailing stderr) to the exit broadcast so a process that dies
  before emitting anything structured still explains itself.

- **Light theme** alongside the existing dark one, and chat-links from a trace
  event into the panel that shows it.

- `CREWHAUS_UI_LAUNCH` (and `"launch"` in a shape's `config.json`) is now
  documented: `auto` | `compiled` | `interpreter`.

### Changed

- Token counts are sourced from `model_response.usage` rather than estimated,
  and a model with no price entry is flagged as unpriced instead of costed at 0.
- Crew orchestration events without a `runId` are recognized and rendered.
- The `file` view id was canonicalized to `files`; the `file` alias is gone.

## [0.1.3] - 2026-07-01

### Added

- Per-turn rating bar (thumbs, with progressive stars and a comment), feeding
  `crewhaus rate` / the response-ratings flywheel.
