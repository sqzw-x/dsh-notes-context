/**
 * The zero-LLM rollover engine.
 *
 * ## What this class changes, and what it deliberately does not
 *
 * `BasicCompactionEngine` reaches its summarizer through `regionDependencies()`
 * (`dsh-compaction-basic/lib/index.js:1013-1024`), whose `summarize` entry is the
 * arrow `(input, owner, abort) => this.summarize(input, owner, abort)`. That is a
 * late-bound property read on `this`, so overriding `summarize` replaces the
 * summarizer for **every** entry point — `compactIfNeeded` (pressure and
 * context-overflow), `compactNow`, and a direct `compactRegion` call — while the
 * parent keeps owning range selection, retention, tool-call pairing, the durable
 * compaction lock, and the `compaction/*` transaction.
 *
 * `summarize` is the documented sole subclass hook
 * (`dsh-compaction-basic/lib/types/index.d.ts:20-23`). Everything else stays the
 * parent's. In particular this class never touches `compactIfNeeded`,
 * `compactNow`, `regionDependencies`, or `_registerAutomaticCompaction`.
 *
 * ## The summary is static, and that is the feature
 *
 * The returned `SummaryResult` is the configured rollover text plus the
 * session's own persistent notebook. No model call is made, so a rollover
 * cannot hallucinate, cannot fail on a provider error, and costs nothing. This
 * module therefore never reads `this.ctx.llm`; that is asserted in prose here
 * and by the absence of any `llm` use below.
 *
 * What lands on the surface is not this text verbatim: the parent frames the
 * returned summary with its own checkpoint preamble and `<compacted-summary>`
 * tags (`dsh-compaction-basic/lib/index.js:344-355`, applied at `:596-599`).
 * That framing belongs to the private compaction transaction and cannot be
 * replaced without reimplementing the transaction; this engine chooses only the
 * body inside it.
 *
 * ## The agent is supplied; it is not captured
 *
 * `summarize` receives the owning `Agent` as its second positional argument on
 * every path, because `compactSurfaceRegion` passes `agent` as `summarizeCompaction`'s
 * `agent` parameter (`:478`) and that function calls
 * `dependencies.summarize(prepared.input, agent, signal)` (`:587`). No
 * `WeakMap` capture inside an overridden `compactRegion` is needed — and such a
 * capture would in fact be *wrong*, because `compactNow` calls
 * `compactSurfaceRegion` directly (`:994`) and so never passes through
 * `compactRegion` at all. See the module test notes in `test/` for the
 * executable proof.
 *
 * ## The parent's shrink guard: the exact condition
 *
 * After `summarize` returns, the parent prices the framed checkpoint and rejects
 * it when that price is not smaller than the shadowed span:
 *
 * ```
 * // dsh-compaction-basic/lib/index.js:601
 * if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) throw new Error(
 *   `summary is not smaller than the shadowed content (...)`);
 * ```
 *
 * The framed price is effectively **fixed**: the parent's checkpoint preamble
 * (300 chars) plus the `<compacted-summary>` tags plus this engine's rollover
 * template plus the notebook capped by `notebookSummaryMaxChars`. Measured with
 * the harness's own estimator (`@deepseek-ai/dsh-token-meter/estimate`;
 * 4 chars/token plus 4 per block) it is **225 tokens with no notebook and 738 at
 * the default 2048-character cap**. The shadowed span, by contrast, is
 * `thresholdTokens - retainTokens`, which at the parent's defaults
 * (`thresholdRatio 0.8`, `retainRatio 0.16`) is orders of magnitude larger for an
 * ordinary window: ~41,984 at a 128,000-token window and ~640,000 at 1,000,000,
 * against a fixed 738.
 *
 * So the guard is reachable only once the shadowed span itself becomes tiny — and
 * the parent's fixed `headroomTokens` (65536) makes that a narrow band rather
 * than a smooth function of window size. Working in
 * `messageBudgetTokens = contextWindow - reservedCompletionTokens`, the shadowed
 * span at the moment a rollover first becomes eligible is
 * `0.84 * messageBudgetTokens - 65536`, which drops below the 738-token framed
 * cost only while `messageBudgetTokens` lies between **78,020 and 78,896** — a
 * band 877 window sizes wide. At the defaults:
 *
 * - `messageBudgetTokens` below ~78,020 never reaches the guard: either the
 *   pressure budget is non-positive, or `retainTokens` is not below the
 *   threshold, and the parent throws `TargetPressureConfigError` instead — which
 *   the automatic listener logs once per route (`:844-847`).
 * - Inside the band the selected span collapses to a single node of a few
 *   hundred tokens, because `retainTokens` has grown almost to equal the
 *   threshold, and the guard rejects the summary.
 * - Every larger window is safe by a very wide margin.
 *
 * The band is stated in `messageBudgetTokens` so it holds whatever the reserve
 * is. **For the deployed route that reserve is 0**, measured against the real
 * transaction rather than inferred: for a routed request whose header declares
 * no `maxTokens` and whose adapter declares no `defaultMaxTokens`, the guard
 * fires at `contextWindow` 78,500 and 78,896 (selected spans of ~260 and ~737
 * tokens against the 738-token fixed cost) and every trial from 100,000 upward
 * succeeds. Had the reserve been 65536 the engine would have thrown
 * `TargetPressureConfigError` at those same sizes instead, because
 * `contextWindow - 2 * 65536` is negative there.
 *
 * The engine's own `maxTokens` policy default of 65536 — readable as
 * `engine.config.maxTokens` — is **not** that reserve.
 * `reservedCompletionTokens(agent, defaultMaxTokens)` (`:757-760`) consults the
 * routed request's envelope and the *adapter's* declared default only, and
 * `resolveCompactSpec` merely copies `policy.maxTokens` into its returned spec
 * (`:143`) without ever feeding it into the threshold.
 *
 * A deliberately tiny `thresholdRatio` combined with a tiny `retainTokens` — a
 * configuration chosen to make rollovers cheap in a test — widens the band to
 * cover ordinary windows. That is a testing configuration, not a defect in the
 * boundary, and it does not describe a default installation.
 *
 * ## Why `compaction/end.error` is not a health signal
 *
 * A rejected summary is recorded as a `compaction/end` carrying `error`
 * (`:495-499`) and rethrown (`:516`). A healthy run under a deliberately small
 * threshold can therefore show an error pair for every successful rollover, and
 * a 1:1 error-to-success ratio in the log is not evidence of breakage.
 *
 * Two properties of that failure matter, and both were established by measuring
 * the real transaction rather than inferred from reading it:
 *
 * - **It does not retry.** `compactionRetries` (default 1) only re-runs when
 *   `compactRegion` *returns* while pressure is still above the threshold
 *   (`:948-959`); the throw at `:956` unwinds `compactIfNeeded` outright. The
 *   guard also bypasses the `compaction/summary-error` recovery hook, because
 *   that hook wraps only the `summarize` call (`:586-594`) and the guard runs
 *   after it. Measured with `compactionRetries` at its default: `compactRegion`
 *   attempted once, `summarize` attempted once, one `compaction/end` with
 *   `error`.
 * - **It recovers on a later step, not within the attempt.** The failed
 *   transaction leaves the surface untouched, so the step simply performs no
 *   compaction; the automatic listener logs and continues the turn
 *   (`:843-850`). As the session grows, the shadowed span eventually exceeds the
 *   fixed framed cost and a later step succeeds. Until that happens, each step
 *   re-attempts the same range and appends another `compaction/start` /
 *   `compaction/end` pair — the honest cost of a boundary that could not shrink.
 *
 * ## Configuration: one schema, two consumers, one live object
 *
 * The loader validates and defaults one composed object (`./schema.ts`) holding
 * both the parent's compaction policy and this plugin's own fields, so a profile
 * author writes a single `config:` block. The parent, however, re-validates
 * strictly and rejects any key outside its own set, so the engine hands it a
 * filtered copy built by `baseEngineConfig` (`./config.ts`) — the one shared
 * helper, which forwards every base key the caller set and skips volatile
 * handles.
 *
 * This plugin's own fields are **volatile**, i.e. live read handles rather than
 * values, so this class keeps the config object itself and reads
 * `this.notes.<field>.get()` at the point of use. Capturing `.get()` into a
 * field at construction would freeze the value at mount and silently defeat
 * `loader/volatile-update`.
 *
 * The engine deliberately declares **no** `static Config` of its own. That is
 * load-bearing, not an omission. `ctx.plugin(NotesCompactionEngine, config)`
 * passes the already-resolved row config — the object carrying those handles —
 * and cordis re-validates it through the class's `Config`: `resolveConfig`
 * (`cordis/lib/index.js:956-958`) calls `Config['~standard'].validate(config)`.
 * Measured behaviour:
 *
 * - validating a resolved volatile config against a schema that **declares**
 *   those volatile fields returns **validation issues** (`expected number but
 *   got [object Object]`), which the loader turns into a mount failure;
 * - validating it against a schema that does **not** declare them — the parent's,
 *   which the class inherits — passes the handles through **by reference**:
 *   `isVolatile` still true, `childConfig.field === rowConfig.field`, and a value
 *   committed into the row handle afterwards is visible through the child.
 *
 * Inheriting the parent's schema therefore both avoids the mount failure and
 * preserves the handle identity that makes live updates reach this class. The
 * row's own schema in `./schema.ts` is what the loader and the settings page use.
 *
 * @module dsh-notes-context/engine
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { baseEngineConfig, resolveReserveTokens, type Config as NotesLiveConfig } from './config.ts'
import { notebookBlock } from './inject.ts'
import { latestNotebook, type NotebookState } from './notebook.ts'

/**
 * Structural mirror of the parent's `SummarizationInput`
 * (`dsh-compaction-basic/lib/types/summarizer.d.ts:20-25`).
 *
 * Declared here because the type is genuinely unnameable from outside the
 * package: the entry point imports it without re-exporting it
 * (`lib/types/index.d.ts:13`), and the exports map exposes no
 * `./lib/types/summarizer` subpath while `files` ships no `src/`
 * (`dsh-compaction-basic/package.json`). Nothing here is guessed — the shape
 * is transcribed from that declaration, and the `override` on
 * {@link NotesCompactionEngine.summarize} makes the compiler check this
 * signature against the parent's real one, so any drift in either direction is
 * a type error rather than a silent mismatch.
 */
