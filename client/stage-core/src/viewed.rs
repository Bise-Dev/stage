//! Self-Review viewed marks (v6-light L2; flags F2/F2b) — per-(repo, branch,
//! file) "I've looked at this" markers, moved into the shared SQLite store so
//! the engine (overview rows) and later the CLI can read them.
//!
//! The content anchor (F2b): each mark records the post-image blob OID the
//! file had when the author marked it. A mark whose OID no longer matches the
//! file's *current* post-image counts as **unviewed**. Stale rows are ignored
//! at read time, never pruned: the anchor is content-addressed like git
//! itself, so undoing the edit restores the mark.

use std::path::Path;

use git2::Repository;

use crate::error::StageError;
use crate::repo_key::RepoKey;
use crate::store::Store;

/// A stored viewed mark. `blob_oid` is the content anchor;
/// [`ABSENT_POST_IMAGE`] marks a post-image that didn't exist (deleted file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewedMark {
    pub file: String,
    pub blob_oid: String,
    /// Epoch seconds (UTC), matching the store's timestamp convention.
    pub viewed_at: i64,
}

/// The stored "Mark reviewed" state (flag F3): explicit, SHA-bound. Valid only
/// while `head_sha` is still the branch head — derived at read time, so a new
/// commit silently returns the branch to not-done without a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfReviewDone {
    pub head_sha: String,
    /// Epoch seconds (UTC).
    pub done_at: i64,
}

/// The zero OID — the sentinel for an absent post-image (a deleted file).
/// Stable by construction: a mark on a deletion stays valid exactly as long
/// as the file stays deleted.
pub const ABSENT_POST_IMAGE: &str = "0000000000000000000000000000000000000000";

/// The file's *current* post-image blob OID, from the author's perspective:
/// the working-tree bytes when the branch is checked out on `worktree`
/// (hashed exactly as git would store the blob — uncommitted edits count),
/// otherwise the blob at the branch tip. Absent either way →
/// [`ABSENT_POST_IMAGE`]. An unreadable file or unresolvable branch fails
/// loud — never a guessed anchor.
pub fn current_post_image_oid(
    repo: &Repository,
    worktree: Option<&Path>,
    branch: &str,
    file: &str,
) -> Result<String, StageError> {
    if let Some(wt) = worktree {
        let path = wt.join(file);
        return match std::fs::read(&path) {
            Ok(bytes) => Ok(git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)?.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ABSENT_POST_IMAGE.into()),
            Err(e) => Err(StageError::Invalid(format!(
                "viewed_post_image: could not read {}: {e}",
                path.display()
            ))),
        };
    }
    let tree = repo
        .revparse_single(branch)
        .map_err(|e| {
            StageError::Invalid(format!(
                "viewed_post_image: branch '{branch}' does not resolve: {e}"
            ))
        })?
        .peel_to_commit()?
        .tree()?;
    match tree.get_path(Path::new(file)) {
        Ok(entry) => Ok(entry.id().to_string()),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(ABSENT_POST_IMAGE.into()),
        Err(e) => Err(StageError::Git(e)),
    }
}

