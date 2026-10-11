# dsh-notes-context

> Brings omp's (Oh My Pi) **notes-backed context windows** to DeepSeek Harness:
> a model-written persistent notebook replaces LLM-summarized compaction.
> **The window boundary itself costs zero model calls.**

English | [简体中文](README.md)

---

## The problem

DSH's default compaction (`@deepseek-ai/dsh-compaction-basic`) makes an **extra LLM
call** when context pressure crosses a threshold: it summarizes the older span and
replaces that history with the summary. The costs are threefold:

1. **Latency** — compaction happens exactly when you want to keep working, and you
   wait for that summary call to return.
2. **Unpredictability** — summary quality is whatever the model produces; the detail
   you need next may not survive.
3. **Loss** — once summarized, the original text is gone from the model's view.

This plugin takes a different route: **don't summarize, take notes.**

| | Default compaction | This plugin |
|---|---|---|
| Model call at the boundary | Yes (a full summarization request) | **No** (static template is written) |
| Boundary predictable | No (depends on model output) | Yes (local, deterministic) |
| Original history readable afterwards | No, only the summary | **Yes**, `context_history` by `seq` |
| Who decides what matters | the summarization model | the model doing the work |

## How it works

### 1. The notebook (`context_notes`)

The model **voluntarily** records task state, decisions, changed files, evidence,
blockers and next steps into a persistent notebook:

```
context_notes                      → read the current notebook
context_notes { text: "..." }      → replace it wholesale (not append)
context_notes { text: "" }         → clear it
```

- **16 KiB** cap (UTF-8 bytes; an over-long write fails *before* anything is stored).
- Every write is a **whole replacement**, so the model tends to read → edit → write back
  rather than appending without bound.
- Delivery is ordering-safe: the revision rides the tool result as deferred context, so
  it reaches the model **after** that result and never breaks the
  `assistant(tool-call) → tool(result)` sequence a provider requires.

### 2. The per-window reminder

