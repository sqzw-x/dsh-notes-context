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
	/** Lead time as a fraction of the rollover threshold, before clamping. */
	reminderLeadRatio: Volatile<number>
	/** Lower clamp for the reminder lead, in tokens. */
	reminderLeadMinTokens: Volatile<number>
	/** Upper clamp for the reminder lead, in tokens. */
	reminderLeadMaxTokens: Volatile<number>
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
	reminderLeadRatio: number
	reminderLeadMinTokens: number
	reminderLeadMaxTokens: number
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
	reminderLeadRatio: Schema.number()
		.min(0)
		.max(1)
		.default(0.125)
		.description('Reminder lead time as a fraction of the rollover threshold.').volatile(),
	reminderLeadMinTokens: Schema.number().min(0).default(8192).description('Lower clamp for the reminder lead, in tokens.').volatile(),
	reminderLeadMaxTokens: Schema.number().min(0).default(32000).description('Upper clamp for the reminder lead, in tokens.').volatile(),
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

/**
 * The subset of configuration {@link resolveReminderBand} needs.
 *
 * **Plain numbers, not handles.** This helper is deliberately pure and takes its
 * inputs by value so it stays a function of its arguments: callers (including the
 * reminder and the unit tests) read `.get()` themselves and pass the numbers in.
 */
export interface ReminderBandConfig {
	/** Lead fraction of the threshold. */
	reminderLeadRatio: number
	/** Lower clamp for the lead, in tokens. */
	reminderLeadMinTokens: number
	/** Upper clamp for the lead, in tokens. */
	reminderLeadMaxTokens: number
}

/** Half-open token band `[start, end)` in which the reminder should fire. */
export interface ReminderBand {
	/** Token count at which the band opens. */
	readonly start: number
	/** Token count at which the band closes — the rollover threshold itself. */
	readonly end: number
}

/**
 * Coerce one clamp/ratio value to a usable finite number.
 *
 * A field that failed schema validation arrives `undefined`, and an operator may
 * also patch the resolved object directly. The reminder runs inside a step
 * boundary and must never throw there, so a missing or non-finite value degrades
 * to `0` instead of crashing the step.
 *
 * @param value - the candidate field value.
 * @returns the value when finite, otherwise `0`.
 */
function finiteOr(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Derive the reminder band from a rollover threshold.
 *
 * `lead = clamp(round(thresholdTokens * cfg.reminderLeadRatio), min, max)`, and
 * the band opens `lead` tokens before the threshold — but never earlier than
 * `0`, so a lead larger than the threshold yields `{ start: 0, end: threshold }`
 * rather than a negative window. `min` and `max` are ordered defensively, so an
 * inverted pair still produces a usable band.
 *
 * Pure: no I/O, no clock, no hidden state, so it is safe to call from a render
 * or decision path. It never throws: a non-finite or non-positive
 * `thresholdTokens` yields the empty band `{ start: 0, end: 0 }`, and a missing
 * or non-finite field degrades to `0` for that field (see {@link finiteOr}).
 *
 * @param thresholdTokens - token count at which a rollover becomes eligible.
 * @param cfg - the three clamp/ratio fields.
 * @returns the half-open band, with `start` never negative.
 */
export function resolveReminderBand(thresholdTokens: number, cfg: ReminderBandConfig): ReminderBand {
	if (!Number.isFinite(thresholdTokens) || thresholdTokens <= 0) return { start: 0, end: 0 }
	const end = Math.round(thresholdTokens)
	const ratio = finiteOr(cfg?.reminderLeadRatio)
	const low = finiteOr(cfg?.reminderLeadMinTokens)
	const high = finiteOr(cfg?.reminderLeadMaxTokens)
	const lead = Math.min(Math.max(Math.round(thresholdTokens * ratio), low), Math.max(low, high))
	return { start: Math.max(0, end - lead), end }
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
	return base as BasicCompactionConfig
}
