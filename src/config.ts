/**
 * Configuration for `dsh-notes-context`: the Schemastery schema, the shape every
 * other module consumes, and the pure reminder-band helper.
 *
 * Every tunable of the plugin lives here — no other module in this package
 * carries a numeric or textual default of its own.
 *
 * ## Why every field is volatile
 *
 * Two requirements pull in the same direction. The Web Settings page renders a
 * plugin's `Config` through `volatileForm()`
 * (`dsh-settings/lib/index.js:122-131`), which keeps ONLY fields with a volatile
 * ancestor and returns `undefined` — no page at all — when an object has none; a
 * non-volatile field is "ordinary configuration" and is excluded. And a live edit
 * is committed into the running fiber by `loader/volatile-update`
 * (`cordis-plugin-loader/lib/types/index.d.ts:29-35`) *without a remount*.
 *
 * So a volatile field is not a marker but a **read/write handle**
 * (`Schema.prototype.volatile`, `schemastery/lib/index.mjs:235-238`;
 * `Schema.resolve`, `:265-275`, wraps the resolved value in `createVolatile`).
 * Consequently:
 *
 * - `Number(config.maxNotebookBytes)` is `NaN` and `JSON.stringify` gives `{}` —
 *   a handle only behaves through `.get()`.
 * - `.get()` must be called **at the point of use**, never hoisted into a
 *   variable that outlives one operation. Capturing the value once freezes it
 *   and silently defeats the no-restart requirement.
 * - `.volatile()` takes NO argument; the widely copied `.volatile(true)` ignores
 *   the `true`.
 *
 * The consumer-facing shape is therefore {@link Config}, whose fields are all
 * `Volatile<T>`. {@link ResolvedConfig} is kept separately as the *plain* shape
 * because `schema.ts` composes its `.dict` with the base engine's schema and
 * needs to reason about the fields rather than their handles.
 *
 * @module dsh-notes-context/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import Schema from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/**
 * The static, zero-LLM rollover template. This text IS the compaction
 * summary: no model call is made at a rollover boundary, so the boundary
 * costs nothing and cannot hallucinate. It deliberately states that (a) the
 * raw transcript stays canonical and recoverable, (b) the notebook and the
 * retained recent tail are the continuation state, and (c) this is not an LLM
 * summary, so the model must go read raw history rather than assume the
 * boundary compressed anything.
 */
export const DEFAULT_ROLLOVER_TEMPLATE = `<context-window-rollover>
The earlier raw transcript remains canonical and recoverable at context_history.
Continue from the persistent notebook, the retained recent tail, and the latest user request,
which is retained separately when it falls outside the tail.
Earlier task instructions and constraints may still require recovery from raw history.
Do not assume this boundary is an LLM summary; use the notebook and raw-history reads when
prior details are needed.
</context-window-rollover>`

/** The omp `notes` bound: the notebook never exceeds 16 KiB of UTF-8. */
const DEFAULT_MAX_NOTEBOOK_BYTES = 16384

/**
 * Default character cap for a static summary body.
 *
 * Independent of {@link DEFAULT_MAX_NOTEBOOK_BYTES}: this is a character count
 * for a different consumer, chosen low enough that a fully multi-byte notebook
 * is still truncated by a bound that reads sensibly as a character count.
 */
const DEFAULT_NOTEBOOK_SUMMARY_MAX_CHARS = 2048

/** `thresholdTokens: -1` — unset, so the rollover point follows the ratio instead. */
export const THRESHOLD_TOKENS_UNSET = -1

/**
 * The `compaction.keepRecentTokens` default, in absolute tokens.
 *
 * Upstream omp keeps this many tokens of recent history verbatim
 * (`@oh-my-pi/pi-agent-core` `compaction/compaction.ts:216`). Absolute, not a
 * fraction: the tail is a working set the model re-reads, so its useful size
 * does not scale with the window.
 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20000

/** omp's absolute reserve floor, used when `reserveTokens` is left unset. */
export const DEFAULT_RESERVE_TOKENS = 16384