interface StaticSummarizationInput {
	/** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
	readonly tools?: readonly ToolSchema[]
	/** The derived system head, when present, followed by the shadowed region in surface order. */
	readonly messages: readonly Message[]
}

/**
 * Structural mirror of the parent's `SummaryResult`
 * (`dsh-compaction-basic/lib/types/summarizer.d.ts:26-44`), specialised to the
 * unmarked arm: the arm for "a template, remote, or other summarizer", which is
 * what this engine is.
 *
 * The `llmStreamCall` arm is deliberately not modelled — this engine makes no
 * `ctx.llm.stream()` call, and claiming one would be a false durable record in
 * the `compaction/summary` event.
 */
interface StaticSummaryResult {
	/** Safe, text-only summary content. */
	summary: ContentBlock[]
	/** Route label recorded on the durable `compaction/summary` event. */
	provider: string
	/** Model label recorded on the durable `compaction/summary` event. */
	model: string
	/** Absent: no generation happened, so no generation cap applied. */
	maxTokens?: number
	/** Absent: no provider was called, so no usage was reported. */
	usage?: TokenUsage
	/** Complete output from an unmarked summarizer; this engine's output is its summary. */
	rawOutput?: ContentBlock[]
	/** An unmarked result does not identify a call through this context's LLM seam. */
	llmStreamCall?: never
}

