/**
 * `dsh-notes-context` — browser half.
 *
 * ## Why this module exists at all
 *
 * The host half declares every plugin-owned field as `.volatile()`, which is
 * what admits the row to `settings.describe()` and makes the fields writable.
 * It cannot draw anything: **DSH has no auto-generated settings form.** The host
 * computes an `autoGenerate` flag and publishes a schema, but no
 * `dsh-client-ui-*` bundle reads either. Volatility is a *data* plane
 * (admission + writability), not a UI plane.
 *
 * What renders a bundle's configuration is the official Plugins page's
 * `plugins.bundle.config` seat, and the page only shows a config section for a
 * bundle whose package name is in its configured ledger — which requires some
 * client half to have registered into that seat.
 *
 * ## Nothing third-party here
 *
 * The seat is declared by the shipped `@deepseek-ai/dsh-client-ui-plugin-manager`
 * and the form is built from `@deepseek-ai/dsh-client-ui-primitives`, the
 * harness's own component kit (styled through `--dsw-*` tokens). This half has no
 * dependency on any community aggregate; `react` is the only runtime `require`,
 * served by the page's module table.
 *
 * ## TWO DIFFERENT STRINGS — do not conflate them
 *
 * `dsh-notes-context` is exactly the shape where the identifiers differ (unlike
 * `dshmarket` or `dsh-git-review`, where they coincide and hide the distinction):
 *
 * - {@link ENTRY_ID} `'notes-context'` is the **profile entry id** — the `id:` of
 *   the row in `cordis.patch.yml`, which `describe()` reports as `ns`. It is what
 *   `ctx.configForms.get()` takes.
 * - {@link BUNDLE} `'dsh-notes-context'` is the **npm package name**, which is
 *   what the seat's `key` takes because the page dispatches on
 *   `ledger.bundles.has(openPkg.name)`.
 *
 * Either one wrong fails silently.
 *
 * ## Form shape
 *
 * This follows the deployed convention
 * (`dsh-client-ui-settings-agent-loop/lib/client.js`): a `SettingsFormModel` owns
 * staging, validation and dirty state; `SettingsValueField` renders each row; and
 * `SettingsForm` supplies the save/discard chrome plus the read-only and
 * unavailable messaging. Edits stage locally and commit on Save — which is still
 * no-restart, because the write lands on the live volatile handle.
 *
 * @module dsh-notes-context/client
 */
import type { Context } from '@deepseek-ai/cordis'

/** The profile entry id of the row that owns this plugin's Config. */
const ENTRY_ID = 'notes-context'

/** The npm package name the Plugins page dispatches this bundle's seat on. */
const BUNDLE = 'dsh-notes-context'

/** Locale namespace for this card's own copy. */
const NS = 'notes-context.client'

/**
 * The fields this card edits.
 *
 * Every one is declared `.volatile()` by the host half: a non-volatile field is
 * excluded from the form and refused by the write path. The base compaction knobs
 * are deliberately absent — the engine reads them by value at mount, so they
 * could not apply live even if they were shown.
 */
const FIELD_IDS = {
	enabled: 'enabled',
	maxNotebookBytes: 'maxNotebookBytes',
	reminderEnabled: 'reminderEnabled',
	thresholdTokens: 'thresholdTokens',
	keepRecentTokens: 'keepRecentTokens',
	reserveTokens: 'reserveTokens',
	rolloverText: 'rolloverText',
	notebookSummaryMaxChars: 'notebookSummaryMaxChars',
	staticProvider: 'staticProvider',
	staticModel: 'staticModel',
	historyDefaultLimit: 'historyDefaultLimit',
	maxHistoryEntries: 'maxHistoryEntries',
	maxHistoryBytes: 'maxHistoryBytes',
	historySummaryMaxChars: 'historySummaryMaxChars',
	summaryTruncationMarker: 'summaryTruncationMarker',
	historyBoundaryMarker: 'historyBoundaryMarker',
} as const

/** A field id this card knows how to render. */
type FieldId = keyof typeof FIELD_IDS

/**
 * Fields rendered as an immediate-write `Switch` rather than a staged text row.
 *
 * Booleans are the one control the harness edits immediately: the deployed
 * convention (`dsh-client-ui-settings-general`) wires `Switch.onChange` straight
 * to a write with a busy guard, and never stages them behind the form's Save. A
 * checkbox that needed "Save" would be the odd one out.
 */
const BOOLEAN_FIELDS = new Set<FieldId>(['enabled', 'reminderEnabled'])

