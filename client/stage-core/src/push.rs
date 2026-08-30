//! Explicit, confirmed branch push — the branch-menu "Push branch…" action.
//!
//! Two-phase, exactly like [`crate::switch`]: [`push_plan`] inspects and
//! produces the git command that *would* run (the UI renders it behind the
//! ADR-0027 confirmation that lists the exact commands), and [`push_execute`]
//! re-derives that plan and runs it. Planning never touches the network and
//! never mutates anything.
//!
//! ## What this is not
//!
//! A push is **not** a working-tree mutation: it moves a remote ref and leaves
//! every file where it is. Uncommitted work is not stashed, not committed, and
//! not pushed — the plan reports how much of it stays local precisely so the
//! author isn't surprised to find it missing on the remote.
//!
//! Nor is it Publish. ADR-0019 made Publish the one gesture that pushes *and*
//! opens a PR; this is the other half of that sentence — getting commits onto
//! the remote without deciding to open anything. It calls no `gh`, so it works
//! with `gh` absent or unauthenticated (ADR-0022 §5): transport is the user's
//! own git credentials, like every other Stage git op.
//!
//! ## Worktrees
//!
//! The push runs in the branch's **own** worktree when it has one, not in
//! whichever worktree the app happens to be focused on (ADR-0016 — a linked
//! worktree is a first-class checkout). Pushing a ref works from any worktree
//! of the repo, so this changes no outcome today; it means the branch's own
//! per-worktree git config, hooks and `--set-upstream` write land where the
//! author would look for them, and it keeps the command Stage shows identical
//! to the one they'd type in that directory. A branch with no worktree — never
//! checked out, or one git reports `prunable` — pushes from the repo root,
//! which is exactly why it need not be checked out to be pushed.
//!
//! ## What it refuses
//!
//! **Stage never force-pushes and never rewrites history.** A branch whose
//! upstream has commits it doesn't is a [`PushPlanOutcome::Diverged`], reported
//! with both counts and no button: the fix (rebase, merge, or a deliberate
//! `--force-with-lease`) is the author's call, made in their terminal. That is
//! the fail-loud rule applied to a destructive default — the plain `git push`
//! git would reject here is the *safe* outcome, and quietly upgrading it to a
//! force is the kind of "helpful" that loses commits.

use std::path::{Path, PathBuf};

use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::StageError;
use crate::git_cli::{check_git, run_git};
use crate::git_step::{plural, GitStep, GitStepKind};
use crate::overview::uncommitted_count;
use crate::worktree::list_worktrees;

/// A confirmed-push plan: the exact command [`push_execute`] will run, plus
/// what the author needs to know before authorising it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PushPlan {
    pub branch: String,
    /// The remote the branch pushes to — its configured `branch.<n>.remote`,
    /// else `origin`, else the repo's only remote.
    pub remote: String,
    /// The remote-tracking branch this push updates (`origin/feat`), or `None`
    /// when the remote has never seen this branch.
    pub upstream: Option<String>,
    /// Commits the local branch has that the remote doesn't. `None` exactly
    /// when `upstream` is `None` — there is nothing to count against.
    pub ahead: Option<u32>,
    /// Whether the push also sets the branch's upstream (`--set-upstream`).
    pub sets_upstream: bool,
    /// Working-tree entries in the branch's worktree that this push leaves
    /// behind. `None` when the branch has no worktree (nothing to leave).
    pub uncommitted_count: Option<u32>,
    /// The directory the push runs in — the branch's worktree, or the repo root.
    pub run_in: PathBuf,
    pub steps: Vec<GitStep>,
}

/// [`push_plan`]'s outcome. "Nothing to push" and "diverged" are *expected*
/// states with their own affordances, not errors: the UI reports them and
/// offers no confirm button.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum PushPlanOutcome {
    #[serde(rename_all = "camelCase")]
    Plan { plan: PushPlan },
    /// The remote already has every local commit. `behind` says whether the
    /// remote has moved on past it (a fast-forwardable pull, not a divergence).
    #[serde(rename_all = "camelCase")]
    NothingToPush {
        branch: String,
        remote: String,
        upstream: String,
        behind: u32,
    },
    /// Both sides have commits the other lacks, so a plain push is rejected.
    /// Stage never force-pushes: reported, never planned.
    #[serde(rename_all = "camelCase")]
    Diverged {
        branch: String,
        remote: String,
        upstream: String,
        ahead: u32,
        behind: u32,
    },
}