/**
 * Stated when a rollover happens with no notebook on record.
 *
 * Deliberately not configurable and deliberately explicit: the whole point of
 * this engine is that the boundary is not a model summary, so the model must be
 * told plainly that nothing recorded the earlier context rather than being left
 * to infer that a summary exists.
 */
const NO_NOTEBOOK_NOTE = [
	'No persistent notebook was recorded in this session before the rollover.',
	'Nothing condensed the earlier transcript: recover whatever is still needed from the retained',
	'recent tail and from raw history at context_history.',
].join('\n')

/** Appended after a notebook truncated to the configured summary cap. */
const TRUNCATION_NOTE = '\n[notebook truncated to fit the static rollover summary; read context_history for the full text]'

/**
 * The pressure policy fields one engine resolved for its routed target.
 *
 * These are exactly the two fields `resolveCompactSpec`
 * (`dsh-compaction-basic/lib/index.js:124-150`) uses to derive
 * `thresholdTokens`, so reproducing the threshold from them cannot drift from
 * the parent's own trigger.
 */
export interface PressurePolicy {
	/** Window fraction for pressure; the parent's default is `0.8`. */
	readonly thresholdRatio: number
	/** Additional pressure headroom beyond the routed output reservation; the parent's default is `65536`. */
	readonly headroomTokens: number
}

