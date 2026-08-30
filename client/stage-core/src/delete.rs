//! Explicit, confirmed branch delete — the branch-menu "Delete branch…" action.
//!
//! Two-phase like [`crate::switch`] and [`crate::push`]: [`delete_plan`]
//! inspects and returns the exact command that *would* run (ADR-0027's
//! confirmation), and [`delete_execute`] re-derives that plan and runs it.
//!
//! ## Scope: the local ref, and nothing else
//!
//! This deletes **one local branch**. It does not touch the remote — no
//! `git push --delete`, no branch deletion on GitHub. A local delete is
//! recoverable from the reflog; deleting the shared remote branch is visible to
//! everyone and can break an open PR, so it stays a deliberate act the author
//! performs themselves. It also does not remove worktrees (ADR-0016: Stage
//! never creates, removes or prunes them) and does not delete the branch's
//! Stage-local Debrief or Self-Review notes — a branch can be recreated at the
//! same name, and silently dropping the author's own notes as a side effect of
//! a ref delete would be the more surprising behaviour.
//!
//! ## Recovery, and why the SHA is in the plan
//!
//! Deleting a branch removes a ref; the commits themselves survive in the
//! reflog until git garbage-collects them. That makes the branch tip's SHA the
//! whole recovery story — with it, `git branch <name> <sha>` puts the branch
//! back. So the plan carries `tip_sha` and the confirmation shows it, for every
//! delete and not only the risky ones. Stage deliberately does **not** create a
//! backup tag or branch first: an unasked-for ref left behind is clutter the
//! author then has to clean up, and the reflog already is the safety net.
//!
//! ## What it refuses
//!
//! A branch that is checked out — here or in a linked worktree — is a
//! [`DeletePlanOutcome::CheckedOut`], not an error: git forbids deleting it,
//! the remedy is the author's (switch away, or remove the worktree themselves),
//! and Stage will not remove a worktree to make a delete possible. The repo's
//! default branch is refused outright.
//!
//! An **unmerged** branch is planned, not refused — deleting a dead
//! experiment is a normal thing to want, and it is the single case where the
//! author most needs to see what they are about to lose. The plan says how many
//! commits are not in the comparison ref, names that ref, and carries the tip
//! SHA; the command is the honest `git branch -D`.

use std::path::{Path, PathBuf};

use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::StageError;
use crate::git_cli::{check_git, run_git};
use crate::git_step::{plural, GitStep, GitStepKind};
use crate::worktree::list_worktrees;

/// A confirmed-delete plan: the exact command [`delete_execute`] will run, and
/// everything the author needs to weigh it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeletePlan {
    pub branch: String,
    /// Commits on the branch that are not in [`DeletePlan::merged_into`].
    /// `0` ⇒ fully merged, and the command is the safe `git branch -d`.
    pub unmerged_count: u32,
    /// What "merged" was measured against: the branch's upstream when it has
    /// one, else the repo's default branch. `None` when neither exists — then
    /// nothing can vouch for the commits and `unmerged_count` is meaningless,
    /// so the UI must treat the delete as unverified.
    pub merged_into: Option<String>,
    /// The branch tip, full SHA — the whole recovery story
    /// (`git branch <name> <sha>` restores it while the reflog holds).
    pub tip_sha: String,
    /// The branch's last commit summary, so the confirmation can show *what*
    /// is being deleted and not only a SHA.
    pub tip_summary: Option<String>,
    pub steps: Vec<GitStep>,
}

/// [`delete_plan`]'s outcome. "Checked out" is an expected state git forbids
/// the delete for, with a remedy that belongs to the author — not an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum DeletePlanOutcome {
    #[serde(rename_all = "camelCase")]
    Plan { plan: DeletePlan },
    /// The branch is checked out on a worktree, so git refuses to delete it.
    /// Stage never removes a worktree (ADR-0016), so this is reported with the
    /// path and no action.
    #[serde(rename_all = "camelCase")]
    CheckedOut {
        branch: String,
        worktree_path: PathBuf,
        /// The worktree in question is the one the app is focused on.
        is_current: bool,
    },
}

/// A completed delete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeleteOutcome {
    pub branch: String,
    /// The deleted branch's tip. Surfaced so the confirmation's "recover with"
    /// line survives into the success path — this is the last moment the SHA
    /// is easy to come by.
    pub tip_sha: String,
    /// The delete discarded commits not present in the comparison ref.
    pub was_unmerged: bool,
    pub executed: Vec<GitStep>,
}