/** Fraction of the window omp reserves, used when `reserveTokens` is left unset. */
const RESERVE_WINDOW_FRACTION = 0.15

/** omp's derivation for the approaching-rollover lead. See {@link resolveReminderLeadTokens}. */
const LEAD_FRACTION = 0.125
const LEAD_MIN_TOKENS = 8192
const LEAD_MAX_TOKENS = 32000

/**
 * The approaching-rollover lead, derived exactly as omp derives it
 * (`packages/coding-agent/src/session/speculation-lead.ts`):
 *
 * ```
 * lead = min(32000, max(8192, floor(thresholdTokens × 0.125)))
 * ```
 *
 * Derived rather than configured, for the reason the upstream comment gives: a
 * fixed gap would be 200k tokens on a 1M model and useless on a 32k one, so the
 * band scales with the threshold. The floor stops tiny windows from reminding on
 * every step; the cap bounds how much history the rollover misses, because the
 * retained tail grows by at most ~lead tokens between the reminder and the
 * boundary it precedes.
 *
 * @param thresholdTokens - the token count at which a rollover becomes eligible.
 * @returns the lead, in tokens.
 */
export function resolveReminderLeadTokens(thresholdTokens: number): number {
	if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return LEAD_MIN_TOKENS
	return Math.min(LEAD_MAX_TOKENS, Math.max(LEAD_MIN_TOKENS, Math.floor(thresholdTokens * LEAD_FRACTION)))
}

/**
 * omp's reserve for one window: `max(floor(window × 0.15), 16384)`.
 *
 * The absolute floor exists because the proportional reserve would be useless on
 * a small bundled window; the fraction exists because a fixed reserve is
 * negligible on a 1M window. Mirrors `effectiveReserveTokens`
 * (`@oh-my-pi/pi-agent-core` `compaction/compaction.ts:314-316`).
 *
 * @param contextWindow - the adapter-declared window.
 * @param reserveTokens - an explicit reserve, or `undefined` to derive omp's default.
 * @returns the reserve, in tokens.
 */
export function resolveReserveTokens(contextWindow: number, reserveTokens?: number): number {
	if (Number.isFinite(reserveTokens) && (reserveTokens as number) >= 0) return Math.floor(reserveTokens as number)
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return DEFAULT_RESERVE_TOKENS
	return Math.max(Math.floor(contextWindow * RESERVE_WINDOW_FRACTION), DEFAULT_RESERVE_TOKENS)
}

/**
 * The consumer-facing configuration shape: every plugin-owned field is a
 * VOLATILE HANDLE, not a value.
 *
 * Read a field with `.get()` **at the point of use**. Never hoist a value into a
 * variable that outlives one operation: a captured value freezes at the moment
 * of capture and silently defeats live settings updates.
 *
 * Arithmetic on a handle does not work — `Number(config.x)` is `NaN` and
 * `JSON.stringify(config)` gives `{}`.
 */
