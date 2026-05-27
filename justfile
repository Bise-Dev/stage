mod backend
mod client

PRE_COMMIT_VERSION := "4.5.1"

default:
    @just --list

# Bootstrap the whole monorepo: backend, client, and the pre-commit hook
[group('setup')]
bootstrap:
    just backend::bootstrap
    just client::install
    uv tool run pre-commit@{{PRE_COMMIT_VERSION}} install

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
    just backend::test