/// Plan the delete of `branch`: the exact command, what it discards, and how to
/// undo it. Mutates nothing.
///
/// Refusals (fail loud, complete messages): no such local branch, the repo's
/// default branch.
pub fn delete_plan(repo_path: &Path, branch: &str) -> Result<DeletePlanOutcome, StageError> {
    let repo = Repository::open(repo_path)?;

    let local = repo.find_branch(branch, BranchType::Local).map_err(|_| {
        StageError::Invalid(format!(
            "Couldn't plan the delete — no local branch named `{branch}`."
        ))
    })?;
    let tip = local.get().peel_to_commit().map_err(|e| {
        StageError::Invalid(format!(
            "Couldn't plan the delete — `{branch}` has no readable commit ({e})."
        ))
    })?;

    if default_branch_name(&repo).as_deref() == Some(branch) {
        return Err(StageError::Invalid(format!(
            "Couldn't delete `{branch}` — it's this repository's default branch. \
             Stage won't delete it; if you really mean to, do it in your terminal."
        )));
    }

    // git refuses to delete a branch any worktree holds, and Stage never
    // removes a worktree to make room (ADR-0016). Report it instead.
    if let Some((path, is_current)) = branch_checkout(repo_path, branch)? {
        return Ok(DeletePlanOutcome::CheckedOut {
            branch: branch.to_string(),
            worktree_path: path,
            is_current,
        });
    }

    // What can vouch for the commits: the branch's own upstream first (it is
    // what the author pushed to), else the repo default. With neither, nothing
    // can — say so rather than inventing a comparison.
    let merged_into = local
        .upstream()
        .ok()
        .and_then(|u| u.name().ok().flatten().map(str::to_string))
        .or_else(|| default_branch_name(&repo));

    let unmerged_count = match &merged_into {
        Some(reference) => {
            let other = repo
                .revparse_single(reference)
                .map_err(|e| {
                    StageError::Invalid(format!(
                        "Couldn't plan the delete — `{reference}` is unreadable ({e}). \
                         Fetch and try again."
                    ))
                })?
                .peel_to_commit()
                .map_err(|e| {
                    StageError::Invalid(format!(
                        "Couldn't plan the delete — `{reference}` doesn't point at a commit ({e})."
                    ))
                })?;
            let (ahead, _behind) = repo.graph_ahead_behind(tip.id(), other.id())?;
            ahead as u32
        }
        // No upstream and no default branch: nothing to measure against. Treat
        // as unverified — the command below is the force delete, because a
        // plain `-d` would fail for exactly this reason and the author would
        // learn nothing from git's refusal.
        None => 1,
    };

    let force = unmerged_count > 0;
    let command = if force {
        format!("git branch -D {branch}")
    } else {
        format!("git branch -d {branch}")
    };
    let note = match (&merged_into, unmerged_count) {
        (Some(reference), 0) => {
            format!("delete the branch — every commit is already in `{reference}`")
        }
        (Some(reference), n) => format!(
            "delete the branch, discarding {} not in `{reference}`",
            plural(n, "commit", "commits")
        ),
        (None, _) => "delete the branch — nothing local can vouch for its commits".to_string(),
    };

    Ok(DeletePlanOutcome::Plan {
        plan: DeletePlan {
            branch: branch.to_string(),
            unmerged_count,
            merged_into,
            tip_sha: tip.id().to_string(),
            tip_summary: tip.summary().map(str::to_string),
            steps: vec![GitStep::new(GitStepKind::Delete, command, note)],
        },
    })
}

