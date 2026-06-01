//! `stage` — the local CLI a coding agent drives to author a Handoff (and, in
//! later PRs, to read the author's Review notes back). No network, no Stage
//! token, no GitHub credentials: it writes through `stage-core` into the
//! app-data store the desktop app shares (ADR-0011).

use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use stage_core::diff::{
    assert_files_in_base_diff, default_base, self_review_diff, SelfReviewScope,
};
use stage_core::{repo_key_from_cwd, repo_root_from_cwd, HandoffInput, StageError, Store};

#[derive(Parser)]
#[command(name = "stage", about = "Stage — local agent self-review", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Author or inspect the Handoff for the current repo + branch.
    #[command(subcommand)]
    SelfReview(SelfReviewCmd),
}

#[derive(Subcommand)]
enum SelfReviewCmd {
    /// List the files in the current Base-scope diff (committed branch work +
    /// uncommitted edits, against `--base` or the repo's default branch) as
    /// JSON — the candidate files for a Handoff.
    Files {
        /// Base branch to diff against. Defaults to the repo's default branch.
        #[arg(long)]
        base: Option<String>,
    },
    /// Read a Handoff JSON document from stdin and store it. Every `file` must
    /// be in the Base-scope diff against the payload's `base` (else rejected).
    /// Echoes the stored Handoff (with resolved timestamps) on success.
    ///
    /// Stdin shape:
    /// `{ "base": "main", "steps": [{ "file": "...", "intro": "md", "order": 0 }] }`
    Set,
    /// Print the stored Handoff for the current repo + branch as JSON (or
    /// `null` if none has been authored).
    Show,
    /// Delete the stored Handoff for the current repo + branch.
    Clear,
}

fn main() -> ExitCode {
    // clap handles --help/--version/parse errors itself (exiting before we run).
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            // Fail loud (CLAUDE.md): the complete cause to stderr, nonzero exit.
            eprintln!("stage: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), StageError> {
    let cwd = std::env::current_dir()?;
    let root = repo_root_from_cwd(&cwd)?;
    match cli.command {
        Command::SelfReview(cmd) => self_review(cmd, &cwd, &root),
    }
}

fn self_review(cmd: SelfReviewCmd, cwd: &Path, root: &Path) -> Result<(), StageError> {
    match cmd {
        SelfReviewCmd::Files { base } => {
            let base = match base {
                Some(b) => b,
                None => default_base(root)?,
            };
            let diff = self_review_diff(root, SelfReviewScope::Base, Some(&base))?;
            // Compact projection: the agent reads file contents itself, so it
            // only needs the in-scope paths, their status, and line counts.
            let files: Vec<_> = diff
                .files
                .iter()
                .map(|f| {
                    serde_json::json!({
                        "file": f.path,
                        "status": f.status,
                        "additions": f.additions,
                        "deletions": f.deletions,
                    })
                })
                .collect();
            let out = serde_json::json!({ "base": base, "files": files });
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        SelfReviewCmd::Set => {
            let key = repo_key_from_cwd(cwd)?;
            let store = Store::open_default()?;
            let mut raw = String::new();
            std::io::stdin().read_to_string(&mut raw)?;
            let input: HandoffInput = serde_json::from_str(&raw)?;
            let base = input.base.clone();
            let files: Vec<String> = input.steps.iter().map(|s| s.file.clone()).collect();
            assert_files_in_base_diff(root, &base, &files)?;
            let handoff = store.set_handoff(&key, &base, input.into_steps())?;
            println!("{}", serde_json::to_string_pretty(&handoff)?);
        }
        SelfReviewCmd::Show => {
            let key = repo_key_from_cwd(cwd)?;
            let store = Store::open_default()?;
            match store.get_handoff(&key)? {
                Some(handoff) => println!("{}", serde_json::to_string_pretty(&handoff)?),
                None => println!("null"),
            }
        }
        SelfReviewCmd::Clear => {
            let key = repo_key_from_cwd(cwd)?;
            let store = Store::open_default()?;
            let removed = store.clear_handoff(&key)?;
            eprintln!(
                "stage: {}",
                if removed {
                    "handoff cleared"
                } else {
                    "no handoff to clear"
                }
            );
        }
    }
    Ok(())
}
