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
    branch_head_sha, parse_pr_ref, repo_key_from_cwd, repo_root_from_cwd, resolve_clone,
    DebriefInput, NoteStatus, PrRef, StageError, Store,
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
    /// Open (or focus) the Stage desktop app, forwarding the target to a running
    /// instance (ADR-0014). With no argument, opens the current repo in
    /// Self-Review. With a GitHub **PR URL** (or `owner/repo#number`), opens that
    /// PR in **read-only review mode** (ADR-0022 §6): the PR is resolved to a
    /// local clone by `origin` match, its head is fetched, and the storyline +
    /// diff render with no working-tree mutation. No matching local clone is a
    /// loud, actionable error. Fails loud (nonzero) if the GUI binary can't be
    /// located — set `STAGE_GUI_BIN` to override.
    Open {
        /// A GitHub PR URL (e.g. `https://github.com/owner/repo/pull/123`) or
        /// `owner/repo#123`. Omit to open the current repo in Self-Review.
        #[arg(value_name = "PR_URL")]
        target: Option<String>,
    },
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
    match cli.command {
        Command::SelfReview(cmd) => {
            // Self-Review is always scoped to the repo containing cwd.
            let root = repo_root_from_cwd(&cwd)?;
            self_review(cmd, &cwd, &root)
        }
        // `open` may be run from anywhere for a PR URL, so it resolves its own
        // repo (it must not require cwd to be a repo for the review path).
        Command::Open { target } => open(target, &cwd),
    }
}

/// `stage open [<pr-url>]`. With no argument, open the current repo in
/// Self-Review (the existing behaviour). With a PR URL (or `owner/repo#number`),
/// resolve it to a local clone by `origin` match and open it in read-only review
/// mode (ADR-0022 §6, milestone F). Fail loud on an unparseable target or when no
/// matching local clone exists.
fn open(target: Option<String>, cwd: &Path) -> Result<(), StageError> {
    match target {
        None => {
            let root = repo_root_from_cwd(cwd)?;
            open_gui(&root)
        }
        Some(target) => {
            let pr = parse_pr_ref(&target)?;
            let clone = resolve_review_clone(&pr, cwd)?;
            open_review_gui(&pr, &clone)
        }
    }
}

/// Resolve the PR to a local clone by `origin` match (ADR-0022 §6). The reviewer
/// runs `stage open <pr-url>` from within (or above) their clone, so the cwd's
/// repo is the candidate; a cwd that isn't a git repo simply yields no candidate
/// and falls through to [`resolve_clone`]'s loud "no local clone" error.
fn resolve_review_clone(pr: &PrRef, cwd: &Path) -> Result<PathBuf, StageError> {
    let candidates: Vec<PathBuf> = repo_root_from_cwd(cwd).map(|r| vec![r]).unwrap_or_default();
    resolve_clone(&candidates, pr)
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

/// Launch the Stage desktop app in **read-only review mode** for `pr`, forwarding
/// the resolved `clone` root and the PR identity (ADR-0022 §6). The GUI parses
/// `--review <owner>/<repo>#<number>` into an `OpenMode::Review` intent and, on a
/// warm start, the single-instance plugin forwards this argv to the live app.
/// Detached stdio for the same reason as [`open_gui`].
fn open_review_gui(pr: &PrRef, clone: &Path) -> Result<(), StageError> {
    let bin = resolve_gui_binary()?;
    let spec = format!("{}/{}#{}", pr.owner, pr.name, pr.number);
    std::process::Command::new(&bin)
        .arg("open")
        .arg(clone)
        .arg("--review")
        .arg(&spec)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    eprintln!(
        "stage: opening {}/{} PR #{} for review",
        pr.owner, pr.name, pr.number
    );
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
            // The retired per-file `steps` shape gets the actionable hard-break
            // error (ADR-0025), not a generic serde parse failure.
            let input = DebriefInput::from_json(&raw)?;
            let base = input.base.clone();
            let files: Vec<String> = input
                .chapters
                .iter()
                .flat_map(|c| c.files.iter().cloned())
                .collect();
            assert_files_in_base_diff(root, &base, &files)?;
            // The Debrief describes the branch as the agent left it; record the
            // head it was written against so the app can derive new/seen/outdated.
            let head_sha = branch_head_sha(root, &key.branch)?;
            let debrief = store.set_debrief(&key, &base, input.chapters, &head_sha)?;
            println!("{}", serde_json::to_string_pretty(&debrief)?);
        }
        SelfReviewCmd::Show => {
            let key = repo_key_from_cwd(cwd)?;
            let store = Store::open_default()?;
            match store.get_debrief(&key)? {
                Some(debrief) => {
                    let freshness = debrief.freshness(&branch_head_sha(root, &key.branch)?);
                    let view = debrief.into_view(freshness);
                    println!("{}", serde_json::to_string_pretty(&view)?);
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("spawn git")
            .success();
        assert!(ok, "git {args:?} failed in {dir:?}");
    }

    fn pr(owner: &str, name: &str, number: u32) -> PrRef {
        PrRef {
            owner: owner.into(),
            name: name.into(),
            number,
        }
    }

    #[test]
    fn resolve_review_clone_uses_the_cwd_repo_when_origin_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(
            root,
            &["remote", "add", "origin", "git@github.com:Octo/Stage.git"],
        );

        // Case-insensitive origin match → the cwd repo resolves.
        let got = resolve_review_clone(&pr("octo", "stage", 5), root).expect("resolve");
        assert_eq!(
            got.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
            "the cwd clone is the resolved review root"
        );
    }

    #[test]
    fn resolve_review_clone_errors_loudly_when_cwd_origin_mismatches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(
            root,
            &["remote", "add", "origin", "git@github.com:someone/else.git"],
        );

        let err = resolve_review_clone(&pr("octo", "stage", 9), root).unwrap_err();
        assert!(err.to_string().contains("octo/stage"), "{err}");
    }

    #[test]
    fn resolve_review_clone_errors_loudly_outside_a_repo() {
        // cwd is not a git repo → no candidate → the loud "no local clone" error.
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_review_clone(&pr("octo", "stage", 3), dir.path()).unwrap_err();
        assert!(err.to_string().contains("No local clone"), "{err}");
    }
}