/** One exact provider/model pressure override, structurally compatible with the parent's policy table. */
export interface PressurePolicyOverride {
	/** Registered provider route to match. */
	readonly provider: string
	/** Exact routed model id to match within `provider`. */
	readonly model: string
	/** Window fraction override for this exact target. */
	readonly thresholdRatio?: number
	/** Headroom override for this exact target. */
	readonly headroomTokens?: number
}

/**
 * The readable pressure policy of a live compaction service.
 *
 * `ctx.compaction` is typed as the abstract `CompactionEngine`, which exposes
 * none of this; the resolved policy lives on `BasicCompactionEngine`'s public
 * `readonly config`. Narrowing structurally — rather than casting to a concrete
 * class — keeps the reminder honest when a deployment mounts a different
 * backend: an engine without these fields is simply not one whose band can be
 * predicted, and the caller skips.
 */
export interface PressurePolicySource {
	/** Resolved default window fraction for pressure. */
	readonly thresholdRatio: number
	/** Resolved default headroom beyond the routed output reservation. */
	readonly headroomTokens: number
	/** Exact-target overrides, when the backend supports them. */
	readonly modelPolicies?: readonly PressurePolicyOverride[]
}

/**
 * Narrow an arbitrary value to a readable pressure policy.
 *
 * @param value - candidate, typically `ctx.compaction.config`.
 * @returns the policy source, or `undefined` when the value is not one.
 */
export function asPressurePolicySource(value: unknown): PressurePolicySource | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Record<string, unknown>
	const thresholdRatio = record['thresholdRatio']
	const headroomTokens = record['headroomTokens']
	if (typeof thresholdRatio !== 'number' || !Number.isFinite(thresholdRatio)) return undefined
	if (typeof headroomTokens !== 'number' || !Number.isFinite(headroomTokens)) return undefined
	const modelPolicies = record['modelPolicies']
	return {
		thresholdRatio,
		headroomTokens,
		...(Array.isArray(modelPolicies) ? { modelPolicies: modelPolicies as readonly PressurePolicyOverride[] } : {}),
	}
}

/**
 * Merge the exact-target override over the resolved default policy.
 *
 * Mirrors `resolveTargetPolicy` (`dsh-compaction-basic/lib/index.js:94-111`)
 * for the two fields the threshold depends on.
 *
 * @param source - the engine's resolved policy.
 * @param provider - exact routed provider.
 * @param model - exact routed model within `provider`.
 * @returns the effective pressure policy for that target.
 */
export function readPressurePolicy(source: PressurePolicySource, provider: string, model: string): PressurePolicy {
	const override = source.modelPolicies?.find((policy) => policy.provider === provider && policy.model === model)
	return {
		thresholdRatio: override?.thresholdRatio ?? source.thresholdRatio,
		headroomTokens: override?.headroomTokens ?? source.headroomTokens,
	}
}

