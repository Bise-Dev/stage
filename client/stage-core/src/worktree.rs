//! Enumerate the worktrees git has attached to a repo — observe-only (ADR-0016).
//!
//! Git is the source of truth: we shell out to `git worktree list --porcelain
//! -z` from the repo's working directory (or the common directory for a bare
//! repo) and parse the records, rather than keep our own registry. Directories
//! git omits (orphaned/unregistered) do not appear here. We reuse the system
//! `git` — as `src-tauri/src/git.rs::fetch` already does — because the
//! porcelain `-z` format is a stable contract and sidesteps libgit2
//! worktree-API edge cases.

use std::path::{Path, PathBuf};
use std::process::Command;

use git2::Repository;
use serde::{Deserialize, Serialize};

use crate::error::StageError;

/// One worktree git reports for a repo — a single checked-out working directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Absolute path of the worktree's working directory, as git reports it.
    pub path: PathBuf,
    /// Checked-out branch shorthand (e.g. `"main"`); `None` when detached or bare.
    pub branch: Option<String>,
    /// HEAD commit id (40-hex); `None` for a bare entry with no HEAD.
    pub head: Option<String>,
    /// The repo's root (main) worktree — git lists it first; it cannot be removed.
    pub is_root: bool,
    /// HEAD is detached (no branch); `branch` is then `None`.
    pub detached: bool,
    /// A bare entry (no working directory of its own).
    pub bare: bool,
    /// git reports the worktree locked; `Some(reason)` (reason may be empty), else `None`.
    pub locked: Option<String>,
    /// git reports the worktree prunable (its dir is gone/invalid); `Some(reason)`, else `None`.
    pub prunable: Option<String>,
}

/// Accumulates one record while scanning the `-z` token stream.
struct Builder {
    path: PathBuf,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    bare: bool,
    locked: Option<String>,
    prunable: Option<String>,
}

impl Builder {
    fn new(path: &str) -> Self {
        Self {
            path: PathBuf::from(path),
            head: None,
            branch: None,
            detached: false,
            bare: false,
            locked: None,
            prunable: None,
        }
    }

    fn finish(self) -> WorktreeInfo {
        WorktreeInfo {
            path: self.path,
            // A detached worktree has no branch even if a stale `branch` line slipped in.
            branch: if self.detached { None } else { self.branch },
            head: self.head,
            is_root: false, // set by the caller: git lists the root first.
            detached: self.detached,
            bare: self.bare,
            locked: self.locked,
            prunable: self.prunable,
        }
    }
}

/// `refs/heads/main` -> `main`; anything else is returned unchanged.
fn shorthand_ref(refname: &str) -> String {
    refname
        .strip_prefix("refs/heads/")
        .unwrap_or(refname)
        .to_string()
}

/// Parse `git worktree list --porcelain -z` bytes.
///
/// The `-z` format NUL-terminates every attribute line (`worktree <path>`,
/// `HEAD <sha>`, `branch <ref>`, `detached`, `bare`, `locked [reason]`,
/// `prunable [reason]`) and separates records with an extra NUL. Splitting on
/// NUL therefore yields attribute tokens with empty tokens as record breaks.
/// The first record is the root worktree.
pub(crate) fn parse_porcelain_z(bytes: &[u8]) -> Vec<WorktreeInfo> {
    let text = String::from_utf8_lossy(bytes);
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<Builder> = None;

    let flush = |cur: &mut Option<Builder>, out: &mut Vec<WorktreeInfo>| {
        if let Some(b) = cur.take() {
            out.push(b.finish());
        }
    };

    for token in text.split('\0') {
        if token.is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        let (key, val) = match token.split_once(' ') {
            Some((k, v)) => (k, Some(v)),
            None => (token, None),
        };
        match key {
            "worktree" => {
                flush(&mut cur, &mut out);
                cur = Some(Builder::new(val.unwrap_or_default()));
            }
            "HEAD" => {
                if let Some(b) = cur.as_mut() {
                    b.head = val.map(str::to_string);
                }
            }
            "branch" => {
                if let Some(b) = cur.as_mut() {
                    b.branch = val.map(shorthand_ref);
                }
            }
            "detached" => {
                if let Some(b) = cur.as_mut() {
                    b.detached = true;
                }
            }
            "bare" => {
                if let Some(b) = cur.as_mut() {
                    b.bare = true;
                }
            }
            "locked" => {
                if let Some(b) = cur.as_mut() {
                    b.locked = Some(val.unwrap_or_default().to_string());
                }
            }
            "prunable" => {
                if let Some(b) = cur.as_mut() {
                    b.prunable = Some(val.unwrap_or_default().to_string());
                }
            }
            _ => {}
        }
    }
    flush(&mut cur, &mut out);

    if let Some(first) = out.first_mut() {
        first.is_root = true;
    }
    out
}

