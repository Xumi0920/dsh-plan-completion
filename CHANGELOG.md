# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: SemVer.

## [0.4.3] - 2026-11-06

- Expand README with installation/upgrade, current 0.4.x screenshots, keyboard and panel shortcuts, environment/configuration reference, exact test baseline, and a documentation navigation table.
- Replace the public full design contract with a pinned entry to the private `Xumi0920/dsh-plugin-design-system` baseline (v1.0.0, commit `80ec9bc`), keeping this plugin's business boundaries public.
- Add CI/npm/license/release/tests/requirements badges, refresh plan-panel light/dark screenshots and the composer entry image, and normalize repository line endings to LF via `.gitattributes`.
- Sync current-version references in README/docs to 0.4.3. No runtime behavior, configuration, storage or component-topology changes.

## [0.4.2] - 2026-11-06

- Ship `docs/ui-design-contract.md` inside the npm package together with the DSH UI/verification contract referenced by README/AGENTS/CONTRIBUTING.
- Relax `engines.dsh` upper bound from `>=0.2.1-rc.5 <0.3.0` to `>=0.2.1-rc.5` so newer DSH hosts can load the plugin without an engine warning.
- Sync documentation version records (compatibility/security/delivery/phase-2/managed-validation/managed-embedding/README) to 0.4.1/0.4.2; document the internal, npm-unpublished v0.1.8 tag backfill and the release-order convention.

## [0.4.1] - 2026-11-06

- Align the plan popover and composer entries with DSH theme tokens, native button variants, typography and radii. Completed status uses a pale success surface with readable primary text in both themes.
- Keep the header, update time and actions visible while plan details scroll; hide the empty active-steps section, unify manual confirmation controls, and fit narrow windows. Keep one close control in the header and place the primary draft action last.

## [0.4.0] - 2026-11-06

- Split local Q8 process ownership into an independent embedding component; retrieval owns the index and borrows vectors, with lexical fallback when the local runtime is disabled.
- Provide Chinese/English names, descriptions and icons for all six DSH component entries, including the effect of disabling each one.
- Preserve root-only and old five-row profiles, honor explicitly disabled embedding rows, and wait for the previous Q8 owner to close before starting a replacement.
- Add component lifecycle/migration regression tests, a native DSH Loader check and packaged locale/export validation.

## [0.3.1] - 2026-11-06

- Fix automatic plan/completion updates dropping the latest evidence: the evidence budget now preserves the latest answer (head and conclusion), at least one tool result, failure record and user instruction instead of charging old plan/acceptance/receipt metadata against the narrative budget; adds 4 regression tests covering legacy and strict updates. 281/281 tests.
- CI: enable manual `workflow_dispatch` runs for PR-only validation when pull_request events are delayed.

## [0.3.0] - 2026-11-06

- Zero-config managed Q8: RAG stays off by default; the first enable shows one confirmation, then downloads the pinned official llama.cpp runtime (Windows/Linux x64, Vulkan with CPU fallback) and the official Qwen3-Embedding-0.6B Q8 model (SHA-256 verified), starts llama-server on a random loopback port with a one-time key/alias, and reuses or reaps it automatically.
- Managed assets are installed under `<storageDir>/managed`; explicit paths and DSH_LLAMA_SERVER / DSH_Q8_MODEL remain supported, and `autoManage:false` restores the manual-path mode.
- Downloads honor explicit/env proxies and the Windows system proxy (curl-first transport); the llama child still never inherits provider credentials, proxy variables, or LLAMA_ARG_* overrides.
- Settings page adds the enable confirmation, live download/start progress, retry/stop controls, and collapsed advanced settings (variant, install dir, manual paths, external backend).
- First-start resilience: a longer startup window, a real CPU fallback when the Vulkan build cannot start, continuous status polling (a transient failure no longer leaves the UI stuck), an explicit retry that bypasses the failure cooldown, and asset errors surfaced in the settings status.
- Q8 status and diagnostics: the settings header shows a running/preparing/failed chip and the page keeps polling until ready; a stale "preparing" flag is cleared on load/save, retries bypass the failure cooldown, and llama-server stdout/stderr is captured under `<storageDir>/logs/llama-server.log`.
- Authenticated `GET /plan-completion/rag/status` returns the process state (running/pid/port/variant/uptime/error), the live embedding snapshot, and the last 200 llama-server log lines by default (`tail`/`lines` override, 10..1000); `POST /plan-completion/rag/prepare` retries immediately. Both routes are registered in the production allowlist.
- Managed Q8 auto-resumes on DSH restart when assets are installed, overlapping starts wait for the previous owner to close, and the settings page adds a startup-log view with failure tail and log path.
- Tests: 277 total, including status/tail bounds, variant switching, prepare-after-failure, managed asset discovery/downloads, and zero-config validation.

