# Changelog

## Unreleased

### Documentation

- **New section: how the thresholds are computed.** Every symbol is defined before it is
  used — `contextWindow`, `reservedCompletionTokens`, `M`, `B`, `thresholdTokens`,
  `retainTokens`, `lead`, `band` — with the reason each step exists, a worked 1M-window
  example on defaults, and the three traps (`lead` is capped at 32k rather than 12.5%;
  which of the two ceilings wins depends on the output reservation; `maxTokens` is not
  an independent setting). Mirrored in both README editions.
- **Recorded which values accept a ratio and which accept an absolute number**, and that
  there is no absolute form of the threshold at all — it is always derived from
  `thresholdRatio` and the model's declared window.
- **State plainly that dsh's own compaction settings can only be changed in the config
  file and need a dsh restart**, while this plugin's 16 fields are live-editable. Was
  previously split across two places without saying how the change is made.

### Changed

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
