//! Explicit, confirmed branch switch — v6-light L3 (ADR-0027 as amended).
//!
//! Reading never mutates; this module is the *user-initiated* "Switch to
//! branch…" action, the one place Stage moves a working tree between branches.
//! It is strictly two-phase: [`switch_plan`] produces the exact git commands
//! that would run (the UI renders them behind an explicit confirmation, per
//! ADR-0027 "always behind an explicit confirmation that lists the exact git
//! commands"), and [`switch_execute`] re-derives that plan and runs it.
//!
//! Stash handling follows the shared-stash-stack discipline: the entry is
//! pushed with a unique message tag, its commit id is captured immediately,
//! and the pop resolves the entry *by that id* — never a bare `stash pop`
//! that could eat someone else's entry. On a pop conflict nothing is
//! auto-resolved: the entry stays put and the error names it (fail loud,
//! CLAUDE.md).

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use git2::Repository;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::StageError;
use crate::overview::uncommitted_count;
use crate::worktree::list_worktrees;

/// What a planned git step does — drives the UI's step-dot color.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SwitchStepKind {
    Stash,
    Checkout,
    Pop,
}

/// One git command the switch will run, as the confirmation dialog shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SwitchStep {
    pub kind: SwitchStepKind,
    /// The command line, verbatim (display only — execution builds its own argv).
    pub command: String,
    /// Human note rendered above the command ("set aside 3 uncommitted files").
    pub note: String,
}

/// A confirmed-switch plan: the exact steps [`switch_execute`] will run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SwitchPlan {
    /// Branch the working tree currently has checked out (`None` when detached).
    pub current_branch: Option<String>,
    pub target_branch: String,
    /// Working-tree entries that would be stashed (0 ⇒ no stash steps).
    pub uncommitted_count: u32,
    pub steps: Vec<SwitchStep>,
}

/// [`switch_plan`]'s outcome. "Checked out elsewhere" is an expected state the
/// UI answers with a different affordance (focus that worktree), not an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum SwitchPlanOutcome {
    #[serde(rename_all = "camelCase")]
    Plan { plan: SwitchPlan },
    /// git forbids a second checkout of a branch another linked worktree holds;
    /// the UI offers "focus that worktree" instead (ADR-0027).
    #[serde(rename_all = "camelCase")]
    CheckedOutElsewhere {
        target_branch: String,
        worktree_path: PathBuf,
    },
}

/// A fully executed switch (every planned step succeeded).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SwitchOutcome {
    pub switched_to: String,
    /// The steps that ran, in order (mirrors the confirmed plan).
    pub executed: Vec<SwitchStep>,
}

/// The stash message tag for a switch out of `branch` — unique enough to find
/// our own entry in a stash stack other tools may also push to.
fn stash_tag(target: &str) -> String {
    format!("stage: switch to {target}")
}

/// Plan the switch: validate, then list the exact commands that would run.
///
/// Refusals (fail loud, complete messages): target missing, target already
/// checked out here, a rebase/merge/cherry-pick in progress. The
/// checked-out-in-another-worktree case is a structured outcome, not an error.
pub fn switch_plan(repo_path: &Path, target_branch: &str) -> Result<SwitchPlanOutcome, StageError> {
    let repo = Repository::open(repo_path)?;
    let current = current_branch(&repo);

    if repo.state() != git2::RepositoryState::Clean {
        return Err(StageError::Invalid(format!(
            "Couldn't plan the switch — a {:?} is in progress in this working tree. \
             Finish or abort it first.",
            repo.state()
        )));
    }
    if repo
        .find_branch(target_branch, git2::BranchType::Local)
        .is_err()
    {
        return Err(StageError::Invalid(format!(
            "Couldn't plan the switch — no local branch named `{target_branch}`."
        )));
    }
    if current.as_deref() == Some(target_branch) {
        return Err(StageError::Invalid(format!(
            "`{target_branch}` is already checked out in this working tree."
        )));
    }
    if let Some(other) = branch_worktree_elsewhere(repo_path, target_branch)? {
        return Ok(SwitchPlanOutcome::CheckedOutElsewhere {
            target_branch: target_branch.to_string(),
            worktree_path: other,
        });
    }

    let dirty = uncommitted_count(repo_path)?;
    let mut steps = Vec::new();
    if dirty > 0 {
        let tag = stash_tag(target_branch);
        steps.push(SwitchStep {
            kind: SwitchStepKind::Stash,
            command: format!("git stash push -u -m \"{tag}\""),
            note: format!(
                "set aside {dirty} uncommitted {}",
                if dirty == 1 { "file" } else { "files" }
            ),
        });
    }
    steps.push(SwitchStep {
        kind: SwitchStepKind::Checkout,
        command: format!("git checkout {target_branch}"),
        note: "switch to the branch you picked".to_string(),
    });
    if dirty > 0 {
        steps.push(SwitchStep {
            kind: SwitchStepKind::Pop,
            command: "git stash pop".to_string(),
            note: "restore your uncommitted files".to_string(),
        });
    }

    Ok(SwitchPlanOutcome::Plan {
        plan: SwitchPlan {
            current_branch: current,
            target_branch: target_branch.to_string(),
            uncommitted_count: dirty,
            steps,
        },
    })
}

