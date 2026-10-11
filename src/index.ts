/**
 * `dsh-notes-context` — notes-backed context windows for DeepSeek Harness.
 *
 * ## What this plugin changes
 *
 * The harness ships an LLM-summarizing compaction backend
 * (`@deepseek-ai/dsh-compaction-basic`): when context pressure crosses a
 * threshold it spends one extra model call to condense the older span, and the
 * original text is gone from the model's view forever. This plugin replaces
 * exactly one thing — **the text that boundary writes** — with a static,
 * deterministic rollover template plus the session's own persistent notebook.
 * No model call happens at a boundary, so a rollover cannot hallucinate, cannot
 * fail on a provider error, and costs nothing.
 *
 * Everything else about compaction is deliberately inherited from the base
 * backend: pressure policy, retention, tool-call pairing and the durable
 * `compaction/*` transaction all stay the parent's. See `engine.ts`.
 *
 * ## Composition
 *
 * One profile row mounts this module, which does two things in order:
 *
 * 1. registers the model-facing tools and the per-window reminder, then
 * 2. mounts {@link NotesCompactionEngine} as a **child plugin** so it becomes
 *    `ctx.compaction`.
 *
 * Both halves receive the same resolved configuration object from the single
 * composed schema in `schema.ts`, so the profile author writes one `config:`
 * block. The engine is mounted through `ctx.plugin(...)` rather than exported as
 * this row's plugin class because a Cordis class plugin's constructor would
 * *replace* `apply` — the two halves would then never both run from one row.
 *
 * **The base backend must be disabled in the same patch layer.** Two providers
 * for one service conflict: `ctx.reflect.provide` throws, the losing fiber is
 * logged and left `FAILED`, and which one loses is decided by service
 * availability order rather than by anything the profile author controls.
 *
 * ## Disabling
 *
 * `enabled: false` unregisters the tools and the reminder. The engine stays
 * mounted, so rollover keeps using the static template — that is intentional: a
 * notebook half switched off should not silently revert the process to LLM
 * summarization.
 *
 * @module dsh-notes-context
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, type ResolvedPluginConfig } from './schema.ts'
import { NotesCompactionEngine } from './engine.ts'
import { registerTools } from './tools.ts'
import { registerNotesReminder } from './reminder.ts'

export { NotesCompactionEngine } from './engine.ts'
export { Config, type ResolvedPluginConfig } from './schema.ts'
export {
	DEFAULT_ROLLOVER_TEMPLATE,
	baseEngineConfig,
	resolveReminderBand,
	resolveReminderLeadTokens,
	resolveReserveTokens,
} from './config.ts'
export {
	latestNotebook,
	latestNotebookSeq,
	writeNotebook,
	notebookBytes,
	markNotebookWriteRejected,
	NotebookTooLargeError,
	CONTEXT_NOTES_TOOL_NAME,
	type NotebookState,
	type PendingNotebook,
} from './notebook.ts'
export { notebookBlock, notebookMessage, reminderMessage, unwrapNotebookBlock } from './inject.ts'
export { CONTEXT_NOTES_TOOL, CONTEXT_HISTORY_TOOL } from './tools.ts'

/** Stable plugin identity for fiber diagnostics and logger names. */
export const name = 'notes-context'

/**
 * Service dependencies of the entry row.
 *
 * `tools` is where the model-facing half registers. `tokenMeter` and `llm` are
 * what the reminder needs to resolve pressure and the routed model, and the
 * child engine injects `llm`, `tokenMeter` and `sessions` itself.
 */
export const inject = ['tools', 'tokenMeter', 'llm']

/**
 * Register the notes-backed half of the plugin and mount the rollover engine.
 *
 * Every registration goes through `ctx`, so unloading this row removes the
 * tools, the reminder listener and the child engine fiber together, in reverse
 * order, with no manual teardown.
 *
 * @param ctx - the plugin context.
 * @param config - the validated, default-filled plugin configuration.
 */
export function apply(ctx: Context, config: ResolvedPluginConfig): void {
	// Read through the volatile handle: this gate runs once, at mount, because a
	// volatile-only config change commits into the running fiber without a remount
	// (`cordis-plugin-loader/lib/index.js:380-420`). So `enabled` is a LOAD-TIME
	// switch — flipping it in the settings page cannot unregister tools that are
	// already registered, and does not need to: every other field is read live.
	if (!config.enabled.get()) {
		ctx.logger.info('notes-context: disabled by configuration; no tools or reminder registered')
		return
	}

	registerTools(ctx, config)
	registerNotesReminder(ctx, config)

	ctx.logger.info(
		'notes-context: notebook tools registered (cap %d bytes, reminder %s)',
		config.maxNotebookBytes.get(),
		config.reminderEnabled.get() ? 'enabled' : 'disabled',
	)

	// The engine is mounted with the SAME object. Its own base knobs stay plain
	// values (the parent reads them by value and rejects unknown keys), while this
	// plugin's fields are volatile handles — both halves therefore observe an edit
	// in place, with no second set of defaults to drift.
	ctx.plugin(NotesCompactionEngine, config)
}
