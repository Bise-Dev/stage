//! `stage` — the local CLI a coding agent drives to author a Debrief (and, in
//! later PRs, to read the author's Review notes back). No network, no Stage
//! token, no GitHub credentials: it writes through `stage-core` into the
//! app-data store the desktop app shares (ADR-0011).

use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use stage_core::diff::{
    assert_files_in_base_diff, default_base, self_review_diff, DiffLineIndex, SelfReviewScope,
};
use stage_core::{
    repo_key_from_cwd, repo_root_from_cwd, DebriefInput, NoteStatus, StageError, Store,
};

#[derive(Parser)]
#[command(name = "stage", about = "Stage — local agent self-review", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Author or inspect the Debrief for the current repo + branch.
    #[command(subcommand)]
    SelfReview(SelfReviewCmd),
}

#[derive(Subcommand)]
enum SelfReviewCmd {
    /// List the files in the current Base-scope diff (committed branch work +
    /// uncommitted edits, against `--base` or the repo's default branch) as
    /// JSON — the candidate files for a Debrief.
    Files {
        /// Base branch to diff against. Defaults to the repo's default branch.
        #[arg(long)]
        base: Option<String>,
    },
    /// Read a Debrief JSON document from stdin and store it. Every `file` must
    /// be in the Base-scope diff against the payload's `base` (else rejected).
    /// Echoes the stored Debrief (with resolved timestamps) on success.
    ///
    /// Stdin shape:
    /// `{ "base": "main", "steps": [{ "file": "...", "intro": "md", "order": 0 }] }`
    Set,
    /// Print the stored Debrief for the current repo + branch as JSON (or
    /// `null` if none has been authored).
    Show,
    /// Delete the stored Debrief for the current repo + branch.
    Clear,
    /// List the author's Review notes for the current repo + branch as JSON,
    /// each carrying its `replies` thread and a computed `outdated` flag (its
    /// anchored file left the diff, or its anchored line range is gone). Filter
    /// with `--status`; the agent reads `--status open` to find work.
    Notes {
        #[arg(long, value_enum)]
        status: Option<StatusArg>,
    },
    /// Append the agent's reply to a Review note's thread, marking it
    /// `addressed`. Fails loud if the note id is unknown or already resolved.
    Address {
        /// The note id (from `notes`).
        id: String,
        /// The agent's reply describing how it addressed the note.
        #[arg(long)]
        reply: String,
    },
}

/// `--status` filter for `notes`, mirroring [`NoteStatus`].
#[derive(Clone, Copy, ValueEnum)]
enum StatusArg {
    Open,
    Addressed,
    Resolved,
}

impl From<StatusArg> for NoteStatus {
    fn from(s: StatusArg) -> Self {
        match s {
            StatusArg::Open => NoteStatus::Open,
            StatusArg::Addressed => NoteStatus::Addressed,
            StatusArg::Resolved => NoteStatus::Resolved,
        }
    }
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
            let input: DebriefInput = serde_json::from_str(&raw)?;
            let base = input.base.clone();
            let files: Vec<String> = input.steps.iter().map(|s| s.file.clone()).collect();
            assert_files_in_base_diff(root, &base, &files)?;
            let debrief = store.set_debrief(&key, &base, input.into_steps())?;
            println!("{}", serde_json::to_string_pretty(&debrief)?);
        }
        SelfReviewCmd::Show => {
            let key = repo_key_from_cwd(cwd)?;
            let store = Store::open_default()?;
            match store.get_debrief(&key)? {
                Some(debrief) => println!("{}", serde_json::to_string_pretty(&debrief)?),
                None => println!("null"),
            }
        }
        SelfReviewCmd::Clear => {
            let key = repo_key_from_cwd(cwd)?;
            let store = Store::open_default()?;
            let removed = store.clear_debrief(&key)?;
            eprintln!(
                "stage: {}",
                if removed {
                    "debrief cleared"
                } else {
                    "no debrief to clear"
                }
            );
        }
        SelfReviewCmd::Notes { status } => {
            let key = repo_key_from_cwd(cwd)?;
            let store = Store::open_default()?;
            let notes = store.list_notes(&key, status.map(Into::into))?;
            // `outdated` is computed against the current Debrief's base (the
            // diff the notes live on), falling back to the default branch. The
            // line index is built once and shared across notes — and matches the
            // app's computation (ADR-0012) so the agent and author never disagree.
            let base = match store.get_debrief(&key)? {
                Some(debrief) => debrief.base,
                None => default_base(root)?,
            };
            let index = DiffLineIndex::from_base_diff(root, &base)?;
            let views: Vec<_> = notes
                .into_iter()
                .map(|n| {
                    let outdated = index.is_outdated(&n.anchor);
                    n.into_view(outdated)
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&views)?);
        }
        SelfReviewCmd::Address { id, reply } => {
            let key = repo_key_from_cwd(cwd)?;
            let store = Store::open_default()?;
            let note = store.address_note(&key, &id, &reply)?;
            println!("{}", serde_json::to_string_pretty(&note)?);
        }
    }
    Ok(())
}
