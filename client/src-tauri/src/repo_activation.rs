//! Mapping a freshly-opened path onto the repo's worktree set (ADR-0016).
//!
//! Pure logic, no Tauri: given git's worktree list (the source of truth) and
//! the directory the user opened, decide which worktree is *focused* (the one
//! Self-Review targets) and which is the *root* (the recents entry the Repo
//! collapses to). Paths are compared canonically so a symlinked path
//! (`/var/...` vs `/private/var/...`) still matches git's reported path.

use std::path::{Path, PathBuf};

use stage_core::WorktreeInfo;

/// The outcome of activating a repo from `opened`.
pub struct Activation {
    /// The worktree to focus: the opened one if it is a worktree, else the root.
    pub focused: PathBuf,
    /// The repo's root worktree path — what the recents list keys on.
    pub root: PathBuf,
}

/// Best-effort canonicalization: non-existent paths (in tests) compare literally.
fn canon(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// The git-reported path of the worktree at `target`, matched canonically;
/// `None` when `target` is not one of `worktrees`.
pub fn match_worktree(worktrees: &[WorktreeInfo], target: &Path) -> Option<PathBuf> {
    let t = canon(target);
    worktrees
        .iter()
        .find(|w| canon(&w.path) == t)
        .map(|w| w.path.clone())
}

/// Pick the focused + root worktree paths for a repo opened at `opened`.
pub fn resolve_activation(worktrees: &[WorktreeInfo], opened: &Path) -> Activation {
    let root = worktrees
        .iter()
        .find(|w| w.is_root)
        .map(|w| w.path.clone())
        .unwrap_or_else(|| opened.to_path_buf());
    let focused = match_worktree(worktrees, opened).unwrap_or_else(|| root.clone());
    Activation { focused, root }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wt(path: &str, is_root: bool) -> WorktreeInfo {
        WorktreeInfo {
            path: PathBuf::from(path),
            branch: Some("b".into()),
            head: Some("0".repeat(40)),
            is_root,
            detached: false,
            bare: false,
            locked: None,
            prunable: None,
        }
    }

    #[test]
    fn focuses_the_opened_linked_worktree_and_finds_root() {
        let wts = vec![wt("/ws/repo", true), wt("/ws/repo-feat", false)];
        let a = resolve_activation(&wts, Path::new("/ws/repo-feat"));
        assert_eq!(a.focused, PathBuf::from("/ws/repo-feat"));
        assert_eq!(a.root, PathBuf::from("/ws/repo"));
    }

    #[test]
    fn opening_the_root_focuses_the_root() {
        let wts = vec![wt("/ws/repo", true), wt("/ws/repo-feat", false)];
        let a = resolve_activation(&wts, Path::new("/ws/repo"));
        assert_eq!(a.focused, PathBuf::from("/ws/repo"));
        assert_eq!(a.root, PathBuf::from("/ws/repo"));
    }

    #[test]
    fn unmatched_path_falls_back_to_root() {
        let wts = vec![wt("/ws/repo", true)];
        let a = resolve_activation(&wts, Path::new("/somewhere/else"));
        assert_eq!(a.focused, PathBuf::from("/ws/repo"));
    }

    #[test]
    fn match_worktree_returns_none_for_a_stranger() {
        let wts = vec![wt("/ws/repo", true)];
        assert!(match_worktree(&wts, Path::new("/ws/other")).is_none());
        assert_eq!(
            match_worktree(&wts, Path::new("/ws/repo")),
            Some(PathBuf::from("/ws/repo"))
        );
    }
}