/**
 * Derive the token count at which a rollover becomes eligible.
 *
 * Mirrors `resolveCompactSpec` (`dsh-compaction-basic/lib/index.js:124-150`)
 * exactly:
 *
 * ```
 * messageBudget   = contextWindow - reservedCompletionTokens
 * pressureBudget  = messageBudget  - headroomTokens
 * thresholdTokens = floor(min(contextWindow * thresholdRatio, pressureBudget))
 * ```
 *
 * Unlike the parent — which throws a `TargetPressureConfigError` from a step
 * boundary, where the automatic listener catches it — this returns `undefined`
 * for a capacity that leaves no message or pressure budget. The reminder must
 * never throw while a step is being admitted, and a target with no budget is
 * precisely a target whose rollover the parent will refuse to perform.
 *
 * @param policy - effective policy for the routed target.
 * @param contextWindow - adapter-declared combined request and response capacity.
 * @param reservedCompletionTokens - output tokens the routed request reserves.
 * @returns the threshold, or `undefined` when no positive budget exists.
 */
export function resolveThresholdTokens(
	policy: PressurePolicy,
	contextWindow: number,
	reservedCompletionTokens: number,
): number | undefined {
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
	if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) return undefined
	const messageBudgetTokens = contextWindow - reservedCompletionTokens
	if (messageBudgetTokens <= 0) return undefined
	const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens
	if (pressureBudgetTokens <= 0) return undefined
	return Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))
}

/**
 * Bound text to a character cap without splitting a surrogate pair.
 *
 * @param text - the text to bound.
 * @param maxChars - inclusive character cap.
 * @returns the text, truncated with {@link TRUNCATION_NOTE} when it exceeded the cap.
 */
function capChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	if (maxChars <= 0) return TRUNCATION_NOTE.trimStart()
	let end = maxChars
	const last = text.charCodeAt(end - 1)
	if (last >= 0xd800 && last <= 0xdbff) end -= 1
	return `${text.slice(0, end)}${TRUNCATION_NOTE}`
}

/**
 * The configuration object this engine is constructed with.
 *
 * The base knobs are plain values — the parent reads them by value in
 * `resolveConfig` (`dsh-compaction-basic/lib/index.js:59-124`) and rejects keys
 * it does not know, so wrapping them in handles would corrupt its arithmetic —
 * while this plugin's own fields are live {@link NotesLiveConfig} handles.
 *
 * The same object the entry row's `apply` receives, passed through unchanged:
 * `baseEngineConfig` is what narrows it for `super()`.
 */
export type NotesCompactionEngineConfig = BasicCompactionConfig & NotesLiveConfig

/**
 * Replay-aware compaction backend whose summary is a static, model-free
 * projection of the rollover template and the session's persistent notebook.
 */
export class NotesCompactionEngine extends BasicCompactionEngine {
	/**
	 * The live configuration object, composed with the parent's.
	 *
	 * This plugin's own fields are volatile handles, so every read goes through
	 * `.get()` **at the point of use** ({@link summarize} and
	 * {@link NotesCompactionEngine.staticSummary}). Holding this reference is
	 * correct; holding a `.get()` result in a field would freeze it at mount.
	 *
	 * Named `notes` rather than `config` because `config` is the parent's own
	 * public, authoritative resolved policy.
	 */
	readonly notes: NotesCompactionEngineConfig

	/**
	 * Deliberately **no** `static Config` override.
	 *
	 * The row plugin (`./index.ts`) owns the schema; this class is mounted as a
	 * child with the already-resolved config and inherits the parent's schema,
	 * which does not declare this plugin's volatile fields. That inheritance is
	 * load-bearing: re-validating a resolved volatile config against a schema
	 * that *does* declare those fields fails with validation issues, while the
	 * parent's schema passes the handles through **by reference**, preserving the
	 * identity that makes `loader/volatile-update` reach this instance. See the
	 * module docblock.
	 */