/** The staged text/number fields, in display order, per group. */
const GROUPS: ReadonlyArray<{ id: string; fields: readonly FieldId[] }> = [
	{ id: 'notebook', fields: ['enabled', 'maxNotebookBytes'] },
	{ id: 'reminder', fields: ['reminderEnabled'] },
	{ id: 'rollover', fields: ['thresholdTokens', 'keepRecentTokens', 'reserveTokens', 'rolloverText', 'notebookSummaryMaxChars', 'staticProvider', 'staticModel'] },
	{
		id: 'history',
		fields: [
			'historyDefaultLimit',
			'maxHistoryEntries',
			'maxHistoryBytes',
			'historySummaryMaxChars',
			'summaryTruncationMarker',
			'historyBoundaryMarker',
		],
	},
]

/** Where a staged field's value lives in the projection store. */
type Cell = { text: string; overridden: boolean; invalid: boolean }

/**
 * Fields rendered as staged text/number rows.
 *
 * Booleans are excluded: they are edited through an immediate-write `Switch`, so
 * the form model never stages them.
 */
const TEXT_FIELDS = new Set<FieldId>([
	'rolloverText',
	'staticProvider',
	'staticModel',
	'summaryTruncationMarker',
	'historyBoundaryMarker',
])

/**
 * Copy for this card, in the two locales the harness ships.
 *
 * Keys mirror the harness convention (`settings.<feature>.*`), and the
 * dictionaries are registered through `ctx.locale.register(NS, { zh, en })` so
 * `ctx.locale.bind(NS)` resolves them against the ACTIVE language — including
 * switching language live, because the bound function reads the active locale at
 * call time.
 */
const zh: Record<string, string> = {
	title: '笔记式上下文压缩',
	description: 'Agent 跨窗口维护一本持久笔记本，窗口滚动本身不产生模型调用。',
	overridden: '已覆盖',
	reset: '恢复默认',
	readOnly: '本部署的设置为只读。',
	unavailable: '该插件当前未加载，暂时无法配置。',
	save: '保存',
	saving: '保存中…',
	saveFailed: '本部署没有接受这些值，已保留供你修改。',
	invalidNumber: '请填数字；留空表示使用默认值。',
	enabled: '笔记本工具与提醒',
	enabledHint: '注册 context_notes 与 context_history，以及每窗口一次的滚动提醒。',
	maxNotebookBytes: '笔记本大小上限（字节）',
	maxNotebookBytesHint: 'UTF-8 硬上限。超限的写入在落盘前就被拒绝。',
	reminderEnabled: '上下文窗口提醒',
	reminderEnabledHint: '接近阈值时，每窗口给模型一次可见的提示。',
	thresholdTokens: '滚动触发点（tokens，-1 = 跟随比例）',
	thresholdTokensHint: '绝对值优先于 thresholdRatio。填 -1 表示改用比例。实际触发点还受窗口与本次请求的输出预留限制。',
	keepRecentTokens: '滚动后保留原文（tokens）',
	keepRecentTokensHint: '绝对值。取代 DSH 内置压缩的 retainRatio / retainTokens。',
	reserveTokens: '触发点下方的预留（tokens）',
	reserveTokensHint: '留空表示默认：模型窗口的 15%，且不低于 16384。触发点取它与「窗口 − 输出预留」两道里的低者。',
	footer: '触发点、保留量与预留改完立刻生效；滚动边界模板等要下一次窗口滚动才体现。',
	notebook: "笔记本",
	reminder: "滚动提醒",
	rollover: "滚动边界",
	history: "历史回读",
	rolloverText: "滚动边界模板",
	rolloverTextHint: "窗口滚动时写入的静态「摘要」全文。它不会被模型加工；下一次窗口滚动生效。",
	notebookSummaryMaxChars: "边界摘要里的笔记本字符上限",
	notebookSummaryMaxCharsHint: "超出部分会被截断并附注提示，原始笔记本不受影响。",
	staticProvider: "摘要的 provider 标记",
	staticProviderHint: "写进 compaction/summary 的溯源标签，便于日后分辨「这段不是模型摘要」。",
	staticModel: "摘要的 model 标记",
	staticModelHint: "同上，作为模型字段写入。",
	historyDefaultLimit: "context_history 默认条数",
	historyDefaultLimitHint: "模型不指定范围时返回多少条。",
	maxHistoryEntries: "单次返回条数上限",
	maxHistoryEntriesHint: "硬上限，防止一次拉回整份日志。",
	maxHistoryBytes: "单次返回字节上限",
	maxHistoryBytesHint: "硬上限（UTF-8 字节）。超出的条目整条丢弃，不截半条。",
	historySummaryMaxChars: "单条摘要字符上限",
	historySummaryMaxCharsHint: "索引视图里每条事件摘要多长。",
	summaryTruncationMarker: "截断标记",
	summaryTruncationMarkerHint: "摘要被截断时追加的后缀。",
	historyBoundaryMarker: "边界标记文字",
	historyBoundaryMarkerHint: "标出压缩/窗口滚动边界的那段文字。",
}

