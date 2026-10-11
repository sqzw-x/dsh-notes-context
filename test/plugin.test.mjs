/**
 * Unit tests for the parts of `dsh-notes-context` that are testable without a
 * live agent loop: the pure helpers, the notebook registry, and the schema.
 *
 * The end-to-end behaviour (rollover, reminder delivery, provider message
 * ordering) is verified against a real provider in `research/verification-report.md`;
 * these tests cover the logic those runs cannot exercise cheaply.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, SessionSeq } from '@deepseek-ai/dsh-session'

import { updateVolatile } from '@deepseek-ai/cosmokit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

import {
	Config,
	DEFAULT_ROLLOVER_TEMPLATE,
	NotebookTooLargeError,
	baseEngineConfig,
	latestNotebook,
	notebookBlock,
	notebookBytes,
	resolveReminderBand,
	resolveReminderLeadTokens,
	resolveReserveTokens,
	writeNotebook,
} from '../lib/index.js'

/** A fresh store + session per test, so no test can observe another's state. */
function newSession(id) {
	const ctx = new Context()
	const store = new SessionStore(ctx)
	return store.create(SessionId(id))
}

/** The plugin's own defaults, read from the real schema. */
function notesConfig(overrides = {}) {
	return Config['~standard'].validate({ enabled: true, ...overrides }).value
}

/**
 * The `writeNotebook` options built from the real configuration.
 *
 * Every plugin-owned field resolves to a volatile read/write handle, not a plain
 * value, so it must be read through `.get()`. Passing the whole config object as
 * options silently yields `maxNotebookBytes: undefined`, which disabled the byte
 * guard in an earlier revision of this file — hence this single explicit helper
 * rather than ad-hoc option objects at each call site.
 *
 * @param overrides - raw config overrides validated through the real schema.
 * @returns options for `writeNotebook` with plain values.
 */
function writeOptions(overrides = {}) {
	return { maxNotebookBytes: notesConfig(overrides).maxNotebookBytes.get() }
}

// ---------------------------------------------------------------- byte measurement

test('notebookBytes measures UTF-8 bytes, not UTF-16 code units', () => {
	// The bound is a byte bound; String.length would under-count CJK by 3x.
	assert.equal('中文笔记'.length, 4)
	assert.equal(notebookBytes('中文笔记'), 12)
	assert.equal(notebookBytes(''), 0)
	assert.equal(notebookBytes('ascii'), 5)
	// Astral plane: one code point, 4 UTF-8 bytes, 2 UTF-16 units.
	assert.equal('😀'.length, 2)
	assert.equal(notebookBytes('😀'), 4)
})

// ---------------------------------------------------------------- reminder band

test('resolveReminderBand derives the lead with the upstream formula', () => {
	// The lead is DERIVED, not configured: min(32000, max(8192, floor(threshold * 0.125))).
	// 800k -> raw 100k -> capped at the 32000 ceiling.
	assert.deepEqual(resolveReminderBand(800_000), { start: 768_000, end: 800_000 })
	// A small threshold clamps up to the 8192 floor: 10k -> raw 1250 -> 8192.
	assert.deepEqual(resolveReminderBand(10_000), { start: 1_808, end: 10_000 })
	// The headline example: an absolute 450k trigger reminds at 418k.
	assert.deepEqual(resolveReminderBand(450_000), { start: 418_000, end: 450_000 })
	// The band scales with the threshold, and the lead never exceeds it.
	for (const threshold of [200_000, 850_000, 1_000_000, 2_000_000]) {
		const band = resolveReminderBand(threshold)
		assert.ok(band.start >= 0, `band start stays non-negative at ${threshold}`)
		assert.ok(band.start < band.end, `band is non-empty at ${threshold}`)
	}
})

test('resolveReminderBand is the empty band for a non-positive threshold', () => {
	assert.deepEqual(resolveReminderBand(0), { start: 0, end: 0 })
	assert.deepEqual(resolveReminderBand(-5), { start: 0, end: 0 })
	assert.deepEqual(resolveReminderBand(Number.NaN), { start: 0, end: 0 })
	assert.deepEqual(resolveReminderBand(Number.POSITIVE_INFINITY), { start: 0, end: 0 })
})