	/**
	 * Inherited from `BasicCompactionEngine` (`dsh-compaction-basic/lib/index.js:801-805`)
	 * and restated so the required services stay visible at this class's own
	 * declaration.
	 */
	static override inject = ['llm', 'tokenMeter', 'sessions']

	/**
	 * @param ctx - context providing the parent's injected services.
	 * @param config - the composed, already-resolved configuration holding live handles.
	 */
	constructor(ctx: Context, config: NotesCompactionEngineConfig) {
		super(ctx, baseEngineConfig(config))
		this.notes = config
	}

	/** The last `provider/model` whose absolute trigger was locked into {@link config}. */
	private lockedTarget: string | undefined

	/**
	 * Pin the absolute rollover trigger for one routed target.
	 *
	 * `thresholdTokens` is an absolute token count, but the backend's trigger is
	 * a ratio of the model's window, and the window is declared by the adapter and
	 * only resolvable at runtime. So the ratio is computed here, once per routed
	 * target, and swapped into the base backend's resolved config — the same
	 * object reference the backend re-reads on every step, so the very next
	 * pressure check uses it.
	 *
	 * ## The headroom is a cushion, never the trigger restated
	 *
	 * `headroomTokens` is written as the reserve itself — the same
	 * `max(15% of window, 16384)` derivation `reserveTokens` documents — and
	 * **never** as `window − desired`. The difference is not cosmetic. The base
	 * backend clamps the trigger with, in `messageBudgetTokens = contextWindow −
	 * reservedCompletionTokens`,
	 *
	 * ```
	 * thresholdTokens = floor(min(contextWindow × thresholdRatio,
	 *                           messageBudgetTokens − headroomTokens))
	 * ```
	 *
	 * A headroom of `window − desired` therefore collapses the second ceiling to
	 * `desired − reservedCompletionTokens`: the routed request's own output
	 * reservation is subtracted a second time, and the trigger the profile asked
	 * for shrinks by exactly that reservation. A `thresholdTokens: 450000` on a
	 * 1,000,000-token window whose request reserves 393,216 tokens for output
	 * fires at 56,784 — 5.7% of the window — rather than 450,000. Writing the
	 * reserve keeps each ceiling on its own quantity, and the effective trigger is
	 * then `min(desired, messageBudgetTokens − reserve)`: the point the profile
	 * asked for, or the latest point the window can hold when the routed output
	 * reservation leaves less than that. The shortfall is bounded by the reserve,
	 * so a target set too close to the window comes earlier by at most the
	 * cushion.
	 *
	 * The base config object is deeply frozen, so assignments into it cannot
	 * work; the reference itself is what gets replaced.
	 *
	 * Failure is never fatal: an unresolved window leaves the configured ratio in
	 * force, which is exactly what a profile that only set `thresholdRatio`
	 * expects. The attempt is remembered per target so a window that never
	 * resolves is not re-resolved on every step.
	 *
	 * @param contextWindow - the adapter-declared window, in tokens.
	 * @param target - the routed provider and model whose window this is.
	 * @returns whether an absolute trigger was locked.
	 */
	lockThreshold(contextWindow: number, target: { provider: string; model: string }): boolean {
		const trigger = this.notes.thresholdTokens?.get()
		if (trigger === undefined || !Number.isFinite(trigger) || trigger <= 0) return false
		if (!Number.isInteger(contextWindow) || contextWindow <= 0) return false
		const key = `${target.provider}/${target.model}`
		if (this.lockedTarget === key) return true
		/* A trigger at or past the window can never fire before the request
		 * overflows, so fall back to the window less the reserve — mirroring the
		 * base backend's own guard. */
		const reserve = resolveReserveTokens(contextWindow, this.notes.reserveTokens?.get())
		const desired = Math.min(trigger, contextWindow - reserve)
		if (desired <= 0) return false
		const next = {
			...this.config,
			thresholdRatio: desired / contextWindow,
			/* The cushion, NOT `contextWindow - desired`. See the module docblock
			 * above: the parent subtracts the routed output reservation and this
			 * headroom from the same window, so restating the trigger here
			 * subtracts the reservation twice. */
			headroomTokens: reserve,
		}
		;(this as { config: unknown }).config = next
		this.ctx.logger.debug(
			'notes-context: rollover trigger requested at %d tokens (window %d, reserve %d)',
			desired,
			contextWindow,
			reserve,
		)
		this.lockedTarget = key
		return true
	}

