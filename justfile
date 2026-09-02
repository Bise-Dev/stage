mod client

PRE_COMMIT_VERSION := "4.5.1"
# `proc_log` in mprocs.yaml — the pane→logs/client.log mirror — landed in
# mprocs 0.9.0. An older mprocs drops the block silently, so `run` checks.
MPROCS_MIN_VERSION := "0.9.0"

default:
    @just --list

# Bootstrap the monorepo: the client and the pre-commit hook. Stage is
# backend-free (ADR-0022) — there is nothing else to set up.
[group('setup')]
bootstrap:
    just client::install
    uv tool run pre-commit@{{PRE_COMMIT_VERSION}} install

# Launch the dev stack in mprocs, titled with the current branch
[group('dev')]
run:
    #!/usr/bin/env bash
    set -euo pipefail
    # Fail loud rather than run without logs: an mprocs older than
    # {{MPROCS_MIN_VERSION}} ignores `proc_log` in mprocs.yaml without a word,
    # and the session's only output is then the live pane.
    have="$(mprocs --version | awk '{print $NF}')"
    want="{{MPROCS_MIN_VERSION}}"
    if [ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -1)" != "$want" ]; then
        echo "error: mprocs $have is too old — mprocs.yaml needs >= $want for proc_log" >&2
        echo "       upgrade with: volta install mprocs@latest" >&2
        exit 1
    fi
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    exec mprocs --proc-list-title "⎇ $branch"

# Print the dev-stack log with the pane's terminal escapes stripped.
# `proc_log` mirrors the pty verbatim, so the pane keeps its colours and the
# file keeps their escape sequences — which makes a raw `grep -i warn` miss
# coloured levels and drags control codes into anything you paste. Read through
# this instead: `just logs | grep -i error`, `just logs | pbcopy`.
[group('dev')]
logs:
    python3 scripts/strip-ansi.py logs/client.log

alias pc := pre-commit

# Run all pre-commit hooks against every file
[group('qa')]
pre-commit:
    uv tool run pre-commit@{{PRE_COMMIT_VERSION}} run --all-files

# Full local QA pipeline: pre-commit hooks + heavy checks + tests
[group('qa')]
verify:
    just pre-commit
    just client::clippy
    just client::test
