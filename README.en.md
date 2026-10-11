# dsh-notes-context

> Brings omp's (Oh My Pi) **notes-backed context compression** to DeepSeek Harness:
> a model-written persistent notebook replaces LLM-summarized compaction.
> **The window boundary itself costs zero model calls.**

English | [简体中文](README.md)

---

## The problem

Here is how DSH's built-in compaction works. When the context window is nearly full, it
asks the model to summarize the older history, then replaces that history with the summary.

That causes three problems.

It is slow. You wait for the summary call, and you are waiting at the exact moment you
wanted to keep working.

It is unreliable. How good the summary is depends on how the model performs this time.

It loses information. By default the model can no longer see the text that was replaced —
only the summary.

This plugin takes another route: **don't summarize, take notes.**

| | Default compaction | This plugin |
|---|---|---|
| Model call at the boundary | Yes (a full summarization request) | **No** (a static template is written) |
| Boundary predictable | No | Yes (local, deterministic) |
| Original history readable afterwards | No | **Yes**, by `seq` |
| Who decides what matters | the summarization model | the model doing the work |

## How it works

**The notebook (`context_notes`)**

As it works, the model records task state, settled decisions, which files it changed, what
is blocking it, and what comes next. The notebook lives with the session and survives a
window rollover.

```
context_notes                    → read the notebook
context_notes { text: "..." }    → replace it whole (not append)
context_notes { text: "" }       → clear it
```

The cap is 16 KiB (UTF-8 bytes). A write past the cap is refused outright rather than
stored in part.

**The reminder (once per window)**

As the context nears the trigger, the plugin sends the model one reminder: update the
notebook now, while the details are still in front of you.

The reminder is **optional**. Ignore it and compaction happens anyway. What it buys is
fidelity, not savings.

**The rollover (no model call)**

At the trigger, the plugin reuses the built-in compaction's retention policy but swaps out
the summarizing step: instead of asking the model for a summary, it writes a fixed
transition note followed by the current notebook. No model call is made.

**Raw history read-back (`context_history`)**

A rollover only removes the replaced history from what the model can see; it does not
delete it, because the log is append-only. When the model needs an old detail, it can read
the original text back by `seq`:

```
context_history                                 → full index
context_history { from: 120, to: 200 }          → a range
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

> **The reminder position has no setting.** It is tied to the trigger by a formula:
> `lead = min(32000, max(8192, floor(trigger × 0.125)))`.
> With `thresholdTokens: 450000`, the reminder lands at **418,000** — 32,000 before the
> trigger. To move the reminder, move the trigger.

Changes apply **immediately**, whether you edit the settings page or the config file. The
exception is `rolloverText`, `notebookSummaryMaxChars` and the two `static*` labels: those
are read only while a boundary is being written, so they take effect at the **next
rollover**.

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

- **Notebook quality is entirely up to the model.** The plugin never backfills a notebook
  or writes one for you. If the model records nothing useful, details are left in the raw
  history and have to be recovered from there.
- **Every notebook write stays in the conversation as a message**, so rewriting it often
  makes the context grow.
- **A free boundary is not a free feature.** Writing the notebook is a tool call. The cost
  moved earlier; it did not go away.
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