/** English copy; the fallback locale, so it must carry every key above. */
const en: Record<string, string> = {
	title: 'Notes-backed context compression',
	description:
		'The agent keeps a durable notebook across context rollovers, so a window boundary costs no model call.',
	overridden: 'Overridden',
	reset: 'Reset to default',
	readOnly: 'This deployment stores settings read-only.',
	unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
	save: 'Save',
	saving: 'Saving…',
	saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
	invalidNumber: 'Enter a number, or leave blank to use the default.',
	enabled: 'Notebook tools and reminder',
	enabledHint: 'Registers context_notes and context_history, plus the per-window rollover reminder.',
	maxNotebookBytes: 'Notebook size cap (bytes)',
	maxNotebookBytesHint: 'Hard UTF-8 bound. A larger write is refused before anything is stored.',
	reminderEnabled: 'Context-window reminder',
	reminderEnabledHint: 'One model-visible nudge per window before the rollover threshold.',
	thresholdTokens: 'Rollover trigger (tokens, -1 follows the ratio)',
	thresholdTokensHint: 'An absolute count wins over thresholdRatio. Use -1 to follow the ratio instead. The effective trigger is also capped by the window less this request\'s output reservation.',
	keepRecentTokens: 'Recent history kept after a rollover (tokens)',
	keepRecentTokensHint: 'Absolute. Replaces the base backend retainRatio / retainTokens.',
	reserveTokens: 'Reserve held below the trigger (tokens)',
	reserveTokensHint: 'Leave blank for the default: 15% of the model window, never below 16384. The trigger is the lower of your target and the window less the output reservation.',
	footer:
		'Trigger, retention and reserve apply immediately; the boundary template and static labels apply at the next window rollover.',
	notebook: "Notebook",
	reminder: "Rollover reminder",
	rollover: "Rollover boundary",
	history: "History read-back",
	rolloverText: "Rollover boundary template",
	rolloverTextHint: "The static \"summary\" written at a rollover. It is never processed by a model; applies at the next rollover.",
	notebookSummaryMaxChars: "Notebook chars inside the boundary summary",
	notebookSummaryMaxCharsHint: "Longer text is truncated with a note; the stored notebook is untouched.",
	staticProvider: "Summary provider label",
	staticProviderHint: "Recorded on compaction/summary, so a later reader can tell this was not a model summary.",
	staticModel: "Summary model label",
	staticModelHint: "The same, written as the model field.",
	historyDefaultLimit: "context_history default entries",
	historyDefaultLimitHint: "How many entries a range-less call returns.",
	maxHistoryEntries: "History entries per call",
	maxHistoryEntriesHint: "Hard cap, so one call cannot pull the whole log.",
	maxHistoryBytes: "History bytes per call",
	maxHistoryBytesHint: "Hard UTF-8 cap. An entry that would exceed it is dropped whole, never split.",
	historySummaryMaxChars: "Per-entry summary length",
	historySummaryMaxCharsHint: "How long each event summary is in the index view.",
	summaryTruncationMarker: "Truncation marker",
	summaryTruncationMarkerHint: "Appended to a summary that was cut short.",
	historyBoundaryMarker: "Boundary marker text",
	historyBoundaryMarkerHint: "The text marking a compaction or rollover boundary.",
}

/**
 * Inline copies of the official settings-row text styles.
 *
 * The real values live in the primitives' hashed CSS modules
 * (`settings-form/fields.module.css`), which a third-party bundle cannot import —
 * the client module table ships JavaScript only. These are transcribed so the
 * card's own containers match the harness's rhythm instead of inventing one.
 * The CONTROLS themselves are the official components and keep their own styling.
 */
