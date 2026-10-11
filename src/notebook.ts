/**
 * The persistent notebook store: a plugin-owned projection over the session
 * log, fronted by a per-session registry of the newest revision.
 *
 * ## Why the notebook is not its own session event type
 *
 * The obvious design — declare `'notes-context/notebook'` in the merge-extensible
 * `SessionEventMap` — is **not usable by an out-of-repo plugin** in this build,
 * and it fails in a way that destroys the session rather than degrading:
 *
 * - `Session.append` structurally cannot set the envelope's `ignorable` marker.
 *   It builds the event as `{ type, seq, time, data, ...surfaceMetadata }` where
 *   `surfaceMetadata` is assembled from `surfaceOp` / `sourceEventSeqs` only
 *   (`dsh-session/lib/index.js:1441-1465`; `SurfaceIntent` is declared at
 *   `dsh-session/lib/types/types.d.ts:467-475`). Verified empirically: passing
 *   `{ ignorable: true }` as the third argument is silently swallowed.
 * - `KNOWN_SESSION_EVENT_TYPES` is a generated catalog of in-repo event types
 *   (`dsh-session/lib/types/known-event-types.js`), so an external plugin's type
 *   is never in it.
 * - The persistence read path therefore REFUSES the whole log:
 *   `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw ...`
 *   (`dsh-session-persistence/lib/index.js:182-184`). Verified by calling
 *   `validateStoredEvents` on a real appended event — it throws
 *   `SessionFormatUnsupportedError`, making the session unresumable.
 *
 * So a notebook revision is written as a **`user/message`** — a type the harness
 * already knows — carrying a plugin-owned `MessageSourceMap` kind. That kind is
 * a pure type-level merge (no runtime persistence consequence), and message
 * source admission deliberately preserves unknown kinds: it requires only a
 * non-empty `kind` string (`dsh-session/lib/index.js:1202`), and the format layer
 * rejects only a missing/non-string `kind` or the retired literal `'plugin'`
 * (`dsh-session-format-v3-to-v4/lib/index.js:124-127`).
 *
 * ## Why the write path does NOT append, and why a registry exists
 *
 * A tool body must not append its own model-visible message. Calling
 * `session.append('user/message', …)` from inside `execute` lands the message on
 * the surface BEFORE the tool result of the very call that produced it:
 * `executeToolCalls` appends results only after a whole group settles
 * (`dsh-agent-loop/lib/index.js:506-533`), so the surface became
 * `assistant(tool-call) → notebook → tool(result)`. That sequence is illegal and
 * a real provider rejects the request with HTTP 400 `invalid_request_error`.
 *
 * The ordering-correct channel is `exec.deferContext(message)`
 * (`dsh-tools/lib/types/index.d.ts:306-312`), which rides the tool result as
 * `additionalContexts` and is drained AFTER the result is appended:
 * `appendToolResult(...)` then `for (const context of result.additionalContexts ?? []) acceptContext(context)`
 * (`dsh-agent-loop/lib/index.js:570-573`). The loop's acceptor stages it in the
 * durable `next-step` inbox (`:1154`; `Inbox.splice` → `agent/inbox/spliced`,
 * `:159-177`), and the next `preStep` claims it (`:906`), so it materializes as
 * a `user/message` at the next step boundary (`:1061`).
 *
 * Between the `context_notes` call and that materialization the newest revision
 * exists only in memory, which is why this module keeps a per-session registry.
 * The registry is a front for the log, never a replacement: a resumed session
 * has the materialized `user/message` and is served entirely by the log scan.
 *
 * @module dsh-notes-context/notebook
 */
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionSeq as toSessionSeq } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { NOTEBOOK_SOURCE_KIND, notebookBlock, unwrapNotebookBlock } from './inject.ts'

/**
 * Model-facing name of the notebook tool.
 *
 * Declared here, in the lower layer, and re-exported by `tools.ts` as
 * `CONTEXT_NOTES_TOOL`: the log-recovery arm has to recognize the tool's call
 * events, so the name is part of the storage contract rather than a presentation
 * detail.
 */
export const CONTEXT_NOTES_TOOL_NAME = 'context_notes'

/** Reusable, stateless UTF-8 encoder. Never use `String.length` for the bound. */
const encoder = new TextEncoder()

