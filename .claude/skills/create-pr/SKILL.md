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
   - `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` if base is unclear. If this fails with a repo-resolution error, fall back to `git symbolic-ref refs/remotes/origin/HEAD` (and see auth note below).
2. **Push the branch** — `git push origin HEAD`; add `-u` only if upstream isn't set (`git config branch.$(git branch --show-current).remote` is empty).
3. **Decide the Conventional Commit type** from the diff using the table in *Title — Conventional Commits* below. Pick the *narrowest* type that fits.
4. **Check for visual changes** — if the diff touches UI (frontend components, styles, templates, generated images), ask the user:
   > "This PR touches the UI. Can you attach a screenshot or short screen capture? Paste the image or drop the file path here, or say 'skip'."
   Wait for the response before continuing. If they provide a path, embed it as `![](path)` in the body.
5. **Draft title and body** following the templates below. If the user said "draft" / "wip" / "not ready for review", pass `--draft` to `gh pr create`.
6. **Create the PR** with a HEREDOC:
   ```sh
   gh pr create --title "<type>(<scope>): <subject>" --body "$(cat <<'EOF'
   ...body...
   EOF
   )"
   ```
7. **Return the PR URL** to the user.

### When `gh` fails with a repo-resolution error

`GraphQL: Could not resolve to a Repository...` means the active `gh` account can't see the repo — common in multi-account setups (personal + work). Check with `gh auth status`; if a different account is logged in, run `gh auth switch -u <other-user>` or `gh auth login` for the right account. Git push over SSH may still work even when the gh API can't see the repo, so the branch may already be pushed; you only need to redo the `gh pr create` step.

## Title — Conventional Commits

`<type>(<scope>)<!>: <subject>`

- **type** (required): see table.
- **scope** (optional): short noun for the area, e.g. `(auth)`, `(api)`, `(client)`, `(dx)`.
- **!** (optional): mark breaking changes; also add `BREAKING CHANGE:` footer in the body.
- **subject**: imperative, lowercase, no trailing period.
- **length**: full title ≤ 70 chars (including `<type>(<scope>): ` prefix).

### Picking the type

| Type | Use when the diff is primarily… | Examples |
|---|---|---|
| `feat` | Adding user-visible capability | New endpoint, new flag, new UI surface |
| `fix` | Correcting broken behaviour | Bug fix, wrong validation, off-by-one |
| `perf` | Making existing behaviour faster / lighter | Query optimisation, caching, smaller bundle |
| `refactor` | Restructuring without behaviour change | Rename, extract module, change internals |
| `docs` | Doc-only changes | README, ADR, code comments, docstrings |
| `test` | Test-only changes | New tests, fixing flaky test, test infra |
| `style` | Formatting-only (no logic) | Whitespace, import order, lint fixes |
| `build` | Build system, deps, packaging | `package.json`, `pyproject.toml`, lockfiles |
| `ci` | CI/CD pipelines | GitHub Actions, workflow files |
| `chore` | Repo hygiene / dev-experience that doesn't ship to users | Tooling, configs, internal scripts |
| `revert` | Reverting a previous commit | Pair with the reverted SHA in the body |

If the diff spans multiple types, pick the *dominant* one and mention the others in the body. If you can't pick, the PR is likely doing two things — ask the user whether to split.

Examples:
- `feat(auth): add passkey login`
- `fix(api): reject empty workspace names`
- `refactor(client)!: drop legacy watcher`
- `chore(dx): monorepo justfile + pre-commit setup`

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
- Aim for 3–6 bullets total across `What changed` + `Review focus`. If you need more than 6, consider whether the PR should be split — but exceed the cap deliberately if the diff genuinely spans multiple distinct areas (and say so).
- No restating the title. No "this PR…" preamble. No marketing.
- Call out anything non-obvious: feature flags, migration order, follow-ups, intentionally-skipped tests, deferred work landing in a separate PR.
- Do NOT include `Generated with Claude Code` or co-author trailers unless the user asks.

## When to ask for a screenshot

Ask when the diff includes any of:
- `.tsx`, `.jsx`, `.vue`, `.svelte`, `.html`, `.css`, `.scss` changes that affect rendered output
- Image/asset additions
- Template files (Django templates, etc.)
- Storybook stories or visual snapshots

Skip the ask for: pure logic refactors, backend-only changes, config, tests, docs.