/// One-shot import of legacy webview-store marks (F2 migration): every file is
/// stamped with its **current** post-image OID — "viewed as of now", the only
/// honest anchor available since the legacy format stored none. `worktree` is
/// the working tree to hash from for `current_branch` (the focused checkout);
/// other branches anchor at their tip.
///
/// A branch that no longer resolves is skipped with a warning (its marks have
/// nothing to anchor to — the branch was deleted since); that is a logged,
/// deliberate discard, not a silent fallback. Returns the number imported.
/// Clearing the legacy source afterwards is the caller's job and must happen
/// only on `Ok`.
pub fn import_legacy_viewed(
    store: &Store,
    repo_root: &Path,
    repo_owner: &str,
    repo_name: &str,
    current_branch: &str,
    marks_by_branch: &std::collections::HashMap<String, Vec<String>>,
) -> Result<u32, StageError> {
    let repo = Repository::discover(repo_root)?;
    let mut imported = 0u32;
    for (branch, files) in marks_by_branch {
        if repo.revparse_single(branch).is_err() {
            tracing::warn!(
                branch = %branch,
                files = files.len(),
                "viewed_import_branch_missing: branch no longer resolves; its legacy marks are discarded"
            );
            continue;
        }
        let worktree = (branch == current_branch).then_some(repo_root);
        let key = RepoKey {
            repo_owner: repo_owner.to_string(),
            repo_name: repo_name.to_string(),
            branch: branch.clone(),
        };
        for file in files {
            let oid = current_post_image_oid(&repo, worktree, branch, file)?;
            store.set_viewed(&key, file, &oid)?;
            imported += 1;
        }
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "t").unwrap();
            cfg.set_str("user.email", "t@t").unwrap();
        }
        (dir, repo)
    }

    fn commit_file(repo: &Repository, name: &str, contents: &str, msg: &str) {
        let root = repo.workdir().unwrap().to_path_buf();
        std::fs::write(root.join(name), contents).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap();
    }

    #[test]
    fn worktree_hash_tracks_content() {
        let (dir, repo) = temp_repo();
        commit_file(&repo, "a.txt", "one\n", "c1");
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();

        let at_tip = current_post_image_oid(&repo, None, &branch, "a.txt").unwrap();
        let in_wt = current_post_image_oid(&repo, Some(dir.path()), &branch, "a.txt").unwrap();
        assert_eq!(at_tip, in_wt, "clean worktree hashes to the tip blob");

        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        let edited = current_post_image_oid(&repo, Some(dir.path()), &branch, "a.txt").unwrap();
        assert_ne!(edited, at_tip, "an uncommitted edit moves the anchor");
    }

    #[test]
    fn absent_post_image_is_the_zero_oid() {
        let (dir, repo) = temp_repo();
        commit_file(&repo, "a.txt", "one\n", "c1");
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();

        assert_eq!(
            current_post_image_oid(&repo, None, &branch, "gone.txt").unwrap(),
            ABSENT_POST_IMAGE
        );
        assert_eq!(
            current_post_image_oid(&repo, Some(dir.path()), &branch, "gone.txt").unwrap(),
            ABSENT_POST_IMAGE
        );
    }

    #[test]
    fn unresolvable_branch_fails_loud() {
        let (_dir, repo) = temp_repo();
        commit_file(&repo, "a.txt", "one\n", "c1");
        let err = current_post_image_oid(&repo, None, "no-such-branch", "a.txt").unwrap_err();
        assert!(err.to_string().contains("no-such-branch"));
    }

    #[test]
    fn legacy_import_stamps_current_oids_and_skips_missing_branches() {
        let (dir, repo) = temp_repo();
        commit_file(&repo, "a.txt", "one\n", "c1");
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();
        let store = Store::open(&dir.path().join("store.sqlite3")).unwrap();

        let mut marks = std::collections::HashMap::new();
        marks.insert(branch.clone(), vec!["a.txt".to_string()]);
        marks.insert("gone-branch".to_string(), vec!["b.txt".to_string()]);

        let imported =
            import_legacy_viewed(&store, dir.path(), "octo", "stage", &branch, &marks).unwrap();
        assert_eq!(imported, 1, "the deleted branch's marks are discarded");

        let key = RepoKey {
            repo_owner: "octo".into(),
            repo_name: "stage".into(),
            branch: branch.clone(),
        };
        let stored = store.list_viewed(&key).unwrap();
        assert_eq!(stored.len(), 1);
        // Stamped "viewed as of now": the anchor is the file's current
        // post-image, so the mark reads back as valid immediately.
        let current = current_post_image_oid(&repo, Some(dir.path()), &branch, "a.txt").unwrap();
        assert_eq!(stored[0].blob_oid, current);
        assert!(!store
            .list_viewed_by_branch("octo", "stage")
            .unwrap()
            .contains_key("gone-branch"));
    }
}