/**
 * Measure a string's UTF-8 byte length.
 *
 * @param text - the text to measure.
 * @returns its encoded byte length, never the UTF-16 code-unit count.
 */
export function notebookBytes(text: string): number {
	return encoder.encode(text).byteLength
}

/** Raised when a notebook write would exceed `maxNotebookBytes`. */
export class NotebookTooLargeError extends Error {
	/** UTF-8 byte length the write attempted. */
	readonly bytes: number
	/** Configured bound the write violated. */
	readonly limit: number

	/**
	 * @param bytes - attempted UTF-8 byte length.
	 * @param limit - configured maximum.
	 */
	constructor(bytes: number, limit: number) {
		super(`notebook is ${bytes} bytes which exceeds the configured maxNotebookBytes of ${limit}`)
		this.name = 'NotebookTooLargeError'
		this.bytes = bytes
		this.limit = limit
	}
}

/**
 * The authoritative state of the persistent notebook.
 *
 * `visible` reports whether the revision is on the model-visible surface right
 * now. When it is false, {@link materialized} says which of two very different
 * situations applies:
 *
 * - `materialized: false` — the revision is awaiting delivery at the next step
 *   boundary; its `user/message` has not reached the log yet, so `seq` is
 *   `undefined`. Nothing is wrong and a repair must NOT re-publish it.
 * - `materialized: true` — the revision reached the log but a rollover SHADOWED
 *   it, so it stays readable while dropping out of context. This is the
 *   condition a repair must act on, and re-publishing is the correct response.
 */
export interface NotebookState {
	/** The notebook text exactly as written. */
	readonly text: string
	/** Monotonic revision counter, `1` for the first write. */
	readonly revision: number
	/** UTF-8 byte length of {@link text}, recomputed from the text. */
	readonly bytes: number
	/** Log position once materialized; `undefined` while still pending delivery. */
	readonly seq: SessionSeq | undefined
	/** Whether the revision is on the model-visible surface right now. */
	readonly visible: boolean
	/** Whether the revision has reached the session log yet. */
	readonly materialized: boolean
	/**
	 * Whether {@link revision} is an authoritative counter value. False when the
	 * only recoverable trace was a requested write (`tool/call` arguments), whose
	 * revision is an estimate from its ordinal position among the notebook writes
	 * in the log. Consumers must not mint a new revision from an untrusted value's
	 * successor without that caveat in mind.
	 */
	readonly revisionTrusted: boolean
}

/**
 * What the registry tracks for the newest revision: identity plus content.
 *
 * `id` is the message identity, which survives materialization verbatim — the
 * claimed inbox batch is appended as-is (`dsh-agent-loop/lib/index.js:1061`), so
 * a registry entry can be correlated with its log event by identity rather than
 * by content.
 */
interface NotebookRecord {
	readonly id: string
	readonly text: string
	readonly revision: number
	readonly bytes: number
}

/** All per-session state this module keeps. Dies with the session. */
interface SessionNotebookState {
	/**
	 * Bumped by {@link writeNotebook}. A write changes what `latestNotebook`
	 * answers while changing NEITHER the log (`writeNotebook` does not append) NOR
	 * the surface, so it is the only signal that can invalidate the memo for that
	 * window. Without it a write would serve the previous revision until its
	 * message materialized, corrupting both the rollover projection and the
	 * repair guard.
	 */
	version: number
	/** The newest revision written in this process, if any. */
	pending: NotebookRecord | undefined
	/**
	 * Set when a write is authoritatively known to have FAILED (an over-bound
	 * rejection). The rejected text still appears in the log as a `tool/call`
	 * argument, so recovery must not resurrect a revision the plugin already
	 * refused — which is precisely the case a restart-inside-the-window test
	 * would otherwise get wrong.
	 */
	revisionTombstone: string | undefined
	/** Memoized last answer and the exact state it was computed from. */
	memo: { key: string; value: NotebookState | undefined } | undefined
}

/** Per-session state. Keyed by the session so it cannot outlive it. */
const states = new WeakMap<Session, SessionNotebookState>()

/** Read (and lazily create) one session's state. */
function stateOf(session: Session): SessionNotebookState {
	let state = states.get(session)
	if (state === undefined) {
		state = { version: 0, pending: undefined, revisionTombstone: undefined, memo: undefined }
		states.set(session, state)
	}
	return state
}

