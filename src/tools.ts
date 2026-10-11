/**
 * The two model-facing tools of `dsh-notes-context`.
 *
 * - `context_notes` — read, replace, or clear the persistent notebook.
 * - `context_history` — read the ACTIVE session's raw transcript back by stable
 *   sequence range, including the compaction/rollover boundaries in it.
 *
 * Registration is an effect: `registerTools` is called from the plugin's `apply`
 * and Cordis removes both tools when the fiber disposes. Nothing here mutates
 * module-level state, and every tunable comes from {@link Config}.
 *
 * @module dsh-notes-context/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageSource } from '@deepseek-ai/dsh-llm/message'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import {
	CONTEXT_NOTES_TOOL_NAME,
	NotebookTooLargeError,
	latestNotebook,
	markNotebookWriteRejected,
	notebookBytes,
	writeNotebook,
} from './notebook.ts'
import { NOTEBOOK_SOURCE_KIND } from './inject.ts'

/**
 * Model-facing name of the notebook tool.
 *
 * Re-exported from `notebook.ts` rather than declared here: the log-recovery arm
 * there has to recognize this tool's `tool/call` events, so the name is part of
 * the storage contract.
 */
export const CONTEXT_NOTES_TOOL = CONTEXT_NOTES_TOOL_NAME

/** Model-facing name of the raw-history tool. */
export const CONTEXT_HISTORY_TOOL = 'context_history'

/**
 * Event-type prefix for the log events a compaction transaction emits. Matched
 * by prefix rather than against a closed union on purpose: this package does not
 * declare the `compaction/*` session events (they belong to
 * `@deepseek-ai/dsh-compaction`), so switching on those literals would be a
 * non-exhaustive comparison against `SessionEventMap` from here.
 */
const BOUNDARY_EVENT_PREFIX = 'compaction/'

/**
 * Whether one log event marks a rollover/compaction boundary.
 *
 * Two shapes count, because the boundary is visible on two different surfaces:
 *
 * 1. The `compaction/*` transaction events, from the raw log.
 * 2. The REPLACEMENT `user/message` the backend publishes as the boundary's
 *    model-visible record — recognized by its `compact-checkpoint` source using
 *    the backend-independent predicate `isCompactCheckpointSource`
 *    (`@deepseek-ai/dsh-compaction`, `lib/types/checkpoint.d.ts:37`, runtime at
 *    `lib/index.js:128-130`). Checking the source rather than the event type is
 *    what makes this work for every backend, and it is the shape this plugin's
 *    own notebook has to survive.
 *
 * @param event - one session log entry.
 * @returns whether the event is a rollover/compaction boundary.
 */
function isBoundaryEvent(event: SessionEvent): boolean {
	if (event.type.startsWith(BOUNDARY_EVENT_PREFIX)) return true
	if (event.type !== 'user/message') return false
	const data: unknown = event.data
	if (!isRecord(data)) return false
	const source = data['source']
	return isRecord(source) && isCompactCheckpointSource(source as MessageSource)
}

/** Whether a value is a non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the live session a tool call runs against.
 *
 * A tool with no active agent (for example an out-of-band protocol invocation)
 * has no session to read or write, so this fails loudly rather than inventing
 * one.
 *
 * @param agent - `exec.agent`, present when the agent loop dispatched the call.
 * @returns the live session.
 * @throws {Error} when the call has no agent or no session.
 */
function requireSession(agent: Agent | undefined): Session {
	if (agent === undefined) throw new Error('this tool requires an active agent session')
	return agent.session
}

/**
 * Truncate a summary to the configured character cap.
 *
 * @param text - the raw summary text.
 * @param cfg - resolved configuration supplying the cap and marker.
 * @returns the possibly-truncated summary.
 */
function truncateSummary(text: string, cfg: Config): string {
	// Read once per operation: a live settings write between two reads of the same
	// field would otherwise produce a summary truncated by one cap and suffixed by
	// another configuration's marker.
	const cap = cfg.historySummaryMaxChars.get()
	if (text.length <= cap) return text
	return text.slice(0, cap) + cfg.summaryTruncationMarker.get()
}

/**
 * Extract the readable text of a message-shaped payload.
 *
 * @param message - candidate message record.
 * @returns the concatenated text blocks, or `undefined` when none are present.
 */
