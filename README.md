# Stage

A local-first tool for human-tailored pull-request review. Authors craft a guided walkthrough ("storyline") over their branch; reviewers follow it and comment. GitHub stays the backend of record.

**So far only the local self-review/debrief aspect is supported**

## Install

There are no prebuilt releases yet — you build the app once from this repo.

### Prerequisites

- [`just`](https://just.systems) — task runner.
- [`bun`](https://bun.sh) — JS runtime & package manager.
- [Rust](https://rustup.rs) via `rustup` — the pinned toolchain (`client/rust-toolchain.toml`) is picked up automatically.
- [`gh`](https://cli.github.com), authenticated (`gh auth login`) — Stage does all GitHub API work through it.
- macOS: Xcode Command Line Tools (`xcode-select --install`).

### Build & install the CLI

```sh
just client::install-cli
```

This builds the desktop app plus the `st` CLI and links the CLI to `~/.local/bin/st` (make sure that's on your `PATH`). Then, from any repo:

```sh
st open              # open the current repo in Stage
st open <pr-url>     # open a specific PR
```

### Install the app into /Applications

`install-cli` leaves the app inside the build tree, which is enough for `st open`. To get a real Mac app, one you can launch from the Dock or Spotlight, install the production build:

```sh
just client::install-app
```

That builds the release bundle and copies it to `/Applications/Stage.app`, replacing any copy already there. `st open` launches the build tree's app when there is one and falls back to `/Applications` (then `~/Applications`), so it keeps working either way — set `STAGE_GUI_BIN` to point it at a specific app.

Because Stage has no prebuilt releases yet, an installed copy can quietly fall behind the repo. **Settings → About** shows the version and the date and time this copy was built — check it there, and re-run `just client::install-app` after pulling.

## How to use

Stage covers both sides of a review:

**As an author:**

1. Work on a feature branch as usual, then run `st open` in the repo. Stage shows your branch's diff against the base branch.
2. **Self-review** your work first: walk the diff, leave notes on files or lines. (A coding agent can attach a "Debrief" — its own chaptered walkthrough of what it did — which you read and annotate here.)
3. When you're happy, hit **Ready to share** and craft the **storyline**: group the changed files into titled **chapters**, each with a short intro telling reviewers what to look at and why. Files you leave out land in an automatic "Everything else" section.
4. **Publish**. Stage commits the storyline to `.stage/<branch>/`, pushes, and links the GitHub PR — all with your own `git`/`gh` credentials.

**As a reviewer:**

1. Open the PR in Stage (`st open <pr-url>`).
2. Follow the storyline chapter by chapter instead of scrolling one flat diff.
3. Comment as you go and submit a verdict — everything is posted as a normal GitHub review, so teammates without Stage see it natively on the PR.

### Agent debriefs (optional)

If you work with a coding agent (e.g. Claude Code), it can attach a **Debrief** to your branch — its own chaptered walkthrough of what it did, which you review and annotate in Stage's Self-Review screen; your notes flow back to the agent. This is driven by the [`self-review-debrief` skill](./.claude/skills/self-review-debrief/): it works out of the box when the agent runs inside this repo. To use it in your own repos, copy (or symlink) the skill folder into `~/.claude/skills/` and set `STAGE_REPO` to your Stage clone's root.

## Learn more

- [`CONTEXT.md`](./CONTEXT.md) — the glossary: what every term means.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the map: topology and where each decision lives.
- [`docs/adr/`](./docs/adr/) — the decisions and their rationale.
- [`CLAUDE.md`](./CLAUDE.md) — conventions for working in this repo.

Developing Stage itself? `just bootstrap` once, then `just run` for the dev stack, and `just pre-commit` / `just verify` before pushing (see [`justfile`](./justfile)).