/// Enumerate the worktrees git reports for the repo containing `cwd`.
///
/// Discovers the repo from `cwd` (works from any worktree or subdirectory),
/// then runs `git worktree list --porcelain -z` from the discovered working
/// directory so git lists every worktree in the set. Git is the source of
/// truth (ADR-0016): entries are returned exactly as git reports them, root
/// first. Fails loud with git's stderr on a non-zero exit.
pub fn list_worktrees(cwd: &Path) -> Result<Vec<WorktreeInfo>, StageError> {
    let repo = Repository::discover(cwd).map_err(|_| StageError::NotARepo(cwd.to_path_buf()))?;
    // Run from a working directory when there is one (any worktree lists the
    // whole set); fall back to the common dir for a bare repo.
    let run_dir = repo
        .workdir()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo.path().to_path_buf());

    let output = Command::new("git")
        .arg("-C")
        .arg(&run_dir)
        .args(["worktree", "list", "--porcelain", "-z"])
        .output()
        .map_err(StageError::Io)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        return Err(StageError::Worktree(if msg.is_empty() {
            "git worktree list failed".to_string()
        } else {
            msg.to_string()
        }));
    }

    Ok(parse_porcelain_z(&output.stdout))
}

/// The repo's **common directory** — the shared `.git` every worktree of a repo
/// points at (ADR-0016). git2 0.19 has no `commondir()` binding, so derive it:
/// a linked worktree's gitdir is `<common>/worktrees/<id>`, so its common dir is
/// the grandparent; the main worktree's gitdir *is* the common dir.
pub fn repo_common_dir(repo: &Repository) -> PathBuf {
    let gitdir = repo.path();
    if repo.is_worktree() {
        gitdir
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| gitdir.to_path_buf())
    } else {
        gitdir.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command as TestCommand;

    /// Run `git -C <dir> <args...>`, asserting success. Test-only.
    fn git(dir: &Path, args: &[&str]) {
        let status = TestCommand::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    #[test]
    fn list_worktrees_reports_root_and_linked() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("README.md"), "hi\n").unwrap();
        git(&root, &["add", "."]);
        git(
            &root,
            &[
                "-c",
                "user.email=t@e.com",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        );
        let linked = tmp.path().join("repo-feat");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                linked.to_str().unwrap(),
                "-b",
                "feat",
            ],
        );

        // Discover from inside the LINKED worktree -- must still see both.
        let got = list_worktrees(&linked).unwrap();
        assert_eq!(got.len(), 2, "root + linked");

        let root_wt = got.iter().find(|w| w.is_root).expect("a root worktree");
        assert_eq!(root_wt.branch.as_deref(), Some("main"));

        let feat_wt = got
            .iter()
            .find(|w| w.branch.as_deref() == Some("feat"))
            .expect("the linked feat worktree");
        assert!(!feat_wt.is_root);
        assert!(!feat_wt.detached);
    }

    #[test]
    fn parses_two_worktrees_with_branches() {
        // Exactly the bytes `git worktree list --porcelain -z` emits:
        // NUL after each attribute line, an extra NUL between records.
        let raw = b"worktree /repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /repo-feat\0HEAD 2222222222222222222222222222222222222222\0branch refs/heads/feat\0\0";
        let got = parse_porcelain_z(raw);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].path, PathBuf::from("/repo"));
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert!(got[0].is_root);
        assert!(!got[0].detached);
        assert_eq!(got[1].path, PathBuf::from("/repo-feat"));
        assert_eq!(got[1].branch.as_deref(), Some("feat"));
        assert!(!got[1].is_root);
    }

    #[test]
    fn parses_detached_locked_and_prunable() {
        let raw = b"worktree /repo\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0branch refs/heads/main\0\0worktree /repo-spike\0HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\0detached\0\0worktree /repo-old\0HEAD cccccccccccccccccccccccccccccccccccccccc\0locked\0prunable gitdir file points to non-existent location\0\0";
        let got = parse_porcelain_z(raw);
        assert_eq!(got.len(), 3);
        assert!(got[1].detached);
        assert_eq!(got[1].branch, None);
        assert_eq!(got[2].locked.as_deref(), Some(""));
        assert_eq!(
            got[2].prunable.as_deref(),
            Some("gitdir file points to non-existent location")
        );
    }
}
