/**
 * The per-window rollover reminder, and the notebook-visibility repair.
 *
 * ## One listener, two bounded jobs
 *
 * 1. **Reminder.** When measured pressure enters the configured band
 *    `[threshold - lead, threshold)`, tell the model once — and only once per
 *    context window — to bring its persistent notebook up to date before the
 *    boundary. The band is disjoint from the parent's own trigger, which fires
 *    at or above `threshold` (`dsh-compaction-basic/lib/index.js:941`), so a
 *    reminder and a rollover can never describe the same step.
 * 2. **Repair.** A notebook revision is a `user/message`, which makes it a
 *    surface node; a rollover can therefore *shadow* it, leaving it readable in
 *    the log but invisible to the model exactly across the boundary it was
 *    written for. When the newest revision is off the surface, it is delivered
 *    again, once per revision.
 *
 * Nothing else is injected. In particular there is no "refresh the notebook"
 * path: while a revision is visible the model already has it as an ordinary
 * message, and re-sending it would deliver the same text twice.
 *
 * ## Why delivery goes through the returned decision
 *
 * `agent/pre-step` is a waterfall, and `step()` appends every entry of the
 * returned `decision.messages` as a `user/message` with `surfaceOp: 'append'`
 * (`dsh-agent-loop/lib/index.js:1061`) *before* the request is built (`:1065`).
 * So extending that array lands the message in **this** step, durably, with the
 * loop owning the append. This module never calls `session.append` itself.
 *
 * ## The turn-liveness guard is load-bearing
 *
 * That same array is the loop's turn-liveness test
 * (`dsh-agent-loop/lib/index.js:962-966`): a decision with no messages ends the
 * turn, so a listener that appends unconditionally manufactures a step — and
 * keeps manufacturing them, one per reminder — instead of letting the agent go
 * idle. Both injections here are therefore gated on the loop having decided to
 * enter the step for its own reasons, which makes them incapable of changing
 * any turn's outcome.
 *
 * @module dsh-notes-context/reminder
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq as toSessionSeq } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
/* Type-only, erased at build time: loads `dsh-token-meter`'s `Context`
 * augmentation so `ctx.tokenMeter` is typed. The runtime service is supplied by
 * whatever mounts the meter. */
import type {} from '@deepseek-ai/dsh-token-meter'
import { resolveReminderBand, type Config as NotesLiveConfig } from './config.ts'
import { asPressurePolicySource, readPressurePolicy, resolveThresholdTokens } from './engine.ts'
import type { PressurePolicySource } from './engine.ts'
import { notebookMessage, reminderMessage } from './inject.ts'
import { latestNotebook } from './notebook.ts'
import { CONTEXT_NOTES_TOOL } from './tools.ts'

/**
 * The reminder body.
 *
 * Not configurable, and deliberately not wrapped by `notebookBlock`: this text
 * is plugin-authored instruction, not model-written notebook content, so the
 * untrusted-record warning would misdescribe it — `inject.ts` reserves that
 * framing for content that has no instruction authority. The tool name is
 * interpolated from its single definition so a rename cannot strand this copy.
 */
const REMINDER_TEXT = `<context-window-reminder>
The current context window is nearing its rollover threshold. Before important details fall out of the live tail, use ${CONTEXT_NOTES_TOOL} to save a concise durable notebook: current task state, decisions, changed files, evidence, blockers, and exact next steps. Keep the notebook a compact index with one line per item, no copied logs or file bodies, and replace stale entries instead of appending so it stays well under the configured cap. Do not request a new window until the notebook is current.
</context-window-reminder>`

/**
 * Per-session bookkeeping for both jobs.
 *
 * Held in a `WeakMap` owned by one {@link registerNotesReminder} call — never a
 * module global — so two mounted contexts (or a reload) cannot share or leak
 * each other's state, and a disposed session's record is collected with it.
 */
interface ReminderState {
	/** Whether the pre-existing rollover boundary has been recovered from the log. */
	recovered: boolean
	/** Seq of the rollover that opened the current window; `-1` while none has happened. */
	boundary: number
	/** True between an unmatched `compaction/start` and its `compaction/end`. */
	compacting: boolean
	/** Boundary the reminder was delivered for; `undefined` means never delivered. */
	remindedBoundary: number | undefined
	/** Notebook revision most recently re-published; `undefined` means never. */
	republishedRevision: number | undefined
	/** Route-and-window key the cached threshold belongs to. */
	thresholdKey: string | undefined
	/** Rollover threshold cached for {@link thresholdKey}, when it resolved. */
	thresholdTokens: number | undefined
}