export interface Config {
	/** Master switch. See `registerTools` for what a live change can and cannot do. */
	enabled: Volatile<boolean>
	/**
	 * Hard upper bound on the notebook's UTF-8 byte length. Enforced with a
	 * `TextEncoder` (NOT `String.length`) immediately before a write is accepted.
	 */
	maxNotebookBytes: Volatile<number>
	/** Whether the approaching-rollover reminder is injected at all. */
	reminderEnabled: Volatile<boolean>
	/**
	 * Absolute token count at which a rollover becomes eligible, or
	 * {@link THRESHOLD_TOKENS_UNSET} to follow `thresholdRatio` instead.
	 *
	 * This is `compaction.thresholdTokens` upstream. Absolute wins over the
	 * ratio, so one number pins the rollover point regardless of how the ratio
	 * reads. The window it divides by is known only at step time, so the exact
	 * trigger is locked on the first step of each window.
	 */
	thresholdTokens: Volatile<number>
	/**
	 * Tokens of recent history kept verbatim after a rollover. Absolute, like
	 * `compaction.keepRecentTokens` upstream.
	 *
	 * Replaces the base engine's `retainRatio`/`retainTokens` knobs when set, so
	 * the tail has one owner and one unit.
	 */
	keepRecentTokens: Volatile<number>
	/**
	 * Reserve held back below the trigger, or `undefined` to derive omp's
	 * `max(15% of window, 16384)`.
	 *
	 * Replaces the base engine's `headroomTokens`, and is written into it at the
	 * absolute trigger's lock. It is both the second ceiling on the trigger and
	 * the safety gap the rollover leaves under the window: the trigger is
	 * `min(thresholdTokens, window − reservedCompletionTokens − this)`, so a target
	 * set closer to the window than this reserve comes earlier, by at most this
	 * reserve.
	 *
	 * It is deliberately a CUSHION and never the trigger restated. Writing
	 * `window − thresholdTokens` here would collapse the parent's second ceiling to
	 * `thresholdTokens − reservedCompletionTokens`, subtracting the routed output
	 * reservation twice; see `lockThreshold`.
	 */
	reserveTokens: Volatile<number | undefined>
	/** The static rollover template emitted at a rollover boundary. */
	rolloverText: Volatile<string>
	/** Character cap for a static-summary body derived from the notebook. */
	notebookSummaryMaxChars: Volatile<number>
	/** `provider` label recorded on a static (non-LLM) summary result. */
	staticProvider: Volatile<string>
	/** `model` label recorded on a static (non-LLM) summary result. */
	staticModel: Volatile<string>
	/** Default `context_history` entry count when the model gives no range. */
	historyDefaultLimit: Volatile<number>
	/** Hard cap on `context_history` entries returned from one call. */
	maxHistoryEntries: Volatile<number>
	/** Hard cap on the UTF-8 bytes of the `context_history` transcript text. */
	maxHistoryBytes: Volatile<number>
	/** Character cap for one `context_history` entry summary. */
	historySummaryMaxChars: Volatile<number>
	/** Suffix marking a summary that was truncated to `historySummaryMaxChars`. */
	summaryTruncationMarker: Volatile<string>
	/** Marker rendered next to a compaction/rollover boundary event. */
	historyBoundaryMarker: Volatile<string>
}

/**
 * The plugin's own fields as PLAIN values — the shape produced by resolving
 * {@link Config} without the volatile wrapper.
 *
 * Kept because composition needs to reason about the fields themselves: the
 * Lead's `schema.ts` merges `NotesConfig.dict` with `BasicCompactionEngine`'s
 * schema, and {@link baseEngineConfig} hands the base engine's fields to the
 * parent, which reads them by value.
 */
export interface ResolvedConfigValues {
	enabled: boolean
	maxNotebookBytes: number
	reminderEnabled: boolean
	thresholdTokens: number
	keepRecentTokens: number
	reserveTokens: number | undefined
	rolloverText: string
	notebookSummaryMaxChars: number
	staticProvider: string
	staticModel: string
	historyDefaultLimit: number
	maxHistoryEntries: number
	maxHistoryBytes: number
	historySummaryMaxChars: number
	summaryTruncationMarker: string
	historyBoundaryMarker: string
}

/**
 * Schemastery schema (a Standard Schema validator). Cordis validates
 * synchronously and fills defaults before `apply` runs.
 */
