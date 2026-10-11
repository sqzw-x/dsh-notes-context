# Acceptance reproduction

How the plugin was verified against a real provider, and how to re-run it.

## Why a separate profile

`desktop` is managed exclusively by the Electron application — `dsh plugin add`
refuses to touch it and `dsh --profile desktop --dump-config` exits with
`error: profile "desktop" is managed exclusively by the Electron application`.
Verification therefore runs on a throwaway profile:

```sh
dsh --profile notes-test --from-default-profile headless
dsh plugin --profile notes-test add /abs/path/to/packages/dsh-notes-context
```

## The instruments

- `acceptance-patch.yml` — points the test profile at a working provider and
  sets a deliberately tiny compaction threshold so rollovers are cheap.
  Edit the provider block for your own credentials (`apiKeyEnv`).
- `dump-request.mjs` — an `llm/stream` observer that prints every outgoing
  request's roles, source kinds and content previews to stderr. This is what
  proved the notebook lands *after* its tool result; a log-only check cannot see
  message ordering. It is also what caught the 400-producing sequence.

Run with both:

```sh
cd /tmp && rm -rf tV && mkdir tV && cd tV
dsh --profile notes-test \
    --patch /abs/path/docs/acceptance-patch.yml \
    --patch /abs/path/docs/diag-patch.yml \
    "Call context_notes with text 'ACCEPT-NOTE'. Then reply OK."
```

## The load-bearing lesson

**The plugin executes `lib/index.js`, not `src/`.** During development a bug
persisted across a "fixed" tree because `src/` was patched while `lib/` was a
stale build still calling `session.append` inside a tool body. A passing
`tsc --noEmit` says nothing about what runs.

So every acceptance run must record the artifact:

```sh
shasum -a 256 packages/dsh-notes-context/lib/index.js
```

and the run must be preceded by `npx tsdown`.

## What a passing run looks like

1. `npx tsc --noEmit` → no output, exit 0.
2. `npm test` → 18/18.
3. The request dump shows each `assistant` tool-call immediately followed by its
   `tool` result, with the notebook-sourced `user` message **after** them.
4. Zero `INVALID_REQUEST` in stderr.
5. The durable log shows `compaction/summary` events with
   `provider: "dsh-notes-context"`, `model: "static-rollover"`, and **no**
   `llmStreamCall` and **no** `usage` — that absence is the zero-LLM claim.
6. A fresh session's first notebook write reports `Notebook revision 1`.
7. `context_history` returns the whole raw transcript including shadowed events.

Session logs live at
`$DSH_HOME/sessions/--<escaped-cwd>--/<sessionId>/session.v4.jsonl.zstd`
and are read with `zstd -dc`.