/** A fresh record for one newly seen session. */
function newState(): ReminderState {
	return {
		recovered: false,
		boundary: -1,
		compacting: false,
		remindedBoundary: undefined,
		republishedRevision: undefined,
		thresholdKey: undefined,
		thresholdTokens: undefined,
	}
}

/**
 * Recover the rollover boundary a resumed or already-running session starts
 * with, so "once per window" is not reset by a process restart.
 *
 * A single newest-to-oldest scan for the latest `compaction/*` marker, run at
 * most once per session. It mirrors the parent's own
 * `inspectCompactionEntryState` (`dsh-compaction-basic/lib/index.js:704-736`),
 * which performs the identical reverse scan on a live session, and — like
 * `dsh-tool-skill/lib/index.js:331-350` — accepts the `@deprecated` log read
 * because the async persisted-session query path is wrong for a step boundary.
 *
 * The first `compaction/*` marker found is decisive: an unmatched
 * `compaction/start` means a transaction is open, and a `compaction/end` means
 * the newest boundary is that end.
 *
 * @param session - the live session to scan.
 * @param state - the record to populate.
 */
function recoverBoundary(session: Session, state: ReminderState): void {
	state.recovered = true
	for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
		const event = session.eventAt(toSessionSeq(seq))
		if (event === undefined) return
		if (event.type === 'compaction/start') {
			state.compacting = true
			state.boundary = Number(event.seq)
			return
		}
		if (event.type === 'compaction/end') {
			state.boundary = Number(event.seq)
			return
		}
	}
}

/** The notebook text and revision to deliver again, when a repair is due. */
interface RepublishPlan {
	/** The stored notebook text, exactly as the model wrote it. */
	readonly text: string
	/** The revision being re-delivered. */
	readonly revision: number
}

/**
 * Decide whether the newest notebook revision needs re-delivering.
 *
 * ## The three states a revision can be in
 *
 * - **pending** — queued for delivery into a later step (the write path defers
 *   it so a notebook never lands between an assistant tool call and its tool
 *   result, which providers reject). It has no durable event yet.
 * - **visible** — materialized as a `user/message` and still on the surface.
 * - **shadowed** — materialized, then dropped from the surface by a rollover.
 *
 * Only **shadowed** is this function's business. A visible revision is already
 * in front of the model, and a pending one is already on its way: re-injecting
 * either would deliver the same text twice. The test is therefore positive — the
 * revision must have reached the log *and* be off the surface — never merely
 * "not visible", which `materialized: false` also satisfies.
 *
 * The `seq` assertion after `materialized` is belt-and-braces rather than a
 * restatement: `materialized` is the contract, and a durable event to repair is
 * the precondition this function actually needs. If the two flags ever
 * disagreed, declining to repair is the safe direction — a missing repair is
 * recoverable on a later step, whereas a double delivery is not.
 *
 * Synchronous and pure apart from reading the session, so it can be planned
 * before the rest of the waterfall runs.
 *
 * @param session - the live session.
 * @param state - the session's record.
 * @param config - resolved plugin configuration.
 * @returns the plan, or `undefined` when nothing is due.
 */
function planRepublish(session: Session, state: ReminderState, config: NotesLiveConfig): RepublishPlan | undefined {
	if (!config.enabled.get()) return undefined
	const notebook = latestNotebook(session)
	if (notebook === undefined) return undefined
	/* Pending delivery: the next-step inbox already carries it. */
	if (!notebook.materialized) return undefined
	/* In context: the model is already looking at it. */
	if (notebook.visible) return undefined
	/* No durable event to repair — decline rather than risk a double delivery. */
	if (notebook.seq === undefined) return undefined
	if (state.republishedRevision === notebook.revision) return undefined
	return { text: notebook.text, revision: notebook.revision }
}

/**
 * Decide whether the reminder is due for the window now open.
 *
 * Pressure is measured **before** the remainder of the waterfall runs, because
 * the parent's automatic compaction runs inside `next()`
 * (`dsh-compaction-basic/lib/index.js:839-852`). The two triggers are disjoint —
 * the parent compacts at or above the threshold, this band is strictly below
 * it — so the pre-compaction measurement is the same one the parent will judge,
 * and no reminder can be emitted for a step in which a rollover also happened.
 *
 * @param ctx - context supplying the token meter and the LLM capability lookup.
 * @param session - the live session.
 * @param state - the session's record.
 * @param config - resolved plugin configuration.
 * @param signal - the turn's cancellation signal.
 * @returns the boundary the reminder is due for, or `undefined`.
 */