/// Execute a confirmed switch. The plan is **re-derived** (the tree may have
/// changed between confirm and click), so the same refusals apply; a
/// checked-out-elsewhere state at this point is an error — the UI should have
/// offered "focus that worktree" instead.
pub fn switch_execute(repo_path: &Path, target_branch: &str) -> Result<SwitchOutcome, StageError> {
    let plan = match switch_plan(repo_path, target_branch)? {
        SwitchPlanOutcome::Plan { plan } => plan,
        SwitchPlanOutcome::CheckedOutElsewhere { worktree_path, .. } => {
            return Err(StageError::Invalid(format!(
                "`{target_branch}` is checked out in another worktree \
                 ({}) — focus that worktree instead of switching this one.",
                worktree_path.display()
            )));
        }
    };
    execute_steps(repo_path, &plan)
}

/// Run a derived plan's steps. Split from [`switch_execute`] so tests can
/// drive failure paths (e.g. a checkout that fails after the stash) directly.
fn execute_steps(repo_path: &Path, plan: &SwitchPlan) -> Result<SwitchOutcome, StageError> {
    let target = &plan.target_branch;
    let needs_stash = plan.uncommitted_count > 0;

    // 1 · stash (only when dirty). Capture the entry's commit id immediately —
    // pops resolve by id, never by a racy `stash@{0}`.
    let stashed: Option<String> = if needs_stash {
        let tag = stash_tag(target);
        let out = run_git(repo_path, &["stash", "push", "-u", "-m", &tag])?;
        check_git(&out, "git stash push")?;
        let out = run_git(repo_path, &["rev-parse", "--verify", "refs/stash"])?;
        check_git(&out, "git rev-parse refs/stash")?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    };

    // 2 · checkout. If it fails after a stash, pop the stash back so the tree
    // the user confirmed from is restored — then fail loud with git's stderr.
    let out = run_git(repo_path, &["checkout", target])?;
    if let Err(checkout_err) = check_git(&out, "git checkout") {
        if let Some(sha) = &stashed {
            match pop_stash_by_id(repo_path, sha) {
                Ok(()) => {
                    return Err(StageError::GitCli(format!(
                        "Couldn't switch to `{target}` — {checkout_err} \
                         Your uncommitted files were restored."
                    )));
                }
                Err(pop_err) => {
                    // Both failed: report both causes and where the work sits.
                    return Err(StageError::GitCli(format!(
                        "Couldn't switch to `{target}` — {checkout_err} \
                         Restoring your uncommitted files also failed ({pop_err}); \
                         they are safe in stash commit {sha} — run \
                         `git stash list` to locate and `git stash pop` it."
                    )));
                }
            }
        }
        return Err(checkout_err);
    }

    // 3 · pop (only when stashed). A conflict is NOT auto-resolved: git keeps
    // the entry; surface the verbatim error plus the entry's id (fail loud).
    if let Some(sha) = &stashed {
        if let Err(pop_err) = pop_stash_by_id(repo_path, sha) {
            return Err(StageError::GitCli(format!(
                "Switched to `{target}`, but restoring your uncommitted files \
                 failed: {pop_err} Nothing was auto-resolved — your changes are \
                 intact in stash commit {sha} (`git stash list` shows it); \
                 resolve and `git stash pop` it manually."
            )));
        }
    }

    Ok(SwitchOutcome {
        switched_to: target.clone(),
        executed: plan.steps.clone(),
    })
}

