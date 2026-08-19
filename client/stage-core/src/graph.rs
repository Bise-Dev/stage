//! Branch graph — v6-light L6: commit topology with lane assignment, computed
//! entirely in Rust so the webview only renders (ADR-0022 §7).
//!
//! The walk covers a bounded window (newest [`GRAPH_WINDOW`] commits reachable
//! from any local branch tip, topological + time order). Lane assignment is
//! the classic single-pass "waiting lane" scheme, kept deliberately simple to
//! match the design's orthogonal look (straight vertical lanes; a fork row
//! draws a top-half vertical at the forking lane plus a horizontal elbow into
//! the commit's dot):
//!
//! * each lane slot waits for one commit sha; the leftmost lane waiting for
//!   the current commit becomes its lane, every *other* lane waiting for it is
//!   a fork terminating at this row (`forks`) and is freed;
//! * a commit nobody waits for is a branch tip and claims the first free lane;
//! * the commit's lane then waits for its first parent; a second parent gets a
//!   fresh lane unless one already waits for it (merged-in line continuing
//!   below). Parents beyond the second are kept in `parents` but draw no lane
//!   of their own — octopus merges degrade gracefully, per the plan.
//!
//! `through` lists the lanes drawn as full-height verticals on a row (active
//! lanes plus the commit's own, minus the fork lanes). A tip row draws its own
//! lane full height — the same simplification the design mock makes.
//!
//! Fail loud (CLAUDE.md): any repo/walk error is a [`StageError`], never a
//! partial graph.

use std::collections::HashMap;
use std::path::Path;

use git2::{BranchType, Repository, Sort};
use serde::Serialize;
use ts_rs::TS;

use crate::error::StageError;
use crate::overview::uncommitted_count;
use crate::worktree::list_worktrees;

/// Newest commits included in the graph, across all local branch tips.
pub const GRAPH_WINDOW: usize = 250;

/// A branch tip label sitting on a commit row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphLabel {
    pub branch: String,
    /// The branch checked out in the focused worktree (HEAD at the repo root).
    pub is_head: bool,
    /// The branch is checked out on some worktree (observe-only, ADR-0016).
    pub on_worktree: bool,
}

/// One commit row, with its precomputed lane geometry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphRow {
    /// Full 40-hex sha.
    pub sha: String,
    /// Abbreviated sha for display (7 chars — git's default abbreviation).
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    /// Author time, epoch seconds (UTC). Formatted on the client.
    #[ts(type = "number")]
    pub authored_at: i64,
    /// The lane carrying this commit's dot.
    pub lane: u32,
    /// Lanes drawn as full-height verticals on this row (includes `lane`).
    pub through: Vec<u32>,
    /// Lanes terminating at this row with an elbow into `lane` — branch lines
    /// whose next (parent) commit is this one.
    pub forks: Vec<u32>,
    /// Parent shas, first-parent first. More than two ⇒ octopus; only the
    /// first two get lane geometry.
    pub parents: Vec<String>,
    pub is_merge: bool,
    /// Branch tips sitting on this commit.
    pub labels: Vec<GraphLabel>,
}

/// A local branch and the lane its tip landed in — drives the rail's lane
/// colors. `lane` is `None` when the tip fell outside the window (its line
/// never got a row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphBranch {
    pub name: String,
    pub tip_sha: String,
    pub lane: Option<u32>,
    pub is_head: bool,
    pub on_worktree: bool,
}

/// Footer facts for the graph view. Every field is derived or absent — never
/// guessed (WS-5): `ahead`/`behind` are `None` when the HEAD branch has no
/// upstream, `uncommitted_count` is `None` when there is no working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphHeadStatus {
    /// Branch checked out at the repo root; `None` when detached.
    pub branch: Option<String>,
    /// Commits ahead of / behind the branch's upstream (`origin/<branch>`).
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub uncommitted_count: Option<u32>,
}

/// The assembled graph. `truncated` marks a window-bounded view; the client
/// labels it honestly ("latest N commits") instead of faking a total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BranchGraphView {
    pub rows: Vec<GraphRow>,
    pub branches: Vec<GraphBranch>,
    pub head: GraphHeadStatus,
    #[ts(type = "number")]
    pub window: u32,
    pub truncated: bool,
}

