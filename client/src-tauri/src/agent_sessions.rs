//! Live Claude Code sessions on this machine, joined to the repo's worktrees.
//!
//! Claude Code registers every running session as `~/.claude/sessions/<pid>.json`
//! — its working directory, a human task name, and a `busy`/`idle` status. Stage
//! reads those files (observe-only, the same posture ADR-0016 takes on
//! worktrees) and matches each session's cwd to a worktree, so the branch table
//! can show "an agent is working here".
//!
//! The feature is opt-in (Settings), and the files are another tool's
//! undocumented internals, so this module is deliberately best-effort — the
//! sanctioned exception to fail-loud, decided as product behavior: a session
//! must never break or block the overview. A file that fails to parse, a dead
//! pid, or a missing directory yields *absence* (no pill), never an error the
//! user has to deal with. Skips are still logged so a format drift stays
//! diagnosable.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use stage_core::WorktreeInfo;
use ts_rs::TS;

/// One live Claude Code session working in a dedicated (non-root) worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentSession {
    /// The branch checked out in the worktree the session runs in.
    pub branch: String,
    /// Claude Code's human task name for the session (falls back to the
    /// session id's first 8 chars when the file carries no name).
    pub name: String,
    /// Claude Code's own status vocabulary, passed through verbatim —
    /// `"busy"` or `"idle"` today; anything new renders as-is rather than
    /// being guessed at.
    pub status: String,
    /// The Claude Code session id — what `claude --resume <id>` takes.
    pub session_id: String,
}

/// A live session inside the repo but in no dedicated worktree (yet): it sits
/// in the root checkout — typically an agent that hasn't created its worktree
/// — or in a directory git no longer lists (a pruned worktree). The branch
/// table shows these below the rows, like PRs with no local branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnattachedAgentSession {
    pub name: String,
    pub status: String,
    pub session_id: String,
    /// The session's cwd relative to the repo root (`""` = the root itself);
    /// absolute if it can't be relativized.
    pub dir: String,
}

/// Everything the overview shows about live Claude Code sessions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentSessionsView {
    /// One per branch with a dedicated worktree (busy outranks idle).
    pub attached: Vec<AgentSession>,
    /// In the repo, but with no dedicated worktree yet — every session, no
    /// per-branch collapsing (each is its own piece of pending work).
    pub unattached: Vec<UnattachedAgentSession>,
}

/// The subset of `~/.claude/sessions/<pid>.json` Stage reads. Every field is
/// optional: the format is not ours, so a missing key skips the session
/// instead of failing the parse.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    pid: Option<u32>,
    session_id: Option<String>,
    cwd: Option<PathBuf>,
    name: Option<String>,
    status: Option<String>,
    /// Claude Code pre-warms "spare" sessions that have no task; not agent work.
    #[serde(default)]
    spare: bool,
}

/// Read `~/.claude/sessions` and return the live sessions inside one of
/// `worktrees`: per-branch for dedicated worktrees, listed separately when a
/// session has no dedicated worktree yet. Sessions outside the repo (other
/// projects) never appear.
pub fn probe(worktrees: &[WorktreeInfo]) -> AgentSessionsView {
    let Some(home) = std::env::var_os("HOME") else {
        return AgentSessionsView::default();
    };
    let dir = Path::new(&home).join(".claude").join("sessions");
    // No directory means Claude Code isn't installed (or has never run):
    // genuine absence, not a failure.
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return AgentSessionsView::default();
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(std::ffi::OsStr::new("json")) {
            continue;
        }
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<SessionFile>(&s).map_err(|e| e.to_string()))
        {
            Ok(s) => sessions.push(s),
            // Best-effort (module note): skip the file, keep the rest.
            Err(err) => {
                tracing::warn!(file = %path.display(), err, "agent_session_file_unreadable");
            }
        }
    }

    let live = live_pids(sessions.iter().filter_map(|s| s.pid).collect());
    join(sessions, &live, worktrees)
}