/** Whether a value is a non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recover one revision from a message-shaped record, or `undefined` when it is
 * not a well-formed notebook revision.
 *
 * Used for both durable shapes: a delivered `user/message` event payload, whose
 * `data` IS the message, and an entry of `agent/inbox/spliced`'s `inserted[]`.
 *
 * Everything returned is re-derived from what was actually persisted — the byte
 * count included — so a stale or forged field cannot lie.
 *
 * @param data - candidate message record.
 * @returns the recovered record, or `undefined` when it is not a well-formed
 *   notebook revision.
 */
function recordFromMessage(data: Record<string, unknown>): NotebookRecord | undefined {
	const source = data['source']
	if (!isRecord(source) || source['kind'] !== NOTEBOOK_SOURCE_KIND) return undefined
	const revision = source['revision']
	if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
	const id = data['id']
	if (typeof id !== 'string' || id === '') return undefined
	const content = data['content']
	if (!Array.isArray(content) || content.length !== 1) return undefined
	const block: unknown = content[0]
	if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return undefined
	// The stored content carries the untrusted-record wrapper (see `writeNotebook`);
	// the model must get back exactly what it wrote, or a read → edit → write cycle
	// would append another wrapper every time.
	const text = unwrapNotebookBlock(block['text'])
	return { id, text, revision, bytes: notebookBytes(text) }
}

/**
 * Recover one revision from a `user/message` log event, or `undefined` when the
 * event is not a well-formed notebook revision.
 *
 * A malformed revision returns `undefined` so the newest-to-oldest scan can
 * continue to an older valid one instead of letting the malformed entry mask it.
 *
 * @param event - one immutable session log entry.
 * @returns the recovered record, or `undefined`.
 */
function recordFromEvent(event: SessionEvent): NotebookRecord | undefined {
	if (event.type !== 'user/message') return undefined
	const data: unknown = event.data
	return isRecord(data) ? recordFromMessage(data) : undefined
}

/** A revision recovered from the log, plus whether it has been delivered yet. */
interface LogRecord extends NotebookRecord {
	/** Seq of the event the revision was recovered from. */
	readonly seq: SessionSeq
	/** True for a delivered `user/message`; false for a still-pending inbox splice. */
	readonly materialized: boolean
	/**
	 * False when the revision number could not be trusted — the
	 * {@link RECOVERY_ARM_TOOL_CALL} arm reads a request, which carries no
	 * revision. The caller substitutes its own estimate rather than letting an
	 * invented number collide with the monotone counter.
	 */
	readonly revisionTrusted: boolean
}

/** The two durable pending lists of the agent inbox. */
const INBOX_TARGETS = ['next-turn', 'next-step'] as const

/** Reconstruct the inbox's pending messages from its splices, up to a seq bound. */
function inboxAt(session: Session, event: SessionEvent): UserMessage[] {
	const state: Record<(typeof INBOX_TARGETS)[number], UserMessage[]> = { 'next-turn': [], 'next-step': [] }
	for (let index = 0; index < session.seq; index += 1) {
		const candidate = session.eventAt(toSessionSeq(index))
		if (candidate === undefined) break
		if (Number(candidate.seq) > Number(event.seq)) break
		if (candidate.type !== 'agent/inbox/spliced') continue
		const splice: unknown = candidate.data
		if (!isRecord(splice)) continue
		const target = splice['target']
		if (target !== 'next-turn' && target !== 'next-step') continue
		const start = splice['start']
		if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) continue
		const inserted = splice['inserted']
		if (!Array.isArray(inserted)) continue
		const messages: UserMessage[] = []
		for (const message of inserted) {
			if (isRecord(message) && typeof message['id'] === 'string') messages.push(message as unknown as UserMessage)
		}
		// `removedCount` is absent for a pure insert; mirror the inbox fold's tolerance.
		const removedCount = typeof splice['removedCount'] === 'number' ? splice['removedCount'] : 0
		state[target].splice(start, removedCount, ...messages)
	}
	return [...state['next-turn'], ...state['next-step']]
}

