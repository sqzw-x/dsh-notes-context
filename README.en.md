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
`[threshold − lead, threshold)` with `lead` derived from `threshold × 0.125` and then
bounded by 8192 and 32000 (see [How the thresholds are computed](#how-the-thresholds-are-computed)).
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

The sections above keep referring to "the threshold", "the lead" and "the retention
budget". This section derives each one, so you do not have to guess.

### Inputs (not configuration)

| Symbol | Meaning | Where it comes from |
|---|---|---|
| `contextWindow` | **The model's declared total capacity** — one window shared by input and output | `ctx.llm.resolveModelInfo(provider, model)` → `context.contextWindow`, declared by the adapter |
| `reservedCompletionTokens` | **Output tokens reserved for this reply**; this space cannot hold input | `session.requestHeader().config.maxTokens` → else `info.defaultMaxTokens` → else `0` |

`contextWindow` belongs to the **model**, not to configuration. Swap models and every
number below changes.

### Step 1 — how much room is left

| Symbol | Formula | Meaning |
|---|---|---|
| `M` | `contextWindow − reservedCompletionTokens` | **What is actually available for conversation content** once the output reservation is set aside. The window is shared, so output must be yielded first |
| `B` | `M − headroomTokens` | **The ceiling the conversation may grow to** after the fixed headroom is also deducted. Compaction must not wait until the window is genuinely full |

`headroomTokens` is defined upstream as *"additional pressure headroom beyond the
routed output reservation"* — **a fixed token reserve deducted on top of the output
reservation** (default 65536). It does two things:

1. it holds the threshold **below** the physical capacity ceiling, giving compaction
   that much lead; and
2. an unset `maxTokens` **inherits its value** (`dsh-compaction-basic/lib/index.js:64`).

### Step 2 — the threshold: the smaller of two ceilings

```
thresholdTokens = floor( min( contextWindow × thresholdRatio,  B ) )
                            └────────── ceiling 1 ────────┘   └ceiling 2┘
```

| Ceiling | Formula | Meaning |
|---|---|---|
| 1: window fraction | `contextWindow × thresholdRatio` | **A policy preference**: "compress once the window is 80% used" |
| 2: remaining capacity | `B` | **A physical constraint**: after the output reservation and headroom, this is all there is |

`thresholdTokens` is **the pressure at which dsh performs one compaction**. Each ceiling
is an independent reason to stop growing, and **either one is sufficient** — hence the
minimum.

### Step 3 — the retention budget

```
retainTokens = retainTokens                     when an absolute value is configured
             = floor( M × retainRatio )         otherwise
```

**How much recent raw text is kept verbatim after a compaction.** Hard constraint: it
must be `< thresholdTokens`, or the engine throws — compacting to still-above-threshold
would be pointless.

Mind the **base**: this multiplies `M` (the input budget), while `thresholdRatio`
multiplies `contextWindow`. The two are not comparable directly.

The number is a **budget**, and the real tail is only ever larger: selection works on
whole messages and cannot split one, so the accumulation overshoots the budget, and the
cut then moves further back to satisfy tool-call/tool-result pairing
(`dsh-compaction-basic/lib/index.js:410-433`).

### Step 4 — the reminder lead and band

```
lead = min( max( round(thresholdTokens × reminderLeadRatio),  reminderLeadMinTokens ),
            max(reminderLeadMinTokens, reminderLeadMaxTokens) )
band = [ max(0, thresholdTokens − lead),  thresholdTokens )
```

| Symbol | Meaning | How to read it |
|---|---|---|
| `lead` | **How long before the threshold the model is told to write its notebook** | Three layers: ① by ratio → ② raised to the lower bound → ③ capped by the upper bound. The outer `max(Min, Max)` keeps an inverted pair from producing a negative-width band |
| `band` | **The interval in which the reminder can fire**, half-open | `max(0, …)` keeps the start non-negative when the lead exceeds the threshold |

The half-open interval is deliberate: dsh compacts at `≥ thresholdTokens`
(`dsh-compaction-basic/lib/index.js:941`) while the reminder lives strictly below it, so
**no single step can both remind and compact**.

### Worked example: a 1M window on defaults

`contextWindow = 1,000,000`, `reservedCompletionTokens = 0`:

| Step | Quantity | Formula | Value |
|---|---|---|---|
| 1 | `M` | 1,000,000 − 0 | 1,000,000 |
| 1 | `B` | 1,000,000 − 65,536 | 934,464 |
| 2 | ceiling 1 | 1,000,000 × 0.8 | 800,000 |
| 2 | ceiling 2 | = `B` | 934,464 |
| 2 | `thresholdTokens` | min(800,000, 934,464) | **800,000** ← ratio wins |
| 3 | `retainTokens` | floor(1,000,000 × 0.16) | **160,000** |
| 4 | `lead` | 100,000 → 100,000 → 32,000 | **32,000** ← upper bound wins |
| 4 | `band` | [800,000 − 32,000, 800,000) | **[768,000, 800,000)** |
| — | one compaction | 800,000 − 160,000 | ~640,000 |

So the event chain is: **reminder possible from 768k → model writes the notebook →
compaction at 800k (static template, zero model calls) → a 160k tail plus the notebook
are kept → the notebook is re-published if a rollover shadowed it**. The window then
advances 800k per cycle, i.e. a period of 1.25 one-million-token windows with a fixed
in-window position.

Three things that are easy to get wrong:

1. **`lead` is capped at 32k, not 12.5%.** `800k × 0.125 = 100k` is held down by
   `reminderLeadMaxTokens = 32000`. To let the lead scale with the threshold you must
   raise that upper bound too.
2. **Which ceiling wins depends on `reservedCompletionTokens`.** With a reservation of
   ≤ 131,072 the threshold is 800k; at 200,000 ceiling 2 takes over and it drops to
   734,464. **A larger output reservation lowers the threshold.**
3. **`maxTokens` is not an independent setting.** Left unset it equals `headroomTokens`,
   and it feeds both the output reservation and `B`.

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
| `reminderLeadRatio` | `0.125` | Reminder lead as a fraction of the threshold |
| `reminderLeadMinTokens` | `8192` | Lower bound for the lead |
| `reminderLeadMaxTokens` | `32000` | Upper bound for the lead |
| `rolloverText` | see above | Static template written at the boundary |

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