/// Pop the stash entry whose commit id is `sha`, resolving its current
/// `stash@{n}` position first (the stack is shared; the index may have moved).
fn pop_stash_by_id(repo_path: &Path, sha: &str) -> Result<(), StageError> {
    let out = run_git(repo_path, &["stash", "list", "--format=%H %gd"])?;
    check_git(&out, "git stash list")?;
    let listing = String::from_utf8_lossy(&out.stdout);
    let stash_ref = listing
        .lines()
        .find_map(|l| l.strip_prefix(&format!("{sha} ")))
        .ok_or_else(|| {
            StageError::GitCli(format!(
                "stash entry {sha} is no longer in the stash list — \
                 it may have been popped by another process."
            ))
        })?
        .to_string();
    let out = run_git(repo_path, &["stash", "pop", &stash_ref])?;
    check_git(&out, "git stash pop")
}

/// The branch another linked worktree has checked out, if any.
fn branch_worktree_elsewhere(
    repo_path: &Path,
    branch: &str,
) -> Result<Option<PathBuf>, StageError> {
    let here = std::fs::canonicalize(repo_path)?;
    for wt in list_worktrees(repo_path)? {
        if wt.branch.as_deref() != Some(branch) {
            continue;
        }
        // The worktree's own dir may be gone (prunable) — treat an
        // uncanonicalizable path as "not a live checkout elsewhere".
        let Ok(wt_path) = std::fs::canonicalize(&wt.path) else {
            continue;
        };
        if wt_path != here {
            return Ok(Some(wt.path));
        }
    }
    Ok(None)
}

fn current_branch(repo: &Repository) -> Option<String> {
    repo.head().ok()?.shorthand().map(str::to_string)
}

/// Spawn `git -C <repo>` and capture output; a spawn failure is loud.
fn run_git(repo_path: &Path, args: &[&str]) -> Result<Output, StageError> {
    Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|e| {
            tracing::error!(err = %e, "git_spawn_failed");
            StageError::GitCli(format!("Couldn't run `git`: {e}"))
        })
}

