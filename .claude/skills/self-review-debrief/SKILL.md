---
name: self-review-debrief
description: Author and revise a Stage Debrief — an agent's reviewable account of its own branch work — and read the author's Review notes back. Use after you (the agent) have made code changes the author will review locally in Stage, or when the author asks you to "update the debrief", "address the review notes", or "write a self-review debrief".
---

# Self-Review Debrief

You just changed code on a branch. This skill produces a **Debrief**: an ordered, per-file account of *what you did and why*, written for the **author** to review locally inside Stage's Self-Review screen. The author leaves **Review notes** anchored to the diff; you read them back, fix the code, reply, and regenerate the Debrief. That is the local author↔agent loop (ADR-0011, `CONTEXT.md` → **Debrief**, **Review note**).

It is **local and auth-free**: no network, no tokens. You write through the `stage` CLI into a SQLite store the desktop app shares. The author never sees raw JSON — they see your intros and notes in the app.

## The `stage` binary

The CLI is a debug build in this repo's cargo workspace — **not on `PATH`**. Build it (incremental; a near-instant no-op when nothing changed), then call it by path. Always build first so the binary matches the current source:

```sh
cargo build -p stage-cli --manifest-path client/Cargo.toml
BIN=client/target/debug/stage
```

Run every command below as `"$BIN" self-review …` from the **repo root**. The CLI discovers the repo and current branch itself; it keys the Debrief by `(repo, branch)`, so just be on the right branch.

## Step 1 — pick the mode

Always start by reading the open Review notes:

```sh
"$BIN" self-review notes --status open
```

- **Non-empty array → [address mode](#address-mode).** The author has feedback waiting. Handle it first.
- **`[]` → [produce mode](#produce-mode).** No outstanding feedback; (re)author the Debrief over your current changes.

## Produce mode

Write a fresh Debrief over your Base-scope changes.

1. **Get the scope.** This lists every file in the diff against the base branch (committed branch work + uncommitted edits) — the only files a Debrief may reference:

   ```sh
   "$BIN" self-review files
   ```

   Output: `{ "base": "main", "files": [{ "file": "...", "status": "...", "additions": N, "deletions": N }] }`. Pass `--base <branch>` to diff against something other than the repo's default branch.

2. **Author an intro per file.** For each file you want the author to review, write a short **markdown** intro in *your own voice* — what you changed in that file and why, decisions and trade-offs, anything the author should scrutinise. This is the value of the Debrief; don't just restate the diff. Skip files that are pure noise (lockfiles, generated output) if they add nothing to the review.

3. **Build the payload and store it.** The `set` command reads one JSON document from stdin:

   ```jsonc
   {
     "base": "main",
     "steps": [
       { "file": "client/src/foo.ts", "intro": "# Refactor\nExtracted the parser so…", "order": 0 },
       { "file": "client/src/bar.ts", "intro": "Thread the new option through…" }
     ]
   }
   ```

   - `base` — the branch you diffed against (echo back the `base` from `files`).
   - `steps[].file` — a path **that appeared in `files`**. Files not in the Base diff are **rejected loudly** (see [Rules](#rules)).
   - `steps[].intro` — markdown. Because it is multi-line, its newlines must be JSON-escaped (`\n`). **Do not hand-assemble the JSON in a shell string** — a raw newline makes the CLI reject the payload as invalid JSON. Write the document to a file with the editor, then pipe it in:

   ```sh
   "$BIN" self-review set < /tmp/debrief.json
   ```

   - `order` — optional; defaults to array position. `set` sorts by it.

   On success `set` echoes the stored Debrief (with `createdAt`/`updatedAt`). `set` **replaces** the whole Debrief each time — it is the full current account, not an append. Regenerating preserves `createdAt`.

4. **Tell the author** it's ready to review in Stage's Self-Review screen.

Inspect or remove the stored Debrief any time with `"$BIN" self-review show` (prints it, or `null`) and `"$BIN" self-review clear`.

## Address mode

The author left Review notes. Each note is feedback anchored to a diff location:

```jsonc
{
  "id": "…uuid…",
  "anchor": { "file": "client/src/foo.ts", "lineStart": 42, "lineEnd": 48 },
  "body": "this allocates on every call — hoist it",
  "status": "open",
  "agentReply": null,
  "outdated": false,
  "createdAt": 1780000000, "updatedAt": 1780000000
}
```

For **each** open note:

1. **Read it** — `body` is the ask; `anchor.file` (+ optional `lineStart`/`lineEnd`) is where. `outdated: true` means the anchored file is no longer in the current diff (the **Stale step** pattern) — the feedback may be obsolete or the file was reverted; use judgement and say so in your reply.
2. **Fix the code** to satisfy the note. Make the actual change.
3. **Record it** — mark the note addressed with a reply describing *how* you handled it:

   ```sh
   "$BIN" self-review address <id> --reply "Hoisted the regex to a module constant."
   ```

   `address` moves the note `open → addressed`. It **fails loud** on an unknown id or a note the author already `resolved` (you cannot re-address a resolved note). It does not resolve the note — only the author closes it (`resolved`) or reopens it.

After every open note is addressed, **regenerate the Debrief** so it reflects the revised code: re-run [produce mode](#produce-mode) (`files` → author intros → `set`). Then tell the author what you changed.

## Rules

- **Never invent files.** Only reference paths from `self-review files`. The CLI rejects a `set` whose steps name files absent from the Base diff, naming the offenders — this is intentional (the author must never be shown a step for a file they aren't reviewing). If a path is rejected, re-run `files` and reconcile; do not work around it.
- **Fail loud, don't paper over.** Every command prints its error to stderr and exits non-zero (per `CLAUDE.md`). If a command fails, read the message and fix the cause — don't retry blindly or fabricate output.
- **Intros are your commentary, in markdown.** Write for a human reviewer who can already see the diff: explain intent and decisions, not line-by-line restatement.
- **The Debrief is whole, not incremental.** `set` overwrites. Always send the complete current set of steps.
- **You only ever set status to `addressed`.** `resolved`/reopen are the author's actions in the app. Don't assume a note is done because you replied.

## Command reference

| Command | Purpose |
|---|---|
| `self-review files [--base <b>]` | List Base-scope diff files (Debrief candidates) as JSON. |
| `self-review set` | Read a Debrief JSON doc from stdin and store it (validates every file). |
| `self-review show` | Print the stored Debrief as JSON, or `null`. |
| `self-review clear` | Delete the stored Debrief. |
| `self-review notes [--status open\|addressed\|resolved]` | List Review notes as JSON, each with computed `outdated`. |
| `self-review address <id> --reply "…"` | Mark a note `addressed` with your reply. |