	/**
	 * Produce the static rollover checkpoint for one compacted region.
	 *
	 * ## Why the signature is annotated with local mirrors
	 *
	 * `SummarizationInput` and `SummaryResult` are declared in
	 * `dsh-compaction-basic/lib/types/summarizer.d.ts:20-44` but are **not
	 * re-exported** from the package entry point
	 * (`dsh-compaction-basic/lib/types/index.d.ts:13,15` imports the former and
	 * re-exports only the `types.ts` vocabulary), the exports map exposes no
	 * `./lib/types/summarizer` subpath, and no `src/` is shipped. The parent's
	 * hook types are therefore unnameable by any out-of-repo subclass. Annotation
	 * is nonetheless required: TypeScript does not contextually type an
	 * overriding method's parameters, so an unannotated override is an implicit
	 * `any`. {@link StaticSummarizationInput} and {@link StaticSummaryResult} are
	 * exact transcriptions of the parent's declarations, and the compiler
	 * re-checks them here as part of the override.
	 *
	 * The `input` replay is not read for content: this engine deliberately does
	 * not condense the conversation. It is only counted, for the diagnostic
	 * line, and the session's notebook is read through the log rather than
	 * through the replay so the notebook survives every earlier boundary.
	 *
	 * @param input - the replayed conversation prefix the parent priced.
	 * @param agent - the owning agent; supplies the session whose notebook is projected.
	 * @param signal - optional cancellation; never ignored, though the work here is synchronous.
	 * @returns the static summary blocks plus the configured static route label.
	 */
	protected override async summarize(
		input: StaticSummarizationInput,
		agent: Agent,
		signal?: AbortSignal,
	): Promise<StaticSummaryResult> {
		signal?.throwIfAborted()
		const notebook = latestNotebook(agent.session)
		signal?.throwIfAborted()
		this.ctx.logger.debug(
			'notes-context: static rollover over %d replayed messages (notebook revision %s)',
			input.messages.length,
			notebook?.revision ?? 'none',
		)
		const summary: ContentBlock[] = [{ type: 'text', text: this.staticSummary(notebook) }]
		signal?.throwIfAborted()
		return {
			summary,
			provider: this.notes.staticProvider.get(),
			model: this.notes.staticModel.get(),
		}
	}

	/**
	 * Compose the model-visible checkpoint body.
	 *
	 * Every field is read through `.get()` here, at the point of use, so a value
	 * committed by `loader/volatile-update` is picked up by the very next
	 * rollover — the template and the notebook cap included.
	 *
	 * @param notebook - the latest notebook revision, when one exists.
	 * @returns the rollover template followed by the notebook projection.
	 */
	private staticSummary(notebook: NotebookState | undefined): string {
		const rolloverText = this.notes.rolloverText.get()
		if (notebook === undefined) return `${rolloverText}\n\n${NO_NOTEBOOK_NOTE}`
		const capped = capChars(notebook.text, this.notes.notebookSummaryMaxChars.get())
		return `${rolloverText}\n\n${notebookBlock(capped)}`
	}

	/**
	 * The effective pressure policy for one routed target.
	 *
	 * Exposed so the reminder derives its band from the same resolved
	 * configuration the parent triggers on, rather than from a second copy of
	 * the defaults.
	 *
	 * @param provider - exact routed provider.
	 * @param model - exact routed model within `provider`.
	 * @returns the effective policy.
	 */
	resolvePressurePolicy(provider: string, model: string): PressurePolicy {
		return readPressurePolicy(this.config, provider, model)
	}
}