/**
 * Scan the raw log newest-to-oldest for the newest notebook revision.
 *
 * Both durable shapes are recognized, because a revision reaches the log twice
 * on its way to the model:
 *
 * - a delivered `user/message` carrying our source kind;
 * - an `agent/inbox/spliced` event whose `inserted[]` carries our message — the
 *   deferred context staged by `Inbox.splice` before the next step boundary. The
 *   complete `UserMessage`, `source.kind` and `revision` included, is inside that
 *   core event, which is why a revision that is never delivered is still
 *   recoverable after a resume (the in-memory registry does not survive one).
 *
 * A spliced match counts only if it is still pending when the scan reaches it:
 * the inbox fold is replayed deterministically through that event's own seq, and
 * the message counts only while present in the rebuilt pending lists. A splice
 * that later removed it therefore does not resurrect it. Because the scan runs
 * backwards and a materialized message always follows the splice that produced
 * it, a delivered revision is found first and the splice is never reached.
 *
 * It reads the RAW log rather than the derived surface on purpose: the notebook
 * must outlive a compaction/rollover boundary, which replaces surface messages,
 * and shadowing is exactly the condition reported through `visible`.
 *
 * NOTE: `eventAt` / `snapshotEvents` / `ownEvents` all carry `@deprecated` in
 * 0.2.0-rc.2 ("new calls are prohibited", see
 * `dsh-session/lib/types/index.d.ts:175-207`). We deliberately use `eventAt`
 * anyway, mirroring the sanctioned in-repo precedent in
 * `dsh-tool-skill/lib/index.js:331-350` (`catalogHistory`), which performs the
 * identical newest-to-oldest `user/message` source-kind scan over a live session.
 * The async `ctx.sessionQuery.readSession(...)` path is for persisted sessions
 * and is wrong for this hot path.
 *
 * @param session - the live session to read.
 * @returns the newest valid revision and its delivery state, or `undefined` when
 *   none was ever written or every candidate is malformed.
 */
function scanLog(session: Session): LogRecord | undefined {
	/** The newest revision from an authoritative arm, if any. */
	let authoritative: LogRecord | undefined
	/** The newest accepted-write revision recorded by a tool result. */
	let accepted: { revision: number; seq: SessionSeq } | undefined
	/** The newest requested write, whether or not it was ever accepted. */
	let requested: { text: string; seq: SessionSeq } | undefined
	for (let index = session.seq - 1; index >= 0; index -= 1) {
		const event = session.eventAt(toSessionSeq(index))
		if (event === undefined) {
			throw new Error(`notes-context cannot read seq ${String(index)} below the current Session length`)
		}
		const delivered = recordFromEvent(event)
		if (delivered !== undefined) {
			authoritative ??= { ...delivered, seq: event.seq, materialized: true, revisionTrusted: true }
			continue
		}
		if (event.type === 'agent/inbox/spliced') {
			const pending = inboxAt(session, event)
			for (const message of pending) {
				const data: unknown = message
				if (!isRecord(data)) continue
				const source = data['source']
				if (!isRecord(source) || source['kind'] !== NOTEBOOK_SOURCE_KIND) continue
				const record = recordFromMessage(data)
				if (record === undefined) continue
				authoritative ??= { ...record, seq: event.seq, materialized: false, revisionTrusted: true }
				break
			}
			continue
		}
		if (accepted === undefined) {
			const revision = revisionFromToolResult(event)
			if (revision !== undefined) accepted = { revision, seq: event.seq }
		}
		if (requested === undefined && event.type === 'tool/call') {
			const text = recordFromToolCall(event)
			if (text !== undefined) requested = { text, seq: event.seq }
		}
	}

	// Precedence, highest first:
	//   1. a delivered `user/message` (authoritative content AND revision)
	//   2. a pending `agent/inbox/spliced` (authoritative content AND revision)
	//   3. a `tool/result` carrying a `Notebook revision N` account — an accepted
	//      write: authoritative revision, but the text is not in the result
	//   4. a `tool/call` argument — the request only: authoritatively the text, but
	//      NO trustworthy revision, and no proof the write was accepted.
	//
	// (4) is used when the newest thing in the log is a request with no accepted
	// result after it, which is exactly the crash-inside-the-window case.
	if (authoritative !== undefined) return authoritative
	if (requested !== undefined && (accepted === undefined || requested.seq > accepted.seq)) {
		const text = requested.text
		return {
			id: '',
			text,
			// Not an ordinal guess: this write IS the next revision after the newest
			// accepted one. It is still flagged untrusted, and `writeNotebook` never
			// lets an untrusted number feed allocation, so the flag stays honest.
			revision: (accepted?.revision ?? 0) + 1,
			bytes: notebookBytes(text),
			seq: requested.seq,
			materialized: false,
			revisionTrusted: false,
		}
	}
	if (accepted === undefined) return undefined
	// An accepted write with nothing newer. Its revision is authoritative, but the
	// RESULT does not carry the notebook text — that lived in the deferred message,
	// which was discarded before delivery. Reporting a revision with empty content
	// would claim the notebook is empty, which is a different and false statement,
	// so no state is returned; the revision is still honoured by
	// {@link trustedRevision}, which reads `accepted` directly.
	return undefined
}

