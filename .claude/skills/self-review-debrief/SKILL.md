---
name: self-review-debrief
description: Author and revise a Stage Debrief — an agent's reviewable account of its own branch work — and read the author's Review notes back. Use after you (the agent) have made code changes the author will review locally in Stage, or when the author asks you to "update the debrief", "address the review notes", or "write a self-review debrief". Intros and note replies are written terse (caveman-compressed) for fast review; full technical accuracy is preserved.
---

# Self-Review Debrief

You just changed code on a branch. This skill produces a **Debrief**: an ordered account of *what you did and why*, told in **Chapters** (ADR-0025) — each Chapter a titled group of changed files with **one** markdown intro; files carry no per-file title or intro. It is written for the **author** to review locally inside Stage's Self-Review screen. The author leaves **Review notes** — feedback anchored to specific diff lines; you read them back, fix the code, reply, and regenerate the Debrief. That is the local author↔agent loop.

It is **local and auth-free**: no network, no tokens. You write through the `stage` CLI into a local store the Stage app reads. The author never sees raw JSON — they see your intros and notes in the app.

## Caveman voice

Intros and note replies are the wordy part of a Debrief. Write them **terse, like a smart caveman**: all technical substance stays, only fluff dies. Author reads dense + fast, not prose. This is the *content* style — workflow steps below stay as written.

**Drop:** articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/happy to/of course), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Abbreviate common terms (DB/auth/config/req/res/fn/impl). Strip needless conjunctions. Arrows for causality (`X -> Y`). One word when one word enough.

**Keep exact:** technical terms, file + symbol names, code blocks (unchanged), error strings (quoted verbatim). Brevity never costs accuracy.

Pattern: `[thing] [action] [reason]. [next step / watch-out].` Markdown still fine — short heading + terse lines beats a wall of text.

> # Parser extract
> Split `parse()` out of `Loader` -> testable alone. Caller unchanged.
> Watch: error path now returns `Err`, not panic. See `load_test.rs`.

Not: "I refactored the loader by extracting the parsing logic into its own function so that it can be tested independently. The caller remains unchanged. Please note that…"

**Caveman off** — write full prose — when terseness risks misread:

- security / credential / data-exposure implications
- irreversible or destructive changes (migrations, deletes, drops, force-pushes)
- multi-step sequences where fragment order could be read wrong

Resume terse after the part that needs care.

## Locating the `stage` binary

The CLI is built inside the **Stage repo** at `client/target/debug/stage` — **not on `PATH`**. It is **not** bound to the repo you're reviewing: the binary lives in your Stage clone, but it discovers the repo + branch under review from your **current working directory** and keys the Debrief by `(repo, branch)`. So you resolve the binary once, then run it from wherever you're working.

Resolve it at the start, in this order — `$STAGE_REPO` (set when the skill is installed globally), then an in-repo relative path (when your CWD already *is* the Stage clone), then `$PATH`:

```sh
if [ -n "$STAGE_REPO" ]; then ROOT="$STAGE_REPO"
elif [ -e client/stage-cli/Cargo.toml ]; then ROOT="$PWD"; fi

if [ -n "$ROOT" ]; then
  BIN="$ROOT/client/target/debug/stage"
  # Build once if missing, or after stage-cli / stage-core changes — from inside client/.
  [ -x "$BIN" ] || (cd "$ROOT/client" && cargo build -p stage-cli)
elif command -v stage >/dev/null 2>&1; then
  BIN="$(command -v stage)"   # on PATH; note it can't self-build from here
else
  echo "stage CLI not found: set STAGE_REPO to your Stage repo root, or put 'stage' on PATH." >&2
  exit 1
fi
```

(The toolchain is pinned in `client/rust-toolchain.toml` and `rustup` selects it by *current directory*, not `--manifest-path` — building from the repo root silently uses the default toolchain and can fail to compile `libsqlite3-sys`. That is why `STAGE_REPO` points at the **repo root**: it serves both the binary path and the build.)

**Assume the binary is already built** and just point at it; do **not** rebuild on every invocation. Run every command as `"$BIN" self-review …` **from the directory of the repo you're reviewing** — do **not** `cd` into `$STAGE_REPO` to run it. The CLI discovers the repo and current branch itself, so just be on the right branch.

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

