# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: SemVer.

## [0.1.0] - 2026-11-02

### Added- Implicit per-session plan with version watermark (`gen.rev`), steps, evidence and update reason.
- Turn-end trigger: after every completed turn the plugin generates a Tab-completable next-message
  suggestion plus plan patches, using an isolated model call (never the agent loop).
- Floating suggestion bar above the composer: `Tab` fills the draft (does not send), `Alt+1..3`
  fills alternates, `Esc` dismisses; always-on `▤ vX.Y` entry opens the plan panel.
- Plan panel (card style): intent, steps with status, evidence, latest update reason, next
  suggestion, fill/sync actions.
- Always-on fallback states: dashed hint pill when the session has no plan yet, and a floating
  hero entry (`▤ 计划`) when no session-bound dock is mounted (new conversation shell).
- Warm backfill: opening an old session the plugin has never observed builds its plan from the
  durable session log (`POST /plan-completion/warm`, deduped per session).
- User edit channel (`POST /plan-completion/steps`): mark a step done/doing, or rewrite the whole
  step list; `editedByUser` plans cannot be auto-rewritten by the model (use `/replan`).
- Slash commands: `/roadmap` (read-only plan) and `/replan <direction>` (force rewrite).
- Production settings from plugin config: `evidenceChars`, `maxTokensPatch`, `maxTokensRewrite`,
  `warmBackfill`, `enableDebugRoutes`, `debugDir`.
- 78 unit tests (plan/prompt/heuristics/evidence/job/store/pipeline).

### Changed
- Package renamed from `@local/dsh-plan-completion` to **`dsh-plan-completion`** for standalone
  GitHub distribution (install as a `link:` profile bundle). Existing installs should uninstall
  the old name and install the repository path; existing runtime state is preserved across the
  rename.
- Patch-path evidence is sliced to `evidenceChars` (default 1500) and output capped at
  `maxTokensPatch` (400); rewrite keeps full evidence and 1200 tokens — based on two isolation
  test rounds (27 variants each) and 6 real auto-job samples.

### Fixed
- Cold-boot ordering: routes/commands register through `ctx.inject`, so the plugin works even when
  it activates before `webServer` / `commands` exist.
- Duplicate HTTP handlers after plugin toggle/hot reload: host state and route disposers now live in
  a process-wide registry, so re-applying the plugin disposes the previous handlers.
- Client keeps a stale plan when the host reports none; `plan:null` now clears the cached plan so
  the bar falls back to its always-on state.

### Security
- Debug endpoints (`theme`, `experiment`, `autojob`, `steps`, `reset`) are only registered when
  `enableDebugRoutes: true`; production endpoints are `state`, `debug`, `diag`, `replan`, `warm`.
- No credentials are stored in the plugin; model calls use the host `llm` service.