## [0.2.0] - 2026-11-05

- Default to compatible legacy progress behavior, with an explicit unverified label; opt into versioned strict acceptance in Settings. Preserve existing valid receipts on replan and the legacy two-none replan hint.
- Add authenticated human confirmation/revocation with plan/acceptance CAS and dependent-step invalidation.
- Keep one package with a root state service and observer, retrieval, generator and API components; honor legacy profile overrides and explicit component disabling.
- Run official Q8 through a lazy, authenticated, loopback llama.cpp subprocess owned by the retrieval component. No Ollama dependency, automatic downloads, shell launch, or inherited provider credentials. Release on idle/dispose; reap on Host exit; recover from crashes.
- Fail closed on invalid model routing, cancel stale requests, revalidate restored plans, and follow isolated DSH_HOME for the default store.
- Exclude archived experiment data and screenshots from npm; add isolated tarball/import checks to all four CI jobs. Validation scope and remaining desktop UI gate are recorded in docs/managed-validation.md.

## [0.1.8] - 2026-11-03

- Settings page final DSH visual alignment: filled borderless selects with custom chevron, no row borders, filled save button, DSH toggle colors, build marker settings-2026-11-03 (forces a fresh client bundle after host restart).

## [0.1.7] - 2026-11-02

### Fixed
- Settings page model lists now load per provider (`GET /settings?provider=…`), so third-party
  providers' models appear after switching Provider; fixed an internal error caused by a
  provider-scope bug in the settings snapshot.

### Changed
- Settings page redesign matched to DSH General Settings: flat 66px rows (title + description left,
  control right), filled controls without borders, DSH-sized toggle, right-aligned save button,
  unified typography/theme tokens for light and dark themes.

## [0.1.6] - 2026-11-02

### Added
- Model settings page registered at `settings.plugins.tab` (Settings → Plugins → 计划补全):
  radio group for `default` / `fixed` / `auto` model policy, Provider/Model ID inputs for fixed
  mode, a `modelCalls` toggle, current host-default route hint, and save/status feedback.
- Host settings route `GET/POST /plan-completion/settings` (authenticated) persists the policy to
  `<storageDir>/settings.json` and loads it on apply; `pickModel` honours `default`/`fixed`/`auto`.
- Client transport test for the settings page (GET/POST, failure handling).
- Dev-only suggestion log lives outside the release: `research/suggestion-log-local/` keeps a local
  copy for tuning; the published plugin does not contain or enable suggestion-content logging.

### Changed
- `npm test` now reports **138/138** tests.

## [0.1.5] - 2026-11-02

### Fixed
- Detect a plan that stopped tracking the conversation: after **two consecutive `op=none`**
  generation outcomes (e.g. an edited plan whose coarse step needs splitting), the published
  suggestion becomes `/replan 按最近进展重排计划，把已完成项标记完成` and the plan is marked
  stale, so the user can fix the plan with one Tab fill instead of seeing a repeated stale hint.
- `/reset` and forced `/replan` clear the none-streak counter.

### Changed
- `npm test` now reports **133/133** tests.

## [0.1.4] - 2026-11-02

### Fixed
- Suggestion/Markdown cleaning no longer destroys identifiers, file names or globs: `transaction_id`,
  `payment_test.py`, `C:\work\my_file.js` and `src/**/*.js` keep their underscores/stars. Only paired
  emphasis markers (`**bold**`, `*italic*`, `_emphasis_`, `~~strike~~`) are stripped; inline code keeps
  its content with backticks removed.
- Semantic shortening replaces the raw 40-character cut: prefer the last clause boundary, then a
  whitespace boundary, then cut before an ASCII token; never leave a truncated identifier/path or a
  dangling command prefix (`npm`, `npm te`), and drop dangling separators.