export const Config: Schema<ResolvedConfigValues, Config> = Schema.object({
	enabled: Schema.boolean().default(true).description('Master switch. Turning it off stops the notebook and history tools from doing anything (they refuse from the next call) and silences the reminder immediately; the tool entries themselves stay in the tool catalog until the app restarts, because registration is a mount-time effect.').volatile(),
	maxNotebookBytes: Schema.number()
		.min(1)
		.default(DEFAULT_MAX_NOTEBOOK_BYTES)
		.description('Maximum notebook size in UTF-8 bytes.').volatile(),
	reminderEnabled: Schema.boolean().default(true).description('Inject an approaching-rollover reminder.').volatile(),
	thresholdTokens: Schema.number()
		.min(THRESHOLD_TOKENS_UNSET)
		.default(THRESHOLD_TOKENS_UNSET)
		.description(
			'Absolute token count at which a rollover becomes eligible, or -1 to follow thresholdRatio. Absolute wins over the ratio; the trigger is capped at the window less the routed output reservation and reserveTokens.',
		).volatile(),
	keepRecentTokens: Schema.number()
		.min(1)
		.default(DEFAULT_KEEP_RECENT_TOKENS)
		.description(
			'Tokens of recent history kept verbatim after a rollover. Absolute; replaces retainRatio/retainTokens.',
		).volatile(),
	reserveTokens: Schema.number()
		.min(0)
		.description(
			'Reserve held back below the rollover trigger, in tokens. Leave blank for the default: 15% of the model window, never below 16384. The trigger is the lower of your target and the window less the routed output reservation and this reserve.',
		).volatile(),
	rolloverText: Schema.string().default(DEFAULT_ROLLOVER_TEMPLATE).description('Static rollover template text.').volatile(),
	notebookSummaryMaxChars: Schema.number()
		.min(0)
		.default(DEFAULT_NOTEBOOK_SUMMARY_MAX_CHARS)
		.description('Character cap for a static summary body derived from the notebook.').volatile(),
	staticProvider: Schema.string().default('dsh-notes-context').description('Provider label for a static summary result.').volatile(),
	staticModel: Schema.string().default('static-rollover').description('Model label for a static summary result.').volatile(),
	historyDefaultLimit: Schema.number().min(1).default(200).description('Default context_history entry count.').volatile(),
	maxHistoryEntries: Schema.number().min(1).default(500).description('Maximum context_history entries per call.').volatile(),
	maxHistoryBytes: Schema.number().min(1).default(51200).description('Maximum context_history text bytes per call.').volatile(),
	historySummaryMaxChars: Schema.number()
		.min(1)
		.default(200)
		.description('Character cap for one context_history entry summary.').volatile(),
	summaryTruncationMarker: Schema.string().default('…').description('Suffix marking a truncated summary.').volatile(),
	historyBoundaryMarker: Schema.string()
		.default('[ROLLOVER BOUNDARY]')
		.description('Marker rendered next to a compaction/rollover boundary event.').volatile(),
})

/**
 * The plugin's own configuration schema, under the name consumers compose with.
 *
 * The Lead's `schema.ts` intersects its `.dict` with `BasicCompactionEngine`'s
 * schema, so a user configures every knob in one block while each half still owns
 * and validates only its own keys.
 *
 * Typed `Schema<ResolvedConfigValues, Config>`: the *input* is plain configuration
 * (what `cordis.yml` or the settings page supplies) and the *output* is the
 * volatile-handle shape. Input fields are optional in Schemastery's object
 * typing, so the plain input type satisfies it.
 */
export const NotesConfig: Schema<ResolvedConfigValues, Config> = Config

/** Half-open token band `[start, end)` in which the reminder should fire. */
export interface ReminderBand {
	/** Token count at which the band opens. */
	readonly start: number
	/** Token count at which the band closes — the rollover threshold itself. */
	readonly end: number
}

/**
 * Derive the reminder band from a rollover threshold.
 *
 * The band is `[threshold − lead, threshold)`, where `lead` is DERIVED by
 * {@link resolveReminderLeadTokens} rather than configured — upstream exposes no
 * setting for it either. There is therefore no knob to clamp and no inverted
 * pair to defend against: the lead is always positive and never exceeds the
 * threshold, because the fraction is ≤ 1 and the floor is applied to a
 * non-negative threshold.
 *
 * Pure: no I/O, no clock, no hidden state, so it is safe to call from a render
 * or decision path. It never throws: a non-finite or non-positive
 * `thresholdTokens` yields the empty band `{ start: 0, end: 0 }`.
 *
 * @param thresholdTokens - token count at which a rollover becomes eligible.
 * @returns the half-open band.
 */