test('resolveReminderLeadTokens matches the upstream derivation at its boundaries', () => {
	// Below the floor's crossover the lead is flat at 8192...
	assert.equal(resolveReminderLeadTokens(100), 8192)
	assert.equal(resolveReminderLeadTokens(65_535), 8192)
	// ...then follows the fraction until the ceiling takes over.
	assert.equal(resolveReminderLeadTokens(200_000), 25_000)
	assert.equal(resolveReminderLeadTokens(450_000), 32_000)
	assert.equal(resolveReminderLeadTokens(1_000_000), 32_000)
	assert.equal(resolveReminderLeadTokens(Number.NaN), 8192)
})

test('resolveReserveTokens derives the upstream reserve unless one is set', () => {
	// 15% of the window, floored at 16384.
	assert.equal(resolveReserveTokens(1_000_000), 150_000)
	assert.equal(resolveReserveTokens(200_000), 30_000)
	assert.equal(resolveReserveTokens(32_000), 16_384)
	assert.equal(resolveReserveTokens(100_000), 16_384)
	// An explicit reserve wins outright, including 0.
	assert.equal(resolveReserveTokens(1_000_000, 65_536), 65_536)
	assert.equal(resolveReserveTokens(1_000_000, 0), 0)
	// An unusable window still yields the absolute floor rather than NaN.
	assert.equal(resolveReserveTokens(Number.NaN), 16_384)
})

// ---------------------------------------------------------------- schema

test('the composed schema fills base compaction defaults and plugin defaults', () => {
	const resolved = notesConfig()
	// Plugin-owned.
	assert.equal(resolved.maxNotebookBytes.get(), 16384)
	assert.equal(resolved.reminderEnabled.get(), true)
	assert.equal(resolved.rolloverText.get(), DEFAULT_ROLLOVER_TEMPLATE)
	// Base-engine-owned: composed in, so a user configures them on the same row.
	assert.equal(resolved.modelPolicies.length, 0)
})

test('a user-set base knob survives the composed schema', () => {
	const resolved = notesConfig({ thresholdRatio: 0.55, retainTokens: 4321, auto: false })
	assert.equal(resolved.thresholdRatio, 0.55)
	assert.equal(resolved.retainTokens, 4321)
	assert.equal(resolved.auto, false)
})

// ---------------------------------------------------------------- notebook write

test('writeNotebook stores a revision without appending to the log', () => {
	const session = newSession('write-1')
	const before = session.seq
	const written = writeNotebook(session, 'BLUE-HERON-77', writeOptions())
	// The write must NOT touch the log: appending from inside a tool body would
	// land the notebook before that tool's own result.
	assert.equal(session.seq, before)
	assert.equal(written.revision, 1)
	assert.equal(written.bytes, 13)
	assert.equal(written.message.content[0].text.includes('BLUE-HERON-77'), true)
	assert.equal(written.message.source.kind, 'notes-context/notebook')
	// Readable from the instant the call returns, before any materialization.
	const state = latestNotebook(session)
	assert.equal(state?.text, 'BLUE-HERON-77')
	assert.equal(state?.revision, 1)
	assert.equal(state?.materialized, false)
	assert.equal(state?.visible, false)
})

test('the byte bound is enforced before any state changes', () => {
	const session = newSession('bound-1')
	const before = session.seq
	assert.throws(
		() => writeNotebook(session, 'x'.repeat(20_001), writeOptions()),
		(err) => err instanceof NotebookTooLargeError && err.bytes === 20_001 && err.limit === 16384,
	)
	// No partial write, and the revision counter was not consumed.
	assert.equal(session.seq, before)
	assert.equal(latestNotebook(session), undefined)
})

test('revisions are monotone and the newest valid one wins', () => {
	const session = newSession('rev-1')
	assert.equal(writeNotebook(session, 'first', writeOptions()).revision, 1)
	assert.equal(writeNotebook(session, 'second', writeOptions()).revision, 2)
	assert.equal(writeNotebook(session, 'third', writeOptions()).revision, 3)
	assert.equal(latestNotebook(session)?.text, 'third')
	assert.equal(latestNotebook(session)?.revision, 3)
})

