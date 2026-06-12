# Installing `self-review-debrief` as a personal (global) skill

This skill drives Stage's **Self-Review** loop from an agent. It already ships inside this repo at
`.claude/skills/self-review-debrief/`, so it works automatically whenever your agent is running with this
repo as the working directory.

Installing it **globally** (under `~/.claude/skills/`) makes it available in *every* session, from *any*
directory — not just when you're inside the Stage repo. This guide is the candid, copy-paste path to do that.

---

## What you need first

| Requirement | Why | Check |
|---|---|---|
| A local clone of the **Stage repo** | The `stage` CLI that the skill calls is built here. This is a **hard prerequisite** — the skill cannot work without it. | You're reading this file, so you have it. |
| **Rust** via `rustup` | To build the `stage` CLI (`client/target/debug/stage`). | `rustup --version` |
| **Claude Code** | The skill runs inside it. | `claude --version` |

> The skill is **local and auth-free** — no network, no tokens. Everything happens on your machine.

---

## How the skill finds Stage

The skill needs to locate one thing: the **`stage` binary**, built at `<stage-repo>/client/target/debug/stage`.
It resolves it in this order:

1. **`$STAGE_REPO`** — an environment variable pointing at your Stage repo root. (This is what a global install uses.)
2. **In-repo relative** — if your current directory already *is* the Stage repo, it just uses `./client/...`.
3. **`$PATH`** — if you put a `stage` binary on your `PATH`.

For a global install you set option 1 once. That's the whole trick.

---

## Step 1 — note your Stage repo path

From inside your Stage clone, print the absolute path and keep it handy:

```sh
cd /path/to/your/stage      # wherever you cloned it
pwd                         # e.g. /Users/you/perso/stage  ← copy this
```

Use the **absolute** path everywhere below (no `~`, no `$HOME`).

---

## Step 2 — tell the skill where Stage lives (`STAGE_REPO`)

Set `STAGE_REPO` so Claude Code's shell sees it in **every** session. The reliable place is the `env` block of
your global Claude settings (`~/.claude/settings.json`) — the agent's shell does not always load your interactive
shell profile, so `.zshrc`/`.bashrc` alone is not enough.

**Easiest:** in a Claude Code session, run

```
/update-config
```

and ask it to set the env var `STAGE_REPO` to your path.

**Or edit `~/.claude/settings.json` by hand** — add the key inside `env`:

```json
{
  "env": {
    "STAGE_REPO": "/Users/you/perso/stage"
  }
}
```

> `settings.json` must stay valid JSON. If `env` already has keys, add `STAGE_REPO` alongside them with a comma.

Restart Claude Code (or start a new session) so the new env is picked up.

---

## Step 3 — install the skill globally

Pick **one** of these. The symlink is recommended: the global skill then always matches the CLI version in your
clone (the skill's command reference tracks the CLI, so a stale copy can lie to you).

**A) Symlink (recommended — stays in sync with the repo):**

```sh
ln -s "$STAGE_REPO/.claude/skills/self-review-debrief" \
      ~/.claude/skills/self-review-debrief
```

**B) Copy (a frozen snapshot — you must re-copy after the skill changes):**

```sh
cp -R "$STAGE_REPO/.claude/skills/self-review-debrief" \
      ~/.claude/skills/self-review-debrief
```

Either way it now lives at `~/.claude/skills/self-review-debrief/` and loads in every session.

---

## Step 4 — build the CLI once (optional)

The skill auto-builds the binary on first use, but that first run then blocks on a full Rust compile. Pre-building
avoids the wait:

```sh
cd "$STAGE_REPO/client" && cargo build -p stage-cli
```

> Always build **from inside `client/`**, never the repo root — the toolchain is pinned per-directory in
> `client/rust-toolchain.toml`, and building from the root can fail to compile `libsqlite3-sys`.

---

## Step 5 — verify

In a **new** session, confirm the env is visible and the binary resolves:

```sh
echo "$STAGE_REPO"                          # should print your path, not blank
ls "$STAGE_REPO/client/target/debug/stage"  # should exist after Step 4
```

Then, from **any** repo you're working in, ask your agent to *"write a self-review debrief"*. It should locate the
CLI via `$STAGE_REPO`, list your changed files, and (if the desktop app is installed) open Stage on the Self-Review
screen. The agent runs the CLI **from your current repo** — `$STAGE_REPO` only tells it where the binary is, not
which code to review.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `stage CLI not found: set STAGE_REPO…` | Env not set or not loaded | Re-check Step 2; start a **new** session after editing settings. |
| `echo "$STAGE_REPO"` prints blank | Settings change not picked up | Confirm it's in `~/.claude/settings.json` `env`, valid JSON; restart Claude Code. |
| Build fails on `libsqlite3-sys` | Built from repo root | `cd "$STAGE_REPO/client"` first, then build. |
| Reviews the wrong repo | Wrong working directory | The CLI reviews *your current directory's* repo. `cd` into the repo you mean. |
| Skill doesn't show up | Symlink/copy missing | Re-run Step 3; check `ls -la ~/.claude/skills/self-review-debrief`. |

---

## Uninstall

```sh
rm ~/.claude/skills/self-review-debrief        # removes symlink or copy
```

Then remove the `STAGE_REPO` line from `~/.claude/settings.json` `env` (or via `/update-config`).
