# Stage

A local-first tool for human-tailored pull-request review. Authors craft a guided walkthrough ("storyline") over their branch; reviewers follow it and comment. GitHub stays the backend of record.

Stage has no server and no account: it is a desktop app (Tauri) that talks to GitHub through **your own** `gh` and `git`. It stores the walkthrough as committed files in `.stage/<branch>/` on your feature branch.

## Build it locally

### Prerequisites

- [`just`](https://just.systems) — task runner (all commands below).
- [`bun`](https://bun.sh) — JS runtime & package manager.
- [Rust](https://rustup.rs) via `rustup` — the pinned toolchain (`client/rust-toolchain.toml`) is picked up automatically.
- [`gh`](https://cli.github.com), authenticated (`gh auth login`) — Stage does all GitHub API work through it.
- [`mprocs`](https://github.com/pvolok/mprocs) — runs the dev stack.
- [`uv`](https://docs.astral.sh/uv/) — installs the pre-commit hook.
- macOS: Xcode Command Line Tools (`xcode-select --install`) for the Tauri build.

### Setup & run (development)

```sh
just bootstrap    # install JS deps + the pre-commit hook (one-time)
just run          # launch the dev stack: Tauri app with hot reload
```

Logs land in `logs/client.log`.

### Install the app (production build)

```sh
just client::install-cli
```

This builds the desktop bundle plus the `st` CLI and links it to `~/.local/bin/st` (make sure that's on your `PATH`). Then, from any repo:

```sh
st open              # open the current repo in Stage
st open <pr-url>     # open a specific PR
```

### Before pushing changes

```sh
just pre-commit   # linters + formatters + typecheckers
just verify       # pre-commit + clippy + tests (for bigger changes)
```

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

## Learn more

- [`CONTEXT.md`](./CONTEXT.md) — the glossary: what every term means.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the map: topology and where each decision lives.
- [`docs/adr/`](./docs/adr/) — the decisions and their rationale.
- [`CLAUDE.md`](./CLAUDE.md) — conventions for working in this repo.
