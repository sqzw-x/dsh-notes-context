/**
 * The single configuration schema for the plugin row.
 *
 * ## Why this exists as its own module
 *
 * One profile row mounts this package, and that row's `Config` is what the
 * loader validates and what the Web settings page renders. The schema therefore
 * has to carry two kinds of field at once:
 *
 * - **base compaction policy** (`thresholdRatio`, `headroomTokens`,
 *   `retainRatio`, `retainTokens`, `maxTokens`, `compactionRetries`,
 *   `maxOverflowRetries`, `modelPolicies`, `auto`, and the summarization route)
 *   — owned by `BasicCompactionEngine`, taken from its own schema so there is
 *   exactly one declaration and no second default to drift;
 * - **this plugin's own fields** — the notebook, reminder and history knobs
 *   declared in `config.ts`.
 *
 * ## Why the composition is a flat object and not `Schema.intersect`
 *
 * This is load-bearing for the settings page, not a style choice.
 *
 * `SettingsForms` renders a row's form through `volatileForm()`
 * (`dsh-settings/lib/index.js:122-131`), which understands exactly two node
 * kinds: a node whose own `meta.volatile` is set (rendered as
 * `plainSchema(node)`), and an `object` node (recurse into `dict`, keeping only
 * children that yield a field). **Everything else returns `undefined`, and
 * `undefined` means the row gets no page at all.**
 *
 * `Schema.intersect` resolves to a `type: 'intersect'` node carrying `refs`
 * rather than `dict`, so an intersect-composed schema can never produce a form —
 * verified: `Config.toJSON().type === 'intersect'`, `dict` empty, so
 * `volatileForm(Config) === undefined`. Spreading both `dict`s into one
 * `Schema.object` yields a real `object` node, and the form then renders exactly
 * the fields that carry a volatile ancestor.
 *
 * ## Why the two halves are treated differently
 *
 * The base knobs stay **plain values** and this plugin's fields are **volatile**:
 *
 * - `BasicCompactionEngine.resolveConfig()` reads its policy by value
 *   (`config.headroomTokens ?? 65536`) and `validateKeys` rejects keys it does
 *   not know, so handing it volatile `{ get, write }` handles would corrupt its
 *   arithmetic and refuse the row at boot. They are therefore passed through
 *   untouched and are **not** live-editable from the settings page.
 * - This plugin's fields are read through `.get()` at the point of use, so an
 *   edit applies immediately: a volatile-only config change commits into the
 *   running fiber **without a remount** (`cordis-plugin-loader/lib/index.js:380-420`),
 *   which also means `apply` does not re-run and no registration is duplicated.
 *
 * @module dsh-notes-context/schema
 */
import Schema from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { Config as NotesConfig, type Config as NotesConfigInput } from './config.ts'

/**
 * The composed schema: base compaction policy plus this plugin's own fields.
 *
 * The declared parameter type stays the parent's `BasicCompactionConfig` because
 * `Schema<S, T>` is contravariant in `S` and this plugin's resolved shape has
 * strictly more required fields than the parent's all-optional policy. What the
 * loader and the settings service actually consume is the runtime value
 * (`Config['~standard'].validate`), which really is the wider schema.
 */
export const Config: Schema<BasicCompactionConfig> = Schema.object({
	...BasicCompactionEngine.Config.dict,
	...NotesConfig.dict,
}) as unknown as Schema<BasicCompactionConfig>

/**
 * What `Config` resolves to: the base policy joined with this plugin's fields.
 *
 * The base policy resolves to plain values (the parent reads them by value); this
 * plugin's own fields resolve to volatile handles, which is why the plugin half
 * is described by `NotesConfigInput` (the consumer-facing shape) rather than a
 * plain-value interface.
 */
export type ResolvedPluginConfig = BasicCompactionConfig & NotesConfigInput