/**
 * The newest authoritative revision number, or `undefined` when none exists.
 *
 * Used for revision ALLOCATION, so it deliberately ignores the `tool/call`
 * recovery arm: the agent loop logs a `tool/call` for the write CURRENTLY being
 * served, and counting that would make the first write of every session report
 * revision 2 and inflate every write after it.
 *
 * Three sources are merged: the newest revision recorded in the log (delivered
 * message, pending splice, or accepted `tool/result`), and the newest revision
 * this process allocated but has not delivered yet — which is in none of them,
 * because `writeNotebook` does not append.
 *
 * @param session - the live session to read.
 * @returns the highest revision known to have been issued; the next is this + 1.
 */
function trustedRevision(session: Session): number {
	let log = 0
	for (let index = session.seq - 1; index >= 0; index -= 1) {
		const event = session.eventAt(toSessionSeq(index))
		if (event === undefined) break
		const delivered = recordFromEvent(event)
		if (delivered !== undefined) {
			log = Math.max(log, delivered.revision)
			break
		}
		if (event.type === 'agent/inbox/spliced') {
			let found = 0
			for (const message of inboxAt(session, event)) {
				const data: unknown = message
				if (!isRecord(data)) continue
				const source = data['source']
				if (!isRecord(source) || source['kind'] !== NOTEBOOK_SOURCE_KIND) continue
				const record = recordFromMessage(data)
				if (record !== undefined) found = Math.max(found, record.revision)
			}
			if (found > 0) {
				log = Math.max(log, found)
				break
			}
		}
		const accepted = revisionFromToolResult(event)
		if (accepted !== undefined) {
			log = Math.max(log, accepted)
			break
		}
	}
	return Math.max(log, stateOf(session).pending?.revision ?? 0)
}

/**
 * Recognizes the revision account this plugin's own tool result renders.
 *
 * Pattern-matched rather than carried as a structured field because that is
 * genuinely what the durable record is: `tools.ts` renders this prefix from the
 * canonical `revision` value. This regex IS the contract between that `render`
 * and log recovery — the em dash is deliberately not followed by a required
 * space, so a change to the surrounding wording cannot silently disable recovery.
 */
const REVISION_ACCOUNT = /Notebook revision (\d+) —/

/**
 * The revision an accepted `context_notes` write recorded in its tool result.
 *
 * This is the authoritative shape for a write whose deferred message never
 * arrived: the result is durable, and the number in it was rendered from the
 * canonical value rather than inferred from a count.
 *
 * @param event - one session log entry.
 * @returns the recorded revision, or `undefined` when this result records none.
 */
function revisionFromToolResult(event: SessionEvent): number | undefined {
	if (event.type !== 'tool/result') return undefined
	const data: unknown = event.data
	if (!isRecord(data)) return undefined
	const message = data['message']
	if (!isRecord(message)) return undefined
	const content = message['content']
	if (!Array.isArray(content)) return undefined
	for (const block of content) {
		if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') continue
		const match = REVISION_ACCOUNT.exec(block['text'])
		const digits = match?.[1]
		if (digits === undefined) continue
		const revision = Number(digits)
		if (Number.isSafeInteger(revision) && revision >= 1) return revision
	}
	return undefined
}

/**
 * Recover the notebook text a `context_notes` call asked to write.
 *
 * This is the last-resort recovery arm: a `tool/call` event is logged BEFORE
 * `execute` runs, so it survives a crash inside the window where nothing else
 * about the write is durable yet. It records the REQUEST, not the outcome, so it
 * cannot prove the write was accepted — see {@link newestToolCallWrite}, which
 * deliberately re-validates the byte bound.
 *
 * A later read call carries no `text` and is therefore skipped rather than
 * shadowing an earlier write.
 *
 * @param event - one session log entry.
 * @returns the requested text, or `undefined` when this is not a notebook write.
 */