export function resolveReminderBand(thresholdTokens: number): ReminderBand {
	if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return { start: 0, end: 0 }
	const end = Math.round(thresholdTokens)
	return { start: Math.max(0, end - resolveReminderLeadTokens(end)), end }
}

/**
 * Extract the base engine's own configuration keys as PLAIN values.
 *
 * `BasicCompactionEngine` validates its configuration strictly and rejects any
 * key it does not know (`dsh-compaction-basic/lib/index.js:207-210`), and its
 * `resolveConfig` reads base knobs **by value**. Handing it the composed plugin
 * config — which carries this plugin's keys, and volatile handles — would throw
 * on the unknown keys and silently produce `NaN`/`{}` for the ones it does read.
 *
 * Two deliberate properties:
 *
 * - **Forward direction.** Keys come from `BasicCompactionEngine.Config.dict`, so
 *   a knob the parent adds later flows through automatically. The inverse (drop
 *   the keys this plugin declares) would silently omit anything new.
 * - **Handles are skipped.** A volatile field must never reach the parent, which
 *   would read the handle object itself rather than its value.
 *
 * @param config - the composed plugin configuration, plain or volatile.
 * @returns just the base keys the parent accepts, as plain values.
 */
export function baseEngineConfig(config: object): BasicCompactionConfig {
	const record = config as Record<string, unknown>
	const base: Record<string, unknown> = {}
	for (const key of Object.keys(BasicCompactionEngine.Config.dict ?? {})) {
		const value = record[key]
		if (value === undefined) continue
		if (isVolatile(value)) continue
		base[key] = value
	}
	/* This plugin's own three fields own the same ground as three fields of the
	 * base backend, and the base backend must never receive this plugin's key
	 * names (`validateKeys` rejects unknown keys at boot). So they are translated
	 * here.
	 *
	 * `keepRecentTokens` → `retainTokens`: both are absolute recent-history
	 * budgets with the same `< thresholdTokens` constraint, so the base backend's
	 * own retention path does the work; this plugin owns the unit and the name.
	 *
	 * `reserveTokens` → `headroomTokens`: the same "held back below the trigger"
	 * quantity.
	 *
	 * **An explicitly configured base key wins.** These fields carry defaults, so
	 * without this rule a profile that set `retainTokens` (or `headroomTokens`,
	 * or `retainRatio`) directly would be silently overridden by a default it
	 * never asked for. The translation therefore fires only when the base key is
	 * absent — which is also what keeps a profile written before these fields
	 * existed working unchanged.
	 *
	 * `retainRatio` suppresses the retention translation for the same reason:
	 * `retainTokens` and `retainRatio` are mutually exclusive at the base layer,
	 * and a profile that chose the ratio form must keep it.
	 *
	 * `thresholdTokens` is deliberately NOT translated here: an absolute trigger
	 * needs the model's window, which is unknown at construction. The engine
	 * locks it on the first step of each window instead. */
	if (base['retainTokens'] === undefined && base['retainRatio'] === undefined) {
		const keep = readPlain(record, 'keepRecentTokens')
		if (typeof keep === 'number' && Number.isFinite(keep)) base['retainTokens'] = keep
	}
	if (base['headroomTokens'] === undefined) {
		const reserve = readPlain(record, 'reserveTokens')
		if (typeof reserve === 'number' && Number.isFinite(reserve)) base['headroomTokens'] = reserve
	}
	return base as BasicCompactionConfig
}

/**
 * Read one field as a plain value, unwrapping a volatile handle if present.
 *
 * The composed config is resolved before it reaches either half, so a field here
 * is normally already plain; the handle case exists because the same helper is
 * unit-tested against a raw resolved shape. A handle is read through `.get()`
 * rather than returned, so the caller never receives the handle object.
 *
 * @param record - the config record under inspection.
 * @param key - the field name.
 * @returns the plain value, or `undefined` when the field is absent.
 */
function readPlain(record: Record<string, unknown>, key: string): unknown {
	const value = record[key]
	return isVolatile(value) ? (value as { get: () => unknown }).get() : value
}
