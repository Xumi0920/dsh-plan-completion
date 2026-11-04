/**
 * dsh-plan-completion — Client (browser) half.
 *
 * Single browser artifact loaded through window.__ModuleLoader__:
 *   - `conversation.input.dock`    : full-width suggestion row + persistent plan entry, above the composer card
 *   - `shell.overlay`              : anchored plan popover
 *   - window keydown capture       : Tab / Esc / Alt+1..3 / Ctrl+Alt+P
 *
 * Constraints kept on purpose (see task-3): no JSX, only `require('react')`,
 * theme colours come from `--dsw-alias-*` tokens only, no host DOM writes,
 * no document.body manipulation.
 *
 * All places that depend on P0 contracts are isolated in one function each:
 *   getPlanState() / fetchPlanState()   -> plan state source (HTTP half)
 *   insertIntoComposer()                -> Tab fill (captureInsertion + insertText)
 *   replaceComposerDraft()              -> whole-draft writes (setDraft)
 *   isEditorFocused() / hasOpenComposerMenu() -> keyboard gate heuristics
 */

window.__ModuleLoader__.load({
  id: 'dsh-plan-completion',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // =====================================================================
    // Constants
    // =====================================================================
    const NS = 'plan-completion';
    // Full-width entries above the composer card (purpose: "Full-width entries above the composer card").
    const DOCK_SLOT = 'conversation.input.dock';
    const OVERLAY_SLOT = 'shell.overlay';
    const DOCK_ID = 'plan-completion-dock';
    const OVERLAY_ID = 'plan-completion-popover';
    const DOCK_ORDER = 30;
    const OVERLAY_ORDER = 50;
    const STATE_PATH = '/plan-completion/state';
    // Turn-end refresh attempts (ms). The Host may publish a fast heuristic
    // suggestion first and refine it with the model a few seconds later, so the
    // whole chain runs to 9s; planSignature de-dupes unchanged payloads.
    const TURN_RETRY_DELAYS = [300, 800, 1600, 3000, 6000, 9000];
    // Fallback cadence while the host does not expose a usable `running` value.
    const POLL_MS = 4000;
    // Watchdog cadence for a known-but-static `running`: no state request for this
    // long means suggestions may be stuck, so issue one `reason=stale-poll`.
    const STALE_POLL_MS = 15000;
    const STEP_STATUSES = ['todo', 'doing', 'blocked', 'done', 'dropped'];
    // Client build marker surfaced to the Host diagnostic route (proves which bundle is live).
    const CLIENT_BUILD = 'rag-progress-2026-11-04';
    // TEMP verification flag: auto-open the plan panel shortly after mount so a static
    // screenshot can be taken without synthetic clicks. Set back to false before release.
    const DEV_OPEN_POPOVER = false;
    // TEMP verification flag: render the hero fallback entry even when a dock exists.
    const DEV_HERO_PREVIEW = false;

    /**
     * Optional static plan state for local/preview development:
     * set `window.__DEV_PLAN__ = { ...plan }` in the page console and it wins
     * over the HTTP adapter. Kept out of any production path.
     */
    const DEV_PLAN = (typeof globalThis !== 'undefined' && globalThis.__DEV_PLAN__) || null;

    // =====================================================================
    // i18n (zh primary, en secondary). Registered through ctx.locale.
    // =====================================================================
    const MESSAGES = {
      zh: {
        'entry.aria': '打开会话计划面板',
        'entry.title': '会话计划',
        'entry.label': '计划',
        'suggest.noplan': '发送一条消息后自动生成计划与建议',
        'suggest.hint': 'Tab 填入',
        'suggest.alts': 'Alt+1..{count}',
        'suggest.dismiss': '关闭本次建议',
        'popover.title': '会话计划',
        'popover.intent': '目标',
        'popover.steps': '步骤',
        'popover.reason': '最近更新',
        'popover.suggestion': '下一步建议',
        'popover.fill': '填入草稿',
        'popover.sync': '同步给 Agent',
        'popover.close': '关闭',
        'popover.verify': '核对进度',
        'popover.empty': '暂无计划',
        'popover.updated': '更新于 {time}',
        'popover.stale': '计划可能已过期，将在下一回合重建',
        'status.active': '进行中',
        'status.completed': '已完成',
        'status.archived': '已归档',
        'step.todo': '待办',
        'step.doing': '进行中',
        'step.blocked': '需处理',
        'step.done': '已完成',
        'step.dropped': '已放弃',
        'sync.prefix': '请按当前会话计划继续推进。',
        'sync.intent': '目标：{value}。',
        'sync.done': '已完成：{value}。',
        'sync.doing': '进行中：{value}。',
        'sync.todo': '待办：{value}。',
        'sync.reason': '最近更新：{value}。',
        'sync.next': '下一步建议：{value}。',
        'sync.fallback': '请先确认当前进度，再继续推进。',
        'verify.loading': '正在对照计划与实际进度…',
        'verify.assessment': '核对结论',
        'verify.mismatch': '差异',
        'verify.clean': '未发现明显差异。',
        'verify.next': '建议：{value}',
        'verify.failed': '核对失败：{value}',
        'verify.no-session': '当前还没有可用会话',
        'settings.title': '计划补全',
        'settings.model': '模型选择',
        'settings.policy.default': '跟随宿主默认',
        'settings.policy.fixed': '固定模型',
        'settings.policy.auto': '自动（优先非推理）',
        'settings.provider': 'Provider',
        'settings.modelId': 'Model ID',
        'settings.modelCalls': '允许本插件调用模型',
        'settings.modelDesc': '选择插件生成计划与建议时使用的模型来源',
        'settings.providerDesc': '固定使用的 provider',
        'settings.callsDesc': '关闭后插件只使用启发式，不向模型发送内容',
        'settings.defaultRoute': '宿主默认：{value}',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.saved': '已保存',
        'settings.loading': '加载中…',
        'settings.error': '设置加载失败',
        'settings.saveError': '保存失败'
      },
      en: {
        'entry.aria': 'Open the session plan panel',
        'entry.title': 'Session plan',
        'entry.label': 'Plan',
        'suggest.noplan': 'Send a message to generate a plan and suggestion',
        'suggest.hint': 'Tab to fill',
        'suggest.alts': 'Alt+1..{count}',
        'suggest.dismiss': 'Dismiss this suggestion',
        'popover.title': 'Session plan',
        'popover.intent': 'Intent',
        'popover.steps': 'Steps',
        'popover.reason': 'Latest update',
        'popover.suggestion': 'Next suggestion',
        'popover.fill': 'Fill draft',
        'popover.sync': 'Sync to Agent',
        'popover.close': 'Close',
        'popover.verify': 'Verify progress',
        'popover.empty': 'No plan yet',
        'popover.updated': 'Updated {time}',
        'popover.stale': 'The plan may be stale and will be rebuilt next turn',
        'status.active': 'Active',
        'status.completed': 'Completed',
        'status.archived': 'Archived',
        'step.todo': 'Todo',
        'step.doing': 'In progress',
        'step.blocked': 'Needs attention',
        'step.done': 'Done',
        'step.dropped': 'Dropped',
        'sync.prefix': 'Please continue based on the current session plan.',
        'sync.intent': 'Intent: {value}.',
        'sync.done': 'Done: {value}.',
        'sync.doing': 'In progress: {value}.',
        'sync.todo': 'Pending: {value}.',
        'sync.reason': 'Latest update: {value}.',
        'sync.next': 'Next suggestion: {value}.',
        'sync.fallback': 'Please confirm the current progress before continuing.',
        'verify.loading': 'Comparing the plan against the latest evidence…',
        'verify.assessment': 'Assessment',
        'verify.mismatch': 'Mismatch',
        'verify.clean': 'No obvious mismatches found.',
        'verify.next': 'Next: {value}',
        'verify.failed': 'Verification failed: {value}',
        'verify.no-session': 'No session available yet',
        'settings.title': 'Plan Completion',
        'settings.model': 'Model selection',
        'settings.policy.default': 'Follow host default',
        'settings.policy.fixed': 'Fixed model',
        'settings.policy.auto': 'Auto (prefer non-reasoning)',
        'settings.provider': 'Provider',
        'settings.modelId': 'Model ID',
        'settings.modelCalls': 'Allow this plugin to call models',
        'settings.modelDesc': 'Model source used for plan and suggestion generation',
        'settings.providerDesc': 'Provider used by the fixed policy',
        'settings.callsDesc': 'When off, the plugin only uses heuristics and sends nothing',
        'settings.defaultRoute': 'Host default: {value}',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.saved': 'Saved',
        'settings.loading': 'Loading…',
        'settings.error': 'Failed to load settings',
        'settings.saveError': 'Save failed'
      }
    };

    let hostT = null;
    // Test-only hook: the Host's /plan-completion/theme route puts `debugTheme` into the
    // state payload so an automated dark/light check can switch the app theme.
    let pluginThemeService = null;
    let appliedDebugTheme = null;

    function reportTheme(phase, detail) {
      try {
        fetch('/plan-completion/diag', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ phase: phase, build: CLIENT_BUILD }, detail || {})),
        }).catch(function () {});
      } catch (error) {
        /* ignore */
      }
    }

    function applyDebugTheme(mode) {
      if (!mode || appliedDebugTheme === mode) return;
      if (!pluginThemeService) {
        reportTheme('theme-error', { error: 'no-theme-service', mode: mode });
        return;
      }
      try {
        pluginThemeService.setTheme(mode);
        appliedDebugTheme = mode;
        reportTheme('theme-applied', { mode: mode });
      } catch (error) {
        reportTheme('theme-error', { error: String(error), mode: mode });
      }
    }

    function detectLang() {
      try {
        if (typeof navigator === 'undefined' || !navigator) return 'zh';
        const value = navigator.language || (navigator.languages && navigator.languages[0]);
        if (typeof value === 'string' && /^en/i.test(value)) return 'en';
      } catch (error) {
        /* ignore */
      }
      return 'zh';
    }

    const FALLBACK_LANG = detectLang();

    function fallbackT(key, vars) {
      const dict = MESSAGES[FALLBACK_LANG] || MESSAGES.zh;
      let text = dict[key];
      if (typeof text !== 'string') text = MESSAGES.zh[key];
      if (typeof text !== 'string') text = key;
      if (vars && typeof vars === 'object') {
        text = text.replace(/\{(\w+)\}/g, function replace(match, name) {
          return vars[name] === undefined ? match : String(vars[name]);
        });
      }
      return text;
    }

    function makeT(props) {
      const propT = props && typeof props.t === 'function' ? props.t : null;
      return function translate(key, vars) {
        const bound = propT || hostT;
        if (bound) {
          try {
            const value = bound(key, vars);
            if (typeof value === 'string' && value !== key) return value;
          } catch (error) {
            /* fall through to the local dictionary */
          }
        }
        return fallbackT(key, vars);
      };
    }

    // =====================================================================
    // Styles — theme tokens only (host light/dark switching is automatic).
    // =====================================================================
    const DOCK_CSS = [
      // Fixed-height full-width row directly above the composer card: a floating
      // suggestion pill on the left and the persistent plan pill on the right.
      // The row keeps its height without a suggestion so the composer never jumps.
      '.dpc-root{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:36px;box-sizing:border-box;padding:2px 12px 8px 12px;pointer-events:auto;font-size:12px;line-height:18px}',
      '.dpc-suggest-placeholder{flex:0 0 0;width:0;min-width:0;height:0;overflow:hidden}',
      '.dpc-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-width:0;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:100%;box-shadow:0 2px 10px rgba(0,0,0,.08)}',
      '.dpc-suggest-pill{flex:0 1 auto;min-width:0;overflow:hidden}',
      '.dpc-suggest-pill:hover{background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))}',
      '.dpc-suggest-icon{flex:none;color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary));font-size:12px}',
      '.dpc-suggest-hint{flex:none;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dpc-suggest-sep{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.dpc-suggest-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.dpc-suggest-alts{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}',
      '.dpc-dismiss{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:1px 4px;border-radius:999px;cursor:pointer}',
      '.dpc-dismiss:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))}',
      '.dpc-entry{flex:none;margin-left:0;cursor:pointer;opacity:.85;transition:opacity .12s ease}',
      '.dpc-entry:hover{background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));opacity:1}',
      '.dpc-entry-strong{opacity:1}',
      '.dpc-entry[aria-expanded="true"]{opacity:1}',
      '.dpc-entry-icon{color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary));font-size:11px}',
      '.dpc-entry-version{color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}',
      // Always-on state: when the current session has no plan yet (new / cleared
      // conversation), the row still renders with a hint so the bar never vanishes.
      '.dpc-hint-pill{flex:0 1 auto;min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);border-style:dashed;box-shadow:none;background:transparent}',
      '.dpc-hint-pill .dpc-suggest-text{color:var(--dsw-alias-label-tertiary)}',
      '.dpc-entry-label{color:var(--dsw-alias-label-secondary);white-space:nowrap}'
    ].join('\n');

    const POPOVER_CSS = [
      '.dpc-popover{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dpc-pop-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dpc-pop-title{flex:none;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dpc-pop-ver{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dpc-pop-chip{flex:none;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dpc-pop-chip[data-status="completed"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.dpc-pop-chip[data-status="active"]{color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary));border-color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))}',
      '.dpc-pop-chip[data-status="archived"]{color:var(--dsw-alias-label-tertiary)}',
      '.dpc-pop-close{margin-left:auto;flex:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;padding:0 4px;border-radius:4px;cursor:pointer}',
      '.dpc-pop-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))}',
      '.dpc-section{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dpc-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dpc-text{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}',
      '.dpc-stale{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}',
      '.dpc-steps{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
      '.dpc-step{display:flex;align-items:flex-start;gap:8px;min-width:0;font-size:13px;line-height:20px}',
      '.dpc-glyph{flex:none;width:16px;text-align:center;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.dpc-step[data-status="done"] .dpc-glyph{color:var(--dsw-alias-state-success-primary)}',
      '.dpc-step[data-status="doing"] .dpc-glyph{color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))}',
      '.dpc-step-main{display:flex;flex-direction:column;min-width:0;flex:1}',
      '.dpc-step-title{color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.dpc-step[data-status="dropped"] .dpc-step-title{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}',
      '.dpc-evidence{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
      '.dpc-suggest-line{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.dpc-updated{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dpc-actions{display:flex;flex-wrap:wrap;gap:8px;padding-top:4px}',
      '.dpc-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px;cursor:pointer}',
      '.dpc-btn:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.dpc-btn:disabled{opacity:.45;cursor:default}',
      '.dpc-btn[data-primary="true"]{border-color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary));color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))}',
      '.dpc-empty{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      // ── v2 skin: card-style plan panel matching the composer card (radius/shadow/type)
      '.dpc-popover{gap:0;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1));box-shadow:0 12px 32px rgba(0,0,0,.14), 0 2px 8px rgba(0,0,0,.06);overflow:hidden;max-height:min(70vh, 560px)}',
      '.dpc-pop-head{flex:none;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);gap:8px}',
      '.dpc-pop-title{font-size:14px;font-weight:600;line-height:22px}',
      '.dpc-pop-ver{padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;font-variant-numeric:tabular-nums}',
      '.dpc-pop-chip{padding:0 8px;border-radius:999px;font-size:11px;line-height:20px;background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));border:0}',
      '.dpc-pop-chip[data-status="completed"]{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-secondary, var(--dsw-alias-bg-layer-2))}',
      '.dpc-pop-chip[data-status="active"]{color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))}',
      '.dpc-pop-close{width:24px;height:24px;line-height:24px;padding:0;border-radius:999px;text-align:center}',
      '.dpc-pop-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:12px 14px}',
      '.dpc-pop-intent{font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary)}',
      '.dpc-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}',
      '.dpc-steps{gap:2px}',
      '.dpc-step{padding:6px 8px;border-radius:10px;gap:10px;transition:background .12s ease}',
      '.dpc-step:hover{background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))}',
      '.dpc-glyph{width:18px;font-size:12px}',
      '.dpc-step-title{font-size:13px;line-height:20px}',
      '.dpc-evidence{margin-top:1px}',
      '.dpc-reason{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));white-space:pre-wrap;word-break:break-word}',
      '.dpc-suggest-card{padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))}',
      '.dpc-suggest-card .dpc-suggest-line{font-size:13px;line-height:20px}',
      '.dpc-pop-foot{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dpc-pop-foot .dpc-updated{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dpc-actions{padding-top:0;gap:8px;flex:none}',
      '.dpc-btn{border-radius:999px;padding:5px 12px;font-size:12px;line-height:18px}',
      '.dpc-verify-card{gap:6px}',
      '.dpc-verify-loading{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dpc-verify-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary));word-break:break-word}',
      '.dpc-verify-assessment{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}',
      '.dpc-verify-list{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:4px}',
      '.dpc-verify-item{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
      '.dpc-verify-clean{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dpc-verify-next{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.dpc-empty{padding:14px;font-size:13px}'
    ].join('\n');

    // Hero fallback entry (rendered from shell.overlay when no session-bound dock exists).
    const HERO_CSS = [
      '.dpc-hero-entry{position:fixed;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;box-shadow:0 2px 10px rgba(0,0,0,.08);cursor:pointer;z-index:40}',
      '.dpc-hero-entry:hover{background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}',
      '.dpc-hero-entry .dpc-entry-icon{color:var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary));font-size:11px}'
    ].join('\n');

    // =====================================================================
    // Small generic helpers
    // =====================================================================
    function preventDefault(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    }

    function stopPropagation(event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    }

    function listJoin(items) {
      return items.join(FALLBACK_LANG === 'en' ? ', ' : '、');
    }

    function truncate(text, limit) {
      if (typeof text !== 'string') return '';
      if (text.length <= limit) return text;
      return text.slice(0, Math.max(0, limit - 1)) + '…';
    }

    function formatTime(timestamp) {
      try {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return '';
        return date.toLocaleTimeString(FALLBACK_LANG === 'en' ? 'en-US' : 'zh-CN', {
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch (error) {
        return '';
      }
    }

    // =====================================================================
    // Plan state normalization adapters (P0 / cross-half boundary)
    // =====================================================================
    function normalizeEvidence(raw) {
      const out = [];
      const list = Array.isArray(raw) ? raw : [];
      for (let index = 0; index < list.length && out.length < 6; index += 1) {
        const value = list[index];
        if (typeof value === 'string' && value.trim() !== '') out.push(truncate(value.trim(), 160));
      }
      return out;
    }

    function normalizeSteps(raw) {
      const out = [];
      const list = Array.isArray(raw) ? raw : [];
      for (let index = 0; index < list.length; index += 1) {
        const step = list[index];
        if (!step || typeof step !== 'object') continue;
        const title = typeof step.title === 'string' ? step.title.trim() : '';
        if (title === '') continue;
        out.push({
          id: typeof step.id === 'string' && step.id !== '' ? step.id : 's' + (index + 1),
          title: truncate(title, 300),
          status: STEP_STATUSES.indexOf(step.status) >= 0 ? step.status : 'todo',
          lifecycle: typeof step.lifecycle === 'string' ? step.lifecycle : '',
          evidence: normalizeEvidence(step.evidence)
        });
      }
      return out;
    }

    function normalizeSuggestion(raw) {
      if (raw === null || raw === undefined) return null;
      if (typeof raw === 'string') {
        const text = raw.trim();
        return text === '' ? null : { text: truncate(text, 300), alternates: [] };
      }
      if (typeof raw !== 'object') return null;
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (text === '') return null;
      const alternates = [];
      const pushAlternate = function pushAlternate(value) {
        if (typeof value !== 'string') return;
        const alt = value.trim();
        if (alt === '' || alt === text || alternates.length >= 2) return;
        if (alternates.indexOf(alt) >= 0) return;
        alternates.push(truncate(alt, 300));
      };
      if (Array.isArray(raw.alternates)) {
        for (let index = 0; index < raw.alternates.length; index += 1) pushAlternate(raw.alternates[index]);
      } else {
        pushAlternate(raw.text2);
        pushAlternate(raw.text3);
      }
      return { text: truncate(text, 300), alternates: alternates };
    }

    function normalizeVersion(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const gen = Number(raw.gen);
      const rev = Number(raw.rev);
      if (!isFinite(gen) || !isFinite(rev)) return null;
      return { gen: gen, rev: rev };
    }

    /** Tolerate both the Host wire shape and a `{ plan: ... }` envelope. */
    function normalizePlan(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const nested = raw.plan && typeof raw.plan === 'object' ? raw.plan : null;
      const doc = normalizeVersion(raw.version) ? raw : nested;
      if (!doc) return null;
      const version = normalizeVersion(doc.version);
      if (!version) return null;
      // Fields may arrive on the flat object or inside the nested `plan` object.
      const pick = function pick(field) {
        if (doc[field] !== undefined && doc[field] !== null) return doc[field];
        return raw[field];
      };
      const status = pick('status');
      const updatedAt = pick('updatedAt');
      const intent = pick('intent');
      const reason = pick('reason');
      return {
        sessionId: typeof pick('sessionId') === 'string' ? pick('sessionId') : null,
        version: version,
        status: status === 'completed' || status === 'archived' ? status : 'active',
        intent: typeof intent === 'string' ? truncate(intent, 400) : '',
        constraints: Array.isArray(pick('constraints')) ? pick('constraints').filter(v => typeof v === 'string').slice(0, 6) : [],
        retrieval: pick('retrieval') ?? null,
        steps: normalizeSteps(pick('steps')),
        updatedAt: typeof updatedAt === 'number' && isFinite(updatedAt) ? updatedAt : null,
        reason: typeof reason === 'string' ? truncate(reason, 300) : '',
        suggestion: normalizeSuggestion(pick('suggestion')),
        stale: pick('stale') === true
      };
    }

    function planSignature(plan) {
      if (!plan) return null;
      try {
        return JSON.stringify([
          plan.version.gen,
          plan.version.rev,
          plan.status,
          plan.intent,
          plan.updatedAt,
          plan.reason,
          plan.constraints,
          plan.retrieval,
          plan.stale,
          plan.steps.map(function stepKey(step) {
            return [step.id, step.title, step.status, step.lifecycle, step.evidence];
          }),
          plan.suggestion ? [plan.suggestion.text, plan.suggestion.alternates] : null
        ]);
      } catch (error) {
        return null;
      }
    }

    function getSuggestion(plan) {
      return plan && plan.suggestion ? plan.suggestion : null;
    }

    function suggestionKey(plan, suggestion) {
      const version = plan && plan.version ? plan.version.gen + '.' + plan.version.rev : '';
      return version + ':' + (suggestion ? suggestion.text : '');
    }

    function versionLabel(plan) {
      return plan && plan.version ? 'v' + plan.version.gen + '.' + plan.version.rev : '';
    }

    function planFillText(plan) {
      if (!plan) return '';
      const suggestion = getSuggestion(plan);
      if (suggestion) return suggestion.text;
      const doing = plan.steps.filter(function isDoing(step) {
        return step.status === 'doing';
      });
      const todo = plan.steps.filter(function isTodo(step) {
        return step.status === 'todo';
      });
      const next = doing[0] || todo[0];
      return next ? next.title : '';
    }

    /** "Sync to Agent": render the plan as a natural-language instruction (fills draft only). */
    function buildSyncPrompt(plan) {
      if (!plan) return '';
      const t = makeT(null);
      const groups = { done: [], doing: [], todo: [] };
      for (let index = 0; index < plan.steps.length; index += 1) {
        const step = plan.steps[index];
        if (step.status === 'done') groups.done.push(step.title);
        else if (step.status === 'doing') groups.doing.push(step.title);
        else if (step.status === 'todo') groups.todo.push(step.title);
      }
      const parts = [t('sync.prefix')];
      if (plan.intent) parts.push(t('sync.intent', { value: plan.intent }));
      if (groups.done.length > 0) parts.push(t('sync.done', { value: listJoin(groups.done) }));
      if (groups.doing.length > 0) parts.push(t('sync.doing', { value: listJoin(groups.doing) }));
      if (groups.todo.length > 0) parts.push(t('sync.todo', { value: listJoin(groups.todo) }));
      if (plan.reason) parts.push(t('sync.reason', { value: plan.reason }));
      const suggestion = getSuggestion(plan);
      if (suggestion) parts.push(t('sync.next', { value: suggestion.text }));
      if (parts.length === 1) parts.push(t('sync.fallback'));
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    // =====================================================================
    // Module store shared by dock, overlay and the global keyboard handler
    // =====================================================================
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: function get() {
          return state;
        },
        set: function set(patch) {
          let changed = false;
          for (const key in patch) {
            if (state[key] !== patch[key]) {
              changed = true;
              break;
            }
          }
          if (!changed) return;
          state = Object.assign({}, state, patch);
          const snapshot = [];
          listeners.forEach(function collect(listener) {
            snapshot.push(listener);
          });
          for (let index = 0; index < snapshot.length; index += 1) {
            try {
              snapshot[index]();
            } catch (error) {
              /* a broken subscriber must not break the keyboard path */
            }
          }
        },
        subscribe: function subscribe(listener) {
          listeners.add(listener);
          return function unsubscribe() {
            listeners.delete(listener);
          };
        }
      };
    }

    const store = createStore({
      plan: null,
      planSig: null,
      sessionId: undefined,
      overlayOpen: false,
      anchorRect: null,
      dismissedKey: null,
      suggestionVisible: false,
      inputActions: null,
      draftText: '',
      inputEmpty: true,
      dockOwner: null,
      dockRoot: null,
      triggerEl: null,
      popoverRoot: null
    });

    function useStoreSelector(selector) {
      const [value, setValue] = React.useState(function initial() {
        return selector(store.get());
      });
      React.useEffect(function subscribeToStore() {
        const sync = function sync() {
          setValue(function compare(previous) {
            const next = selector(store.get());
            return Object.is(previous, next) ? previous : next;
          });
        };
        sync();
        return store.subscribe(sync);
      }, [selector]);
      return value;
    }

    const selectPlan = function selectPlan(state) {
      return state.plan;
    };
    const selectDismissedKey = function selectDismissedKey(state) {
      return state.dismissedKey;
    };
    const selectOverlayOpen = function selectOverlayOpen(state) {
      return state.overlayOpen;
    };
    const selectAll = function selectAll(state) {
      return state;
    };

    // =====================================================================
    // Plan state source (P0 boundary #1) — same-origin HTTP route.
    // =====================================================================
    let planRefresher = null;
    let lastPlanSessionId;
    // Timestamp of the last state request, shared by every trigger path; drives the
    // `stale-poll` watchdog. Updated whenever a request is actually issued.
    let lastStateRequestAt = 0;
    // All readers (including warm backfill) share an order and a Dock lifecycle.
    // Versions alone are insufficient: a reset may legitimately start at v0.0,
    // and a model can refine the suggestion without changing the plan version.
    let planRequestSequence = 0;
    let planRequestEpoch = 0;
    let lastAppliedPlanRequest = 0;

    function beginPlanRequest(sessionId) {
      return { id: ++planRequestSequence, epoch: planRequestEpoch, sessionId: sessionId, owner: store.get().dockOwner };
    }

    function isCurrentPlanRequest(sessionId, request) {
      const current = store.get();
      return !!request && !!request.owner && request.owner === current.dockOwner &&
        request.epoch === planRequestEpoch && request.sessionId === sessionId &&
        current.sessionId === sessionId && request.id >= lastAppliedPlanRequest;
    }

    function releaseDock(owner) {
      if (store.get().dockOwner !== owner) return;
      planRequestEpoch += 1;
      lastAppliedPlanRequest = 0;
      planRefresher = null;
      store.set({
        dockOwner: null, sessionId: undefined, plan: null, planSig: null,
        inputActions: null, dockRoot: null, draftText: '', inputEmpty: true,
        suggestionVisible: false, dismissedKey: null, overlayOpen: false,
        anchorRect: null, triggerEl: null, popoverRoot: null
      });
    }

    /**
     * Resolve `{ ok, plan }`; `ok` false means the route is absent or the payload is unusable.
     * `reason` is diagnostic only (`mount` / `session` / `turn-end` / `poll` /
     * `stale-poll` / `popover`) and `running` mirrors the client-side running
     * detection (`true` / `false` / `undefined`). Both are forwarded as query
     * parameters so the Host log can attribute every request and reveal what
     * `useSession` returned.
     */
    function fetchPlanState(sessionId, reason, running) {
      const requestToken = beginPlanRequest(sessionId);
      if (DEV_PLAN) {
        return Promise.resolve({ ok: true, plan: normalizePlan(DEV_PLAN), request: requestToken });
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return Promise.resolve({ ok: false, plan: null });
      }
      let request = null;
      const requestReason = typeof reason === 'string' && reason !== '' ? reason : 'mount';
      const runningText = running === true || running === false ? String(running) : 'undefined';
      try {
        if (typeof fetch !== 'function') return Promise.resolve({ ok: false, plan: null });
        const url =
          STATE_PATH +
          '?sessionId=' +
          encodeURIComponent(sessionId) +
          '&reason=' +
          encodeURIComponent(requestReason) +
          '&running=' +
          encodeURIComponent(runningText);
        lastStateRequestAt = Date.now();
        request = fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' }
        });
      } catch (error) {
        return Promise.resolve({ ok: false, plan: null });
      }
      return Promise.resolve(request)
        .then(function readResponse(response) {
          if (!response || response.ok !== true) return { ok: false, plan: null };
          return Promise.resolve(response.json()).then(
            function parsed(json) {
              return { ok: true, plan: normalizePlan(json), request: requestToken,
                debugTheme: json && typeof json === 'object' ? json.debugTheme : null };
            },
            function badJson() {
              return { ok: false, plan: null };
            }
          );
        })
        .catch(function networkError() {
          return { ok: false, plan: null };
        });
    }

    /**
     * P0-1 warm backfill: ask the Host to build a plan for a session it has never observed
     * (old sessions / plugin just enabled). Resolves with the Host's JSON or null.
     */
    function warmPlanState(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve(null);
      const requestToken = beginPlanRequest(sessionId);
      let request = null;
      try {
        request = fetch('/plan-completion/warm', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId })
        });
      } catch (error) {
        return Promise.resolve(null);
      }
      return Promise.resolve(request)
        .then(function readResponse(response) {
          if (!response || response.ok !== true) return null;
          return Promise.resolve(response.json()).then(
            function parsed(json) {
              return json && typeof json === 'object' ? { ok: json.ok === true, json: json, request: requestToken } : null;
            },
            function badJson() {
              return null;
            }
          );
        })
        .catch(function networkError() {
          return null;
        });
    }

    /**
     * P0-5「核对进度」：让 Host 用一次受控模型调用对照计划与实际证据。
     * 返回 Host 的 JSON（{ok, assessment, mismatches, suggestion}）或 null。
     */
    function requestVerify(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve(null);
      let request = null;
      try {
        request = fetch('/plan-completion/verify', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId })
        });
      } catch (error) {
        return Promise.resolve(null);
      }
      return Promise.resolve(request)
        .then(function readResponse(response) {
          if (!response || response.ok !== true) return null;
          return Promise.resolve(response.json()).then(
            function parsed(json) {
              return json && typeof json === 'object' ? json : null;
            },
            function badJson() {
              return null;
            }
          );
        })
        .catch(function networkError() {
          return null;
        });
    }

    /**
     * Host settings used by the settings page (model policy + modelCalls).
     */
    function fetchSettings(provider) {
      try {
        const query = typeof provider === 'string' && provider ? '?provider=' + encodeURIComponent(provider) : '';
        return Promise.resolve(fetch('/plan-completion/settings' + query, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' }
        }))
          .then(function readResponse(response) {
            return response && response.ok === true ? Promise.resolve(response.json()) : null;
          })
          .then(function parsed(json) {
            return json && typeof json === 'object' ? json : null;
          })
          .catch(function networkError() {
            return null;
          });
      } catch (error) {
        return Promise.resolve(null);
      }
    }

    function saveSettings(payload) {
      try {
        return Promise.resolve(fetch('/plan-completion/settings', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {})
        }))
          .then(function readResponse(response) {
            return response && response.ok === true ? Promise.resolve(response.json()) : null;
          })
          .then(function parsed(json) {
            return json && typeof json === 'object' ? json : null;
          })
          .catch(function networkError() {
            return null;
          });
      } catch (error) {
        return Promise.resolve(null);
      }
    }

    /**
     * P0 boundary: read the current plan state. Keep this signature stable —
     * swapping the transport (HTTP route / projection / wire view) only changes
     * this function and fetchPlanState.
     */
    function getPlanState(sessionId, reason, running) {
      return fetchPlanState(sessionId, reason, running).then(function selectPlan(result) {
        return result.plan;
      });
    }

    function applyPlanResult(sessionId, plan, request) {
      if (!plan || !isCurrentPlanRequest(sessionId, request)) return false;
      if (plan.sessionId && plan.sessionId !== sessionId) return false;
      const current = store.get();
      lastAppliedPlanRequest = request.id;
      const signature = planSignature(plan);
      if (current.plan && current.planSig === signature) return true;
      store.set({ plan: plan, planSig: signature });
      return true;
    }

    /**
     * Server said "no plan for this session" (unknown / cleared / reset). Drop the cached plan
     * so the bar falls back to its always-on state instead of showing a stale suggestion.
     */
    function clearPlanResult(sessionId, request) {
      if (!isCurrentPlanRequest(sessionId, request)) return false;
      const current = store.get();
      lastAppliedPlanRequest = request.id;
      if (!current.plan) return true;
      store.set({ plan: null, planSig: null, dismissedKey: null, overlayOpen: false });
      return true;
    }

    function handlePlanFetch(sessionId, result) {
      if (!result || result.ok !== true) return false;
      const applied = result.plan
        ? applyPlanResult(sessionId, result.plan, result.request)
        : clearPlanResult(sessionId, result.request);
      if (applied && result.debugTheme) applyDebugTheme(result.debugTheme);
      return applied;
    }

    // =====================================================================
    // Composer write adapters (P0 boundary #2)
    // =====================================================================
    /** Tab fill: insert at the caret. */
    function insertIntoComposer(inputActions, text) {
      if (!inputActions || typeof text !== 'string' || text === '') return false;
      try {
        if (typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
          const span = inputActions.captureInsertion();
          const result = inputActions.insertText(text, span);
          return result !== false;
        }
        if (typeof inputActions.insertText === 'function') {
          const result = inputActions.insertText(text);
          return result !== false;
        }
        if (typeof inputActions.setDraft === 'function') {
          inputActions.setDraft(text);
          return true;
        }
      } catch (error) {
        return false;
      }
      return false;
    }

    /** Whole-draft replace: used by popover [Fill draft] / [Sync to Agent]. */
    function replaceComposerDraft(inputActions, text) {
      if (!inputActions || typeof text !== 'string' || text === '') return false;
      try {
        if (typeof inputActions.setDraft === 'function') {
          inputActions.setDraft(text);
          return true;
        }
        return insertIntoComposer(inputActions, text);
      } catch (error) {
        return false;
      }
    }

    // =====================================================================
    // Focus / menus (P0 boundary #3): conservative keyboard gating
    // =====================================================================
    function isEditableElement(element) {
      if (!element || typeof element !== 'object') return false;
      const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
      if (tag === 'textarea' || tag === 'input') return true;
      if (element.isContentEditable === true) return true;
      try {
        const attr = typeof element.getAttribute === 'function' ? element.getAttribute('contenteditable') : null;
        if (attr === '' || attr === 'true' || attr === 'plaintext-only') return true;
      } catch (error) {
        /* ignore */
      }
      return false;
    }

    /** Nearest ancestor of our dock that already owns the composer card. */
    function composerRootFromDock(dockEl) {
      if (!dockEl || !dockEl.parentElement) return null;
      let node = dockEl.parentElement;
      for (let depth = 0; depth < 6 && node && node !== document.body; depth += 1) {
        try {
          if (typeof node.querySelector === 'function' && node.querySelector('[data-composer-card]') !== null) return node;
        } catch (error) {
          return null;
        }
        node = node.parentElement;
      }
      return null;
    }

    /**
     * True only when the focused element is the composer editor:
     * editable AND (inside a composer card OR inside an ancestor of our dock OR
     * carries a composer-ish class). Never true for the suggestion bar itself.
     */
    function isEditorFocused(dockEl) {
      try {
        const active = document.activeElement;
        if (!active || active === document.body) return false;
        if (!isEditableElement(active)) return false;
        if (dockEl && typeof dockEl.contains === 'function' && dockEl.contains(active)) return false;
        // Evidence 1: host marks the composer card.
        if (typeof active.closest === 'function' && active.closest('[data-composer-card]') !== null) return true;
        // Evidence 2: focused editor shares an ancestor with our dock.
        if (dockEl && typeof dockEl.parentElement === 'object' && dockEl.parentElement) {
          let node = dockEl.parentElement;
          for (let depth = 0; depth < 5 && node && node !== document.body; depth += 1) {
            if (typeof node.contains === 'function' && node.contains(active)) return true;
            node = node.parentElement;
          }
        }
        // Evidence 3: class-name fallback.
        let node = active;
        for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
          const className = typeof node.className === 'string' ? node.className : '';
          if (/composer/i.test(className)) return true;
          node = node.parentElement;
        }
        return false;
      } catch (error) {
        return false;
      }
    }

    /**
     * Conservative "a slash/@/command menu is up" check. Empty drafts cannot
     * open slash/@ menus, so this guards the programmatic "+" command menu.
     */
    function hasOpenComposerMenu(dockEl) {
      try {
        const root = composerRootFromDock(dockEl);
        if (!root || typeof root.querySelectorAll !== 'function') return false;
        const nodes = root.querySelectorAll(
          '[data-composer-overlay] [role="listbox"], [data-composer-overlay] [role="menu"], [data-composer-overlay] [role="dialog"]'
        );
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index];
          if (node.getClientRects && node.getClientRects().length > 0) return true;
        }
        return false;
      } catch (error) {
        return false;
      }
    }

    function hasTriggerText(text) {
      const value = typeof text === 'string' ? text.replace(/^\s+/, '') : '';
      return value.startsWith('/') || value.startsWith('@');
    }

    function isAnyModalOpen() {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false;
        const nodes = document.querySelectorAll('[aria-modal="true"], dialog[open]');
        for (let index = 0; index < nodes.length; index += 1) {
          const node = nodes[index];
          if (node.getClientRects && node.getClientRects().length > 0) return true;
        }
        return false;
      } catch (error) {
        return false;
      }
    }

    // =====================================================================
    // Overlay / suggestion control
    // =====================================================================
    function openOverlay(triggerEl) {
      const current = store.get();
      const anchorEl = triggerEl || current.triggerEl || current.dockRoot;
      let rect = null;
      try {
        if (anchorEl && typeof anchorEl.getBoundingClientRect === 'function') {
          const box = anchorEl.getBoundingClientRect();
          rect = { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
        }
      } catch (error) {
        rect = null;
      }
      store.set({ overlayOpen: true, triggerEl: anchorEl || null, anchorRect: rect });
    }

    function closeOverlay() {
      store.set({ overlayOpen: false });
    }

    function toggleOverlay(triggerEl) {
      if (store.get().overlayOpen) {
        closeOverlay();
        return;
      }
      openOverlay(triggerEl);
    }

    function dismissSuggestion() {
      const current = store.get();
      const suggestion = getSuggestion(current.plan);
      if (!suggestion) return;
      store.set({ dismissedKey: suggestionKey(current.plan, suggestion) });
    }

    function suggestionTexts(plan) {
      const suggestion = getSuggestion(plan);
      if (!suggestion) return [];
      return [suggestion.text].concat(suggestion.alternates || []);
    }

    // =====================================================================
    // Global keyboard handler (window capture, installed through ctx.effect)
    // =====================================================================
    function canTabFill(state) {
      if (!state.dockOwner || !state.dockRoot || !state.inputActions) return false;
      if (state.dockRoot.isConnected === false) return false;
      if (!state.suggestionVisible) return false;
      const suggestion = getSuggestion(state.plan);
      if (!suggestion) return false;
      if (state.dismissedKey === suggestionKey(state.plan, suggestion)) return false;
      if (!state.inputEmpty) return false;
      if (typeof state.draftText === 'string' && state.draftText.trim() !== '') return false;
      if (hasTriggerText(state.draftText)) return false;
      if (!isEditorFocused(state.dockRoot)) return false;
      if (hasOpenComposerMenu(state.dockRoot)) return false;
      return true;
    }

    function handleKeyDown(event) {
      const e = event;
      if (!e || e.defaultPrevented) return;
      if (e.isComposing || e.keyCode === 229) return;
      const key = typeof e.key === 'string' ? e.key : '';
      const state = store.get();

      // Ctrl+Alt+P — toggle the plan popover (fixed global shortcut).
      if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && (key === 'p' || key === 'P')) {
        if (isAnyModalOpen()) return;
        preventDefault(e);
        stopPropagation(e);
        toggleOverlay(null);
        return;
      }

      // Tab — fill the current suggestion.
      if (key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
        if (!canTabFill(state)) return;
        const suggestion = getSuggestion(state.plan);
        if (!suggestion) return;
        preventDefault(e);
        stopPropagation(e);
        insertIntoComposer(state.inputActions, suggestion.text);
        return;
      }

      // Esc — close the popover, else dismiss the visible suggestion.
      if (key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (state.overlayOpen) {
          if (isAnyModalOpen()) return;
          preventDefault(e);
          stopPropagation(e);
          closeOverlay();
          return;
        }
        if (state.suggestionVisible && isEditorFocused(state.dockRoot)) {
          preventDefault(e);
          stopPropagation(e);
          dismissSuggestion();
          return;
        }
        return;
      }

      // Alt+1..3 — pick the primary suggestion or one of its alternates.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[1-3]$/.test(key)) {
        if (!state.suggestionVisible) return;
        if (state.dismissedKey === suggestionKey(state.plan, getSuggestion(state.plan))) return;
        const texts = suggestionTexts(state.plan);
        const text = texts[Number(key) - 1];
        if (!text) return;
        if (!isEditorFocused(state.dockRoot) && !state.overlayOpen) return;
        preventDefault(e);
        stopPropagation(e);
        insertIntoComposer(state.inputActions, text);
      }
    }

    function handlePointerDown(event) {
      const state = store.get();
      if (!state.overlayOpen) return;
      const target = event && event.target;
      if (!target || typeof target.nodeType !== 'number') return;
      try {
        if (state.popoverRoot && state.popoverRoot.contains(target)) return;
        if (state.triggerEl && state.triggerEl.contains(target)) return;
        if (state.dockRoot && state.dockRoot.contains(target)) return;
      } catch (error) {
        return;
      }
      closeOverlay();
    }

    // =====================================================================
    // Slot components
    // =====================================================================
    // InputState / Session snapshots use selector hooks: always pass a function.
    const selectInputDraft = function selectInputDraft(state) {
      return state ? state.draft : undefined;
    };
    const selectInputPhase = function selectInputPhase(state) {
      return state ? state.phase : undefined;
    };

    function useInputSelector(props, selector) {
      try {
        if (props && typeof props.useInput === 'function') return props.useInput(selector);
      } catch (error) {
        return undefined;
      }
      return undefined;
    }

    function readRunningValue(value) {
      if (value === true || value === false) return value;
      if (!value || typeof value !== 'object') return null;
      if (typeof value.running === 'boolean') return value.running;
      if (typeof value.status === 'string') {
        if (value.status === 'running') return true;
        if (value.status === 'idle') return false;
      }
      if (typeof value.phase === 'string') {
        if (value.phase === 'running') return true;
        if (value.phase === 'idle' || value.phase === 'done') return false;
      }
      return null;
    }

    /**
     * running: true/false when the host exposes it, null when unknown.
     * Both hooks are invoked unconditionally so hook order stays stable.
     */
    function useSessionRunning(props) {
      let direct = undefined;
      try {
        if (props && typeof props.useSession === 'function') {
          direct = props.useSession(function selectRunning(session) {
            return session && typeof session === 'object' ? session.running === true : undefined;
          });
        }
      } catch (error) {
        direct = undefined;
      }
      let mapped = undefined;
      try {
        if (props && typeof props.useSessionStatus === 'function') {
          const sessionId = props.sessionId;
          mapped = props.useSessionStatus(function selectStatus(snapshot) {
            if (!snapshot) return undefined;
            if (typeof snapshot.get === 'function') return snapshot.get(sessionId);
            if (sessionId && snapshot[sessionId]) return snapshot[sessionId];
            return undefined;
          });
        }
      } catch (error) {
        mapped = undefined;
      }
      const running = readRunningValue(direct);
      if (running !== null) return running;
      return readRunningValue(mapped);
    }

    function Dock(props) {
      const plan = useStoreSelector(selectPlan);
      const dismissedKey = useStoreSelector(selectDismissedKey);
      const overlayOpen = useStoreSelector(selectOverlayOpen);
      const t = makeT(props);

      // Hook calls stay unconditional; values may be undefined before the input face mounts.
      const draftValue = useInputSelector(props, selectInputDraft);
      const phaseValue = useInputSelector(props, selectInputPhase);
      const runningValue = useSessionRunning(props);
      // `undefined` means unknown: the host exposes no usable running signal, so the
      // polling fallback below takes over instead of relying on turn-end transitions.
      const running = runningValue === true || runningValue === false ? runningValue : undefined;

      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : undefined;
      const inputActions = props && props.inputActions ? props.inputActions : null;
      const draft = typeof draftValue === 'string' ? draftValue : null;
      const phaseOk = phaseValue === undefined || phaseValue === 'plain';
      const inputEmpty = draft === '' && phaseOk;

      const [turnTick, setTurnTick] = React.useState(0);
      const previousRunningRef = React.useRef(running);
      const turnEndedRef = React.useRef(false);
      const runningRef = React.useRef(running);
      runningRef.current = running;
      const rootRef = React.useRef(null);
      const ownerRef = React.useRef({});
      const suggestion = getSuggestion(plan);
      const currentSuggestionKey = suggestionKey(plan, suggestion);
      const showSuggestion = !!suggestion && inputEmpty && dismissedKey !== currentSuggestionKey;

      // The overlay and keyboard handler outlive a conversation Dock. Its cleanup
      // must not expose a previous session, or erase a newer Dock's ownership.
      React.useEffect(function ownRuntimeFacts() {
        planRequestEpoch += 1;
        lastAppliedPlanRequest = 0;
        store.set({ dockOwner: ownerRef.current });
        const owner = ownerRef.current;
        return function cleanupRuntimeFacts() { releaseDock(owner); };
      }, [sessionId]);

      // Publish the facts the out-of-React keyboard handler needs.
      React.useEffect(function publishRuntimeFacts() {
        const current = store.get();
        if (current.dockOwner !== ownerRef.current) return;
        const patch = {};
        if (current.sessionId !== sessionId) {
          patch.sessionId = sessionId;
          patch.plan = null;
          patch.planSig = null;
          patch.dismissedKey = null;
          patch.overlayOpen = false;
          patch.anchorRect = null;
          patch.triggerEl = null;
        }
        if (current.inputActions !== inputActions) patch.inputActions = inputActions;
        const draftText = draft === null ? '' : draft;
        if (current.draftText !== draftText) patch.draftText = draftText;
        if (current.inputEmpty !== inputEmpty) patch.inputEmpty = inputEmpty;
        if (current.suggestionVisible !== showSuggestion) patch.suggestionVisible = showSuggestion;
        if (current.dockRoot !== rootRef.current) patch.dockRoot = rootRef.current;
        if (Object.keys(patch).length > 0) store.set(patch);
      });

      // TEMP verification: auto-open the plan panel once after mount (static screenshot).
      React.useEffect(function devOpenPopover() {
        if (!DEV_OPEN_POPOVER || typeof window === 'undefined') return undefined;
        const timer = window.setTimeout(function openIt() {
          try {
            const el = document.querySelector('[data-plan-completion-entry]');
            if (el) openOverlay(el);
          } catch (error) {
            /* ignore */
          }
        }, 2500);
        return function cleanup() {
          window.clearTimeout(timer);
        };
      }, []);

      // Align the floating pill group with the composer card it floats above, so the
      // suggestion entry shares the composer's left edge instead of the column edge.
      React.useEffect(function alignWithComposer() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
        let frame = 0;
        const measure = function measure() {
          try {
            const row = rootRef.current;
            if (!row || typeof row.getBoundingClientRect !== 'function') return;
            const rowRect = row.getBoundingClientRect();
            if (rowRect.width <= 0) return;
            const candidates = Array.from(document.querySelectorAll('[data-composer-card]'));
            let card = null;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const node of candidates) {
              const rect = node.getBoundingClientRect();
              const gap = rect.top - rowRect.bottom;
              const visible = rect.width > 100 && rect.height > 20;
              // Prefer the composer card that sits right below this row (the mounted one).
              if (!visible || gap < -24 || gap > 220) continue;
              if (gap < bestDistance) {
                bestDistance = gap;
                card = rect;
              }
            }
            if (!card) return;
            const left = Math.max(0, Math.round(card.left - rowRect.left));
            row.style.paddingLeft = left + 'px';
          } catch (error) {
            /* ignore */
          }
        };
        const schedule = function schedule() {
          if (frame) return;
          try {
            frame = window.requestAnimationFrame(function run() {
              frame = 0;
              measure();
            });
          } catch (error) {
            frame = 0;
            measure();
          }
        };
        measure();
        const timer = window.setTimeout(measure, 400);
        const timer2 = window.setTimeout(measure, 1200);
        const timer3 = window.setTimeout(measure, 2500);
        window.addEventListener('resize', schedule, true);
        let observer = null;
        let cardObserver = null;
        try {
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(schedule);
            observer.observe(document.documentElement);
            // The composer card moves when the column width or the tool row changes.
            const cardEl = document.querySelector('[data-composer-card]');
            if (cardEl) {
              cardObserver = new ResizeObserver(schedule);
              cardObserver.observe(cardEl);
            }
          }
        } catch (error) {
          /* ignore */
        }
        return function cleanupAlign() {
          try {
            window.clearTimeout(timer);
            window.clearTimeout(timer2);
            window.clearTimeout(timer3);
            window.removeEventListener('resize', schedule, true);
            if (observer) observer.disconnect();
            if (cardObserver) cardObserver.disconnect();
            if (frame) window.cancelAnimationFrame(frame);
          } catch (error) {
            /* ignore */
          }
        };
      }, [sessionId]);

      // Known running transitions bump turnTick; true -> false marks a turn end.
      // While `running` is unknown no tick can ever fire, and the polling effect
      // below keeps the plan state fresh instead.
      React.useEffect(function trackTurnEnd() {
        const previous = previousRunningRef.current;
        previousRunningRef.current = running;
        if (previous === undefined || running === undefined || previous === running) return;
        turnEndedRef.current = previous === true && running === false;
        setTurnTick(function bump(value) {
          return value + 1;
        });
      }, [running]);

      // Mount / session switch: read once (silent when the route is absent).
      React.useEffect(function loadPlanOnMount() {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        // Distinguish the first mount from an actual sessionId change for the Host log.
        const reason = lastPlanSessionId !== undefined && lastPlanSessionId !== sessionId ? 'session' : 'mount';
        lastPlanSessionId = sessionId;
        let cancelled = false;
        const request = function request(kind, allowWarm) {
          if (cancelled) return;
          fetchPlanState(sessionId, kind, runningRef.current).then(function loaded(result) {
            if (cancelled) return;
            if (!handlePlanFetch(sessionId, result)) return;
            if (result.plan) return;
            // P0-1: session known to the app but never observed by this plugin (old session,
            // plugin just enabled) — ask the Host to backfill from the durable session log.
            if (allowWarm === false) return;
            warmPlanState(sessionId).then(function applyWarm(warmed) {
              if (cancelled || !warmed || !warmed.ok || !warmed.json) return;
              const warmedPlan = normalizePlan(warmed.json);
              if (warmedPlan) applyPlanResult(sessionId, warmedPlan, warmed.request);
            });
          });
        };
        const refresher = function refresh(kind) {
          request(typeof kind === 'string' && kind !== '' ? kind : 'popover', false);
        };
        planRefresher = refresher;
        request(reason, true);
        return function cleanup() {
          cancelled = true;
          if (planRefresher === refresher) planRefresher = null;
        };
      }, [sessionId]);

      // Turn end: silent retries across the full chain (300..9000ms) so both the
      // fast heuristic suggestion and the later model-refined one are picked up.
      React.useEffect(function refreshAfterTurnEnd() {
        if (turnTick === 0) return undefined;
        if (!turnEndedRef.current) return undefined;
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        let cancelled = false;
        let timer = 0;
        let attempt = 0;
        function scheduleNext() {
          if (cancelled) return;
          attempt += 1;
          if (attempt >= TURN_RETRY_DELAYS.length) return;
          timer = window.setTimeout(step, TURN_RETRY_DELAYS[attempt]);
        }
        function step() {
          if (cancelled) return;
          fetchPlanState(sessionId, 'turn-end', runningRef.current).then(
            function loaded(result) {
              if (cancelled) return;
              handlePlanFetch(sessionId, result);
              scheduleNext();
            },
            function failed() {
              if (cancelled) return;
              scheduleNext();
            }
          );
        }
        timer = window.setTimeout(step, TURN_RETRY_DELAYS[0]);
        return function cleanup() {
          cancelled = true;
          if (timer) window.clearTimeout(timer);
        };
      }, [turnTick, sessionId]);

      // Fallback for an unknown `running`: poll every 4s while the page is visible
      // (`reason=poll`) so a suggestion still appears within ~4-5s of a turn end.
      React.useEffect(function pollWhileRunningUnknown() {
        if (running !== undefined) return undefined;
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        let cancelled = false;
        let timer = 0;
        let inFlight = false;
        function schedule() {
          if (cancelled) return;
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(request, POLL_MS);
        }
        function request() {
          if (cancelled || inFlight) return;
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            schedule();
            return;
          }
          inFlight = true;
          fetchPlanState(sessionId, 'poll', runningRef.current).then(
            function loaded(result) {
              inFlight = false;
              if (cancelled) return;
              handlePlanFetch(sessionId, result);
              schedule();
            },
            function failed() {
              inFlight = false;
              if (!cancelled) schedule();
            }
          );
        }
        schedule();
        return function cleanup() {
          cancelled = true;
          if (timer) window.clearTimeout(timer);
        };
      }, [running, sessionId]);

      // Watchdog for a known-but-static `running`: if no state request happened for
      // 15s, issue one `reason=stale-poll` so suggestions still converge even when
      // no turn-end transition is ever observed.
      React.useEffect(function stalePollWatchdog() {
        if (running === undefined) return undefined;
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        // A settled (idle) session must converge fast (~4s); during a running turn
        // 15s is enough because the answer is not ready yet.
        const interval = running === false ? POLL_MS : 1000;
        let cancelled = false;
        let timer = 0;
        function schedule() {
          if (cancelled) return;
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(check, interval);
        }
        function check() {
          if (cancelled) return;
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            schedule();
            return;
          }
          if (Date.now() - lastStateRequestAt < interval) {
            schedule();
            return;
          }
          fetchPlanState(sessionId, 'stale-poll', runningRef.current).then(
            function loaded(result) {
              if (cancelled) return;
              handlePlanFetch(sessionId, result);
              schedule();
            },
            function failed() {
              if (!cancelled) schedule();
            }
          );
        }
        schedule();
        return function cleanup() {
          cancelled = true;
          if (timer) window.clearTimeout(timer);
        };
      }, [running, sessionId]);

      // Opening the popover refreshes state silently.
      React.useEffect(function refreshOnOpen() {
        if (!overlayOpen) return;
        if (typeof planRefresher === 'function') planRefresher('popover');
      }, [overlayOpen]);

      // The persistent entry is always rendered; with no plan it shows the bare glyph.
      const label = plan ? versionLabel(plan) : '';
      const children = [
        h('style', { key: 'style', 'data-plan-completion-style': 'dock' }, DOCK_CSS)
      ];
      const dockChildren = [];

      // Floating suggestion pill on the left; the fixed-height row keeps its space
      // when hidden so the composer never jumps. The plan pill on the right is a
      // separate flex child and is always rendered, whatever the suggestion length.
      const suggestionVisible = showSuggestion && !!suggestion;
      if (suggestionVisible && suggestion) {
        const alternatives = suggestion.alternates ? suggestion.alternates.length : 0;
        const pillChildren = [
          h('span', { key: 'icon', className: 'dpc-suggest-icon', 'aria-hidden': true }, '⏎'),
          h('span', { key: 'hint', className: 'dpc-suggest-hint' }, t('suggest.hint')),
          h('span', { key: 'sep', className: 'dpc-suggest-sep', 'aria-hidden': true }, '·'),
          h(
            'span',
            { key: 'text', className: 'dpc-suggest-text', title: suggestion.text },
            '「' + suggestion.text + '」'
          )
        ];
        if (alternatives > 0) {
          pillChildren.push(
            h('span', { key: 'alts', className: 'dpc-suggest-alts' }, t('suggest.alts', { count: alternatives + 1 }))
          );
        }
        pillChildren.push(
          h(
            'button',
            {
              key: 'dismiss',
              type: 'button',
              className: 'dpc-dismiss',
              tabIndex: -1,
              'aria-label': t('suggest.dismiss'),
              onMouseDown: preventDefault,
              onClick: function onClickDismiss(event) {
                stopPropagation(event);
                dismissSuggestion();
              }
            },
            '✕'
          )
        );
        dockChildren.push(
          h(
            'div',
            {
              key: 'suggest',
              className: 'dpc-pill dpc-suggest-pill',
              'data-plan-completion-suggest': 'visible',
              role: 'status',
              'aria-live': 'polite'
            },
            pillChildren
          )
        );
      } else {
        // No suggestion: show a dashed "hint" pill while the session has no plan yet so the
        // bar stays visible (常驻) even in a brand-new / cleared conversation.
        if (!plan) {
          dockChildren.push(
            h(
              'div',
              { key: 'hint', className: 'dpc-pill dpc-hint-pill', role: 'status' },
              h('span', { key: 'icon', className: 'dpc-suggest-icon', 'aria-hidden': true }, '▤'),
              h('span', { key: 'text', className: 'dpc-suggest-text' }, t('suggest.noplan'))
            )
          );
        } else {
          // Flex spacer: keeps the plan pill pinned left without moving the row.
          dockChildren.push(
            h('span', {
              key: 'suggest',
              className: 'dpc-suggest-placeholder',
              'data-plan-completion-suggest': 'hidden',
              'aria-hidden': 'true'
            })
          );
        }
      }

      dockChildren.push(
        h(
          'button',
          {
            key: 'entry',
            type: 'button',
            className: 'dpc-pill dpc-entry' + (suggestionVisible ? ' dpc-entry-strong' : ''),
            'data-plan-completion-entry': 'true',
            'aria-haspopup': 'dialog',
            'aria-expanded': overlayOpen ? 'true' : 'false',
            'aria-label': t('entry.aria'),
            title: label ? label + (plan && plan.intent ? ' · ' + plan.intent : '') : t('entry.title'),
            onMouseDown: preventDefault,
            onClick: function onClickEntry(event) {
              stopPropagation(event);
              toggleOverlay(event && event.currentTarget ? event.currentTarget : null);
            }
          },
          h('span', { key: 'icon', className: 'dpc-entry-icon', 'aria-hidden': true }, '▤'),
          label
            ? h('span', { key: 'version', className: 'dpc-entry-version' }, label)
            : h('span', { key: 'label', className: 'dpc-entry-label' }, t('entry.label'))
        )
      );

      children.push(
        h(
          'div',
          {
            key: 'root',
            ref: rootRef,
            className: 'dpc-root',
            'data-plan-completion': 'dock',
            'data-plan-completion-version': label
          },
          dockChildren
        )
      );

      return h(React.Fragment, null, children);
    }

    function computePopoverPosition(rect) {
      const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1024;
      const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 768;
      const width = Math.max(300, Math.min(440, viewportWidth - 24));
      const style = {
        position: 'fixed',
        right: 12,
        bottom: 12,
        width: width,
        maxHeight: Math.max(180, Math.min(520, viewportHeight - 24)),
        overflow: 'auto'
      };
      if (rect && typeof rect.top === 'number' && typeof rect.right === 'number') {
        style.bottom = Math.max(12, viewportHeight - rect.top + 8);
        style.right = Math.max(12, Math.min(viewportWidth - rect.right, viewportWidth - width - 12));
        style.maxHeight = Math.max(160, Math.min(520, rect.top - 16));
      }
      return style;
    }

    function renderCloseButton(t) {
      return h(
        'button',
        {
          key: 'close',
          type: 'button',
          className: 'dpc-pop-close',
          'aria-label': t('popover.close'),
          onMouseDown: preventDefault,
          onClick: function onClickClose(event) {
            stopPropagation(event);
            closeOverlay();
          }
        },
        '✕'
      );
    }

    function renderPopoverContent(plan, inputActions, t, verify, onVerify) {
      const children = [];
      if (!plan) {
        children.push(
          h(
            'div',
            { key: 'head', className: 'dpc-pop-head' },
            h('span', { className: 'dpc-entry-icon', 'aria-hidden': true }, '▤'),
            h('span', { className: 'dpc-pop-title' }, t('popover.title')),
            renderCloseButton(t)
          )
        );
        children.push(h('div', { key: 'empty', className: 'dpc-empty' }, t('popover.empty')));
        return [children[0], h('div', { key: 'body', className: 'dpc-pop-body' }, children.slice(1))];
      }

      children.push(
        h(
          'div',
          { key: 'head', className: 'dpc-pop-head' },
          h('span', { className: 'dpc-entry-icon', 'aria-hidden': true }, '▤'),
          h('span', { className: 'dpc-pop-title' }, t('popover.title')),
          h('span', { className: 'dpc-pop-ver' }, versionLabel(plan)),
          h('span', { className: 'dpc-pop-chip', 'data-status': plan.status }, t('status.' + plan.status)),
          renderCloseButton(t)
        )
      );

      if (plan.stale) {
        children.push(h('div', { key: 'stale', className: 'dpc-stale', role: 'status' }, t('popover.stale')));
      }

      if (plan.intent) {
        children.push(
          h(
            'div',
            { key: 'intent', className: 'dpc-section' },
            h('div', { className: 'dpc-label' }, t('popover.intent')),
            h('div', { className: 'dpc-text' }, plan.intent)
          )
        );
      }

      const activeSteps = plan.steps.filter(s => s.status !== 'done' && s.status !== 'dropped').sort((a, b) => ({blocked:0,doing:1,todo:2}[a.status] - {blocked:0,doing:1,todo:2}[b.status]));
      if (plan.constraints && plan.constraints.length) children.push(h('div', { key: 'constraints', className: 'dpc-section' }, h('div', { className: 'dpc-label' }, '关键约束'), plan.constraints.map((text, i) => h('div', { key: i, className: 'dpc-text' }, text))));
      if (plan.steps.length > 0) {
        children.push(
          h(
            'div',
            { key: 'steps', className: 'dpc-section' },
            h('div', { className: 'dpc-label' }, t('popover.steps')),
            h(
              'ol',
              { className: 'dpc-steps' },
              activeSteps.slice(0, 3).map(function renderStep(step) {
                const glyph =
                  step.status === 'blocked' ? '!' : step.status === 'done' ? '✓' : step.status === 'doing' ? '●' : step.status === 'dropped' ? '✕' : '○';
                const mainChildren = [h('span', { key: 'title', className: 'dpc-step-title' }, step.title), h('span', { key: 'state', className: 'dpc-evidence' }, step.lifecycle === 'awaiting_receipt' ? '等待工具回执' : step.lifecycle === 'outcome_unverified' ? '结果待核验' : t('step.' + step.status))];
                if (step.evidence.length > 0) {
                  mainChildren.push(
                    h('details', { key: 'evidence', className: 'dpc-evidence' }, h('summary', null, '查看回执编号'), step.evidence.join(' · '))
                  );
                }
                return h(
                  'li',
                  { key: step.id + ':' + step.title, className: 'dpc-step', 'data-status': step.status },
                  h(
                    'span',
                    { className: 'dpc-glyph', role: 'img', 'aria-label': t('step.' + step.status) },
                    glyph
                  ),
                  h('span', { className: 'dpc-step-main' }, mainChildren)
                );
              })
            )
          )
        );
      }

      children.push(h('details', { key: 'full-plan', className: 'dpc-section' }, h('summary', null, '完整计划 · ' + plan.steps.filter(s => s.status === 'done').length + ' 项已完成'), plan.steps.map(s => h('div', { key: s.id, className: 'dpc-text' }, t('step.' + s.status) + ' · ' + s.title))));
      children.push(h('div', { key: 'retrieval-note', className: 'dpc-evidence' }, '思考仅作意图参考；完成状态须核对执行回执。' + (plan.retrieval?.mode === 'hybrid' ? ' Q8 混合检索' : plan.retrieval?.mode === 'lexical' ? ' 词法检索（向量暂不可用或预热中）' : '')));
      if (plan.reason) {
        children.push(
          h(
            'div',
            { key: 'reason', className: 'dpc-section' },
            h('div', { className: 'dpc-label' }, t('popover.reason')),
            h('div', { className: 'dpc-reason' }, plan.reason)
          )
        );
      }

      const suggestion = getSuggestion(plan);
      if (suggestion) {
        children.push(
          h(
            'div',
            { key: 'suggestion', className: 'dpc-section dpc-suggest-card' },
            h('div', { className: 'dpc-label' }, t('popover.suggestion')),
            h('div', { className: 'dpc-suggest-line' }, suggestion.text)
          )
        );
      } else if (plan.status === 'active') {
        const fillText = planFillText(plan);
        if (fillText) {
          children.push(
            h(
              'div',
              { key: 'suggestion', className: 'dpc-section dpc-suggest-card' },
              h('div', { className: 'dpc-label' }, t('popover.suggestion')),
              h('div', { className: 'dpc-suggest-line' }, fillText)
            )
          );
        }
      }

      // P0-5「核对进度」结果：显示在计划正文里，不改动计划本身。
      if (verify && (verify.loading || verify.error || verify.result)) {
        const verifyChildren = [
          h('div', { key: 'label', className: 'dpc-label' }, t('verify.assessment'))
        ];
        if (verify.loading) {
          verifyChildren.push(h('div', { key: 'loading', className: 'dpc-verify-loading' }, t('verify.loading')));
        } else if (verify.error) {
          verifyChildren.push(
            h('div', { key: 'error', className: 'dpc-verify-error' }, t('verify.failed', { value: verify.error }))
          );
        } else if (verify.result) {
          const result = verify.result;
          if (result.assessment) {
            verifyChildren.push(h('div', { key: 'assessment', className: 'dpc-verify-assessment' }, result.assessment));
          }
          const mismatches = Array.isArray(result.mismatches) ? result.mismatches : [];
          if (mismatches.length) {
            verifyChildren.push(
              h(
                'ul',
                { key: 'mismatches', className: 'dpc-verify-list' },
                mismatches.map(function renderMismatch(item, index) {
                  const prefix = item && item.stepId ? '[' + item.stepId + '] ' : '';
                  return h(
                    'li',
                    { key: 'mismatch-' + index, className: 'dpc-verify-item' },
                    prefix + String(item && item.issue ? item.issue : '')
                  );
                })
              )
            );
          } else {
            verifyChildren.push(h('div', { key: 'clean', className: 'dpc-verify-clean' }, t('verify.clean')));
          }
          if (result.suggestion) {
            verifyChildren.push(
              h('div', { key: 'next', className: 'dpc-verify-next' }, t('verify.next', { value: result.suggestion }))
            );
          }
        }
        children.push(h('div', { key: 'verify', className: 'dpc-section dpc-verify-card' }, verifyChildren));
      }

      if (plan.updatedAt) {
        children.push(
          h('div', { key: 'updated', className: 'dpc-updated' }, t('popover.updated', { time: formatTime(plan.updatedAt) }))
        );
      }

      const fillText = planFillText(plan);
      const canWrite = !!inputActions;
      children.push(
        h(
          'div',
          { key: 'actions', className: 'dpc-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dpc-btn',
              'data-primary': 'true',
              disabled: !canWrite || fillText === '',
              onMouseDown: preventDefault,
              onClick: function onClickFill(event) {
                stopPropagation(event);
                if (replaceComposerDraft(inputActions, fillText)) closeOverlay();
              }
            },
            t('popover.fill')
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dpc-btn',
              disabled: !canWrite,
              onMouseDown: preventDefault,
              onClick: function onClickSync(event) {
                stopPropagation(event);
                const prompt = buildSyncPrompt(plan);
                if (replaceComposerDraft(inputActions, prompt)) closeOverlay();
              }
            },
            t('popover.sync')
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dpc-btn',
              disabled: !!(verify && verify.loading),
              onMouseDown: preventDefault,
              onClick: function onClickVerify(event) {
                stopPropagation(event);
                if (typeof onVerify === 'function') onVerify();
              }
            },
            t('popover.verify')
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dpc-btn',
              onMouseDown: preventDefault,
              onClick: function onClickClose(event) {
                stopPropagation(event);
                closeOverlay();
              }
            },
            t('popover.close')
          )
        )
      );

      // v2 skin: regroup flat children into header / scrollable body / footer.
      if (children.length >= 2) {
        const head = children.shift();
        let updated = null;
        const last = children.length ? children[children.length - 1] : null;
        if (last && last.props && last.props.className === 'dpc-updated') updated = children.pop();
        const actions = children.pop();
        if (actions) {
          return [
            head,
            h('div', { key: 'body', className: 'dpc-pop-body' }, children),
            h('div', { key: 'foot', className: 'dpc-pop-foot' }, updated || null, actions)
          ];
        }
      }

      return children;
    }

    function PlanPopover(props) {
      const state = useStoreSelector(selectAll);
      const t = makeT(props);
      const rootRef = React.useRef(null);
      const open = state.overlayOpen === true;
      const [heroPos, setHeroPos] = React.useState(null);
      const [verify, setVerify] = React.useState(null);

      // Ephemeral P0-5 verification result: clear it when the active session changes.
      React.useEffect(function resetVerify() {
        setVerify(null);
      }, [state.sessionId]);

      const onVerify = React.useCallback(function requestVerifyAction() {
        const sessionId = state.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '') {
          setVerify({ loading: false, result: null, error: 'no-session' });
          return;
        }
        setVerify({ loading: true, result: null, error: null });
        requestVerify(sessionId).then(function applyResult(result) {
          if (!result) {
            setVerify({ loading: false, result: null, error: 'request-failed' });
            return;
          }
          if (result.ok !== true) {
            setVerify({ loading: false, result: null, error: String(result.error || 'failed') });
            return;
          }
          setVerify({ loading: false, result: result, error: null });
        });
      }, [state.sessionId]);

      // P0-2 hero fallback: when no session-bound dock is mounted (new conversation / hero,
      // or a cleared conversation), float a small «▤ 计划» entry above the composer so the
      // entry is always reachable.
      React.useEffect(function trackHeroEntry() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
        let timer = 0;
        const scan = function scan() {
          try {
            if (!DEV_HERO_PREVIEW && document.querySelector('[data-plan-completion="dock"]')) {
              setHeroPos(null);
              return;
            }
            const cards = Array.from(document.querySelectorAll('[data-composer-card]'));
            let card = null;
            for (const node of cards) {
              const rect = node.getBoundingClientRect();
              if (rect.width > 100 && rect.height > 20 && rect.top > 80) {
                card = rect;
                break;
              }
            }
            if (!card) {
              setHeroPos(null);
              return;
            }
            const next = { top: Math.max(8, Math.round(card.top - 34)), left: Math.round(card.left) };
            setHeroPos(function keep(previous) {
              return previous && previous.top === next.top && previous.left === next.left ? previous : next;
            });
          } catch (error) {
            /* ignore */
          }
        };
        scan();
        timer = window.setInterval(scan, 700);
        window.addEventListener('resize', scan);
        return function cleanup() {
          if (timer) window.clearInterval(timer);
          window.removeEventListener('resize', scan);
        };
      }, []);

      React.useEffect(function publishPopoverRoot() {
        store.set({ popoverRoot: open ? rootRef.current : null });
        return function cleanup() {
          if (store.get().popoverRoot === rootRef.current) store.set({ popoverRoot: null });
        };
      }, [open]);

      const styleTag = h('style', { key: 'style', 'data-plan-completion-style': 'overlay' }, POPOVER_CSS + HERO_CSS);
      const heroEntry = heroPos
        ? h(
            'button',
            {
              key: 'hero',
              type: 'button',
              className: 'dpc-hero-entry',
              'data-plan-completion': 'hero-entry',
              style: { top: heroPos.top + 'px', left: heroPos.left + 'px' },
              'aria-haspopup': 'dialog',
              'aria-expanded': open ? 'true' : 'false',
              title: t('entry.title'),
              onMouseDown: preventDefault,
              onClick: function onClickHero(event) {
                stopPropagation(event);
                openOverlay(event && event.currentTarget ? event.currentTarget : null);
              }
            },
            h('span', { key: 'icon', className: 'dpc-entry-icon', 'aria-hidden': true }, '▤'),
            h('span', { key: 'label' }, t('entry.label'))
          )
        : null;

      if (!open) return h(React.Fragment, null, styleTag, heroEntry);

      const position = computePopoverPosition(state.anchorRect);
      return h(
        React.Fragment,
        null,
        styleTag,
        heroEntry,
        h(
          'div',
          {
            key: 'dialog',
            ref: rootRef,
            className: 'dpc-popover',
            role: 'dialog',
            'aria-label': t('popover.title'),
            'data-plan-completion': 'popover',
            style: position
          },
          renderPopoverContent(state.plan, state.inputActions, t, verify, onVerify)
        )
      );
    }

    // =====================================================================
    // Settings page (settings.plugins.tab)
    // =====================================================================
    const SETTINGS_SLOT = 'settings.plugins.tab';
    const SETTINGS_ID = 'plan-completion-settings';
    const SETTINGS_ORDER = 60;

    function settingsCss() {
      // Replica values taken from DSH @deepseek-ai/dsh-client-ui-settings-general
      // (uYSObG_row/title/description) plus the shared filled controls of the settings shell.
      return [
        '.dpc-settings-page{display:flex;flex-direction:column;padding:0 24px 20px;max-width:700px;box-sizing:border-box;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
        '.dpc-settings-head{display:flex;flex-direction:column;gap:4px;padding:6px 0 6px}',
        '.dpc-settings-title{font-size:16px;font-weight:600;line-height:26px}',
        '.dpc-settings-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.dpc-settings-page .dpc-settings-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0 !important;box-sizing:border-box;border:0 !important;border-bottom:.5px solid var(--dsw-alias-border-l2) !important;background:transparent !important;min-height:0 !important}',
        '.dpc-settings-page .dpc-settings-row:last-of-type{border-bottom:0 !important}',
        '.dpc-settings-row-main{display:flex;flex-direction:column;min-width:0}',
        '.dpc-settings-row-label{font-size:14px !important;line-height:20px !important;color:var(--dsw-alias-label-primary)}',
        '.dpc-settings-row-desc{margin-top:4px !important;font-size:12px !important;line-height:18px !important;color:var(--dsw-alias-label-secondary) !important}',
        '.dpc-settings-control{flex:none;display:flex;justify-content:flex-end;align-items:center;min-width:132px;max-width:260px}',
        '.dpc-settings-page .dpc-settings-select{width:100%;appearance:none !important;-webkit-appearance:none !important;border:0 !important;border-radius:8px !important;padding:8px 30px 8px 12px !important;font-size:14px !important;line-height:20px !important;color:var(--dsw-alias-label-primary) !important;background-color:rgba(127,127,127,.14) !important;background-color:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent) !important;background-image:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23888888%22 stroke-width=%222%22%3E%3Cpath d=%22M6 9l6 6 6-6%22/%3E%3C/svg%3E") !important;background-repeat:no-repeat !important;background-position:right 10px center !important;cursor:pointer;box-shadow:none !important}',
        '.dpc-settings-page .dpc-settings-select:focus{outline:none !important;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe) !important}',
        '.dpc-settings-page .dpc-settings-toggle{width:40px !important;height:24px !important;border-radius:999px !important;border:0 !important;background:rgba(127,127,127,.2) !important;background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent) !important;position:relative;cursor:pointer;padding:0;flex:none;box-shadow:none !important}',
        '.dpc-settings-page .dpc-settings-toggle[data-on="true"]{background:var(--dsw-alias-label-primary,#1f1f1f) !important}',
        '.dpc-settings-toggle span{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:999px;background:#fff;transition:left .12s ease;box-shadow:0 1px 2px rgba(0,0,0,.18)}',
        '.dpc-settings-page .dpc-settings-toggle[data-on="true"] span{left:18px}',
        '.dpc-settings-footer{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding-top:16px}',
        '.dpc-settings-status{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));margin-right:auto}',
        '.dpc-settings-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));margin-right:auto}',
        '.dpc-settings-page .dpc-settings-save{border:0 !important;border-radius:8px !important;padding:8px 16px !important;font-size:14px !important;line-height:20px !important;cursor:pointer;background:rgba(127,127,127,.14) !important;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent) !important;color:var(--dsw-alias-label-primary) !important;flex:none;box-shadow:none !important}',
        '.dpc-settings-page .dpc-settings-save:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 11%,transparent) !important}',
        '.dpc-settings-save:disabled{opacity:.5;cursor:default}',
        '.dpc-settings-loading{padding:18px 24px;font-size:13px;color:var(--dsw-alias-label-secondary)}'
      ].join('\n');
    }

    function PlanSettingsPage(props) {
      const t = makeT(props);
      const [settings, setSettings] = React.useState(null);
      const [status, setStatus] = React.useState('loading');
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState('');
      const [saved, setSaved] = React.useState(false);

      React.useEffect(function load() {
        let alive = true;
        fetchSettings().then(function applied(result) {
          if (!alive) return;
          if (!result || result.ok !== true || !result.settings) { setStatus('error'); return; }
          setSettings(result.settings);
          setStatus('ready');
        });
        return function cleanup() { alive = false; };
      }, []);

      function patch(next) {
        setSaved(false);
        setSettings(function keep(previous) { return previous ? { ...previous, ...next } : previous; });
      }
      function chooseProvider(provider) {
        patch({ fixedProvider: provider, fixedModel: '', models: [] });
        fetchSettings(provider).then(function applied(result) {
          if (result && result.ok === true && result.settings) patch({ models: result.settings.models || [] });
        });
      }
      function save() {
        if (!settings || saving) return;
        setSaving(true); setError('');
        saveSettings({
          modelPolicy: settings.modelPolicy,
          fixedProvider: settings.fixedProvider || '',
          fixedModel: settings.fixedModel || '',
          modelCalls: settings.modelCalls === true
        }).then(function applied(result) {
          setSaving(false);
          if (!result || result.ok !== true) {
            const detail = result && typeof result.error === 'string' ? result.error : '';
            setError(detail ? t('settings.saveError') + ': ' + detail : t('settings.saveError'));
            return;
          }
          setSettings(result.settings || settings);
          setSaved(true); setError('');
        });
      }

      const styleTag = h('style', { key: 'style', 'data-plan-completion-style': 'settings' }, settingsCss());
      if (status === 'loading') return h(React.Fragment, null, styleTag, h('div', { key: 'loading', className: 'dpc-settings-loading' }, t('settings.loading')));
      if (status === 'error' || !settings) return h(React.Fragment, null, styleTag, h('div', { key: 'error', className: 'dpc-settings-loading dpc-settings-error' }, t('settings.error')));

      const defaultRoute = settings.defaultSelection ? settings.defaultSelection.provider + '/' + settings.defaultSelection.model : '-';
      const providers = settings.providers || [];
      const models = settings.models || [];
      const row = function row(key, label, desc, control) {
        return h('div', { key: key, className: 'dpc-settings-row' },
          h('div', { key: 'main', className: 'dpc-settings-row-main' },
            h('div', { key: 'label', className: 'dpc-settings-row-label' }, label),
            desc ? h('div', { key: 'desc', className: 'dpc-settings-row-desc' }, desc) : null),
          h('div', { key: 'control', className: 'dpc-settings-control' }, control));
      };

      return h(React.Fragment, null, styleTag,
        h('div', { key: 'page', className: 'dpc-settings-page' },
          h('div', { key: 'head', className: 'dpc-settings-head' },
            h('div', { key: 'title', className: 'dpc-settings-title' }, t('settings.title')),
            h('div', { key: 'sub', className: 'dpc-settings-sub' }, 'v0.1.8 · build ' + CLIENT_BUILD + ' · ' + t('settings.defaultRoute', { value: defaultRoute }))),
          row('policy', t('settings.model'), t('settings.modelDesc'),
            h('select', { className: 'dpc-settings-select', value: settings.modelPolicy,
              onChange: function onPolicy(event) { patch({ modelPolicy: event.target.value }); } },
              [h('option', { key: 'default', value: 'default' }, t('settings.policy.default')),
               h('option', { key: 'fixed', value: 'fixed' }, t('settings.policy.fixed')),
               h('option', { key: 'auto', value: 'auto' }, t('settings.policy.auto'))])),
          settings.modelPolicy === 'fixed'
            ? row('provider', t('settings.provider'), t('settings.providerDesc'),
                h('select', { className: 'dpc-settings-select', value: settings.fixedProvider || '',
                  onChange: function onProvider(event) { chooseProvider(event.target.value); } },
                  [h('option', { key: 'empty', value: '' }, '—')].concat(providers.map(function option(p) {
                    return h('option', { key: p.id, value: p.id }, p.name || p.id);
                  }))))
            : null,
          settings.modelPolicy === 'fixed'
            ? row('model', t('settings.modelId'), t('settings.modelDesc'),
                h('select', { className: 'dpc-settings-select', value: settings.fixedModel || '',
                  onChange: function onModel(event) { patch({ fixedModel: event.target.value }); } },
                  [h('option', { key: 'empty', value: '' }, '—')].concat(models.map(function option(m) {
                    return h('option', { key: m.id, value: m.id }, m.name || m.id);
                  }))))
            : null,
          row('calls', t('settings.modelCalls'), t('settings.callsDesc'),
            h('button', { type: 'button', className: 'dpc-settings-toggle', 'data-on': settings.modelCalls === true ? 'true' : 'false',
              'aria-pressed': settings.modelCalls === true ? 'true' : 'false',
              onClick: function onCalls() { patch({ modelCalls: settings.modelCalls !== true }); } },
              h('span', { key: 'knob' }))),
          h('div', { key: 'footer', className: 'dpc-settings-footer' },
            error ? h('div', { key: 'e', className: 'dpc-settings-error' }, error)
              : saved ? h('div', { key: 's', className: 'dpc-settings-status' }, t('settings.saved')) : null,
            h('button', { key: 'save', type: 'button', className: 'dpc-settings-save', disabled: saving, onClick: save },
              saving ? t('settings.saving') : t('settings.save')))));
    }


    // =====================================================================
    // Plugin entry
    // =====================================================================
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(function registerDictionaries() {
            return ctx.locale.register(NS, { zh: MESSAGES.zh, en: MESSAGES.en });
          }, 'plan-completion: dictionaries');
        } catch (error) {
          /* locale is optional for rendering: makeT falls back to the local dictionary */
        }
        try {
          hostT = ctx.locale.bind(NS);
        } catch (error) {
          hostT = null;
        }
        try {
          pluginThemeService = ctx.get('theme');
        } catch (error) {
          pluginThemeService = null;
        }

        ctx.slots.inject(DOCK_SLOT, function registerDock() {
          return ctx.slots.register(
            { name: DOCK_SLOT, id: DOCK_ID, order: DOCK_ORDER, locale: NS },
            Dock
          );
        });

        ctx.slots.inject(OVERLAY_SLOT, function registerOverlay() {
          return ctx.slots.register({ name: OVERLAY_SLOT, id: OVERLAY_ID, order: OVERLAY_ORDER }, PlanPopover);
        });

        ctx.slots.inject(SETTINGS_SLOT, function registerSettingsPage() {
          return ctx.slots.register(
            { name: SETTINGS_SLOT, id: SETTINGS_ID, order: SETTINGS_ORDER, label: '计划补全' },
            PlanSettingsPage
          );
        });

        ctx.effect(function installKeyboard() {
          if (typeof window === 'undefined') return undefined;
          const onKeyDown = function onKeyDown(event) {
            handleKeyDown(event);
          };
          window.addEventListener('keydown', onKeyDown, true);
          return function removeKeyboard() {
            window.removeEventListener('keydown', onKeyDown, true);
          };
        }, 'plan-completion: keyboard');

        ctx.effect(function installOutsideClick() {
          if (typeof document === 'undefined') return undefined;
          const onPointerDown = function onPointerDown(event) {
            handlePointerDown(event);
          };
          document.addEventListener('pointerdown', onPointerDown, true);
          return function removeOutsideClick() {
            document.removeEventListener('pointerdown', onPointerDown, true);
          };
        }, 'plan-completion: outside-click');

        // Diagnostics: prove which client build is live and whether the capsule UI rendered.
        try {
          if (typeof window !== 'undefined') {
            const styleOf = function styleOf(el) {
              try {
                if (!el || typeof getComputedStyle !== 'function') return null;
                const cs = getComputedStyle(el);
                const box = el.getBoundingClientRect();
                return {
                  left: Math.round(box.left),
                  top: Math.round(box.top),
                  w: Math.round(box.width),
                  h: Math.round(box.height),
                  display: cs.display,
                  bg: cs.backgroundColor,
                  border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
                  radius: cs.borderTopLeftRadius,
                  shadow: cs.boxShadow === 'none' ? 'none' : 'yes',
                  font: cs.fontSize + '/' + cs.lineHeight,
                };
              } catch (error) {
                return { error: String(error) };
              }
            };
            const postDiag = function postDiag(phase) {
              try {
                const pill = document.querySelector('.dpc-pill');
                const entry = document.querySelector('[data-plan-completion-entry]');
                const row = document.querySelector('[data-plan-completion="dock"]');
                const suggest = document.querySelector('.dpc-suggest-pill');
                const hero = document.querySelector('[data-plan-completion="hero-entry"]');
                fetch('/plan-completion/diag', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    phase: phase,
                    build: CLIENT_BUILD,
                    hasPill: !!pill,
                    hasEntry: !!entry,
                    suggestVisible: !!suggest,
                    dockPresent: !!row,
                    heroVisible: !!hero,
                    heroStyle: styleOf(hero),
                    rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
                    rowStyle: styleOf(row),
                    suggestStyle: styleOf(suggest),
                    entryStyle: styleOf(entry),
                    composerStyle: styleOf(document.querySelector('[data-composer-card]')),
                  }),
                }).catch(function () {});
              } catch (error) {
                /* ignore */
              }
            };
            postDiag('module-load');
            window.setTimeout(function later() { postDiag('dom-check'); }, 2500);
          }
        } catch (error) {
          /* ignore */
        }
      }
    };
  }
});

// hot-reload marker 2026-11-01T13:57Z