/// A fully executed push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PushOutcome {
    pub branch: String,
    pub remote: String,
    /// Commits this push put on the remote. `None` when the branch was new
    /// there (nothing to have counted against beforehand).
    pub ahead: Option<u32>,
    /// The push also set the branch's upstream.
    pub set_upstream: bool,
    /// The steps that ran, in order (mirrors the confirmed plan).
    pub executed: Vec<GitStep>,
}

/// Plan the push of `branch`: the exact command that would run, or the
/// structured state that forbids one. Mutates nothing and reaches no network —
/// the ahead/behind counts come from refs already on disk, so a plan is only
/// as fresh as the last fetch, and the confirmation says so.
///
/// Refusals (fail loud, complete messages): no such local branch, no remote
/// configured, an unborn branch with no commit to push.
pub fn push_plan(repo_path: &Path, branch: &str) -> Result<PushPlanOutcome, StageError> {
    let repo = Repository::open(repo_path)?;

    let local = repo.find_branch(branch, BranchType::Local).map_err(|_| {
        StageError::Invalid(format!(
            "Couldn't plan the push — no local branch named `{branch}`."
        ))
    })?;
    let local_oid = local
        .get()
        .peel_to_commit()
        .map_err(|e| {
            StageError::Invalid(format!(
                "Couldn't plan the push — `{branch}` has no commit to push ({e})."
            ))
        })?
        .id();

    let remote = push_remote(&repo, branch)?;

    // The upstream git would update. Prefer the branch's configured upstream;
    // fall back to the remote-tracking ref when the branch has none but the
    // remote already carries the name (a branch pushed from elsewhere, or one
    // whose config was never set). Either way the counts below are honest.
    let configured = configured_upstream(&repo, branch);
    let sets_upstream = configured.is_none();
    let upstream_name = configured.or_else(|| tracking_ref_name(&repo, &remote, branch));

    let run_in = push_dir(repo_path, branch)?;
    // A branch with no worktree has no working tree to be dirty, so `None`
    // here means "nothing to leave behind", never a fake 0 (CLAUDE.md).
    let uncommitted = match branch_worktree(repo_path, branch)? {
        Some(_) => Some(uncommitted_count(&run_in)?),
        None => None,
    };

    let Some(upstream) = upstream_name else {
        // The remote has never seen this branch: nothing to compare, and the
        // push creates the remote branch.
        let command = format!("git push --set-upstream {remote} {branch}");
        return Ok(PushPlanOutcome::Plan {
            plan: PushPlan {
                branch: branch.to_string(),
                remote: remote.clone(),
                upstream: None,
                ahead: None,
                sets_upstream: true,
                uncommitted_count: uncommitted,
                run_in: run_in.clone(),
                steps: vec![GitStep::new(
                    GitStepKind::Push,
                    command,
                    format!("create `{remote}/{branch}` and track it"),
                )],
            },
        });
    };

    let upstream_oid = repo
        .revparse_single(&upstream)
        .map_err(|e| {
            StageError::Invalid(format!(
                "Couldn't plan the push — `{upstream}` is unreadable ({e}). Fetch and try again."
            ))
        })?
        .peel_to_commit()
        .map_err(|e| {
            StageError::Invalid(format!(
                "Couldn't plan the push — `{upstream}` doesn't point at a commit ({e})."
            ))
        })?
        .id();

    let (ahead, behind) = repo.graph_ahead_behind(local_oid, upstream_oid)?;
    let (ahead, behind) = (ahead as u32, behind as u32);

    if ahead == 0 {
        return Ok(PushPlanOutcome::NothingToPush {
            branch: branch.to_string(),
            remote,
            upstream,
            behind,
        });
    }
    if behind > 0 {
        return Ok(PushPlanOutcome::Diverged {
            branch: branch.to_string(),
            remote,
            upstream,
            ahead,
            behind,
        });
    }

    let command = if sets_upstream {
        format!("git push --set-upstream {remote} {branch}")
    } else {
        format!("git push {remote} {branch}")
    };
    let note = if sets_upstream {
        format!(
            "publish {} to `{upstream}` and track it",
            plural(ahead, "commit", "commits")
        )
    } else {
        format!(
            "publish {} to `{upstream}`",
            plural(ahead, "commit", "commits")
        )
    };

    Ok(PushPlanOutcome::Plan {
        plan: PushPlan {
            branch: branch.to_string(),
            remote,
            upstream: Some(upstream),
            ahead: Some(ahead),
            sets_upstream,
            uncommitted_count: uncommitted,
            run_in,
            steps: vec![GitStep::new(GitStepKind::Push, command, note)],
        },
    })
}

