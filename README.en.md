# dsh-notes-context

> Brings omp's (Oh My Pi) **notes-backed context compression** to DeepSeek Harness:
> a model-written persistent notebook replaces LLM-summarized compaction.
> **The window boundary itself costs zero model calls.**

English | [简体中文](README.md)

---

## The problem

DSH's default compaction spends an **extra LLM call** when context pressure crosses a
threshold, summarizing the older span. Three costs follow: **latency** at the moment you
most want to keep working, **unpredictability** because summary quality is whatever the
model produces, and **loss** because the original text is gone from the model's view.

This plugin takes another route: **don't summarize, take notes.**

| | Default compaction | This plugin |
|---|---|---|
| Model call at the boundary | Yes (a full summarization request) | **No** (a static template is written) |
| Boundary predictable | No | Yes (local, deterministic) |
| Original history readable afterwards | No | **Yes**, by `seq` |
| Who decides what matters | the summarization model | the model doing the work |

## How it works

**The notebook (`context_notes`)** — the model records task state, decisions, changed
files, blockers and next steps into a persistent notebook:

```
context_notes                    → read it
context_notes { text: "..." }    → replace it wholesale (not append)
context_notes { text: "" }       → clear it
```

The cap is 16 KiB (UTF-8 bytes), enforced **before** anything is stored, so an over-long
write never leaves a partial record.

**The reminder (once per window)** — as pressure nears the trigger, the plugin injects one
model-visible reminder, so the model updates the notebook before details fall out of the
window. The reminder is **not load-bearing**: compaction happens whether or not the model
acts on it. What it buys is **fidelity**, not savings.

**The rollover (zero model calls)** — at the trigger, the plugin reuses the built-in
compaction's pressure and retention policy and replaces **only the summary text** with a
static template plus the notebook verbatim. `summarize()` never calls a model.

**Raw history read-back (`context_history`)** — a rollover only **shadows** the history it
replaces; it never deletes it, because the log is append-only. The model can read the
original record back by stable `seq`:

```
context_history                                 → index
context_history { from: 120, to: 200 }          → exact range
context_history { from: 0, to: 50, raw: true }  → raw text
```

## Configuration

Four keys cover most uses. Every field is on the settings page; the derivations are in
[Internals](docs/INTERNALS.md).

| Key | Default | What it does |
|---|---|---|
| `thresholdTokens` | `-1` | **Where compaction triggers.** An absolute count wins, so `450000` means 450K on every model. `-1` follows the `thresholdRatio` instead |
| `keepRecentTokens` | `20000` | **How much recent text is kept**, absolute. The real tail is larger, because selection works on whole messages |
| `reserveTokens` | blank | Room held below the trigger. Blank means 15% of the window, never below 16384 |
| `reminderEnabled` | `true` | Whether the reminder is injected at all |

> **The reminder position cannot be configured.** It is bound to the trigger:
> `lead = min(32000, max(8192, floor(trigger × 0.125)))`.
> So `thresholdTokens: 450000` reminds at **418,000** — 32,000 before the trigger. To move
> the reminder, move the trigger.

Changes apply **immediately**, from the settings page or the config file. The exception is
`rolloverText`, `notebookSummaryMaxChars` and the two `static*` labels: those are read only
when a boundary is written, so they apply at the **next rollover**.

```yaml
- id: notes-context
  config:
    thresholdTokens: 450000
    keepRecentTokens: 20000
```

## Install

```sh
dsh plugin --profile <your profile> add ./packages/dsh-notes-context
dsh --profile <your profile> --dump-config   # confirm both rows applied
```

The bundle ships two patch rows: it disables `compaction-basic` and mounts this package.

## Honest limitations

- **Notebook quality and timeliness are entirely the model's responsibility.** The plugin
  never backfills or summarizes for you. If the model writes nothing, details are only
  recoverable from raw history.
- **Every notebook write is a message that stays in the conversation**, so frequent
  rewrites grow the context.
- **A zero-cost boundary is not a zero-cost feature.** Writing the notebook is a tool call;
  the cost moved earlier rather than away.
- **DSH's own compaction settings are neither visible nor changeable here** — they live in
  the config file and need a dsh restart (why: [Internals](docs/INTERNALS.md)).
- Restricted-toolset sessions (subagents) that cannot reach `context_notes` degrade to a
  notebook-less rollover.

## Development

```sh
cd packages/dsh-notes-context
npm run typecheck
npm run build
npm test
```

## License

MIT