/// Non-zero exit → git's stderr verbatim (fail loud), like `github::check_git`.
fn check_git(out: &Output, what: &str) -> Result<(), StageError> {
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = stderr.trim();
    Err(StageError::GitCli(if msg.is_empty() {
        format!("{what} failed")
    } else {
        format!("{what}: {msg}")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command as TestCommand;

    /// Run `git -C <dir> <args...>` asserting success. Test-only.
    fn git(dir: &Path, args: &[&str]) {
        let status = TestCommand::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.email=t@e.com",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    fn init_repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        fs::write(dir.join("file.txt"), "base\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "init"]);
        git(dir, &["branch", "feat"]);
    }

    fn plan_of(outcome: SwitchPlanOutcome) -> SwitchPlan {
        match outcome {
            SwitchPlanOutcome::Plan { plan } => plan,
            other => panic!("expected a plan, got {other:?}"),
        }
    }

    fn head_branch(dir: &Path) -> String {
        let repo = Repository::open(dir).unwrap();
        let name = repo.head().unwrap().shorthand().unwrap().to_string();
        name
    }

    #[test]
    fn plan_on_clean_tree_has_no_stash_steps() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);

        let plan = plan_of(switch_plan(&repo, "feat").unwrap());
        assert_eq!(plan.uncommitted_count, 0);
        assert_eq!(plan.current_branch.as_deref(), Some("main"));
        let kinds: Vec<_> = plan.steps.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec![SwitchStepKind::Checkout]);
    }

    #[test]
    fn plan_on_dirty_tree_wraps_checkout_in_stash_and_pop() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        fs::write(repo.join("file.txt"), "edited\n").unwrap();
        fs::write(repo.join("new.txt"), "untracked\n").unwrap();

        let plan = plan_of(switch_plan(&repo, "feat").unwrap());
        assert_eq!(plan.uncommitted_count, 2);
        let kinds: Vec<_> = plan.steps.iter().map(|s| s.kind).collect();
        assert_eq!(
            kinds,
            vec![
                SwitchStepKind::Stash,
                SwitchStepKind::Checkout,
                SwitchStepKind::Pop
            ]
        );
        assert!(plan.steps[0].command.contains("stash push -u"));
        assert!(plan.steps[0].note.contains("2 uncommitted files"));
    }

    #[test]
    fn plan_refuses_the_current_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);

        let err = switch_plan(&repo, "main").unwrap_err();
        assert!(
            err.to_string().contains("already checked out"),
            "got: {err}"
        );
    }

    #[test]
    fn plan_refuses_a_missing_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);

        let err = switch_plan(&repo, "nope").unwrap_err();
        assert!(err.to_string().contains("no local branch"), "got: {err}");
    }

    #[test]
    fn plan_reports_a_branch_held_by_another_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        let linked = tmp.path().join("repo-feat");
        git(
            &repo,
            &["worktree", "add", "-q", linked.to_str().unwrap(), "feat"],
        );

        match switch_plan(&repo, "feat").unwrap() {
            SwitchPlanOutcome::CheckedOutElsewhere {
                target_branch,
                worktree_path,
            } => {
                assert_eq!(target_branch, "feat");
                assert_eq!(
                    fs::canonicalize(&worktree_path).unwrap(),
                    fs::canonicalize(&linked).unwrap()
                );
            }
            other => panic!("expected CheckedOutElsewhere, got {other:?}"),
        }
    }

    #[test]
    fn execute_clean_switches_head() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);

        let outcome = switch_execute(&repo, "feat").unwrap();
        assert_eq!(outcome.switched_to, "feat");
        assert_eq!(outcome.executed.len(), 1);
        assert_eq!(head_branch(&repo), "feat");
    }

    #[test]
    fn execute_dirty_round_trips_the_working_tree_intact() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        fs::write(repo.join("file.txt"), "my edit\n").unwrap();
        fs::write(repo.join("new.txt"), "untracked\n").unwrap();

        let outcome = switch_execute(&repo, "feat").unwrap();
        assert_eq!(outcome.executed.len(), 3);
        assert_eq!(head_branch(&repo), "feat");
        // Both the tracked edit and the untracked file survived the round-trip
        // and are still uncommitted.
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            "my edit\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("new.txt")).unwrap(),
            "untracked\n"
        );
        assert_eq!(uncommitted_count(&repo).unwrap(), 2);
        // And our stash entry is gone.
        let out = run_git(&repo, &["stash", "list"]).unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).trim().is_empty());
    }

    #[test]
    fn pop_conflict_keeps_the_stash_and_names_it() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        // `feat` commits a conflicting version of file.txt…
        git(&repo, &["checkout", "-q", "feat"]);
        fs::write(repo.join("file.txt"), "theirs\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "theirs"]);
        git(&repo, &["checkout", "-q", "main"]);
        // …while the working tree on main has an uncommitted edit to it.
        fs::write(repo.join("file.txt"), "mine\n").unwrap();

        let err = switch_execute(&repo, "feat").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Switched to `feat`"), "got: {msg}");
        assert!(msg.contains("stash commit"), "got: {msg}");
        // The switch itself happened; the stash entry survived the conflict.
        assert_eq!(head_branch(&repo), "feat");
        let out = run_git(&repo, &["stash", "list"]).unwrap();
        let listing = String::from_utf8_lossy(&out.stdout);
        assert!(
            listing.contains("stage: switch to feat"),
            "stash entry must survive, got: {listing}"
        );
    }

    #[test]
    fn checkout_failure_after_stash_restores_the_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        fs::write(repo.join("file.txt"), "my edit\n").unwrap();

        // Drive the executor with a plan whose target vanished after planning —
        // the checkout fails post-stash and the stash must be popped back.
        let plan = SwitchPlan {
            current_branch: Some("main".into()),
            target_branch: "vanished".into(),
            uncommitted_count: 1,
            steps: Vec::new(),
        };
        let err = execute_steps(&repo, &plan).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Couldn't switch"), "got: {msg}");
        assert!(msg.contains("restored"), "got: {msg}");
        assert_eq!(head_branch(&repo), "main");
        assert_eq!(
            fs::read_to_string(repo.join("file.txt")).unwrap(),
            "my edit\n"
        );
        let out = run_git(&repo, &["stash", "list"]).unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).trim().is_empty());
    }
}
