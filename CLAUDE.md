# Claude conventions

Project-specific guidance for code generation in this monorepo. For domain language and architectural decisions, see [CONTEXT.md](./CONTEXT.md) and [docs/adr/](./docs/adr/).

**Implementation plans are local working notes** — keep them under `docs/plans/` (gitignored), not committed. They're scratch for the task at hand; durable decisions belong in an ADR (`docs/adr/`) or `CONTEXT.md`, never a committed plan file.

## After every change

Run the verify pipeline before declaring any task done:

```sh
just pre-commit       # biome + tsc + cargo fmt + cargo check
```

On bigger changes also run the full pipeline:

```sh
just verify           # pre-commit + clippy + cargo test
```

A change isn't complete until at least the relevant linters and typecheckers pass. If pre-commit modifies files (auto-fix), stage them and re-run. If tsc/clippy report errors, fix them — don't suppress unless you have a specific reason and document it inline.

## Error handling

**Fail loud. No silent fallbacks. No partial-success payloads.** When something goes wrong, two things must happen — both, every time:

1. **Log it** with structured context. In Rust: `tracing::error!(err = %e, …)`. In the webview: `console.warn(...)` is fine for visibility, but it does **not** count as user-facing.
2. **Surface it to the user** with a clear message. In Rust: return a typed `StageError` whose message is a complete, human-readable sentence (pass the underlying cause through — e.g. git's stderr verbatim). In the webview: catch the command rejection and render the error's message in a red banner; don't shorten or rewrite it.

**Explicitly banned:**

- Default-on-error (`unwrap_or_default()`, `return []`, `return "unknown"`) that hides the failure.
- Best-effort warnings collected alongside data (`{"rows": [...], "warnings": [...]}`) — if one piece failed, the whole response fails. The user should never have to wonder whether a row is real or a fallback.
- Catching an error only to log and continue. Logging is half the job; the other half is propagating the error.
- Wrapping an error in a generic message that drops the cause. Carry the real cause in the message or a structured field.

**Why:** in a tool that renders state copied from git and GitHub, "partial" data is a bug-magnet — the user trusts what they see. A loud failure is recoverable; a quietly wrong row isn't. See `client/stage-core/src/github.rs` for the canonical shape: every `gh`/`git` call site checks the exit status and returns git's stderr verbatim on failure.

The one exception (rare and must be documented inline): work that is genuinely fire-and-forget and cannot affect anything the user sees — e.g. emitting a metric, warming a cache after the response has been sent. Even then: log it; the silent part is the user-facing side, not the log.

## Agent skills

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