function messageText(message: Record<string, unknown>): string | undefined {
	const content = message['content']
	if (!Array.isArray(content)) return undefined
	const parts: string[] = []
	for (const block of content) {
		if (!isRecord(block)) continue
		if (block['type'] !== 'text') continue
		const text = block['text']
		if (typeof text === 'string') parts.push(text)
	}
	return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Build a compact, one-line-ish account of one log event for the model.
 *
 * The projection is lossy by design — {@link CONTEXT_HISTORY_TOOL} exists so the
 * model can pull any exact range it still needs, and `raw: true` returns the
 * original JSON for a single call.
 *
 * @param event - one session log entry.
 * @param cfg - resolved configuration supplying the cap and marker.
 * @returns the summary string.
 */
function summarizeEvent(event: SessionEvent, cfg: Config): string {
	const data: unknown = event.data
	if (!isRecord(data)) return ''
	switch (event.type) {
		case 'user/message':
		case 'system/message':
		case 'tool/result': {
			const text = messageText(data)
			return text === undefined ? '' : truncateSummary(text, cfg)
		}
		case 'assistant/message': {
			const message = data['message']
			const text = isRecord(message) ? messageText(message) : undefined
			return text === undefined ? '' : truncateSummary(text, cfg)
		}
		case 'developer/message': {
			const message = data['message']
			const text = isRecord(message) ? messageText(message) : undefined
			const account = text === undefined ? '' : truncateSummary(text, cfg)
			return truncateSummary(`turn ${String(data['turn'])} step ${String(data['step'])} ${account}`, cfg)
		}
		case 'tool/call':
			return truncateSummary(`${String(data['name'])} ${JSON.stringify(data['arguments'] ?? null)}`, cfg)
		case 'turn/start':
		case 'turn/end':
		case 'step/start':
		case 'step/end':
		case 'request/header':
		case 'request/context':
			return truncateSummary(JSON.stringify(data), cfg)
		default:
			return truncateSummary(JSON.stringify(data), cfg)
	}
}

/** One returned transcript entry with its stable sequence identity. */
export interface HistoryEntry {
	/** Stable session sequence number, usable as `from`/`to` on a later call. */
	readonly seq: number
	/** Session event type. */
	readonly type: string
	/** Compact account of the event. */
	readonly summary: string
}

/** Canonical value returned by {@link CONTEXT_HISTORY_TOOL}. */
export interface HistoryValue {
	/** Returned entries in ascending sequence order. */
	readonly entries: HistoryEntry[]
	/** Rendered transcript text. */
	readonly text: string
	/** Total events in the session log, before range filtering and limits. */
	readonly total: number
}

/** Internal transcript projection, before it is split into entries. */
interface HistoryTranscript {
	/** One rendered line per returned event, in ascending sequence order. */
	readonly lines: readonly string[]
	/** The joined transcript text, with header. */
	readonly text: string
	/** Total events in the session log, before range filtering and limits. */
	readonly total: number
}

/**
 * Assemble the rendered transcript.
 *
 * Selection keeps the NEWEST events: with no explicit range a bounded sliding
 * window over the newest `historyDefaultLimit` events is taken, and with an
 * explicit range the newest `maxHistoryEntries` within that range are taken.
 * Either way the oldest events are the ones dropped, so a limit never hides
 * recent work.
 *
 * Rendering then walks NEWEST to OLDEST, so the UTF-8 byte budget
 * (`maxHistoryBytes`) also cuts the tail last. An entry that would exceed the
 * budget is dropped whole rather than split, so every returned `seq` is a range
 * the model can re-read exactly. Lines are finally reversed into ascending
 * sequence order for readability.
 *
 * @param session - the live session to read.
 * @param from - inclusive lower bound, or `undefined` for the log start.
 * @param to - inclusive upper bound, or `undefined` for the current end.
 * @param raw - whether to emit raw JSON instead of summaries.
 * @param cfg - resolved configuration supplying every limit.
 * @param signal - caller-owned cancellation.
 * @returns the rendered transcript.
 */
function readHistory(
	session: Session,
	from: number | undefined,
	to: number | undefined,
	raw: boolean,
	cfg: Config,
	signal: AbortSignal,
): HistoryTranscript {
	const events = session.snapshotEvents()
	const total = events.length
	const lower = from ?? 0
	const upper = to ?? (total - 1)
	// With an explicit range the caller asked for exactly that window, so the
	// ceiling is the hard cap only. With no range the caller wants "recent
	// history", so a bounded sliding window over the newest events applies —
	// this is what `historyDefaultLimit` configures.
	const callerBounded = from !== undefined || to !== undefined
	const ceiling = callerBounded ? cfg.maxHistoryEntries.get() : Math.min(cfg.historyDefaultLimit.get(), cfg.maxHistoryEntries.get())
	const byteBudget = cfg.maxHistoryBytes.get()
	const selected: SessionEvent[] = []
	for (const event of events) {
		const seq = Number(event.seq)
		if (seq < lower || seq > upper) continue
		if (selected.length >= ceiling) selected.shift()
		selected.push(event)
	}
	const reversed: string[] = []
	const reversedSeqs: number[] = []
	let bytes = 0
	for (let index = selected.length - 1; index >= 0; index -= 1) {
		if (signal.aborted) throw new Error(`${CONTEXT_HISTORY_TOOL} was cancelled`)
		const event = selected[index]
		if (event === undefined) continue
		const seq = Number(event.seq)
		const boundary = isBoundaryEvent(event) ? ` ${cfg.historyBoundaryMarker.get()}` : ''
		const body = raw ? JSON.stringify(event.data) : summarizeEvent(event, cfg)
		const line = `#${seq} ${event.type}${boundary}\n${body}`
		const lineBytes = notebookBytes(line)
		if (reversedSeqs.length > 0 && bytes + lineBytes > byteBudget) break
		reversed.push(line)
		reversedSeqs.push(seq)
		bytes += lineBytes
	}
	if (reversedSeqs.length === 0) return { lines: [], text: '', total }
	const newestSeq = reversedSeqs[0] as number
	const oldestSeq = reversedSeqs[reversedSeqs.length - 1] as number
	const header = `session ${String(session.id)} · entries #${oldestSeq}-#${newestSeq} of ${total} events\n\n`
	return { lines: reversed.reverse(), text: header + reversed.join('\n\n'), total }
}

/**
 * Register both tools when the feature is enabled.
 *
 * Call this from `apply`. When `cfg.enabled.get()` is false NEITHER tool is registered,
 * so a disabled plugin leaves the model's tool catalog untouched.
 *
 * @param ctx - plugin context; registration goes through `ctx.tools`.
 * @param cfg - resolved configuration.
 * @returns true when the tools were registered, false when disabled.
 */
export function registerTools(ctx: Context, cfg: Config): boolean {
	if (!cfg.enabled.get()) return false

	ctx.tools.register(
		defineTool({
			name: CONTEXT_NOTES_TOOL,
			description:
				'Read or replace your persistent notebook. The notebook is a durable, model-written record that survives context rollovers; it is replayed to you at the start of later context windows. Call with no `text` to read the current notebook, with `text` to replace it wholesale, or with an empty `text` to clear it. Keep it short and high-signal: it is a working state record, not a transcript.',
			parameters: {
				text: {
					type: 'string',
					description:
						'Complete replacement notebook text. Omit to read the notebook. Pass an empty string to clear it.',
				},
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						present: { type: 'boolean', required: true },
						visible: { type: 'boolean', required: true },
						materialized: { type: 'boolean', required: true },
						revisionTrusted: { type: 'boolean', required: true },
						text: { type: 'string', required: true },
						bytes: { type: 'integer', required: true },
						maxBytes: { type: 'integer', required: true },
						revision: { type: 'integer' },
					},
				},
				/**
				 * Renders the notebook text WITHOUT the untrusted-record wrapper.
				 *
				 * That is deliberate and safe: this is a tool RESULT, which the model
				 * reads as the answer to its own call, not as an instruction. The
				 * wrapper's job is to frame the copy that arrives later as an apparent
				 * user turn, and that copy — the deferred `user/message` — carries it
				 * (see `writeNotebook`). Keeping this render unwrapped is also what lets
				 * a read → edit → write cycle be idempotent, because the model gets back
				 * exactly the text it stored.
				 */
				render: (_args, value) => {
					const remaining = Math.max(0, value.maxBytes - value.bytes)
					if (!value.present) {
						return [
							{
								type: 'text',
								text: `No notebook exists yet. Call ${CONTEXT_NOTES_TOOL} with text to create one (limit ${value.maxBytes} bytes).`,
							},
						]
					}
					return [
						{
							type: 'text',
							text: [
								`Notebook revision ${String(value.revision ?? 0)} — ${String(value.bytes)}/${String(value.maxBytes)} bytes (${String(remaining)} remaining).`,
								value.visible
									? 'This revision is currently in your context.'
									: value.materialized
										? 'NOTE: this revision was dropped from your visible context by a rollover; the text below is read from the log and is authoritative.'
										: 'This revision was accepted and is queued for delivery to you at the next step boundary (it is not in your context yet).',
								'',
								value.text,
							].join('\n'),
						},
					]
				},
			},
			/**
			 * Reads may overlap; a write must not. Revision allocation is a
			 * read-then-write (`(latestNotebook(session)?.revision ?? 0) + 1` in
			 * `writeNotebook`), so two parallel writes would allocate the SAME
			 * revision number and break revision-keyed re-publication. Only a call
			 * with no `text` — a pure read — is parallel-safe.
			 */
			isConcurrencySafe: (args) => args.text === undefined,
			async execute(args, exec) {
				const session = requireSession(exec.agent)
				// Read live, not at registration: registration is a mount-time effect,
				// but the switch itself is a volatile field, so a settings write that
				// flips it must take effect on the NEXT call rather than at the next
				// app start. The tools stay in the model's catalog until unmount, so
				// this guard — not the registration gate — is what a live `false`
				// actually enforces.
				if (!cfg.enabled.get()) throw new Error(`${CONTEXT_NOTES_TOOL} is disabled by configuration`)
				// One read per call: the byte bound actually enforced and the bound
				// reported back to the model must be the same number, even if a live
				// settings write lands mid-call.
				const maxNotebookBytes = cfg.maxNotebookBytes.get()
				if (exec.signal.aborted) throw new Error(`${CONTEXT_NOTES_TOOL} was cancelled`)
				if (args.text !== undefined) {
					// Validated, revision-allocated, and recorded — but deliberately NOT
					// appended. Appending here would place this user/message on the
					// surface BEFORE the tool result of this very call, and a provider
					// rejects an assistant tool call that is not immediately followed by
					// its result. `deferContext` rides the result instead and is drained
					// only after that result is committed.
					let written
					try {
						written = writeNotebook(session, args.text, { maxNotebookBytes })
					} catch (error) {
						// The rejected text is already in the log as this call's `tool/call`
						// argument, so tell the store not to resurrect it on recovery.
						if (error instanceof NotebookTooLargeError) markNotebookWriteRejected(session, args.text)
						throw error
					}
					exec.deferContext(written.message)
					return {
						present: written.text.length > 0,
						visible: false,
						materialized: false,
						revisionTrusted: true,
						text: written.text,
						bytes: written.bytes,
						maxBytes: maxNotebookBytes,
						revision: written.revision,
					}
				}
				const revision = latestNotebook(session)
				if (revision === undefined) {
					return {
						present: false,
						visible: false,
						materialized: false,
						revisionTrusted: true,
						text: '',
						bytes: 0,
						maxBytes: maxNotebookBytes,
					}
				}
				const present = revision.text.length > 0
				return {
					present,
					visible: present && revision.visible,
					materialized: revision.materialized,
					revisionTrusted: revision.revisionTrusted,
					text: revision.text,
					bytes: revision.bytes,
					maxBytes: maxNotebookBytes,
					revision: revision.revision,
				}
			},
		}),
	)

	ctx.tools.register(
		defineTool({
			name: CONTEXT_HISTORY_TOOL,
			description:
				'Read this session\'s raw transcript back from the event log. Returns stable `seq` ids so you can re-read a precise range, and marks rollover/compaction boundaries. Use this whenever a summary, notebook entry, or your own recollection is not enough and you need what was actually said.',
			parameters: {
				from: { type: 'integer', description: 'Inclusive starting seq. Defaults to the start of the log.' },
				to: { type: 'integer', description: 'Inclusive ending seq. Defaults to the newest event.' },
				raw: { type: 'boolean', description: 'Return raw event JSON instead of compact summaries.' },
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						entries: {
							type: 'array',
							required: true,
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									seq: { type: 'integer', required: true },
									type: { type: 'string', required: true },
									summary: { type: 'string', required: true },
								},
							},
						},
						text: { type: 'string', required: true },
						total: { type: 'integer', required: true },
					},
				},
				render: (_args, value) => [{ type: 'text', text: value.text }],
			},
			isConcurrencySafe: () => true,
			async execute(args, run) {
				const session = requireSession(run.agent)
				if (!cfg.enabled.get()) throw new Error(`${CONTEXT_HISTORY_TOOL} is disabled by configuration`)
				if (args.from !== undefined && args.to !== undefined && args.from > args.to) {
					throw new Error(`context_history: from (${String(args.from)}) must not exceed to (${String(args.to)})`)
				}
				const transcript = readHistory(session, args.from, args.to, args.raw === true, cfg, run.signal)
				const entries: HistoryEntry[] = []
				for (const line of transcript.lines) {
					const newline = line.indexOf('\n')
					const head = newline === -1 ? line : line.slice(0, newline)
					const body = newline === -1 ? '' : line.slice(newline + 1)
					if (!head.startsWith('#')) continue
					const [seqText, typeText] = head.slice(1).split(' ', 2)
					if (seqText === undefined || typeText === undefined) continue
					entries.push({ seq: Number(seqText), type: typeText, summary: body })
				}
				return { entries, text: transcript.text, total: transcript.total }
			},
		}),
	)

	return true
}

export { NotebookTooLargeError, NOTEBOOK_SOURCE_KIND }