/// Build the branch graph for the repo at `repo_path`.
pub fn branch_graph(repo_path: &Path) -> Result<BranchGraphView, StageError> {
    let repo = Repository::open(repo_path)?;

    // Local branch tips: name → tip sha. Worktree flags come from `git
    // worktree list` (the porcelain owns that truth, ADR-0016).
    let worktree_branches: Vec<String> = list_worktrees(repo_path)?
        .into_iter()
        .filter_map(|w| w.branch)
        .collect();
    let head_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_string));

    let mut tips: Vec<(String, String)> = Vec::new(); // (branch, tip sha)
    for entry in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = entry?;
        let Some(name) = branch.name()?.map(str::to_string) else {
            continue; // non-UTF-8 branch name: nothing honest to display
        };
        let tip = branch.get().peel_to_commit()?;
        tips.push((name, tip.id().to_string()));
    }
    tips.sort();

    // Bounded topological walk from every tip.
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    for (_, sha) in &tips {
        walk.push(git2::Oid::from_str(sha)?)?;
    }

    let mut labels_by_sha: HashMap<&str, Vec<GraphLabel>> = HashMap::new();
    for (name, sha) in &tips {
        labels_by_sha.entry(sha).or_default().push(GraphLabel {
            branch: name.clone(),
            is_head: head_branch.as_deref() == Some(name),
            on_worktree: worktree_branches.iter().any(|b| b == name),
        });
    }

    // Lane slots: the sha each lane is waiting for.
    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut rows: Vec<GraphRow> = Vec::new();
    let mut truncated = false;

    for oid in walk {
        if rows.len() >= GRAPH_WINDOW {
            truncated = true;
            break;
        }
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let sha = oid.to_string();

        let waiting: Vec<usize> = lanes
            .iter()
            .enumerate()
            .filter(|(_, s)| s.as_deref() == Some(sha.as_str()))
            .map(|(i, _)| i)
            .collect();
        let active_before: Vec<u32> = lanes
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_some())
            .map(|(i, _)| i as u32)
            .collect();

        let lane = match waiting.first() {
            Some(&first) => first,
            None => match lanes.iter().position(|s| s.is_none()) {
                Some(free) => free,
                None => {
                    lanes.push(None);
                    lanes.len() - 1
                }
            },
        };
        let forks: Vec<u32> = waiting.iter().skip(1).map(|&i| i as u32).collect();
        for &i in waiting.iter().skip(1) {
            lanes[i] = None;
        }

        let parents: Vec<String> = commit.parent_ids().map(|p| p.to_string()).collect();
        lanes[lane] = parents.first().cloned();
        if let Some(p2) = parents.get(1) {
            let already = lanes.iter().any(|s| s.as_deref() == Some(p2.as_str()));
            if !already {
                match lanes.iter().position(|s| s.is_none()) {
                    Some(free) => lanes[free] = Some(p2.clone()),
                    None => lanes.push(Some(p2.clone())),
                }
            }
        }

        let mut through: Vec<u32> = active_before
            .into_iter()
            .filter(|l| !forks.contains(l))
            .collect();
        if !through.contains(&(lane as u32)) {
            through.push(lane as u32);
            through.sort_unstable();
        }

        rows.push(GraphRow {
            short_sha: sha.chars().take(7).collect(),
            subject: commit.summary().unwrap_or_default().to_string(),
            author: commit.author().name().unwrap_or_default().to_string(),
            authored_at: commit.author().when().seconds(),
            lane: lane as u32,
            through,
            forks,
            is_merge: parents.len() > 1,
            labels: labels_by_sha.remove(sha.as_str()).unwrap_or_default(),
            parents,
            sha,
        });
    }

    let lane_by_tip: HashMap<&str, u32> = rows
        .iter()
        .flat_map(|r| r.labels.iter().map(move |l| (l.branch.as_str(), r.lane)))
        .collect();
    let branches: Vec<GraphBranch> = tips
        .iter()
        .map(|(name, sha)| GraphBranch {
            name: name.clone(),
            tip_sha: sha.clone(),
            lane: lane_by_tip.get(name.as_str()).copied(),
            is_head: head_branch.as_deref() == Some(name),
            on_worktree: worktree_branches.iter().any(|b| b == name),
        })
        .collect();

    let head = head_status(&repo, repo_path, head_branch.as_deref())?;

    Ok(BranchGraphView {
        rows,
        branches,
        head,
        window: GRAPH_WINDOW as u32,
        truncated,
    })
}

/// Footer facts for the checked-out branch. Ahead/behind compare against the
/// branch's own upstream and are absent (not 0) without one.
fn head_status(
    repo: &Repository,
    repo_path: &Path,
    head_branch: Option<&str>,
) -> Result<GraphHeadStatus, StageError> {
    let uncommitted = if repo.is_bare() {
        None
    } else {
        Some(uncommitted_count(repo_path)?)
    };
    let (ahead, behind) = match head_branch {
        Some(name) => ahead_behind_upstream(repo, name),
        None => (None, None),
    };
    Ok(GraphHeadStatus {
        branch: head_branch.map(str::to_string),
        ahead,
        behind,
        uncommitted_count: uncommitted,
    })
}