/// Execute a confirmed push. The plan is **re-derived** (refs may have moved
/// between the confirmation and the click), so the same refusals apply and a
/// state that forbids a push at this point is an error — the UI should have
/// reported it instead of offering a confirm.
///
/// Fail loud: git's stderr reaches the caller verbatim, so a rejected
/// non-fast-forward, a protected branch, a missing credential or an offline
/// machine all arrive with git's own words and git's own remedy.
pub fn push_execute(repo_path: &Path, branch: &str) -> Result<PushOutcome, StageError> {
    let plan = match push_plan(repo_path, branch)? {
        PushPlanOutcome::Plan { plan } => plan,
        PushPlanOutcome::NothingToPush {
            upstream, behind, ..
        } => {
            return Err(StageError::Invalid(if behind > 0 {
                format!(
                    "Nothing to push — `{upstream}` already has every commit on `{branch}`, \
                     and is {} ahead of it. Fetch to see them.",
                    plural(behind, "commit", "commits")
                )
            } else {
                format!("Nothing to push — `{upstream}` is already up to date with `{branch}`.")
            }));
        }
        PushPlanOutcome::Diverged {
            upstream,
            ahead,
            behind,
            ..
        } => {
            return Err(StageError::Invalid(format!(
                "Couldn't push `{branch}` — it and `{upstream}` have diverged \
                 ({} here, {} there). Stage never force-pushes: rebase or merge \
                 the remote work in first.",
                plural(ahead, "commit", "commits"),
                plural(behind, "commit", "commits"),
            )));
        }
    };

    // Build the argv from the plan's typed fields — never by re-parsing the
    // step's display string (see `git_step`).
    let mut args: Vec<&str> = vec!["push"];
    if plan.sets_upstream {
        args.push("--set-upstream");
    }
    args.push(&plan.remote);
    args.push(&plan.branch);

    let out = run_git(&plan.run_in, &args)?;
    check_git(&out, "git push")?;

    tracing::info!(
        branch = %plan.branch,
        remote = %plan.remote,
        ahead = plan.ahead.unwrap_or(0),
        set_upstream = plan.sets_upstream,
        run_in = %plan.run_in.display(),
        "branch_pushed"
    );

    Ok(PushOutcome {
        branch: plan.branch,
        remote: plan.remote,
        ahead: plan.ahead,
        set_upstream: plan.sets_upstream,
        executed: plan.steps,
    })
}

/// The remote `branch` pushes to: its configured `branch.<n>.remote`, else
/// `origin`, else the repo's sole remote.
///
/// A repo with no remote at all is a refusal that names the fix — there is no
/// sensible default to fall back on, and inventing `origin` would only move
/// the failure into git's mouth one call later.
fn push_remote(repo: &Repository, branch: &str) -> Result<String, StageError> {
    if let Ok(cfg) = repo.config() {
        if let Ok(name) = cfg.get_string(&format!("branch.{branch}.remote")) {
            if !name.is_empty() && repo.find_remote(&name).is_ok() {
                return Ok(name);
            }
        }
    }
    if repo.find_remote("origin").is_ok() {
        return Ok("origin".to_string());
    }
    let remotes = repo.remotes()?;
    remotes
        .iter()
        .flatten()
        .next()
        .map(str::to_string)
        .ok_or_else(|| {
            StageError::Invalid(format!(
                "Couldn't push `{branch}` — this repository has no remote configured. \
                 Add one with `git remote add origin <url>`, then try again."
            ))
        })
}