/// Which of `pids` belong to a running process — one `ps` call for all of
/// them. Claude Code leaves the registration file behind when a session dies,
/// so an mtime or parse check alone would show ghosts.
fn live_pids(pids: Vec<u32>) -> HashSet<u32> {
    if pids.is_empty() {
        return HashSet::new();
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    // `ps` exits non-zero when any pid is gone but still prints the live ones,
    // so only a spawn failure is treated as "none live" (absence, logged).
    match Command::new("ps")
        .args(["-o", "pid=", "-p", &list])
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .filter_map(|t| t.parse().ok())
            .collect(),
        Err(err) => {
            tracing::warn!(err = %err, "agent_sessions_ps_failed");
            HashSet::new()
        }
    }
}

/// Pure join of parsed session files onto worktrees. A session belongs to the
/// *deepest* worktree containing its cwd — the root worktree's path is a
/// prefix of every `.claude/worktrees/*` path, so shallow matching would pin
/// every agent to the default branch. A session whose deepest match is the
/// root (or a detached worktree) has no branch row to ride: it goes to
/// `unattached` — "no dedicated worktree yet" — instead of being dropped.
fn join(
    sessions: Vec<SessionFile>,
    live: &HashSet<u32>,
    worktrees: &[WorktreeInfo],
) -> AgentSessionsView {
    let root = worktrees.iter().find(|w| w.is_root);
    let mut by_branch: HashMap<String, AgentSession> = HashMap::new();
    let mut unattached: Vec<UnattachedAgentSession> = Vec::new();
    for s in sessions {
        if s.spare {
            continue;
        }
        let (Some(pid), Some(session_id), Some(cwd), Some(status)) =
            (s.pid, s.session_id, s.cwd, s.status)
        else {
            continue;
        };
        if !live.contains(&pid) {
            continue;
        }
        let Some(wt) = worktrees
            .iter()
            .filter(|w| cwd.starts_with(&w.path))
            .max_by_key(|w| w.path.components().count())
        else {
            // Outside every worktree: another project's session, not ours to show.
            continue;
        };
        let name = s
            .name
            .unwrap_or_else(|| session_id.chars().take(8).collect());
        let branch = if wt.is_root { None } else { wt.branch.clone() };
        let Some(branch) = branch else {
            // Root checkout or a detached worktree — no branch row to attach to.
            let dir = root
                .and_then(|r| cwd.strip_prefix(&r.path).ok())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| cwd.to_string_lossy().into_owned());
            unattached.push(UnattachedAgentSession {
                name,
                status,
                session_id,
                dir,
            });
            continue;
        };
        let candidate = AgentSession {
            branch: branch.clone(),
            name,
            status,
            session_id,
        };
        // One pill per row: a busy session outranks an idle one; ties keep the
        // first seen.
        let slot = by_branch.entry(branch);
        match slot {
            std::collections::hash_map::Entry::Occupied(mut e) => {
                if e.get().status != "busy" && candidate.status == "busy" {
                    e.insert(candidate);
                }
            }
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(candidate);
            }
        }
    }
    let mut attached: Vec<_> = by_branch.into_values().collect();
    attached.sort_by(|a, b| a.branch.cmp(&b.branch));
    // Every unattached session shows (each is its own pending work); a stable
    // order keeps the list from reshuffling between polls.
    unattached.sort_by(|a, b| (&a.name, &a.session_id).cmp(&(&b.name, &b.session_id)));
    AgentSessionsView {
        attached,
        unattached,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wt(path: &str, branch: Option<&str>) -> WorktreeInfo {
        WorktreeInfo {
            path: PathBuf::from(path),
            branch: branch.map(str::to_string),
            head: None,
            is_root: false,
            detached: branch.is_none(),
            bare: false,
            locked: None,
            prunable: None,
        }
    }

    fn session(pid: u32, cwd: &str, status: &str, name: Option<&str>) -> SessionFile {
        SessionFile {
            pid: Some(pid),
            session_id: Some(format!("sid-{pid}")),
            cwd: Some(PathBuf::from(cwd)),
            name: name.map(str::to_string),
            status: Some(status.to_string()),
            spare: false,
        }
    }

    fn repo_worktrees() -> Vec<WorktreeInfo> {
        let mut root = wt("/r/stage", Some("main"));
        root.is_root = true;
        vec![
            root,
            wt("/r/stage/.claude/worktrees/feat-a", Some("feat-a")),
        ]
    }

    #[test]
    fn cwd_maps_to_the_deepest_containing_worktree() {
        // The nested worktree's path starts with the root's, so a naive first
        // match would land on the root instead of the branch row.
        let live: HashSet<u32> = [1].into();
        let got = join(
            vec![session(
                1,
                "/r/stage/.claude/worktrees/feat-a/client",
                "busy",
                Some("task"),
            )],
            &live,
            &repo_worktrees(),
        );
        assert!(got.unattached.is_empty());
        assert_eq!(got.attached.len(), 1);
        assert_eq!(got.attached[0].branch, "feat-a");
        assert_eq!(got.attached[0].name, "task");
        assert_eq!(got.attached[0].status, "busy");
        assert_eq!(got.attached[0].session_id, "sid-1");
    }

    #[test]
    fn prefix_match_respects_path_components() {
        // `/r/stage-other` shares a string prefix with `/r/stage` but is not
        // inside it — Path::starts_with is component-wise, so nothing appears.
        let live: HashSet<u32> = [1].into();
        let got = join(
            vec![session(1, "/r/stage-other", "busy", None)],
            &live,
            &repo_worktrees(),
        );
        assert!(got.attached.is_empty());
        assert!(got.unattached.is_empty());
    }

    #[test]
    fn dead_spare_and_incomplete_sessions_are_absent() {
        let mut incomplete = session(4, "/r/stage", "busy", None);
        incomplete.cwd = None;
        let mut spare = session(3, "/r/stage", "idle", None);
        spare.spare = true;
        let live: HashSet<u32> = [3, 4].into();
        let got = join(
            vec![
                session(2, "/r/stage", "busy", None), // pid 2 not live
                spare,
                incomplete,
            ],
            &live,
            &repo_worktrees(),
        );
        assert!(got.attached.is_empty());
        assert!(got.unattached.is_empty());
    }

    #[test]
    fn busy_outranks_idle_on_the_same_branch() {
        let live: HashSet<u32> = [1, 2].into();
        let got = join(
            vec![
                session(
                    1,
                    "/r/stage/.claude/worktrees/feat-a",
                    "idle",
                    Some("napping"),
                ),
                session(
                    2,
                    "/r/stage/.claude/worktrees/feat-a",
                    "busy",
                    Some("working"),
                ),
            ],
            &live,
            &repo_worktrees(),
        );
        assert_eq!(got.attached.len(), 1);
        assert_eq!(got.attached[0].name, "working");
    }

    #[test]
    fn root_checkout_sessions_are_unattached_with_a_relative_dir() {
        // A session in the root checkout has no dedicated worktree yet — it
        // must not ride the default branch's row.
        let live: HashSet<u32> = [1, 2].into();
        let got = join(
            vec![
                session(1, "/r/stage", "busy", Some("bootstrapping")),
                session(2, "/r/stage/client", "idle", Some("poking around")),
            ],
            &live,
            &repo_worktrees(),
        );
        assert!(got.attached.is_empty());
        assert_eq!(got.unattached.len(), 2);
        assert_eq!(got.unattached[0].name, "bootstrapping");
        assert_eq!(got.unattached[0].dir, "");
        assert_eq!(got.unattached[1].dir, "client");
    }

    #[test]
    fn detached_worktrees_and_missing_names_fall_back() {
        let mut root = wt("/r/stage", None); // detached root: no branch row
        root.is_root = true;
        let wts = vec![
            root,
            wt("/r/stage/.claude/worktrees/feat-a", Some("feat-a")),
        ];
        let live: HashSet<u32> = [1, 2].into();
        let got = join(
            vec![
                session(1, "/r/stage", "busy", None),
                session(2, "/r/stage/.claude/worktrees/feat-a", "idle", None),
            ],
            &live,
            &wts,
        );
        // The root session surfaces as unattached, not dropped.
        assert_eq!(got.unattached.len(), 1);
        // No name in the file → the session id's first 8 chars.
        assert_eq!(got.unattached[0].name, "sid-1");
        assert_eq!(got.attached.len(), 1);
        assert_eq!(got.attached[0].name, "sid-2");
    }
}