- New `test/text.test.js` covers the identifier/glob/command cases and the old guarantees
  (single line, ≤40 chars, dangerous suggestions filtered).

### Changed
- `npm test` now reports **132/132** tests.

## [0.1.3] - 2026-11-02

### Added
- Plan page「核对进度」button (P0-5): `POST /plan-completion/verify {sessionId}` runs one bounded,
  authenticated model call that compares the stored plan with recent evidence and returns
  `{assessment, mismatches[], suggestion}`. It never mutates the plan; results render in the plan
  panel as an assessment list plus next-step suggestion.
- New config `maxTokensVerify` (default 600); per-session in-flight guard, 8s abort deadline and
  parse-error fallbacks; `modelCalls:false` disables this route's model call.
- Tests: verify prompt/parser edge cases, authenticated route integration, and a client transport
  test for the new request helper.

### Changed
- `npm test` now reports **126/126** tests; production routes are `state`/`replan`/`warm`/`verify`.

## [0.1.2] - 2026-11-02

### Added
- Plan persistence: the plan plus the last suggestion are written per session to a local file
  store (`storageDir/plans/<base64url(sessionId)>.json`, atomic temp+rename). After a DSH restart,
  `GET /state` hydrates the persisted plan before responding, so the previous plan/version and
  suggestion are visible immediately (no model call needed).
- New config: `persistPlans` (default true) and `storageDir` (default `~/.dsh/plan-completion-data`,
  `~` expanded; `DSH_PLAN_COMPLETION_STORE_DIR` also honored). `persistPlans:false` returns to
  memory-only behavior.
- Persisted writes happen on every committed generation, user edit (`/steps`) and are deleted by
  `/reset`; warm backfill sees the persisted plan and reports `already` instead of re-generating.
- `store.getState()` / `put(plan, {cas, suggestion})` in both memory and file stores.
- 9 new tests: store persistence semantics (memory + file, corrupt record tolerance) and a
  restart-simulation integration suite (restore on mount, continue patching after restart, reset
  clears disk).

### Changed
- `npm test` now reports **120/120** tests.

### Security
- Persisted files contain conversation-derived plan/suggestion text (plain JSON, unencrypted, no
  automatic expiry); see `docs/security.md`. `persistPlans:false` disables disk persistence.

## [0.1.1] - 2026-11-02

### Fixed
- Preserve the shared plan/CAS store across plugin reloads, including upgrades from older in-memory state.
- Prevent canceled, superseded or disposed jobs from publishing stale plans; retain concurrent user edits and CAS winners.
- Clear Dock-owned state on unmount; reject responses from older requests or previous Dock lifetimes.
- Preserve legitimate resets and same-version suggestion updates; apply successful warm responses correctly.
- Reset also clears `handledTurns` so a reset session can regenerate on the same turn.
- Add a top-level route error guard and drop dead code (unused trigger key, no-op command disposer loop).
- Fix locale copy: suggestions are shown **above** the composer, not below.
- Sync delivery notes / phase-2 plan with the shipped warm-backfill and hero-entry work.
- Use a Windows-compatible test command and cover Ubuntu/Windows with Node 20/22 in CI.

### Security
- Require DSH Host/Origin and peer authentication on every HTTP endpoint; fail closed when admission is unavailable.
- Keep debug/diag disabled by default and remove arbitrary credentialed CORS.
- Remove conversation/URL/config/error text from diagnostics and runtime logs.
- Use only the host's current default model route (including experimental judging); add modelCalls: false for heuristic-only operation.
- Add production-host, client lifecycle and security/privacy regressions. See docs/security.md for remaining data-flow boundaries.

### Verified
- 111 unit tests pass; real-DSH canary: Electron-proxied client requests keep working under `connection.requestRejection`, direct unauthenticated requests return 401, debug routes absent in production config.

## [0.1.0] - 2026-11-02

### Added
- Implicit per-session plan with version watermark (`gen.rev`), steps, evidence and update reason.
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
- Published to npm as **`dsh-plan-completion@0.1.0`** (https://www.npmjs.com/package/dsh-plan-completion); the DSH profile still installs the repo as a `link:` bundle.
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



