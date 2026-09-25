# Stage

A local-first desktop tool for reviewing your coding agent's work before you share it with your colleagues.

Stage shows your branch's diff as a GitHub PR-like walkthrough. When a coding agent works on the branch, it can attach a **Debrief**, its own chaptered account of what it changed. Stage also lets you:
- See all local branches in a table and graph, each with its linked GitHub PR and/or Claude Code session
- Review diffs with comments in a GitHub-style local review

> The goal of this project was for me to create a tool that directly supports my personal local development flow and furthermore to test how far you can go with a heavily Claude Code assisted programming approach. Throughout various iterations I had the pleasure and pain to see what works well and where the limits of such an approach are.
>
> For most of the implementation I've used a variety of skills from the great [repo](https://github.com/mattpocock/skills) of Matt Pocock. You can find the results of that under for example the [CONTEXT.md](CONTEXT.md) file or the [docs/adr](docs/adr) path.

## Local Dev Install

> **Platform:** Stage is developed and tested on macOS only. Linux and Windows are untested, and the install recipes below target macOS.

### Prerequisites

- [`just`](https://just.systems) — task runner.
- [`bun`](https://bun.sh) — JS runtime & package manager.
- [Rust](https://rustup.rs) via `rustup` — the pinned toolchain (`client/rust-toolchain.toml`) is picked up automatically.
- macOS: Xcode Command Line Tools (`xcode-select --install`).
- For contributing only: [`uv`](https://docs.astral.sh/uv/) (runs the `pre-commit` hooks behind `just bootstrap` / `just pre-commit`) and [`mprocs`](https://github.com/pvolok/mprocs) ≥ 0.9.0 (the dev stack behind `just run`).
- [`gh`](https://cli.github.com) is **optional**: self-review never calls GitHub. Install and authenticate it (`gh auth login`) only if you want the branch table's remote-freshness fetch.

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

That builds the release bundle and copies it to `/Applications/Stage.app`, replacing any copy already there. `st open` launches the build tree's app when there is one and falls back to `/Applications` (then `~/Applications`); set `STAGE_GUI_BIN` to point it at a specific app.

> **Settings → About** shows the version and the date and time each copy was built.

## How to use

1. Work on a feature branch as usual, then run `st open` in the repo. Stage opens on the **branch table** — one row per local branch, with its worktree, uncommitted count, debrief freshness and self-review progress.
2. Pick a branch and open **Self-review**. Stage shows the branch's committed work against its **base branch** (your remote default branch unless you change it); uncommitted edits can be folded in as a separate section.
3. Walk the diff file by file. Mark files viewed, and leave **notes** on a file or a line range — a threaded conversation with an open → addressed → resolved lifecycle, stored locally.
4. If a coding agent worked on the branch, its **Debrief** renders right here: the file list groups into the agent's chapters, each with the agent's intro above the files it covers. Opening the branch's self-review is what marks the debrief seen.

### Agent debriefs

If you work with a coding agent (e.g. Claude Code), it can attach a **Debrief** to your branch — its own chaptered walkthrough of what it did — and read your notes back, so the two of you iterate without leaving the machine. This is driven by the [`self-review-debrief` skill](./.claude/skills/self-review-debrief/): it works out of the box when the agent runs inside this repo. To use it in your own repos, copy (or symlink) the skill folder into `~/.claude/skills/` and set `STAGE_REPO` to your Stage clone's root.

The agent talks to Stage only through the `st` CLI against the shared local store — no server, no token, no network.

## License

[MIT](./LICENSE). Third-party dependency attributions are listed in [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