/// Execute a confirmed delete. The plan is **re-derived** — the branch may have
/// been checked out, or gained commits, since the confirmation — so the same
/// refusals apply and a now-checked-out branch is an error rather than a
/// silently skipped delete.
///
/// Fail loud: git's stderr reaches the caller verbatim.
pub fn delete_execute(repo_path: &Path, branch: &str) -> Result<DeleteOutcome, StageError> {
    let plan = match delete_plan(repo_path, branch)? {
        DeletePlanOutcome::Plan { plan } => plan,
        DeletePlanOutcome::CheckedOut { worktree_path, .. } => {
            return Err(StageError::Invalid(format!(
                "Couldn't delete `{branch}` — it's checked out in {}. \
                 Switch that worktree to another branch, or remove the worktree, first.",
                worktree_path.display()
            )));
        }
    };

    let flag = if plan.unmerged_count > 0 { "-D" } else { "-d" };
    let out = run_git(repo_path, &["branch", flag, &plan.branch])?;
    check_git(&out, "git branch -d")?;

    // Log the tip at info: this is the one record of what the ref pointed at,
    // and the reflog is the only other place it survives.
    tracing::info!(
        branch = %plan.branch,
        tip = %plan.tip_sha,
        unmerged = plan.unmerged_count,
        "branch_deleted"
    );

    Ok(DeleteOutcome {
        branch: plan.branch,
        tip_sha: plan.tip_sha,
        was_unmerged: plan.unmerged_count > 0,
        executed: plan.steps,
    })
}

/// The worktree holding `branch`, and whether it is `repo_path` itself.
///
/// A `prunable` worktree still blocks git's delete (its directory is gone but
/// git keeps the association), so unlike [`crate::push`] this must count the
/// dead ones too — otherwise the plan would look clean and git would refuse.
fn branch_checkout(repo_path: &Path, branch: &str) -> Result<Option<(PathBuf, bool)>, StageError> {
    let here = std::fs::canonicalize(repo_path).ok();
    for wt in list_worktrees(repo_path)? {
        if wt.branch.as_deref() != Some(branch) {
            continue;
        }
        let is_current = match (&here, std::fs::canonicalize(&wt.path).ok()) {
            (Some(a), Some(b)) => *a == b,
            _ => false,
        };
        return Ok(Some((wt.path, is_current)));
    }
    Ok(None)
}

