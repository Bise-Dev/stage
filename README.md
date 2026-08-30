# Stage

A local-first desktop tool for reading your own branch before anyone else does — and for reading what your coding agent says it did.

Stage shows your branch's diff as a walkthrough you can annotate, entirely on your own machine. When a coding agent works on the branch, it attaches a **Debrief** — its own chaptered account of what it changed — which you read alongside the diff and answer inline. Your notes flow back to the agent.

> **Scope of this version.** Stage today supports **one flow: local self-review, with the agent debrief folded into it.** Nothing leaves your machine and no GitHub account is needed.
>
> The wider goal — authors publishing a curated **storyline** over a branch and reviewers following it on the PR — is built, but its UI is **commented out** (see [Not in this version](#not-in-this-version)).

## Install

There are no prebuilt releases yet — you build the app once from this repo.

### Prerequisites

- [`just`](https://just.systems) — task runner.
- [`bun`](https://bun.sh) — JS runtime & package manager.
- [Rust](https://rustup.rs) via `rustup` — the pinned toolchain (`client/rust-toolchain.toml`) is picked up automatically.
- macOS: Xcode Command Line Tools (`xcode-select --install`).
- [`gh`](https://cli.github.com) is **optional** in this version — self-review never calls GitHub. Install and authenticate it (`gh auth login`) only if you want the branch table's remote-freshness fetch.

### Build & install the CLI

```sh
just client::install-cli
```

This builds the desktop app plus the `st` CLI and links the CLI to `~/.local/bin/st` (make sure that's on your `PATH`). Then, from any repo:

```sh
st open              # open the current repo's branch in Stage
```

### Install the app into /Applications

`install-cli` leaves the app inside the build tree, which is enough for `st open`. To get a real Mac app, one you can launch from the Dock or Spotlight, install the production build:

```sh
just client::install-app
```

That builds the release bundle and copies it to `/Applications/Stage.app`, replacing any copy already there. `st open` launches the build tree's app when there is one and falls back to `/Applications` (then `~/Applications`), so it keeps working either way — set `STAGE_GUI_BIN` to point it at a specific app.

Because Stage has no prebuilt releases yet, an installed copy can quietly fall behind the repo. **Settings → About** shows the version and the date and time this copy was built — check it there, and re-run `just client::install-app` after pulling.

## How to use

1. Work on a feature branch as usual, then run `st open` in the repo. Stage opens on the **branch table** — one row per local branch, with its worktree, uncommitted count, debrief freshness and self-review progress.
2. Pick a branch and open **Self-review**. Stage shows the branch's committed work against its **base branch** (your remote default branch unless you change it); uncommitted edits can be folded in as a separate section.
3. Walk the diff file by file. Mark files viewed, and leave **notes** on a file or a line range — a threaded conversation with an open → addressed → resolved lifecycle, stored locally.
4. If a coding agent worked on the branch, its **Debrief** renders right here: the file list groups into the agent's chapters, each with the agent's intro above the files it covers. Opening the branch's self-review is what marks the debrief seen.

### Agent debriefs

If you work with a coding agent (e.g. Claude Code), it can attach a **Debrief** to your branch — its own chaptered walkthrough of what it did — and read your notes back, so the two of you iterate without leaving the machine. This is driven by the [`self-review-debrief` skill](./.claude/skills/self-review-debrief/): it works out of the box when the agent runs inside this repo. To use it in your own repos, copy (or symlink) the skill folder into `~/.claude/skills/` and set `STAGE_REPO` to your Stage clone's root.

The agent talks to Stage only through the `st` CLI against the shared local store — no server, no token, no network.

## Not in this version

These are implemented in the engine, but their UI is commented out, so you will not find them in the app:

| Not available yet | What it will be |
| --- | --- |
| **Ready to share** / **New review…** | Turning a branch into a shareable **Review** artifact. |
| **Storyline** composition | Grouping changed files into titled **chapters** with intros written for reviewers. |
| **Publish** | Committing the storyline to `.stage/<branch>/`, pushing, and linking the GitHub PR. |
| **Reviewer entry** (`st open <pr-url>`) | Opening someone's PR read-only and following their storyline. Currently refused with a loud error. |
| PR status columns, **verdicts**, PR discussion | GitHub review activity posted through your own `gh`. |

Commented out rather than deleted because the code works and is meant to come back on. Each site carries a comment saying why; search the client for `COMMENTED OUT with the review surface`.

## Learn more

- [`CONTEXT.md`](./CONTEXT.md) — the glossary: what every term means, and which terms are live in this version.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the map: topology and where each decision lives.
- [`docs/adr/`](./docs/adr/) — the decisions and their rationale.
- [`CLAUDE.md`](./CLAUDE.md) — conventions for working in this repo.

Developing Stage itself? `just bootstrap` once, then `just run` for the dev stack, and `just pre-commit` / `just verify` before pushing (see [`justfile`](./justfile)).

## License

[MIT](./LICENSE). Third-party dependency attributions are listed in [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