When pressure enters the warm band below the threshold, the plugin inserts one
**model-visible, at-most-once-per-window** reminder at the nearest step boundary
(see the README's Chinese edition for the verbatim text). The band is
`[trigger − lead, trigger)` with `lead` derived as `min(32000, max(8192, trigger × 0.125))`
— there is no setting for it (see [How the thresholds are computed](#how-the-thresholds-are-computed)).
Dedup is keyed on the branch's last rollover boundary, so it fires once per window,
not once per turn.

> The reminder is **not load-bearing**. Even if the model ignores it completely, the
> boundary still commits. What the reminder buys is **fidelity**, not cost.

### 3. The zero-LLM boundary

At rollover the engine subclasses the base backend (reusing its pressure policy,
retention, tool pairing and locking) and replaces **only the summary text**:

```xml
<context-window-rollover>
The earlier raw transcript remains canonical and recoverable at context_history.
Continue from the persistent notebook, the retained recent tail, and the latest user request,
which is retained separately when it falls outside the tail.
Earlier task instructions and constraints may still require recovery from raw history.
Do not assume this boundary is an LLM summary; use the notebook and raw-history reads when
prior details are needed.
</context-window-rollover>
```

followed by the notebook verbatim. `summarize()` **never calls `ctx.llm`**.

### 4. Raw history read-back (`context_history`)

Rollover **shadows** replaced surface nodes; it does not delete them — the log is
append-only. So the model can re-read the original record by stable `seq`:

```
context_history                                 → index (seq / type / one-line summary)
context_history { from: 120, to: 200 }          → exact range
context_history { from: 0, to: 50, raw: true }  → raw text
```

Compaction boundaries are marked explicitly, including the replacement message that
carries a `compact-checkpoint` source.

## Install

```sh
dsh plugin --profile <your profile> add ./packages/dsh-notes-context
dsh --profile <your profile> --dump-config   # confirm both layers applied
```

The bundle patch disables `compaction-basic` and mounts this package. Both rows are
required: two providers for one service conflict, the losing fiber is left `FAILED`,
and which one loses depends on service availability order.

## How the thresholds are computed

The sections above keep referring to "the trigger", "the reminder position" and "the
retention budget". This section derives each one, so you do not have to guess.

> **Just want to set it?** `thresholdTokens` takes an absolute number, so there is
> nothing to compute: `thresholdTokens: 450000` means compaction at 450K, a reminder at
> 418K and a 20,000-token tail. The rest of this section explains the defaults and helps
> when a number comes out unexpected.

### Inputs (not configuration)

| Symbol | Meaning | Where it comes from |
|---|---|---|
| `contextWindow` | **The model's declared total capacity** — one window shared by input and output | Declared by the adapter and resolved at runtime. A 1M model means 1,000,000 |
| `reservedCompletionTokens` | **Output tokens reserved for this reply**; this space cannot hold input | The output cap for this request. Usually 0 and ignorable |

`contextWindow` belongs to the **model**, not to configuration. Swap models and every
number below changes.

### Step 1 — how much room is left

| Symbol | Formula | Meaning |
|---|---|---|
| `M` | `contextWindow − reservedCompletionTokens` | **What is actually available for conversation content** |
| `B` | `M − reserve` | **The ceiling the conversation may grow to.** The reserve defaults to `max(15% of window, 16384)` |

The reserve is configured by `reserveTokens`; leave it blank to get the derivation above.
It has one job: to hold compaction **below** the physical window ceiling so there is room
to spare.

### Step 2 — the trigger: two forms, absolute wins

| What you write | Where it triggers |
|---|---|
| `thresholdTokens: 450000` | **450,000.** The absolute count wins; the window is folded in at runtime, so it stays 450K across models |
| `thresholdTokens: -1` (default) + `thresholdRatio: 0.8` | `floor(min(window × 0.8, B))` → **800,000** on a 1M window |

An absolute count is also guarded: **at or past the window** it could never fire, so it
falls back to `B`.

### Step 3 — the retention budget

```
keepRecentTokens = 20000 (default, absolute)
```

**How much recent raw text is kept verbatim after a compaction.** Hard constraint: it
must be `< trigger`, or the engine throws.

The number is a **budget**, and the real tail is only ever larger: selection works on
whole messages and cannot split one, so the accumulation overshoots the budget, and the
cut then moves further back to satisfy tool-call/tool-result pairing
(`dsh-compaction-basic/lib/index.js:410-433`).

> If you explicitly configured the built-in `retainTokens` or `retainRatio`, those win and
> this field does nothing.

### Step 4 — the reminder position: derived, not configured

```
lead = min(32000, max(8192, floor(trigger × 0.125)))
band = [ trigger − lead,  trigger )
```

| Symbol | Meaning | How to read it |
|---|---|---|
| `lead` | **How long before the trigger the model is told to write its notebook** | Derived exactly as omp derives it, which exposes no setting for it either. The `32000` ceiling binds from a trigger of 256,000 upward, so in a 1M window the lead is always 32,000 |
| `band` | **The interval in which the reminder can fire**, half-open | Compaction happens at `≥ trigger` while the reminder lives strictly below it, so **no single step can both remind and compact** |

### Worked example: a 1M window

`contextWindow = 1,000,000`, `reservedCompletionTokens = 0`, `thresholdTokens: 450000`:

| Step | Quantity | Formula | Value |
|---|---|---|---|
| 1 | reserve | max(1,000,000 × 15%, 16384) | 150,000 |
| 1 | `B` | 1,000,000 − 150,000 | 850,000 |
| 2 | trigger | absolute | **450,000** |
| 3 | `keepRecentTokens` | default | **20,000** |
| 4 | `lead` | min(32000, floor(450,000 × 0.125)) | 32,000 |
| 4 | `band` | [450,000 − 32,000, 450,000) | **[418,000, 450,000)** |
| — | one compaction | 450,000 − 20,000 | 430,000 |

So the event chain is: **reminder at 418k → model writes the notebook → compaction at 450k
(static template, zero model calls) → a 20k tail plus the notebook are kept → the notebook
is re-published if a rollover shadowed it**.

With everything at its default instead (`thresholdTokens: -1`), the trigger falls back to
`min(window × 0.8, B)` — 800,000 on a 1M window — and the band becomes [768,000, 800,000).

Three things that are easy to get wrong:

1. **The reminder position cannot be moved on its own.** It follows the trigger; to move
   it, move the trigger.
2. **An absolute trigger is genuinely absolute.** The window is resolved at runtime and
   the ratio is derived from it, so a 200k model and a 1M model both compact at the number
   you wrote. It yields only when the number is at or past the window.
3. **`reserveTokens` is not the output reservation.** It exists so compaction does not run
   flush against the window ceiling; it defaults to 15% of the window, floored at 16384.

## Configuration

> **dsh's own compaction configuration can only be changed in the config file (the
> profile YAML). dsh reads it once at startup, so a change requires restarting dsh.**

Every compaction setting (`auto`, `thresholdRatio`, `headroomTokens`, `retainRatio`,
`retainTokens`, `maxTokens`, `summarizationProvider`, `summarizationModel`,
`compactionRetries`, `maxOverflowRetries`, `modelPolicies`) is accepted on this row
unchanged, composed from the dsh engine's own schema so there is exactly one declaration
of each. These are **not** volatile, **do not appear on the settings page**, and take
effect only after a restart. Plus these, which are live-editable in the settings page:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Off unregisters the tools and reminder (the static rollover stays) |
| `maxNotebookBytes` | `16384` | Notebook UTF-8 byte cap |
| `reminderEnabled` | `true` | Send the threshold reminder |
| `thresholdTokens` | `-1` | Absolute rollover trigger. An absolute count wins over `thresholdRatio`; `-1` follows the ratio |
| `keepRecentTokens` | `20000` | Verbatim recent history kept after a rollover, absolute. Replaces the built-in `retainRatio`/`retainTokens` |
| `reserveTokens` | blank | Reserve held below the trigger. Blank derives `max(15% of window, 16384)` |
| `rolloverText` | see above | Static template written at the boundary |

The reminder position has no key: it is derived from the trigger, as upstream derives it.

## Honest limitations

- **Notebook quality and timeliness are entirely the model's responsibility.** The
  plugin never writes, backfills, or repairs your notes. If the model writes nothing,
  the boundary still commits and details are only recoverable from raw history.
- **A notebook revision is a message that stays in the conversation**, so frequent
  rewrites grow the context. This is why the reminder asks for a compact index and
  whole replacement rather than appending.
- **A zero-cost boundary is not a zero-cost feature.** Writing the notebook is a tool
  call; the cost is moved earlier, not removed.
- **An out-of-repo plugin cannot declare its own session event type** in DSH
  0.2.0-rc.2. Unknown event types must carry an `ignorable` envelope marker to survive
  a reload, and the SDK exposes no writer for it. The notebook therefore rides a
  `user/message` with a plugin-owned `source.kind`. See `src/notebook.ts` for the full
  write-up.
- **The parent wraps the summary.** The base backend frames every static summary in
  `CHECKPOINT_PREAMBLE` + `<compacted-summary>`; the wrapper is not removable without
  reimplementing the transaction. The inner block is preserved verbatim.
- **dsh's compaction settings are invisible and immutable in the settings page; change
  the config file and restart dsh.** This keeps them working by value, and is a design
  trade-off rather than an oversight.
- Restricted-toolset sessions (subagents) that cannot reach `context_notes` degrade to
  a notebook-less rollover.

## Development

```sh
cd packages/dsh-notes-context
npm run typecheck
npm run build
npm test
```

## License

MIT