/// The branch's configured upstream (`origin/feat`), if it has one.
fn configured_upstream(repo: &Repository, branch: &str) -> Option<String> {
    let local = repo.find_branch(branch, BranchType::Local).ok()?;
    let upstream = local.upstream().ok()?;
    upstream.name().ok().flatten().map(str::to_string)
}

/// `<remote>/<branch>` when that remote-tracking ref exists on disk.
fn tracking_ref_name(repo: &Repository, remote: &str, branch: &str) -> Option<String> {
    let name = format!("{remote}/{branch}");
    repo.find_branch(&name, BranchType::Remote).ok()?;
    Some(name)
}

/// The branch's usable worktree, if it has one.
///
/// A worktree git reports `prunable` is not a worktree for Stage's purposes
/// (CONTEXT.md) — its directory is gone, so a push can't run there.
fn branch_worktree(repo_path: &Path, branch: &str) -> Result<Option<PathBuf>, StageError> {
    for wt in list_worktrees(repo_path)? {
        if wt.branch.as_deref() != Some(branch) || wt.prunable.is_some() {
            continue;
        }
        if wt.path.is_dir() {
            return Ok(Some(wt.path));
        }
    }
    Ok(None)
}

/// Where the push runs: the branch's own worktree, else the repo root.
fn push_dir(repo_path: &Path, branch: &str) -> Result<PathBuf, StageError> {
    Ok(branch_worktree(repo_path, branch)?.unwrap_or_else(|| repo_path.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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

    fn commit(dir: &Path, name: &str) {
        fs::write(dir.join(name), format!("{name}\n")).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", name]);
    }

    /// A working repo with a local `origin` bare remote (so pushes work with no
    /// network), one commit on `main`, already pushed.
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
        work
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "stage-push-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn plan_of(outcome: PushPlanOutcome) -> PushPlan {
        match outcome {
            PushPlanOutcome::Plan { plan } => plan,
            other => panic!("expected a plan, got {other:?}"),
        }
    }

    #[test]
    fn plans_set_upstream_for_a_branch_the_remote_has_never_seen() {
        let root = tmp("new-branch");
        let work = init_repo(&root);
        git(&work, &["checkout", "-q", "-b", "feat"]);
        commit(&work, "a.txt");

        let plan = plan_of(push_plan(&work, "feat").unwrap());
        assert_eq!(plan.remote, "origin");
        assert_eq!(plan.upstream, None);
        assert_eq!(plan.ahead, None, "nothing to count against on the remote");
        assert!(plan.sets_upstream);
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].kind, GitStepKind::Push);
        assert_eq!(plan.steps[0].command, "git push --set-upstream origin feat");

        let outcome = push_execute(&work, "feat").unwrap();
        assert!(outcome.set_upstream);
        assert_eq!(outcome.ahead, None);
        // The remote really has it now, and the branch tracks it.
        let plan = push_plan(&work, "feat").unwrap();
        assert!(
            matches!(plan, PushPlanOutcome::NothingToPush { behind: 0, .. }),
            "after a push there is nothing left to push, got {plan:?}"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn plans_a_plain_push_for_a_tracked_branch_that_is_ahead() {
        let root = tmp("ahead");
        let work = init_repo(&root);
        commit(&work, "a.txt");
        commit(&work, "b.txt");

        let plan = plan_of(push_plan(&work, "main").unwrap());
        assert_eq!(plan.upstream.as_deref(), Some("origin/main"));
        assert_eq!(plan.ahead, Some(2));
        assert!(!plan.sets_upstream, "main already tracks origin/main");
        assert_eq!(plan.steps[0].command, "git push origin main");
        assert!(plan.steps[0].note.contains("2 commits"));

        let outcome = push_execute(&work, "main").unwrap();
        assert_eq!(outcome.ahead, Some(2));
        assert!(!outcome.set_upstream);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_nothing_to_push_rather_than_planning_an_empty_push() {
        let root = tmp("uptodate");
        let work = init_repo(&root);

        match push_plan(&work, "main").unwrap() {
            PushPlanOutcome::NothingToPush {
                upstream, behind, ..
            } => {
                assert_eq!(upstream, "origin/main");
                assert_eq!(behind, 0);
            }
            other => panic!("expected NothingToPush, got {other:?}"),
        }
        // Executing anyway is a loud refusal, not a silent no-op.
        let err = push_execute(&work, "main").unwrap_err().to_string();
        assert!(err.contains("Nothing to push"), "got: {err}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_divergence_and_never_plans_a_force_push() {
        let root = tmp("diverged");
        let work = init_repo(&root);
        // A second clone pushes a commit the first one will never have.
        let other = root.join("other");
        git(
            &root,
            &[
                "clone",
                "-q",
                root.join("remote.git").to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        commit(&other, "theirs.txt");
        git(&other, &["push", "-q", "origin", "main"]);

        // The first clone learns of it, then commits its own.
        git(&work, &["fetch", "-q", "origin"]);
        commit(&work, "mine.txt");

        match push_plan(&work, "main").unwrap() {
            PushPlanOutcome::Diverged { ahead, behind, .. } => {
                assert_eq!((ahead, behind), (1, 1));
            }
            other => panic!("expected Diverged, got {other:?}"),
        }
        let err = push_execute(&work, "main").unwrap_err().to_string();
        assert!(err.contains("never force-pushes"), "got: {err}");
        // And nothing was pushed: the remote still has their commit as its tip.
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pushes_a_branch_that_lives_in_a_linked_worktree_from_that_worktree() {
        let root = tmp("worktree");
        let work = init_repo(&root);
        let wt = root.join("wt-feat");
        git(
            &work,
            &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()],
        );
        commit(&wt, "in-worktree.txt");

        // Planned from the *root* worktree, for a branch checked out elsewhere.
        let plan = plan_of(push_plan(&work, "feat").unwrap());
        assert_eq!(
            fs::canonicalize(&plan.run_in).unwrap(),
            fs::canonicalize(&wt).unwrap(),
            "the push runs in the branch's own worktree"
        );
        assert_eq!(
            plan.uncommitted_count,
            Some(0),
            "the worktree's dirtiness is reported, not the focused one's"
        );

        push_execute(&work, "feat").unwrap();
        // The remote has the branch, pushed from the linked worktree.
        let refs = TestCommand::new("git")
            .arg("-C")
            .arg(root.join("remote.git"))
            .args(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
            .output()
            .unwrap();
        let refs = String::from_utf8_lossy(&refs.stdout);
        assert!(refs.contains("feat"), "remote heads: {refs}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_branch_with_no_worktree_still_plans_and_pushes() {
        let root = tmp("no-worktree");
        let work = init_repo(&root);
        // Create `feat` without checking it out anywhere.
        git(&work, &["checkout", "-q", "-b", "feat"]);
        commit(&work, "a.txt");
        git(&work, &["checkout", "-q", "main"]);

        let plan = plan_of(push_plan(&work, "feat").unwrap());
        assert_eq!(
            plan.uncommitted_count, None,
            "no worktree ⇒ no dirtiness to report, not a fake 0"
        );
        assert_eq!(
            fs::canonicalize(&plan.run_in).unwrap(),
            fs::canonicalize(&work).unwrap()
        );
        push_execute(&work, "feat").unwrap();
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_loudly_with_no_remote_and_with_no_such_branch() {
        let root = tmp("refusals");
        let work = root.join("solo");
        fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        commit(&work, "base.txt");

        let err = push_plan(&work, "main").unwrap_err().to_string();
        assert!(err.contains("no remote configured"), "got: {err}");
        assert!(err.contains("git remote add"), "names the fix: {err}");

        let err = push_plan(&work, "nope").unwrap_err().to_string();
        assert!(err.contains("no local branch named `nope`"), "got: {err}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_uncommitted_work_the_push_leaves_behind() {
        let root = tmp("dirty");
        let work = init_repo(&root);
        commit(&work, "a.txt");
        fs::write(work.join("dirty.txt"), "not committed\n").unwrap();

        let plan = plan_of(push_plan(&work, "main").unwrap());
        assert_eq!(plan.uncommitted_count, Some(1));
        assert_eq!(plan.ahead, Some(1), "the dirty file is not a commit");
        fs::remove_dir_all(&root).ok();
    }
}
