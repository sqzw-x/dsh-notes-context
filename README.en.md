# dsh-notes-context

> Brings omp's (Oh My Pi) **notes-backed context compression** to DeepSeek Harness:
> a model-maintained persistent notebook replaces LLM-summarized compaction, so a window
> boundary costs no model call.

English | [简体中文](README.md)

---

## Built-in compaction in DSH

When the context approaches the window limit, DSH calls the model to summarize the older
history and replaces that history with the summary. Three problems:

- **Slow**: the summary call must return first.
- **Unreliable**: summary quality depends on that call.
- **Lossy**: the replaced history is no longer visible to the model by default.

This plugin uses a notebook instead: **don't summarize, take notes.**

| | Built-in compaction | This plugin |
|---|---|---|
| Model call at the boundary | Yes | **No** (a static template is written) |
| Boundary predictable | No | Yes (local, deterministic) |
| Original text readable afterwards | No | **Yes**, by `seq` |
| What matters is decided by | the summarization model | the model doing the work |

## How it works

### The notebook `context_notes`

The model maintains a notebook across the session: task state, settled decisions, files it
changed, blockers, next steps. The notebook survives a window rollover.

```
context_notes                    → read
context_notes { text: "..." }    → replace whole (not append)
context_notes { text: "" }       → clear
```

Cap: 16 KiB (UTF-8 bytes). A write past the cap is refused, never stored in part.

### The reminder (once per window)

When the context usage approaches the compression threshold — within the final 32,000
tokens before it — one reminder is injected, telling the model to update the notebook.

The reminder may be ignored: compaction proceeds regardless. Its purpose is to limit detail
loss.

### The rollover (no model call)

At the trigger, the plugin reuses the built-in retention policy and replaces only the
summarizing step: it writes a fixed transition text plus the current notebook. No model
call is made.

### Raw history read-back `context_history`

A rollover moves the replaced history out of the model's view; it does not delete it (the
log is append-only). The model can read the original text back by `seq`:

```
context_history                                 → index
context_history { from: 120, to: 200 }          → range
context_history { from: 0, to: 50, raw: true }  → raw text
```

## Configuration

The commonly used keys are below. All fields are on the settings page; derivations are in
[Internals](https://github.com/sqzw-x/dsh-notes-context/blob/main/docs/INTERNALS.md).

| Key | Default | Description |
|---|---|---|
| `thresholdTokens` | `-1` | Compaction trigger. An absolute count wins: `450000` means 450K regardless of model. `-1` uses the `thresholdRatio` instead |
| `keepRecentTokens` | `20000` | Upper bound on retained text after a rollover, absolute. The real tail is larger, because selection works on whole messages |
| `reserveTokens` | blank | Reserve below the trigger. Blank means 15% of the window, never below 16384. A target set closer to the window than this reserve comes earlier by at most the reserve |

**The trigger is the lower of two ceilings**: `min(target, window − routed output
reservation − reserve)`. A provider that declares `maxTokens` — the pi-ai family — spends
about four tenths of the window on that reservation, so a high target is held by that
ceiling. That is the window's physical limit, not a configuration error; to land a target
exactly, lower `reserveTokens`.
| `reminderEnabled` | `true` | Whether the reminder is injected |

**The reminder position has no key.** It is derived from the trigger:

```
lead = min(32000, max(8192, floor(trigger × 0.125)))
```

With a trigger of 450,000 the reminder lands at **418,000**. Moving it requires moving the
trigger.

**Applies immediately.** Exception: `rolloverText`, `notebookSummaryMaxChars` and the two
`static*` labels are read only while a boundary is written, so they take effect at the next
rollover.

```yaml
- id: notes-context
  config:
    thresholdTokens: 450000
    keepRecentTokens: 20000
```

## Install

```sh
# From npm (after release: prebuilt, no local build)
dsh plugin --profile <profile> add dsh-notes-context
dsh --profile <profile> --dump-config   # confirm both rows applied
```

Installing from the GitHub source also works, but pnpm will ask you to allow the
package's build script (`prepack` produces `lib/`). Add the `allowBuilds` entry
pnpm prints to the profile's `pnpm-workspace.yaml`, then retry:

```sh
dsh plugin --profile <profile> add github:sqzw-x/dsh-notes-context
```

The bundle contains two patch rows: it disables `compaction-basic` and mounts this package.

## Limitations

- **Notebook quality is decided by the model.** The plugin does not backfill or summarize
  for you. Anything the model failed to record must be recovered from raw history.
- **Every write is a message that stays in the conversation.** Frequent rewrites grow the
  context.
- **A free boundary is not a free feature.** Writing the notebook is a tool call; the cost
  moves earlier rather than away.
- **DSH's own compaction settings are neither visible nor changeable here** — they live in
  the config file and need a dsh restart (why: [Internals](https://github.com/sqzw-x/dsh-notes-context/blob/main/docs/INTERNALS.md)).
- Sessions with a restricted toolset (subagents) that cannot call `context_notes` degrade to
  a notebook-less rollover.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
```

## Publishing

Pushing a `v*` tag publishes to npm through GitHub Actions (the tag must match the
`package.json` version). Tag the current version for the first release; use `npm version`
after that:

```sh
git tag "v$(node -pe 'require("./package.json").version')" && git push origin --tags   # first release
npm version patch && git push --follow-tags                                            # afterwards
```

The first publish needs an `NPM_TOKEN` secret (an npm granular access token with
read/write package permission) in the repository settings. npm Trusted Publishing is an
alternative; the workflow then needs no long-lived token.

## License

MIT