async function planReminder(
	ctx: Context,
	session: Session,
	state: ReminderState,
	config: NotesLiveConfig,
	signal: AbortSignal,
	warnNoEngine: () => void,
): Promise<number | undefined> {
	if (!config.enabled.get() || !config.reminderEnabled.get()) return undefined
	/* A compaction transaction is open; the window it opens does not exist yet. */
	if (state.compacting) return undefined
	/* Already reminded for this window. */
	if (state.remindedBoundary === state.boundary) return undefined
	/* Mirrors the parent's `routedTarget()` (:743-750): without a durable routed
	 * target the parent cannot compact at all, so there is no boundary to warn
	 * about and no threshold to measure against. */
	const routed = session.requestHeader()?.config
	if (routed === undefined || routed.provider.length === 0 || routed.model.length === 0) return undefined

	const source = mountedPolicySource(ctx)
	if (source === undefined) {
		warnNoEngine()
		return undefined
	}

	const tokens = ctx.tokenMeter.measure(session).totalTokens
	const key = `${state.boundary}|${routed.provider}/${routed.model}`
	if (state.thresholdKey !== key) {
		try {
			const info = await ctx.llm.resolveModelInfo(routed.provider, routed.model, signal)
			const contextWindow = info.context?.contextWindow
			if (contextWindow !== undefined) {
				/* Lock the absolute trigger BEFORE reading the policy the band
				 * derives from, so the reminder and the backend judge the same
				 * number. A profile that set only `thresholdRatio` is unaffected:
				 * the lock is a no-op without `thresholdTokens`. */
				lockAbsoluteTrigger(ctx, contextWindow, routed)
			}
			/* Re-read the policy: the lock above replaced the engine's resolved
			 * config with one carrying this window's ratio, and the band must
			 * derive from the number the backend will actually judge. The
			 * snapshot taken before the lock predates that replacement, so using
			 * it would schedule a window's reminder against the configured
			 * default ratio — far above the locked trigger, and therefore never
			 * delivered before the rollover it is meant to precede. */
			const policy = readPressurePolicy(mountedPolicySource(ctx) ?? source, routed.provider, routed.model)
			state.thresholdTokens =
				contextWindow === undefined
					? undefined
					: resolveThresholdTokens(policy, contextWindow, routed.maxTokens ?? info.defaultMaxTokens ?? 0)
		} catch (error) {
			if (signal.aborted) return undefined
			ctx.logger.warn(
				'notes-context: cannot resolve %s/%s capacity for the rollover reminder: %o',
				routed.provider,
				routed.model,
				error,
			)
			state.thresholdTokens = undefined
		}
		/* Cache the attempt, successful or not, so a target that advertises no
		 * capacity is not re-resolved on every step of the same window. */
		state.thresholdKey = key
	}
	const thresholdTokens = state.thresholdTokens
	if (thresholdTokens === undefined) return undefined

	/* The lead is derived from the threshold, exactly as upstream derives it, so
	 * there is nothing to read live here and no field to clamp. */
	const band = resolveReminderBand(thresholdTokens)
	if (tokens < band.start || tokens >= band.end) return undefined
	return state.boundary
}

/**
 * Ask the mounted backend to pin its absolute trigger for this window.
 *
 * Best-effort by design: the backend narrows structurally, so a backend that
 * does not expose {@link NotesCompactionEngine.lockThreshold} simply keeps its
 * ratio, and a lock that throws must not abort the step that is being admitted.
 *
 * @param ctx - context holding the optional compaction service.
 * @param contextWindow - the adapter-declared window, in tokens.
 * @param routed - the routed provider and model whose window this is.
 */
function lockAbsoluteTrigger(
	ctx: Context,
	contextWindow: number,
	routed: { provider: string; model: string },
): void {
	const service = ctx.get('compaction') as { lockThreshold?: (window: number, target: unknown) => boolean } | undefined
	try {
		service?.lockThreshold?.(contextWindow, routed)
	} catch (error) {
		ctx.logger.warn('notes-context: cannot lock the absolute rollover trigger: %o', error)
	}
}

