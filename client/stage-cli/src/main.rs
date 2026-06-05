//! `stage` — the local CLI a coding agent drives to author a Debrief (and, in
//! later PRs, to read the author's Review notes back). No network, no Stage
//! token, no GitHub credentials: it writes through `stage-core` into the
//! app-data store the desktop app shares (ADR-0011).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{ExitCode, Stdio};

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
    /// Open (or focus) the Stage desktop app in Self-Review for the current
    /// repo. Spawns the GUI and forwards the repo root; a running instance is
    /// brought to front and navigated there (ADR-0014). Fails loud (nonzero) if
    /// the GUI binary can't be located — set `STAGE_GUI_BIN` to override.
    Open,
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
        Command::Open => open_gui(&root),
    }
}

/// The bundled GUI binary's name (the Tauri app), a sibling of this CLI in the
/// shared `target/` dir and inside the installed app bundle.
const GUI_BIN_NAME: &str = "stage-client";

/// Launch the Stage desktop app in Self-Review for `root` (ADR-0014). Spawns
/// detached and returns: on a cold start the GUI keeps running; on a warm start
/// `tauri-plugin-single-instance` forwards this argv to the live app (which
/// focuses + navigates) and the spawned child exits on its own.
fn open_gui(root: &Path) -> Result<(), StageError> {
    let bin = resolve_gui_binary()?;
    // Detach the GUI's stdio from this terminal. Inheriting it floods the
    // caller's shell with the app's own logging (and any backend error bodies
    // it renders) — a launcher must stay quiet. The GUI surfaces its own errors
    // in-app; on a cold start it keeps running after this process exits.
    std::process::Command::new(&bin)
        .arg("open")
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    eprintln!("stage: opening Stage at {}", root.display());
    Ok(())
}

/// Locate the Stage GUI binary: `STAGE_GUI_BIN` override → a sibling of this CLI
/// in the same `target/` dir (dev / `tauri dev`) → an installed app bundle.
fn resolve_gui_binary() -> Result<PathBuf, StageError> {
    if let Some(p) = std::env::var_os("STAGE_GUI_BIN").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(p);
        if p.exists() {
            return Ok(p);
        }
        return Err(StageError::Invalid(format!(
            "STAGE_GUI_BIN points at {} which does not exist",
            p.display()
        )));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    // Locate this CLI in its target dir. Canonicalize first so an install
    // symlink (e.g. ~/.local/bin/stage -> target/release/stage) resolves to the
    // real target dir — `current_exe` returns the *invoked* path (the symlink)
    // on macOS, not the resolved target.
    if let Ok(exe) = std::env::current_exe() {
        let exe = exe.canonicalize().unwrap_or(exe);
        if let Some(dir) = exe.parent() {
            // Prefer a co-located build bundle (e.g. `just install-cli` produces
            // target/<profile>/bundle/macos/Stage.app). Launching the *bundled*
            // binary is what gives the proper Dock/launcher icon — its
            // `mainBundle` resolves to the .app's Info.plist + icon.icns. A bare
            // binary has no enclosing bundle, so macOS shows a generic icon.
            candidates.push(
                dir.join("bundle/macos/Stage.app/Contents/MacOS")
                    .join(GUI_BIN_NAME),
            );
            // Bare sibling: the `tauri dev` / plain-build fallback. Functional
            // (single-instance dedups by app id, not path), but launched cold it
            // has no launcher icon — that's why the bundle is preferred above.
            candidates.push(dir.join(GUI_BIN_NAME));
        }
    }

    // Installed app bundles (also bundled binaries → proper icon).
    candidates.extend(installed_candidates());

    let mut tried: Vec<PathBuf> = Vec::new();
    for cand in candidates {
        if cand.exists() {
            return Ok(cand);
        }
        tried.push(cand);
    }

    Err(StageError::Invalid(format!(
        "could not locate the Stage GUI binary — set STAGE_GUI_BIN to override. Tried: {}",
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

/// Candidate install locations for the bundled GUI binary. macOS only for now;
/// other platforms rely on `STAGE_GUI_BIN` or the dev sibling fallback.
fn installed_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        roots
            .into_iter()
            .flat_map(|root| {
                let macos = root.join("Stage.app").join("Contents").join("MacOS");
                // Tauri names the inner binary after the cargo package; some
                // setups use the productName ("Stage"). Try both.
                [macos.join(GUI_BIN_NAME), macos.join("Stage")]
            })
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
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