fn ahead_behind_upstream(repo: &Repository, branch: &str) -> (Option<u32>, Option<u32>) {
    let Ok(local) = repo.find_branch(branch, BranchType::Local) else {
        return (None, None);
    };
    let Ok(upstream) = local.upstream() else {
        return (None, None); // no upstream: absent, never a fake 0/0
    };
    let (Some(l), Some(u)) = (local.get().target(), upstream.get().target()) else {
        return (None, None);
    };
    match repo.graph_ahead_behind(l, u) {
        Ok((a, b)) => (Some(a as u32), Some(b as u32)),
        Err(_) => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn commit(dir: &Path, file: &str, msg: &str) {
        fs::write(dir.join(file), msg).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

    fn init_repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        commit(dir, "a.txt", "one");
        commit(dir, "a.txt", "two");
    }

    #[test]
    fn linear_history_uses_a_single_lane() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);

        let g = branch_graph(&repo).unwrap();
        assert_eq!(g.rows.len(), 2);
        assert!(g.rows.iter().all(|r| r.lane == 0));
        assert!(g.rows.iter().all(|r| r.through == vec![0]));
        assert!(g.rows.iter().all(|r| r.forks.is_empty()));
        assert!(!g.truncated);
        assert_eq!(g.head.branch.as_deref(), Some("main"));
        assert_eq!(g.head.uncommitted_count, Some(0));
        // No upstream: absent, not 0/0.
        assert_eq!(g.head.ahead, None);
        assert_eq!(g.head.behind, None);
    }

    #[test]
    fn fork_gets_its_own_lane_and_elbows_at_the_fork_point() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        git(&repo, &["checkout", "-q", "-b", "feat"]);
        commit(&repo, "b.txt", "feat work");
        git(&repo, &["checkout", "-q", "main"]);
        commit(&repo, "a.txt", "main moves on");

        let g = branch_graph(&repo).unwrap();
        assert_eq!(g.rows.len(), 4);
        let tip_lanes: Vec<u32> = g.rows[..2].iter().map(|r| r.lane).collect();
        // Two tips, two distinct lanes.
        assert_eq!(tip_lanes.len(), 2);
        assert_ne!(tip_lanes[0], tip_lanes[1]);
        // The common ancestor row absorbs the second lane as a fork elbow.
        let fork_row = &g.rows[2];
        assert_eq!(fork_row.forks.len(), 1);
        assert!(tip_lanes.contains(&fork_row.forks[0]));
        assert_ne!(fork_row.lane, fork_row.forks[0]);
        // Below the fork, one lane remains.
        assert_eq!(g.rows[3].through, vec![g.rows[3].lane]);
    }

    #[test]
    fn branch_tips_carry_labels_and_lane_mapping() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        git(&repo, &["branch", "feat"]);

        let g = branch_graph(&repo).unwrap();
        // Both tips sit on the same commit → one row with both labels.
        let labeled: Vec<_> = g.rows.iter().filter(|r| !r.labels.is_empty()).collect();
        assert_eq!(labeled.len(), 1);
        let names: Vec<_> = labeled[0]
            .labels
            .iter()
            .map(|l| l.branch.as_str())
            .collect();
        assert_eq!(names, vec!["feat", "main"]);
        let head_label = labeled[0]
            .labels
            .iter()
            .find(|l| l.branch == "main")
            .unwrap();
        assert!(head_label.is_head);
        assert_eq!(g.branches.len(), 2);
        assert!(g.branches.iter().all(|b| b.lane == Some(labeled[0].lane)));
        assert!(
            g.branches
                .iter()
                .find(|b| b.name == "main")
                .unwrap()
                .is_head
        );
    }

    #[test]
    fn window_bounds_the_walk_and_marks_truncation() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        for i in 0..(GRAPH_WINDOW + 5) {
            commit(&repo, "a.txt", &format!("c{i}"));
        }

        let g = branch_graph(&repo).unwrap();
        assert_eq!(g.rows.len(), GRAPH_WINDOW);
        assert!(g.truncated);
        assert_eq!(g.window as usize, GRAPH_WINDOW);
    }

    #[test]
    fn merge_commit_keeps_two_parents_and_marks_is_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        init_repo(&repo);
        git(&repo, &["checkout", "-q", "-b", "feat"]);
        commit(&repo, "b.txt", "feat work");
        git(&repo, &["checkout", "-q", "main"]);
        commit(&repo, "c.txt", "main work");
        git(
            &repo,
            &["merge", "-q", "--no-ff", "-m", "merge feat", "feat"],
        );

        let g = branch_graph(&repo).unwrap();
        let merge = &g.rows[0];
        assert!(merge.is_merge);
        assert_eq!(merge.parents.len(), 2);
        // The merged-in line continues below: some later row sits on a
        // different lane than the merge commit's.
        assert!(g.rows.iter().skip(1).any(|r| r.lane != merge.lane));
        // Everything reconverges at the root: last row is the initial commit.
        assert_eq!(g.rows.last().unwrap().subject, "one");
    }
}