/**
 * Read the mounted compaction backend's resolved pressure policy.
 *
 * `ctx.compaction` is typed as the abstract `CompactionEngine`, which exposes
 * no policy at all — the resolved defaults live on `BasicCompactionEngine`'s
 * public `config` and are materialised in its constructor from private
 * defaults (`dsh-compaction-basic/lib/index.js:59-124`). Narrowing
 * structurally, rather than casting to a concrete class, keeps this honest: a
 * backend that does not expose these fields simply has no predictable band, and
 * the reminder declines to guess one.
 *
 * @param ctx - the context holding the optional compaction service.
 * @returns the policy source, or `undefined` when the mounted backend exposes none.
 */
function mountedPolicySource(ctx: Context): PressurePolicySource | undefined {
	const service = ctx.get('compaction')
	if (service === undefined) return undefined
	const config: unknown = (service as { readonly config?: unknown }).config
	return asPressurePolicySource(config)
}

/**
 * Install the reminder and the notebook-visibility repair.
 *
 * One `agent/pre-step` listener, registered with `{ prepend: true }` so it runs
 * before the compaction backend's pressure listener (`prepend` is an `unshift`
 * into a single hook list and waterfall listeners run front-to-back —
 * `cordis/lib/index.js:336`, `:317-327`). Its own reads therefore complete
 * before `compactIfNeeded` runs inside `next()`, and its injections are added to
 * the decision the rest of the chain produced.
 *
 * Both jobs are planned before `next()` and delivered after it, each in its own
 * `try`/`catch`, so a failure in one cannot suppress the other and neither can
 * abort a turn.
 *
 * @param ctx - the plugin context; the listener is disposed with it.
 * @param config - resolved plugin configuration.
 */
export function registerNotesReminder(ctx: Context, config: NotesLiveConfig): void {
	const states = new WeakMap<Session, ReminderState>()
	let warnedNoEngine = false
	/** The mounted backend exposes no readable policy; say so once, not once per step. */
	const warnNoEngine = (): void => {
		if (warnedNoEngine) return
		warnedNoEngine = true
		ctx.logger.warn(
			'notes-context: the mounted compaction engine exposes no readable pressure policy; the rollover reminder is disabled',
		)
	}

	/** The session's record, recovering its boundary on first sight. */
	const stateOf = (session: Session): ReminderState => {
		let state = states.get(session)
		if (state === undefined) {
			state = newState()
			states.set(session, state)
		}
		if (!state.recovered) recoverBoundary(session, state)
		return state
	}

	/* Track boundaries as they are created, so the common path never re-scans. */
	ctx.on('session/event', (session, event) => {
		const state = states.get(session)
		if (state === undefined) return
		if (event.type === 'compaction/start') state.compacting = true
		else if (event.type === 'compaction/end') {
			state.compacting = false
			state.boundary = Number(event.seq)
		}
	})

	ctx.on(
		'agent/pre-step',
		async ({ agent, signal }, next) => {
			const session = agent.session
			const state = stateOf(session)

			let republish: RepublishPlan | undefined
			try {
				republish = planRepublish(session, state, config)
			} catch (error) {
				ctx.logger.warn('notes-context: notebook re-publication check failed: %o', error)
			}

			let reminderBoundary: number | undefined
			try {
				reminderBoundary = signal.aborted
					? undefined
					: await planReminder(ctx, session, state, config, signal, warnNoEngine)
			} catch (error) {
				ctx.logger.warn('notes-context: rollover reminder check failed: %o', error)
			}

			const decision = await next()
			if (decision.kind !== 'enter') return decision
			if (signal.aborted) return decision
			/* Never manufacture a step: an empty decision is how the loop ends a
			 * turn and how it declines to open one (`dsh-agent-loop:962-966`). */
			if (decision.messages.length === 0) return decision

			const added: UserMessage[] = []
			if (reminderBoundary !== undefined) {
				added.push(reminderMessage(REMINDER_TEXT))
				state.remindedBoundary = reminderBoundary
			}
			if (republish !== undefined) {
				added.push(notebookMessage(republish.text, { revision: republish.revision }))
				state.republishedRevision = republish.revision
			}
			if (added.length === 0) return decision
			return { ...decision, messages: [...decision.messages, ...added] }
		},
		{ prepend: true },
	)
}