const LABEL_STYLE = { fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' }
const HINT_STYLE = { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }

/** The bound translate function for namespace {@link NS}. */
type Translate = (key: string) => string

/** The lazy-CJS factory hands `require` to this module as a parameter. */
declare const require: (id: string) => unknown

/**
 * The slice of the React surface this card uses.
 *
 * Declared structurally rather than imported: React is not resolvable from this
 * package at build time, and `require('react')` is served by the page's module
 * table at runtime. This keeps the package free of a React dependency.
 */
interface ReactLike {
	createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
	useMemo<T>(factory: () => T, deps: readonly unknown[]): T
	useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, get: () => T): T
}

/** The official primitives this card builds from. */
interface PrimitivesLike {
	SettingsForm: unknown
	SettingsValueField: unknown
	Switch: unknown
	SettingsFormModel: new (scope: unknown, specs: unknown[]) => FormModelLike
	settingsNumberField(field: string): unknown
	settingsTextField(field: string): unknown
}

/** The staged-form model surface this card drives. */
interface FormModelLike {
	bind<S>(project: () => S): { getSnapshot(): S; subscribe(listener: () => void): () => void }
	shell(): {
		available: boolean
		writable: boolean
		dirty: boolean
		invalid: boolean
		saving: boolean
		failed: boolean
	}
	field(field: string): { text: string; overridden: boolean; invalid: boolean }
	actions(): {
		edit(field: string, text: string): void
		resetField(field: string): void
		save(): void
		discard(): void
	}
	dispose(): void
}

/**
 * The slice of the locale service this card reads.
 *
 * Declared structurally for the same reason as the rest: the service's own types
 * come from a client package this build does not depend on.
 */
interface LocaleServiceLike {
	/** Bind a registered namespace to a translate function that reads the active locale at call time. */
	bind(ns: string): Translate
	/** Register this namespace's dictionaries. Returns a disposer. */
	register(ns: string, dictionaries: { zh: object; en: object }): () => void
}

/** The `ConfigForm` the seat hands us, narrowed to what the model needs. */
interface ConfigFormLike {
	getSnapshot(): { status: string; value?: Record<string, unknown>; writable: boolean; revision?: number }
	subscribe(listener: () => void): () => void
	/** Write one field immediately, bypassing the staged form. */
	set(field: string, value: unknown): Promise<boolean>
	mutate(
		ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
		revision?: number,
	): Promise<boolean>
}

/** Load the official primitives, or `undefined` when this page does not serve them. */
function loadPrimitives(): PrimitivesLike | undefined {
	try {
		return require('@deepseek-ai/dsh-client-ui-primitives') as PrimitivesLike
	} catch {
		return undefined
	}
}

/** The save/discard label set `SettingsForm` requires. */
function formLabels(t: Translate): Record<string, string> {
	return {
		unavailable: t('unavailable'),
		readOnly: t('readOnly'),
		saveFailed: t('saveFailed'),
		save: t('save'),
		saving: t('saving'),
	}
}

/**
 * The bundle's configuration card.
 *
 * @param props - the seat's composed props; `view` distinguishes the list
 *   one-liner from the page body, and `form` is injected by {@link apply}.
 * @returns the rendered element.
 */