2. **Group the files into Chapters and author one intro each.** A Chapter is a narrative unit — a titled, ordered group of related files (e.g. "Core state", "The three steps", "API & infra") with **one** markdown intro in the [Caveman voice](#caveman-voice): what changed across those files and why, decisions and trade-offs, anything the author should scrutinise. **No per-file intros, no per-file titles** — the chapter intro carries the whole group. This is the value of the Debrief; don't restate the diff. Skip files that are pure noise (lockfiles, generated output) if they add nothing to the review — unnarrated files still show up for the author below the chapters.

3. **Build the payload and store it.** The `set` command reads one JSON document from stdin:

   ```jsonc
   {
     "base": "main",
     "chapters": [
       {
         "title": "Parser extract",
         "intro": "Split `parse()` out of `Loader` -> testable alone. Caller unchanged.",
         "files": ["client/src/foo.ts", "client/src/foo.test.ts"]
       },
       {
         "title": "Options plumbing",
         "intro": "Thread new `opt` through -> callers pass `None` by default.",
         "files": ["client/src/bar.ts"]
       }
     ]
   }
   ```

   - `base` — the branch you diffed against (echo back the `base` from `files`).
   - `chapters[].title` — short human title of the narrative unit.
   - `chapters[].intro` — markdown, one per chapter. Because it is multi-line, its newlines must be JSON-escaped (`\n`). **Do not hand-assemble the JSON in a shell string** — a raw newline makes the CLI reject the payload as invalid JSON. Write the document to a file with the editor, then pipe it in:

   ```sh
   "$BIN" self-review set < /tmp/debrief.json
   ```

   - `chapters[].files` — paths **that appeared in `files`**, in the order the author should read them. Files not in the Base diff are **rejected loudly** (see [Rules](#rules)).
   - Chapter order is the array order.

   On success `set` echoes the stored Debrief (with `headSha`/`createdAt`/`updatedAt`). `set` **replaces** the whole Debrief each time — it is the full current account, not an append. Regenerating preserves `createdAt`; it records the branch head SHA, so a rewrite after new commits resets the author's "seen" state. The retired per-file `steps` payload is **rejected loudly** — always send `chapters`.

4. **Open Stage at the Debrief.** Surface the fresh Debrief in the desktop app's Self-Review screen for the author:

   ```sh
   "$BIN" open
   ```

   This launches Stage (or focuses a running instance) directly in Self-Review for the current `(repo, branch)`, with the base set to the Debrief's. **Run it after every successful `set`** — both a fresh produce and the regeneration at the end of [address mode](#address-mode) — and nowhere else. It is **non-fatal**: the Debrief is already stored, so if `open` fails (e.g. the GUI isn't installed — it prints the reason to stderr and exits non-zero), **don't treat the run as failed**. Tell the author the Debrief is stored and ready, and that you couldn't auto-open Stage (with the reason) so they can open it manually.

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

1. **Read it** — `body` is the ask; `anchor.file` (+ optional `lineStart`/`lineEnd`) is where. `outdated: true` means the anchored file is no longer in the current diff — the feedback may be obsolete or the file was reverted; use judgement and say so in your reply.
2. **Fix the code** to satisfy the note. Make the actual change.
3. **Record it** — mark the note addressed with a reply describing *how* you handled it, in the [Caveman voice](#caveman-voice) (terse; full prose for the security/destructive/sequencing exceptions):

   ```sh
   "$BIN" self-review address <id> --reply "Hoisted regex -> module const. One alloc, not per-call."
   ```

   `address` moves the note `open → addressed`. It **fails loud** on an unknown id or a note the author already `resolved` (you cannot re-address a resolved note). It does not resolve the note — only the author closes it (`resolved`) or reopens it.

After every open note is addressed, **regenerate the Debrief** so it reflects the revised code: re-run [produce mode](#produce-mode) (`files` → chapters + intros → `set`). Then tell the author what you changed.

## Rules

- **Never invent files.** Only reference paths from `self-review files`. The CLI rejects a `set` whose chapters name files absent from the Base diff, naming the offenders — this is intentional (the author must never be shown a chapter entry for a file they aren't reviewing). If a path is rejected, re-run `files` and reconcile; do not work around it.
- **Fail loud, don't paper over.** Every command prints its error to stderr and exits non-zero (per `CLAUDE.md`). If a command fails, read the message and fix the cause — don't retry blindly or fabricate output.
- **Chapters, not per-file steps.** One intro per chapter; files inside carry no title or intro (ADR-0025). The old `steps` payload is rejected with a pointer back here.
- **Intros + replies are terse caveman markdown.** Write for a human who can already see the diff: intent and decisions, not line-by-line restatement. Drop fluff, keep every technical fact exact (see [Caveman voice](#caveman-voice)). Switch to full prose for security, destructive, or order-sensitive notes.
- **The Debrief is whole, not incremental.** `set` overwrites. Always send the complete current set of chapters.
- **You only ever set status to `addressed`.** `resolved`/reopen are the author's actions in the app. Don't assume a note is done because you replied.

## Command reference

Every command reads the repo + current branch from your **CWD** and fails loud on error (message to stderr, non-zero exit). The third column is the per-command contract — preconditions and the specific ways it fails.

| Command | Purpose | Contract — preconditions & failure |
|---|---|---|
| `self-review files [--base <b>]` | List Base-scope diff files (Debrief candidates) as JSON. | Output: `{ base, files[] }`. `--base` overrides the diff target (default = repo's default branch). These files are the **only** ones a Debrief may reference. |
| `self-review set` | Read a Debrief JSON doc (`{base, chapters}`) from stdin and store it. | **Rejects** (non-zero exit, names the offenders) any `chapters[].files` entry not present in `files`, and any legacy `steps` payload. **Replaces** the whole Debrief — not append. A raw newline in the doc is invalid JSON → write to a file, then pipe. Preserves `createdAt` across regenerates; records the branch head SHA (a rewrite at a new head resets the author's "seen"). |
| `self-review show` | Print the stored Debrief as JSON, or `null`. | Prints `null` (not an error) when no Debrief is stored. |
| `self-review clear` | Delete the stored Debrief. | Removes the stored Debrief for the current `(repo, branch)`. |
| `self-review notes [--status open\|addressed\|resolved]` | List Review notes as JSON, each with computed `outdated`. | Optional `--status` filter. `outdated: true` = the note's anchored file has left the diff. |
| `self-review address <id> --reply "…"` | Mark a note `addressed` with your reply. | **Fails** on an unknown `<id>` or a note the author already `resolved`. Moves `open → addressed` only — `resolved`/reopen are author-only actions in the app. |
| `open` | Open/focus the Stage desktop app in Self-Review for the current repo. Run after every successful `set`. | **Non-fatal**: on failure (e.g. GUI not installed) it prints the reason to stderr and exits non-zero, but the Debrief is already stored — don't treat the run as failed. |
