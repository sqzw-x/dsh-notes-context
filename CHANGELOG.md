# Changelog

## Unreleased

### Added

- **`thresholdTokens`** — an absolute rollover trigger, matching
  `compaction.thresholdTokens` upstream. It wins over `thresholdRatio`, so one
  number pins the trigger and it stays pinned across models: the model's window is
  resolved at runtime and the ratio is derived from it, instead of asking the
  profile author to divide by a window they cannot see.
- **`keepRecentTokens`** — the verbatim recent-history budget, absolute, matching
  `compaction.keepRecentTokens` upstream (default 20000). Replaces the base
  backend's `retainRatio`/`retainTokens` framing; an explicitly configured base key
  still wins, so existing profiles are unaffected.
- **`reserveTokens`** — the reserve held below the trigger, defaulting to omp's
  `max(15% of window, 16384)` derivation (`effectiveReserveTokens`). Replaces
  `headroomTokens`.

### Removed

- **`reminderLeadRatio`, `reminderLeadMinTokens`, `reminderLeadMaxTokens`.** The
  lead was never a user-facing setting upstream: omp derives it with an exported
  pure function and says so — "derived from the threshold instead of a second
  user-facing knob so the band scales with the window". Exposing three knobs to
  configure one derived number was this port's invention, and it made a two-number
  decision (where the trigger is, where the reminder fires) look like a
  three-layer calculation. The lead now follows omp exactly:
  `min(32000, max(8192, floor(threshold × 0.125)))`, so a 450k trigger reminds at
  418k.

### Documentation

- **The prose was rewritten to read as plain sentences.** The opening paragraph had packed
  the built-in compaction's behaviour and its three consequences into two dense sentences
  ("…spends an extra LLM call… **latency** at the moment you most want to keep working…"),
  which forced a reader to unpack them. The three consequences are now three short
  sentences, and "It loses information" is stated accurately: by default the model cannot
  see the replaced text, though `context_history` can still recover it.
- **The README is a README again.** It had grown to 344 lines (268 in English), most of it
  threshold derivations, field-flow plumbing and schema rationale — internals a reader
  configuring a plugin does not need. It is now 101 / 122 lines: what the plugin does, the
  four keys that matter, install, and the limitations worth knowing. Everything removed
  moved to `docs/INTERNALS.md` rather than being deleted.
- **Both README editions' threshold sections were rewritten for the new fields.** They had
  been describing `reminderLeadRatio` / `Min` / `Max` and the ratio-only trigger long after
  those stopped being how the plugin works, including the 1M-window worked example and the
  "three things that are easy to get wrong" list. The example now runs the configuration
  this project actually uses (`thresholdTokens: 450000` → compaction at 450K, reminder at
  418K, 20,000-token tail), and the settings-page field inventory was corrected: three
  numeric inputs became eleven fields across the same four groups.
- **New section: how the thresholds are computed** — now in `docs/INTERNALS.md`. Every
  symbol is defined before it is used — `contextWindow`, `reservedCompletionTokens`, `M`,
  `B`, `thresholdTokens`, `retainTokens`, `lead`, `band` — with the reason each step
  exists, a worked 1M-window example, and the three traps (`lead` is capped at 32k rather
  than 12.5%; which of the two ceilings wins depends on the output reservation; `maxTokens`
  is not an independent setting). Mirrored in both languages.
- **Recorded which values accept a ratio and which accept an absolute number**, and that
  there is no absolute form of the threshold at all — it is always derived from
  `thresholdRatio` and the model's declared window.
- **State plainly that dsh's own compaction settings can only be changed in the config
  file and need a dsh restart**, while this plugin's 16 fields are live-editable. Was
  previously split across two places without saying how the change is made.

### Changed

- **Display name is now 笔记式上下文压缩** (`Notes-backed context compression` in the
  English locale), replacing 笔记式上下文窗口. The Chinese name matches what the plugin
  actually does: it does not only carry a notebook across a window, it replaces the
  compression that happens at the boundary. Both locales use the same noun so a
  language switch does not rename the feature.
- **Terminology made consistent.** `compaction` is 压缩, `rollover` is 窗口滚动,
  `shadow` is 遮蔽; the settings page and both READMEs now agree. This also removes an
  invented term for rollover that appeared nowhere else.

## 0.1.0

Initial release. Ports omp's **notes-backed context windows** to DeepSeek Harness.

### Added

- **`context_notes` tool** — the model's persistent notebook. Omit `text` to read,
  pass `text` to replace wholesale, pass `''` to clear. Enforced against a UTF-8 byte
  bound (default 16 KiB) *before* anything is stored, so an over-long write never
  leaves a partial record.
- **`context_history` tool** — reads the active session's raw transcript back by stable
  `seq` range, marks compaction boundaries (including the `compact-checkpoint`
  replacement message), and can return raw event text. This is what makes rollover
  non-destructive: shadowed history stays readable.
- **Zero-LLM rollover** — `NotesCompactionEngine` subclasses the base compaction
  backend and replaces only the summary text with a static template plus the current
  notebook. `summarize()` never calls `ctx.llm`, so a boundary cannot hallucinate,
  cannot fail on a provider error, and costs nothing.
- **Per-window reminder** — one model-visible reminder when context pressure enters
  `[threshold − lead, threshold)`, at most once per window, deduplicated on the
  branch's last rollover boundary.
- **Notebook visibility repair** — if a rollover shadows the notebook off the
  model-visible surface, it is re-published once per revision (mirroring the
  `dsh-tool-skill` catalog pattern).
- **Composed configuration** — every base compaction knob plus this plugin's own
  fields, composed from the base engine's schema via `Schema.intersect` so no knob is
  declared twice.

### Design notes

Two constraints in DSH 0.2.0-rc.2 shaped the implementation; both are documented in
`src/notebook.ts` and `src/tools.ts`:

1. **An out-of-repo plugin cannot declare its own session event type.** Unknown event
   types must carry an `ignorable` envelope marker to survive a reload, and the SDK
   exposes no writer for it — a plugin-owned event type would have made every session
   with a notebook unresumable. The notebook therefore rides a `user/message` with a
   plugin-owned `source.kind`.
2. **A tool cannot append to the surface from inside `execute`.** Doing so places the
   message before the tool's own result and produces
   `assistant(tool-call) → user → tool`, which providers reject. Notebook delivery uses
   `exec.deferContext(...)`, which the loop drains into the next-step inbox *after* the
   tool result.