function NotesContextCard(props: {
	view?: 'summary' | 'page'
	form?: ConfigFormLike
	t?: Translate
}): unknown {
	const react = require('react') as ReactLike
	const primitives = loadPrimitives()
	if (primitives === undefined) return null

	// `t` is `ctx.locale.bind(NS)`: it reads the ACTIVE locale at call time, so a
	// language switch re-renders correctly instead of freezing whatever language
	// was active at mount.
	const t = props.t ?? ((key: string): string => key)
	if (props.view === 'summary') return t('description')

	const form = props.form
	if (form === undefined) return null

	// One model per mounted card, created once for its lifetime. The reference
	// implementation (`dsh-client-ui-settings-agent-loop`) builds it in the same
	// shape: a model over the scope, then a bound projection store to render from.
	const model = react.useMemo(
		() =>
			new primitives.SettingsFormModel(form, [
				primitives.settingsNumberField(FIELD_IDS.maxNotebookBytes),
				primitives.settingsNumberField(FIELD_IDS.thresholdTokens),
				primitives.settingsNumberField(FIELD_IDS.keepRecentTokens),
				primitives.settingsNumberField(FIELD_IDS.reserveTokens),
				primitives.settingsTextField(FIELD_IDS.rolloverText),
				primitives.settingsNumberField(FIELD_IDS.notebookSummaryMaxChars),
				primitives.settingsTextField(FIELD_IDS.staticProvider),
				primitives.settingsTextField(FIELD_IDS.staticModel),
				primitives.settingsNumberField(FIELD_IDS.historyDefaultLimit),
				primitives.settingsNumberField(FIELD_IDS.maxHistoryEntries),
				primitives.settingsNumberField(FIELD_IDS.maxHistoryBytes),
				primitives.settingsNumberField(FIELD_IDS.historySummaryMaxChars),
				primitives.settingsTextField(FIELD_IDS.summaryTruncationMarker),
				primitives.settingsTextField(FIELD_IDS.historyBoundaryMarker),
			]),
		[form],
	)

	const store = react.useMemo(
		() =>
			model.bind((): Record<string, unknown> => ({
				...model.shell(),
				maxNotebookBytes: model.field(FIELD_IDS.maxNotebookBytes),
				thresholdTokens: model.field(FIELD_IDS.thresholdTokens),
				keepRecentTokens: model.field(FIELD_IDS.keepRecentTokens),
				reserveTokens: model.field(FIELD_IDS.reserveTokens),
				rolloverText: model.field(FIELD_IDS.rolloverText),
				notebookSummaryMaxChars: model.field(FIELD_IDS.notebookSummaryMaxChars),
				staticProvider: model.field(FIELD_IDS.staticProvider),
				staticModel: model.field(FIELD_IDS.staticModel),
				historyDefaultLimit: model.field(FIELD_IDS.historyDefaultLimit),
				maxHistoryEntries: model.field(FIELD_IDS.maxHistoryEntries),
				maxHistoryBytes: model.field(FIELD_IDS.maxHistoryBytes),
				historySummaryMaxChars: model.field(FIELD_IDS.historySummaryMaxChars),
				summaryTruncationMarker: model.field(FIELD_IDS.summaryTruncationMarker),
				historyBoundaryMarker: model.field(FIELD_IDS.historyBoundaryMarker),
			})),
		[model],
	)

	const state = react.useSyncExternalStore(
		(cb: () => void) => store.subscribe(cb),
		() => store.getSnapshot(),
	)
	const actions = model.actions()
	const fields = state as unknown as { writable: boolean }
	/** Staged cells by field; only the non-boolean fields are present. */
	const cells = state as unknown as Record<FieldId, Cell>
	/** Current host values, used for the immediate-write toggles. */
	const snapshotValues = (form.getSnapshot().value ?? {}) as Record<string, unknown>

	// Sixteen rows in one flat list is unreadable, so render them under four
	// headings that mirror how the fields are used.
	const group = (id: string, children: unknown[]): unknown =>
		react.createElement(
			'section',
			{ key: id, style: { marginTop: '20px' } },
			// Group heading sits a level BELOW the field labels: the official field
			// label is 13px/500 in the primary label colour, so the heading drops to
			// 12px/600 in the secondary colour to read as a section marker rather
			// than competing with the labels under it.
			react.createElement(
				'h4',
				{
					style: {
						margin: '0 0 2px',
						fontSize: '12px',
						fontWeight: 600,
						lineHeight: 1.5,
						color: 'var(--dsw-alias-label-secondary)',
					},
				},
				t(id),
			),
			...children,
		)

	/** A staged row: the harness control, committed by Save. */
	const row = (field: FieldId, numeric: boolean): unknown =>
		react.createElement(primitives.SettingsValueField, {
			id: `notes-context-${field}`,
			label: t(field),
			hint: t(`${field}Hint`),
			text: cells[field].text,
			overridden: cells[field].overridden,
			invalid: cells[field].invalid,
			overriddenLabel: t('overridden'),
			resetLabel: t('reset'),
			invalidLabel: t('invalidNumber'),
			disabled: !fields.writable,
			numeric,
			onEdit: (text: string) => actions.edit(FIELD_IDS[field], text),
			onReset: () => actions.resetField(FIELD_IDS[field]),
		})

	/**
	 * A boolean row.
	 *
	 * `Switch` writes IMMEDIATELY, following the deployed convention
	 * (`dsh-client-ui-settings-general` wires `Switch.onChange` straight to a
	 * write). Staging a checkbox behind Save would make the two on/off fields
	 * behave unlike every other toggle in the harness.
	 */
	const toggle = (field: FieldId): unknown =>
		react.createElement(
			'div',
			{
				key: field,
				// Mirrors the official `.field`: flex column, 6px gap, 12px block
				// padding, and a hairline separator between adjacent fields.
				// Spacing only: the official row already draws its own hairline
				// separator (`fields.module.css`), so adding one here would double it.
				style: { display: 'flex', flexDirection: 'column', gap: '6px' },
			},
			react.createElement(primitives.Switch, {
				checked: snapshotValues[field] === true,
				label: t(field),
				disabled: !fields.writable,
				title: t(`${field}Hint`),
				onChange: (next: boolean) => {
					void form.set(FIELD_IDS[field], next)
				},
			}),
			react.createElement('div', { style: HINT_STYLE }, t(`${field}Hint`)),
		)

	/**
	 * A long-text row.
	 *
	 * The harness ships no multi-line control — `SettingsValueField` covers text
	 * and number only — so the rollover template, a multi-line block, gets a
	 * `textarea` that stages into the same Save/Discard flow as the other rows.
	 */
	const longText = (field: FieldId): unknown =>
		react.createElement(
			'div',
			{
				key: field,
				style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
			},
			react.createElement('div', { style: LABEL_STYLE }, t(field)),
			react.createElement('div', { style: HINT_STYLE }, t(`${field}Hint`)),
			react.createElement('textarea', {
				rows: 9,
				spellCheck: false,
				disabled: !fields.writable,
				value: cells[field].text,
				// Same skin as the official `.input`, but the harness ships no
				// multi-line control, so this one is ours. `line-height: 1.5` matches
				// the official field rhythm and makes a multi-line block readable.
				style: {
					width: '100%',
					boxSizing: 'border-box',
					padding: '8px 12px',
					border: '0.5px solid var(--dsw-alias-border-l4)',
					borderRadius: 'var(--dsw-radius-md)',
					background: 'var(--dsw-alias-bg-layer-3)',
					color: 'var(--dsw-alias-label-primary)',
					fontFamily: 'monospace',
					fontSize: '13px',
					lineHeight: 1.5,
					resize: 'vertical',
				},
				onChange: (e: { target: { value: string } }) => actions.edit(FIELD_IDS[field], e.target.value),
			}),
		)

	/** Render one field with the control its type calls for. */
	const fieldRow = (field: FieldId): unknown => {
		if (BOOLEAN_FIELDS.has(field)) return toggle(field)
		if (field === 'rolloverText') return longText(field)
		return row(field, !TEXT_FIELDS.has(field))
	}

	return react.createElement(
		'div',
		null,
		react.createElement('h3', null, t('title')),
		react.createElement('p', null, t('description')),
		...GROUPS.map((g) => group(g.id, g.fields.map(fieldRow))),
		react.createElement(
			primitives.SettingsForm as never,
			{
				labels: formLabels(t),
				state,
				onSave: () => actions.save(),
				onDiscard: () => actions.discard(),
			},
			null,
		),
		react.createElement('p', null, t('footer')),
	)
}

