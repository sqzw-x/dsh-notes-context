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
`[threshold − lead, threshold)` with `lead = clamp(threshold × 0.125, 8192, 32000)`.
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

## Configuration

Every base compaction knob (`auto`, `thresholdRatio`, `headroomTokens`, `retainRatio`,
`retainTokens`, `maxTokens`, `compactionRetries`, `maxOverflowRetries`, `modelPolicies`)
is accepted on this row unchanged, composed from the base engine's own schema so there
is exactly one declaration of each. Plus:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Off unregisters the tools and reminder (the static rollover stays) |
| `maxNotebookBytes` | `16384` | Notebook UTF-8 byte cap |
| `reminderEnabled` | `true` | Send the threshold reminder |
| `reminderLeadRatio` | `0.125` | Warm-band width as a fraction of the threshold |
| `reminderLeadMinTokens` | `8192` | Lower clamp for the band width |
| `reminderLeadMaxTokens` | `32000` | Upper clamp for the band width |
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