test('a session that logs its own tool/call first still starts at revision 1', () => {
	// The agent loop logs `tool/call` BEFORE the tool's execute runs, so a real
	// session always has a tool/call for the write currently being served. That
	// call must not be counted as a prior revision.
	const session = newSession('rev-call-1')
	session.append('tool/call', {
		callId: 'call-1',
		name: 'context_notes',
		arguments: JSON.stringify({ text: 'FIRST' }),
	})
	assert.equal(writeNotebook(session, 'FIRST', writeOptions()).revision, 1)
})

test('revisions stay exactly sequential when every call is logged first', () => {
	const session = newSession('rev-seq')
	for (let n = 1; n <= 3; n += 1) {
		session.append('tool/call', {
			callId: `call-${n}`,
			name: 'context_notes',
			arguments: JSON.stringify({ text: `v${n}` }),
		})
		const written = writeNotebook(session, `v${n}`, writeOptions())
		assert.equal(written.revision, n, `write ${n} should allocate revision ${n}`)
		session.append('tool/result', {
			callId: `call-${n}`,
			name: 'context_notes',
			message: {
				id: written.message.id,
				role: 'tool',
				content: [{ type: 'text', text: `Notebook revision ${n} — ${written.bytes}/16384 bytes.\n${written.text}` }],
				source: { kind: 'tool', toolCallId: `call-${n}` },
				toolCallId: `call-${n}`,
			},
		}, { surfaceOp: 'append' })
		// The write's own message is delivered by deferContext, not session.append.
	}
	assert.equal(latestNotebook(session)?.revision, 3)
})

test('clearing the notebook is a revision, not a deletion', () => {
	const session = newSession('clear-1')
	writeNotebook(session, 'something', writeOptions())
	const cleared = writeNotebook(session, '', writeOptions())
	assert.equal(cleared.revision, 2)
	assert.equal(latestNotebook(session)?.text, '')
})

test('a notebook is recovered from the log after materializing', () => {
	const session = newSession('log-1')
	const written = writeNotebook(session, 'PERSISTED-NOTE', writeOptions())
	// Materialize exactly the message the write produced, as the agent loop does
	// at the next step boundary. The wrapper travels on the message, and the
	// store must hand the inner text back — so reading after materializing must
	// return the text that was written, not the wrapper.
	session.append('user/message', written.message, { surfaceOp: 'append' })

	const state = latestNotebook(session)
	assert.equal(state?.text, 'PERSISTED-NOTE')
	assert.equal(state?.revision, 1)
	assert.equal(state?.materialized, true)
	assert.equal(state?.visible, true)
	assert.equal(typeof state?.seq, 'number')
})

test('read-after-write is idempotent: the warning wrapper cannot accumulate', () => {
	const session = newSession('idem-1')
	const first = writeNotebook(session, 'STABLE', writeOptions())
	session.append('user/message', first.message, { surfaceOp: 'append' })

	// A model that reads and writes back the same text must not grow the record.
	const readBack = latestNotebook(session)
	assert.equal(readBack?.text, 'STABLE')
	const second = writeNotebook(session, readBack.text, writeOptions())
	assert.equal(second.bytes, first.bytes)
	assert.equal(latestNotebook(session)?.bytes, first.bytes)
})

test('a shadowed notebook stays readable and reports itself as not visible', () => {
	const session = newSession('shadow-1')
	const first = writeNotebook(session, 'NOTEBOOK-V1', writeOptions())
	const firstEvent = session.append('user/message', first.message, { surfaceOp: 'append' })
	// A filler node we then roll over together with the notebook.
	const filler = session.append('user/message', {
		id: firstEvent.data.id,
		role: 'user',
		content: [{ type: 'text', text: 'filler' }],
		source: { kind: 'user' },
	}, { surfaceOp: 'append' })

	session.append('user/message', {
		id: filler.data.id,
		role: 'user',
		content: [{ type: 'text', text: 'rollover checkpoint' }],
		source: { kind: 'user' },
	}, {
		surfaceOp: { op: 'replace', startSeq: firstEvent.seq, endSeq: filler.seq },
		// A replacement must cite every node it shadows.
		sourceEventSeqs: [firstEvent.seq, filler.seq],
	})

	// Off the model-visible surface, but still in the append-only log.
	const state = latestNotebook(session)
	assert.equal(state?.text, 'NOTEBOOK-V1')
	assert.equal(state?.visible, false)
	assert.equal(state?.materialized, true)
	assert.equal(session.surface.nodes.includes(state.seq), false)
})

