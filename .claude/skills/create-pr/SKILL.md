---
name: create-pr
description: Create a GitHub pull request with a short, precise description focused on what changed and what reviewers should watch for, using Conventional Commits for the title. Use when the user asks to "create a PR", "open a pull request", "gh pr create", or wants to ship the current branch for review.
---

# Create PR

Open a PR for the current branch with a tight, review-focused description. Title follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0).

## Workflow

1. **Inspect the branch** — run in parallel:
   - `git status`
   - `git log <base>..HEAD --oneline` (base is usually `main`)
   - `git diff <base>...HEAD`
   - `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` if base is unclear
2. **Push if needed** — `git push -u origin HEAD` when no upstream is set.
3. **Decide the Conventional Commit type** from the diff (see table below). Pick the *narrowest* type that fits.
4. **Check for visual changes** — if the diff touches UI (frontend components, styles, templates, generated images), ask the user:
   > "This PR touches the UI. Can you attach a screenshot or short screen capture? Paste the image or drop the file path here, or say 'skip'."
   Wait for the response before continuing. If they provide a path, embed it as `![](path)` in the body.
5. **Draft title and body** following the templates below.
6. **Create the PR** with a HEREDOC:
   ```sh
   gh pr create --title "<type>(<scope>): <subject>" --body "$(cat <<'EOF'
   ...body...
   EOF
   )"
   ```
7. **Return the PR URL** to the user.

## Title — Conventional Commits

`<type>(<scope>)<!>: <subject>`

- **type** (required): `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **scope** (optional): short noun for the area, e.g. `(auth)`, `(api)`, `(client)`
- **!** (optional): mark breaking changes; also add `BREAKING CHANGE:` footer in the body
- **subject**: imperative, lowercase, no trailing period, ≤ 70 chars total title

Examples:
- `feat(auth): add passkey login`
- `fix(api): reject empty workspace names`
- `refactor(client)!: drop legacy watcher`

## Body template

Keep it short. Skip sections that don't apply.

```md
## What changed
- <bullet per meaningful change, past tense, concrete>

## Review focus
- <where reviewer should look hardest: tricky logic, security, perf, migration safety>

## Screenshots
<only if UI changes — embed image(s) or remove section>
```

Rules for the body:
- 3–6 bullets total across `What changed` + `Review focus`. If you need more, the PR is too big — tell the user.
- No restating the title. No "this PR…" preamble. No marketing.
- Call out anything non-obvious: feature flags, migration order, follow-ups, intentionally-skipped tests.
- Do NOT include `Generated with Claude Code` or co-author trailers unless the user asks.

## When to ask for a screenshot

Ask when the diff includes any of:
- `.tsx`, `.jsx`, `.vue`, `.svelte`, `.html`, `.css`, `.scss` changes that affect rendered output
- Image/asset additions
- Template files (Django templates, etc.)
- Storybook stories or visual snapshots

Skip the ask for: pure logic refactors, backend-only changes, config, tests, docs.