/**
 * The slice of the slots registry this module uses.
 *
 * Declared structurally: the slots service's own types ship under a bare-package
 * augment and this package carries no browser-type dependency. `slots.inject`
 * waits for the seat's declaration, so a deployment whose Plugins page never
 * declares it simply never registers — nothing is consulted and nothing throws.
 */
interface SlotsLike {
	inject(seat: string, contribution: () => () => void): void
	register(options: Record<string, unknown>, component: unknown): () => void
}

/** Cordis services this half needs. */
export const inject = ['slots', 'configForms', 'locale']

/**
 * Register this bundle's configuration card onto the official Plugins page.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
	const services = ctx as unknown as {
		configForms?: { get(id: string): ConfigFormLike }
		slots: SlotsLike
		locale?: LocaleServiceLike
	}

	const forms = services.configForms
	if (forms === undefined) return

	// The form is addressed by PROFILE ENTRY ID, not by package name.
	const form = forms.get(ENTRY_ID)

	// Follow the deployed convention: register the dictionaries as an effect,
	// then bind the namespace ONCE. The bound `t` reads the active locale at call
	// time, so switching language updates the card without a reload.
	const localeService = services.locale
	const t = localeService?.bind(NS)
	if (localeService !== undefined) {
		ctx.effect(() => localeService.register(NS, { zh, en }), 'notes-context: settings dictionaries')
	}

	services.slots.inject('plugins.bundle.config', () =>
		services.slots.register(
			{
				name: 'plugins.bundle.config',
				key: BUNDLE,
				locale: NS,
				inject: () => ({ form, t }),
			},
			NotesContextCard,
		),
	)
}