/// `origin/HEAD`'s target shorthand (e.g. `main`); `None` with no remote.
/// Mirrors `overview::default_branch_name`.
fn default_branch_name(repo: &Repository) -> Option<String> {
    let reference = repo.find_reference("refs/remotes/origin/HEAD").ok()?;
    let target = reference.symbolic_target()?;
    target.rsplit('/').next().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as TestCommand;

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

    fn commit(dir: &Path, name: &str) {
        fs::write(dir.join(name), format!("{name}\n")).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", name]);
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "stage-delete-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A work repo with a local bare `origin`, `main` pushed, and `origin/HEAD`
    /// set so the default branch resolves.
    fn init_repo(root: &Path) -> PathBuf {
        let remote = root.join("remote.git");
        let work = root.join("work");
        fs::create_dir_all(&remote).unwrap();
        fs::create_dir_all(&work).unwrap();
        git(&remote, &["init", "-q", "--bare", "-b", "main"]);
        git(&work, &["init", "-q", "-b", "main"]);
        git(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        commit(&work, "base.txt");
        git(&work, &["push", "-q", "--set-upstream", "origin", "main"]);
        git(
            &work,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        work
    }

    fn plan_of(outcome: DeletePlanOutcome) -> DeletePlan {
        match outcome {
            DeletePlanOutcome::Plan { plan } => plan,
            other => panic!("expected a plan, got {other:?}"),
        }
    }

    fn branch_exists(dir: &Path, branch: &str) -> bool {
        Repository::open(dir)
            .unwrap()
            .find_branch(branch, BranchType::Local)
            .is_ok()
    }

    #[test]
    fn a_merged_branch_plans_the_safe_delete() {
        let root = tmp("merged");
        let work = init_repo(&root);
        // `feat` at the same commit as main ⇒ nothing unmerged.
        git(&work, &["branch", "feat"]);

        let plan = plan_of(delete_plan(&work, "feat").unwrap());
        assert_eq!(plan.unmerged_count, 0);
        assert_eq!(plan.merged_into.as_deref(), Some("main"));
        assert_eq!(plan.steps[0].kind, GitStepKind::Delete);
        assert_eq!(plan.steps[0].command, "git branch -d feat");
        assert!(!plan.tip_sha.is_empty());

        let outcome = delete_execute(&work, "feat").unwrap();
        assert!(!outcome.was_unmerged);
        assert!(!branch_exists(&work, "feat"));
        // The tip survives in the outcome, which is the recovery story.
        assert_eq!(outcome.tip_sha, plan.tip_sha);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unmerged_branch_plans_a_force_delete_and_counts_what_is_lost() {
        let root = tmp("unmerged");
        let work = init_repo(&root);
        git(&work, &["checkout", "-q", "-b", "feat"]);
        commit(&work, "a.txt");
        commit(&work, "b.txt");
        git(&work, &["checkout", "-q", "main"]);

        let plan = plan_of(delete_plan(&work, "feat").unwrap());
        assert_eq!(plan.unmerged_count, 2);
        assert_eq!(plan.merged_into.as_deref(), Some("main"));
        assert_eq!(plan.steps[0].command, "git branch -D feat");
        assert!(plan.steps[0].note.contains("2 commits"));
        assert_eq!(plan.tip_summary.as_deref(), Some("b.txt"));

        let outcome = delete_execute(&work, "feat").unwrap();
        assert!(outcome.was_unmerged);
        assert!(!branch_exists(&work, "feat"));
        // Recoverable: the tip still resolves after the ref is gone.
        let repo = Repository::open(&work).unwrap();
        assert!(repo.revparse_single(&outcome.tip_sha).is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn measures_against_the_upstream_when_the_branch_has_one() {
        let root = tmp("upstream");
        let work = init_repo(&root);
        git(&work, &["checkout", "-q", "-b", "feat"]);
        commit(&work, "a.txt");
        git(&work, &["push", "-q", "--set-upstream", "origin", "feat"]);
        git(&work, &["checkout", "-q", "main"]);

        // Pushed, so nothing is unmerged relative to its own upstream — even
        // though it is ahead of `main`.
        let plan = plan_of(delete_plan(&work, "feat").unwrap());
        assert_eq!(plan.merged_into.as_deref(), Some("origin/feat"));
        assert_eq!(plan.unmerged_count, 0);
        assert_eq!(plan.steps[0].command, "git branch -d feat");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_a_branch_checked_out_here_rather_than_failing() {
        let root = tmp("current");
        let work = init_repo(&root);
        git(&work, &["checkout", "-q", "-b", "feat"]);

        match delete_plan(&work, "feat").unwrap() {
            DeletePlanOutcome::CheckedOut { is_current, .. } => assert!(is_current),
            other => panic!("expected CheckedOut, got {other:?}"),
        }
        let err = delete_execute(&work, "feat").unwrap_err().to_string();
        assert!(err.contains("checked out"), "got: {err}");
        assert!(branch_exists(&work, "feat"), "nothing was deleted");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_a_branch_held_by_a_linked_worktree() {
        let root = tmp("linked");
        let work = init_repo(&root);
        let wt = root.join("wt-feat");
        git(
            &work,
            &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()],
        );

        match delete_plan(&work, "feat").unwrap() {
            DeletePlanOutcome::CheckedOut {
                worktree_path,
                is_current,
                ..
            } => {
                assert!(!is_current, "the linked worktree is not the focused one");
                assert_eq!(
                    fs::canonicalize(&worktree_path).unwrap(),
                    fs::canonicalize(&wt).unwrap()
                );
            }
            other => panic!("expected CheckedOut, got {other:?}"),
        }
        assert!(branch_exists(&work, "feat"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_the_default_branch_and_a_missing_branch() {
        let root = tmp("refusals");
        let work = init_repo(&root);
        git(&work, &["checkout", "-q", "-b", "other"]);

        let err = delete_plan(&work, "main").unwrap_err().to_string();
        assert!(err.contains("default branch"), "got: {err}");
        assert!(branch_exists(&work, "main"));

        let err = delete_plan(&work, "nope").unwrap_err().to_string();
        assert!(err.contains("no local branch named `nope`"), "got: {err}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_prunable_worktree_still_blocks_the_delete() {
        let root = tmp("prunable");
        let work = init_repo(&root);
        let wt = root.join("wt-gone");
        git(
            &work,
            &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()],
        );
        // Delete the directory behind git's back — git still holds the branch,
        // so a delete would fail; the plan must say so rather than look clean.
        fs::remove_dir_all(&wt).unwrap();

        match delete_plan(&work, "feat").unwrap() {
            DeletePlanOutcome::CheckedOut { .. } => {}
            other => panic!("expected CheckedOut for a prunable worktree, got {other:?}"),
        }
        fs::remove_dir_all(&root).ok();
    }
}
