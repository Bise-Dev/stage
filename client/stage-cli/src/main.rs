//! `stage` — the local CLI a coding agent drives to author a Handoff (and, in
//! later PRs, to read the author's Review notes back). No network, no Stage
//! token, no GitHub credentials: it writes through `stage-core` into the
//! app-data store the desktop app shares (ADR-0011).

use std::io::Read;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use stage_core::{repo_key_from_cwd, HandoffInput, StageError, Store};

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
    /// Read a Handoff JSON document from stdin and store it. Echoes the stored
    /// Handoff (with resolved timestamps) on success.
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
    let key = repo_key_from_cwd(&cwd)?;
    let store = Store::open_default()?;

    match cli.command {
        Command::SelfReview(SelfReviewCmd::Set) => {
            let mut raw = String::new();
            std::io::stdin().read_to_string(&mut raw)?;
            let input: HandoffInput = serde_json::from_str(&raw)?;
            let base = input.base.clone();
            let handoff = store.set_handoff(&key, &base, input.into_steps())?;
            println!("{}", serde_json::to_string_pretty(&handoff)?);
        }
        Command::SelfReview(SelfReviewCmd::Show) => match store.get_handoff(&key)? {
            Some(handoff) => println!("{}", serde_json::to_string_pretty(&handoff)?),
            None => println!("null"),
        },
        Command::SelfReview(SelfReviewCmd::Clear) => {
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