// ---------------------------------------------------------------- rendering

test('notebookBlock carries the untrusted-record warning and the text verbatim', () => {
	const block = notebookBlock('remember: the token is ABC')
	assert.equal(block.includes('remember: the token is ABC'), true)
	assert.equal(block.includes('<context-notebook>'), true)
	assert.equal(block.includes('</context-notebook>'), true)
	// The security property: the notebook is not an instruction channel.
	assert.match(block, /UNTRUSTED/)
	assert.match(block, /take precedence/)
})

// ---------------------------------------------------------------- session model sanity

test('a session refuses an unknown event type on reload (why the notebook is a user/message)', () => {
	// Documents the constraint that shaped the design: a plugin-owned event type
	// would be written happily and then make the session unloadable, because the
	// persistence read path refuses unknown types without an `ignorable` marker
	// and the SDK exposes no writer for that marker.
	const session = newSession('unknown-1')
	const event = session.append('notes-context/notebook', { version: 1, text: 'x' })
	assert.equal(event.type, 'notes-context/notebook')
	assert.equal(Object.hasOwn(event, 'ignorable'), false)
	assert.equal(SessionSeq(0), 0)
})

// ---------------------------------------------------------------- settings page
//
// The Web Settings page renders a plugin row through `volatileForm()`
// (dsh-settings/lib/index.js:122-131), which keeps only nodes whose own
// `meta.volatile` is set or that are objects to recurse into. A field without a
// volatile ancestor is "ordinary configuration" and is dropped; if nothing
// survives, the row gets no page at all. These tests pin that contract, because
// silently losing it is how the page disappears.

/** The plugin row's `Config` as the settings service reads it. */
function composedConfig() {
	return Config
}

test('every plugin-owned field is volatile, so the settings page can render it', () => {
	const dict = composedConfig().dict
	const base = new Set(Object.keys(BasicCompactionEngine.Config.dict))
	const mine = Object.keys(dict).filter((k) => !base.has(k))
	assert.ok(mine.length > 0, 'expected the composed schema to carry plugin-owned fields')
	for (const key of mine) {
		assert.equal(dict[key].meta?.volatile, true, `${key} must be volatile or the page drops it`)
	}
})

test('base engine knobs stay plain values and are excluded from the page', () => {
	const dict = composedConfig().dict
	for (const key of Object.keys(BasicCompactionEngine.Config.dict)) {
		assert.notEqual(dict[key].meta?.volatile, true, `${key} must not be volatile`)
	}
	// The base schema carries no defaults of its own — `Config({})` is
	// `{ modelPolicies: [] }` and the real defaults live in the parent's private
	// `resolveConfig()`. What matters here is that nothing turns them into a
	// HANDLE: the engine reads them by value, so a handle would corrupt its
	// arithmetic. They resolve to `undefined` (absent) or a plain value, never a
	// volatile object.
	const resolved = notesConfig()
	for (const key of Object.keys(BasicCompactionEngine.Config.dict)) {
		const value = resolved[key]
		const isHandle = typeof value === 'object' && value !== null && typeof value.get === 'function'
		assert.equal(isHandle, false, `${key} must never resolve to a volatile handle`)
	}
})

test('every plugin-owned field resolves to a read handle, never a plain value', () => {
	const resolved = notesConfig()
	const base = new Set(Object.keys(BasicCompactionEngine.Config.dict))
	for (const key of Object.keys(composedConfig().dict)) {
		if (base.has(key)) continue
		assert.equal(typeof resolved[key], 'object', `${key} should be a volatile handle`)
		assert.equal(typeof resolved[key].get, 'function', `${key} should expose .get()`)
	}
})

