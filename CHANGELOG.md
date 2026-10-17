# Changelog

## Unreleased

- **兼容声明**：`package.json` 增加 `engines.dsh`，覆盖已实测的 `0.2.0-rc.2` 与 `0.2.1-rc.2`；插件市场和新版本 DSH 会据此显示/校验兼容性。

## 0.2.0

The compaction fields follow omp's names and units, and the absolute rollover trigger no
longer shrinks by the routed request's output reservation.

### Added

- **The runtime packages typecheck depends on are now devDependencies.** Every
  `@deepseek-ai/*` import is a peer and marked optional, and dsh is a desktop app that is not
  installed on a CI runner, so a fresh checkout had none of them: the first CI run failed
  with `Cannot find module '@deepseek-ai/cordis'` and 30 more. The ten packages the sources
  import are now pinned in `devDependencies`, which is also how the sibling `dsh-alerts`
  keeps its CI green.
- **CI and publish workflows.** `ci.yml` runs typecheck, tests and the artifact contract on
  Node 22 and 24 for every push and pull request. `publish.yml` publishes to npm on a `v*`
  tag, after verifying the tag matches the `package.json` version and re-running the same
  checks, with `--provenance` for a supply-chain attestation.
- **`package-lock.json`**, so CI installs with `npm ci` and resolves the same tree every run.
- **Repository metadata**: `repository`, `homepage`, `bugs` and `publishConfig.access` in
  `package.json`, so a publish is public and links back to the source.
- **`docs/` now ships in the tarball.** `npm pack` omitted it, which would have left the
  README's 内部机制 links dead on npm.

### Changed

- **README links to the internals doc use absolute URLs.** A relative `docs/INTERNALS.md`
  resolves on GitHub but not on npm, where the README is the package home page.
- **`package.json` description** follows the renamed feature: "notes-backed context
  compression", not "windows".

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

### Fixed

- **The absolute trigger no longer shrinks by the routed output reservation.** The
  lock wrote `headroomTokens = window − thresholdTokens`, which restates the trigger
  inside the base backend's own clamp
  (`min(window × ratio, window − reservedCompletionTokens − headroomTokens)`) and
  collapses the second ceiling to `thresholdTokens − reservedCompletionTokens`: the
  output reservation is subtracted twice. On a 1,000,000-token window whose request
  reserves 393,216 tokens for output — any pi-ai provider with a declared `maxTokens`
  — a `thresholdTokens: 450000` fired at **56,784**, 5.7% of the window, and the
  reminder band opened at 48,592. The headroom is now the configured reserve, so the
  trigger is `min(thresholdTokens, window − reservedCompletionTokens − reserveTokens)`:
  the point the profile asked for, or the latest point the window can hold. Deriving
  the headroom from the trigger had only ever been correct while the routed output
  reservation was 0, which the module docblock stated as an assumption rather than a
  requirement.
- **A window's first reminder is scheduled against the locked trigger.** The band was
  derived from a policy snapshot taken before the lock replaced the engine's resolved
  config, so the first window of every session used the configured default ratio
  (0.8 → a band at 518,464–550,464) while the rollover fired at the locked point. The
  first rollover was therefore never preceded by a reminder. The policy is now re-read
  after the lock.
- **`docs/INTERNALS.md` no longer calls `reservedCompletionTokens` negligible.** It is
  the whole of the defect above: a provider that declares `maxTokens` spends about
  four tenths of the window on it, and the trigger is the lower of the target and
  `window − reservedCompletionTokens − reserve`.

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

- **The remaining invented terms are gone.** 提醒带 and 触发点 were mine; the plain forms
  are 提醒区间 and 压缩阈值, and 提前量 is now `lead`, the name the formula uses. The
  sentence that read "上下文进入触发点前的提醒带时" is now "已使用的上下文接近压缩阈值时
  （距阈值不足 32,000 token）".
- **The prose is documentation register, not narration.** The previous pass over-corrected
  into spoken language: short declarative paragraphs, second person, one idea per line
  ("问题有三个。一是慢。总结要等模型返回…"). That reads as storytelling in a code
  repository. Statements are now terse and impersonal, the three problems are a bulleted
  list under a `DSH 内置压缩机制` heading rather than an essay, and the same change was
  applied to `docs/INTERNALS.md`.
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