function recordFromToolCall(event: SessionEvent): string | undefined {
	if (event.type !== 'tool/call') return undefined
	const data: unknown = event.data
	if (!isRecord(data)) return undefined
	if (data['name'] !== CONTEXT_NOTES_TOOL_NAME) return undefined
	const raw = data['arguments']
	if (typeof raw !== 'string') return undefined
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!isRecord(parsed)) return undefined
		const text = parsed['text']
		return typeof text === 'string' ? text : undefined
	} catch {
		return undefined
	}
}

/**
 * Find the newest notebook revision and report its delivery and surface state.
 *
 * Resolution order:
 *
 * 1. The session registry — the newest revision written in THIS process, which
 *    is authoritative while that revision is still awaiting delivery. It is what
 *    makes a revision readable from the instant `context_notes` returns.
 * 2. The raw log — authoritative after a resume, and once a revision is durable
 *    in either of its two shapes (delivered `user/message`, or still-pending
 *    `agent/inbox/spliced`).
 *
 * A registry entry is dropped as soon as the log catches up, so the two sources
 * cannot drift. Malformed log revisions are skipped; the newest valid wins.
 *
 * If the newest materialized revision is shadowed, that invisible revision IS the
 * state returned (with `visible: false`) rather than an older visible one: the
 * repair is to re-publish the newest content, not to resurrect an older revision.
 *
 * The log scan is O(n) and runs on the hot path of every step, so the answer is
 * memoized per session. The memo key must cover all THREE ways the answer can
 * change, because no single one of them covers the others:
 *
 * - `session.seq` — log growth, including an `agent/inbox/spliced` that changes
 *   the answer without delivering anything.
 * - `session.surface.contentGeneration` — committed replacements and plugin-owned
 *   message changes; this is what catches a notebook being SHADOWED, the
 *   `visible: true → false` transition (`dsh-session/lib/types/surface.d.ts:122-124`).
 * - the per-session `version` bumped by {@link writeNotebook} — a write changes
 *   the answer while moving neither the log nor the surface.
 *
 * A `session.seq`-only key would serve a stale revision for the whole write →
 * materialization window.
 *
 * @param session - the live session to read.
 * @returns the newest state, or `undefined` when no revision exists.
 */
export function latestNotebook(session: Session): NotebookState | undefined {
	const state = stateOf(session)
	const key = `${String(session.seq)}:${String(session.surface.contentGeneration)}:${String(state.version)}`
	const memo = state.memo
	if (memo !== undefined && memo.key === key) return memo.value
	const value = resolveNotebook(session, state)
	state.memo = { key, value }
	return value
}

/**
 * Compute the newest notebook state, reconciling the registry against the log.
 *
 * @param session - the live session to read.
 * @param state - the session's per-session state.
 * @returns the newest state, or `undefined` when no revision exists.
 */
function resolveNotebook(session: Session, state: SessionNotebookState): NotebookState | undefined {
	const newest = scanLog(session)
	const pending = state.pending
	if (pending !== undefined) {
		if (newest !== undefined && newest.id === pending.id) {
			// The deferred context is durable; the log is now authoritative.
			state.pending = undefined
		} else if (newest !== undefined && newest.revisionTrusted && newest.revision >= pending.revision) {
			// A newer revision reached the log without going through this process
			// (a resume, or another writer); the registry entry is stale.
			state.pending = undefined
		} else if (newest !== undefined && !newest.revisionTrusted) {
			// The registry entry predates this process's view of the log; the
			// recovered request is newer. Superseded.
			state.pending = undefined
		} else {
			// The registry holds the only copy, or the newest revision.
			return {
				text: pending.text,
				revision: pending.revision,
				bytes: pending.bytes,
				seq: undefined,
				visible: false,
				materialized: false,
				revisionTrusted: true,
			}
		}
	}
	if (newest === undefined) return undefined
	if (state.revisionTombstone !== undefined && newest.text === state.revisionTombstone) {
		// The only recoverable write is one this process already rejected. Truthfully
		// report that no notebook exists rather than resurrect it; the model must
		// issue a whole new (smaller) write.
		return undefined
	}
	return {
		text: newest.text,
		revision: newest.revision,
		bytes: newest.bytes,
		seq: newest.seq,
		// A still-pending splice is not on the surface; only a delivered message
		// can be, and shadowing is reported truthfully from surface membership.
		visible: newest.materialized && new Set<number>(session.surface.nodes).has(newest.seq),
		materialized: newest.materialized,
		revisionTrusted: newest.revisionTrusted,
	}
}