test('documented defaults are unchanged and readable through .get()', () => {
	const resolved = notesConfig()
	assert.equal(resolved.maxNotebookBytes.get(), 16384)
	assert.equal(resolved.reminderEnabled.get(), true)
	assert.equal(resolved.enabled.get(), true)
	assert.equal(resolved.thresholdTokens.get(), -1)
	assert.equal(resolved.keepRecentTokens.get(), 20000)
	assert.equal(resolved.reserveTokens.get(), undefined)
	assert.equal(resolved.notebookSummaryMaxChars.get(), 2048)
	assert.equal(resolved.historyDefaultLimit.get(), 200)
	assert.equal(resolved.maxHistoryEntries.get(), 500)
	assert.equal(resolved.maxHistoryBytes.get(), 51200)
	assert.equal(resolved.historySummaryMaxChars.get(), 200)
	assert.equal(resolved.summaryTruncationMarker.get(), '…')
	assert.equal(resolved.historyBoundaryMarker.get(), '[ROLLOVER BOUNDARY]')
	assert.equal(resolved.staticProvider.get(), 'dsh-notes-context')
	assert.equal(resolved.staticModel.get(), 'static-rollover')
	assert.equal(resolved.rolloverText.get(), DEFAULT_ROLLOVER_TEMPLATE)
})

// ---------------------------------------------------------------- live updates
//
// A settings write reaches a running fiber through the loader's
// `_commitVolatile` (cordis-plugin-loader/lib/index.js:389-420), which calls
// `updateVolatile(existingRef, newSource)` and emits `loader/volatile-update` —
// deliberately WITHOUT a remount. Consumers therefore have to read `.get()` at
// the point of use: a captured value would freeze and the edit would need a
// restart. This test reproduces that commit against the real handle.

test('a volatile commit is visible to the next read through the same handle', () => {
	const resolved = notesConfig()
	assert.equal(resolved.maxNotebookBytes.get(), 16384)

	// Reproduce _commitVolatile: update the EXISTING handle in place.
	const next = notesConfig({ maxNotebookBytes: 4096 })
	updateVolatile(resolved.maxNotebookBytes, next.maxNotebookBytes)

	assert.equal(resolved.maxNotebookBytes.get(), 4096, 'the live read must see the new value')
	// And the write path must honour it, which is what "applies without restart" means.
	const session = newSession('live-1')
	const options = { maxNotebookBytes: resolved.maxNotebookBytes.get() }
	assert.throws(() => writeNotebook(session, 'x'.repeat(5000), options), NotebookTooLargeError)
})

// ---------------------------------------------------------------- base policy plumbing

test('baseEngineConfig translates this plugin\u2019s three fields into base keys', () => {
	// The base backend rejects unknown keys at boot, so these three must never
	// arrive under their own names. keepRecentTokens and reserveTokens map onto
	// the base keys that own the same ground.
	const mapped = baseEngineConfig(notesConfig({ keepRecentTokens: 4321, reserveTokens: 1234 }))
	assert.equal(mapped.retainTokens, 4321)
	assert.equal(mapped.headroomTokens, 1234)
	const known = new Set(Object.keys(BasicCompactionEngine.Config.dict))
	for (const key of Object.keys(mapped)) {
		assert.ok(known.has(key), `${key} is not a base engine key`)
	}
	// thresholdTokens is deliberately NOT translated: an absolute trigger needs
	// the model window, which is unknown at construction.
	assert.equal('thresholdTokens' in mapped, false)
})

test('baseEngineConfig leaves the base knobs alone when this plugin\u2019s are unset', () => {
	// A profile that configured the base knobs directly must keep working: the
	// mapping only fires when this plugin's field actually carries a value.
	const untouched = baseEngineConfig(notesConfig({ headroomTokens: 4096, retainRatio: 0.2 }))
	assert.equal(untouched.headroomTokens, 4096)
	assert.equal(untouched.retainRatio, 0.2)
	assert.equal('retainTokens' in untouched, false)
})

test('baseEngineConfig forwards user-set base knobs as plain values, excluding volatile ones', () => {
	const base = baseEngineConfig(notesConfig({ thresholdRatio: 0.55, retainTokens: 4321, auto: false }))
	assert.equal(base.thresholdRatio, 0.55)
	assert.equal(base.retainTokens, 4321)
	assert.equal(base.auto, false)
	// Every produced key must be one the parent recognises, or its strict key
	// validation refuses the row at mount.
	const known = new Set(Object.keys(BasicCompactionEngine.Config.dict))
	for (const key of Object.keys(base)) {
		assert.ok(known.has(key), `${key} is not a base engine key`)
		const value = base[key]
		const isHandle = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.get === 'function'
		assert.equal(isHandle, false, `${key} must be a plain value, not a volatile handle`)
	}
})