/**
 * Convenience wrapper returning only the latest notebook text.
 *
 * @param session - the live session to read.
 * @returns the notebook text, or `undefined` when no revision exists.
 */
export function latestNotebookText(session: Session): string | undefined {
	return latestNotebook(session)?.text
}

/** Inputs for {@link writeNotebook}. */
export interface WriteNotebookOptions {
	/** Reject writes longer than this many UTF-8 bytes. */
	readonly maxNotebookBytes: number
}

/**
 * A notebook revision that has been validated and recorded but not yet delivered.
 *
 * The message is handed to `exec.deferContext` by the caller; see this module's
 * header for why appending it directly corrupts the surface.
 */
export interface PendingNotebook {
	/** The complete replacement text. */
	readonly text: string
	/** Monotonic revision number allocated for this write. */
	readonly revision: number
	/** UTF-8 byte length of {@link text}. */
	readonly bytes: number
	/** The identified message to defer; carries the plugin-owned source kind. */
	readonly message: UserMessage
}

/**
 * Record that a write was authoritatively REJECTED, so recovery does not
 * resurrect it.
 *
 * The rejected text still reaches the log as a `tool/call` argument (that event
 * is written before `execute` runs), so without this a rejected over-bound write
 * would come back as the current notebook after a restart — resurrecting a
 * revision the plugin already refused. Call this from the rejection path, next
 * to the throw.
 *
 * @param session - the session the write was attempted on.
 * @param text - the text that was rejected.
 */
export function markNotebookWriteRejected(session: Session, text: string): void {
	const state = stateOf(session)
	state.revisionTombstone = text
	state.version += 1
}

/**
 * Validate a notebook write, allocate its revision, and record it.
 *
 * Performs NO session append. The byte bound is checked BEFORE any state change,
 * so an over-long notebook neither leaves a partial record nor consumes a
 * revision number.
 *
 * The revision is readable through {@link latestNotebook} the moment this
 * returns, which upholds the invariant that a revision is readable from the
 * moment the tool call completes even though its message is delivered later.
 *
 * The message content is WRAPPED with the untrusted-record warning here — where
 * the notebook is stored — because that warning has to travel with the text as
 * it is replayed to the model at a later step boundary.
 * {@link latestNotebook} unwraps it again, so read → edit → write is idempotent.
 *
 * @param session - the live session the revision belongs to.
 * @param text - the complete replacement notebook text.
 * @param options - the configured byte bound.
 * @returns the validated revision and its message, ready for `deferContext`.
 * @throws {NotebookTooLargeError} when `text` exceeds `options.maxNotebookBytes`.
 */
export function writeNotebook(session: Session, text: string, options: WriteNotebookOptions): PendingNotebook {
	const bytes = notebookBytes(text)
	if (bytes > options.maxNotebookBytes) throw new NotebookTooLargeError(bytes, options.maxNotebookBytes)
	const revision = trustedRevision(session) + 1
	const state = stateOf(session)
	const message: UserMessage = createUserMessage({
		// The wrapper is applied HERE, where the notebook is stored, because the
		// warning must travel with the text as it is replayed to the model at a
		// later step boundary. Without it the deferred materialization is raw
		// model-authored text arriving as an apparent user instruction — the exact
		// injection conduit the warning exists to defuse.
		content: [{ type: 'text', text: notebookBlock(text) }],
		source: { kind: NOTEBOOK_SOURCE_KIND, revision },
	})
	state.pending = { id: String(message.id), text, revision, bytes }
	// An accepted write supersedes an earlier rejection of the same text.
	if (state.revisionTombstone === text) state.revisionTombstone = undefined
	// Invalidate the memo: this write changes what `latestNotebook` answers while
	// changing neither the log nor the surface.
	state.version += 1
	return { text, revision, bytes, message }
}

/**
 * The sequence number of the newest materialized notebook revision.
 *
 * @param session - the live session to read.
 * @returns the revision's event seq, or `undefined` while it is still pending or
 *   when no revision exists.
 */
export function latestNotebookSeq(session: Session): SessionSeq | undefined {
	return latestNotebook(session)?.seq
}
