//! The committed `.stage` artifact — the shareable Review that rides the
//! feature branch (ADR-0019 §1). One folder per Review, keyed by branch, with
//! **no shared index file**: the dashboard discovers Reviews by listing folders,
//! never by reading a registry, so two branches never contend on one file.
//!
//! ```text
//! .stage/<branch>/
//!   review.toml          # title, base_ref, head_ref, pr_number (optional)
//!   steps/
//!     010_<slug>.md       # +++ TOML frontmatter (anchor, optional title) +++
//!     020_<slug>.md       #   · markdown body = the step intro
//! ```
//!
//! - One file per step; presentation order is the zero-padded numeric filename
//!   prefix (`010`, `020`, …). One-file-per-step keeps independent edits
//!   independent (ADR-0019 §2).
//! - **Identity (WS-1, #59):** the `head_ref` field is authoritative; the folder
//!   name is only a fast path. Discovery tries `.stage/<current-branch>/`, then
//!   scans folders for a `head_ref` match. A confirmed branch rename re-syncs the
//!   folder name **and** the field ([`resync_folder`]).
//! - **Scoped commits (#59 / "scoped auto-commit guarantee"):** [`scoped_commit`]
//!   stages and commits **only** `.stage/<branch>/…`; the user's code and the
//!   rest of their index are never touched. (Push / PR creation is milestone D —
//!   A provides the commit primitive + tests.)
//!
//! This module only defines the on-disk format and container. Composing and
//! curating steps + intros is milestone B; anything touching `gh` or the network
//! is milestone C/D.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::StageError;

/// The Review folder root, relative to the repo working tree.
const STAGE_DIR: &str = ".stage";
/// The metadata file inside each Review folder.
const REVIEW_TOML: &str = "review.toml";
/// The steps subdirectory inside each Review folder.
const STEPS_DIR: &str = "steps";

/// `review.toml` — the Review's metadata. `head_ref` is the authoritative
/// identity (the folder name is a derived fast path); `pr_number` is set at
/// publish (milestone D) and omitted from the file until then.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewMeta {
    /// Human-readable Review title (WS-3, #61). Independent of the branch name
    /// and of the GitHub PR title — no auto-sync.
    pub title: String,
    /// Branch the change is composed against (GAP-2, #92), e.g. `"origin/main"`.
    pub base_ref: String,
    /// The Review's authoritative identity: the feature branch it rides on.
    pub head_ref: String,
    /// The GitHub PR number once published; `None` (and absent from the file)
    /// pre-publish. Powers reviewer-from-PR lookup (#93/#105) later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u32>,
}

/// One step file: `steps/<order>_<slug>.md`. The TOML frontmatter carries the
/// diff `anchor` and an optional `title`; the markdown body is the `intro`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewStep {
    /// Presentation order — the numeric filename prefix (`010` -> `10`).
    pub order: u32,
    /// Filename slug after the order prefix (`010_rename-foo.md` -> `rename-foo`).
    pub slug: String,
    /// Repo-relative path of the diff location this step is anchored to.
    pub anchor: String,
    /// Optional step heading, distinct from the intro body.
    pub title: Option<String>,
    /// The step intro: the raw markdown body after the frontmatter fence.
    pub intro: String,
}

/// A fully-read Review folder: its metadata plus its steps in presentation order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageReview {
    pub meta: ReviewMeta,
    /// Steps sorted ascending by [`ReviewStep::order`].
    pub steps: Vec<ReviewStep>,
}

/// The serde shape of a step file's `+++ … +++` TOML frontmatter.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StepFrontmatter {
    anchor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

/// `repo_root/.stage` — the Review-folder root for a working tree.
pub fn stage_root(repo_root: &Path) -> PathBuf {
    repo_root.join(STAGE_DIR)
}

/// The fast-path folder for `branch`: `.stage/<sanitized-branch>`. Authoritative
/// identity is still `head_ref` in `review.toml` — this is only the lookup
/// shortcut and the rename target.
pub fn review_dir(repo_root: &Path, branch: &str) -> Result<PathBuf, StageError> {
    Ok(stage_root(repo_root).join(folder_name_for_branch(branch)?))
}

/// Map a branch name to a single, filesystem-safe folder component: any
/// character outside `[A-Za-z0-9._-]` (notably `/` in `feat/x`) becomes `-`.
/// The folder name is a fast path only; `head_ref` disambiguates collisions on
/// read, and [`write_review`] fails loud if two distinct branches would clobber
/// one folder.
fn folder_name_for_branch(branch: &str) -> Result<String, StageError> {
    let name: String = branch
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if name.is_empty() || name == "." || name == ".." {
        return Err(StageError::Invalid(format!(
            "branch {branch:?} has no usable .stage folder name"
        )));
    }
    Ok(name)
}

/// Read the Review folder at `dir` (`<dir>/review.toml` + `<dir>/steps/*.md`).
/// A missing `review.toml` is a malformed folder and fails loud; a missing
/// `steps/` directory is fine (a Review with no steps yet). Steps are returned
/// in ascending `order`.
pub fn read_review_at(dir: &Path) -> Result<StageReview, StageError> {
    let meta_path = dir.join(REVIEW_TOML);
    let meta_raw = std::fs::read_to_string(&meta_path).map_err(|e| {
        tracing::error!(err = %e, path = %meta_path.display(), "review_toml_read_failed");
        StageError::Io(e)
    })?;
    let meta: ReviewMeta = toml::from_str(&meta_raw).map_err(|e| {
        tracing::error!(err = %e, path = %meta_path.display(), "review_toml_parse_failed");
        StageError::Invalid(format!("{}: {e}", meta_path.display()))
    })?;

    let mut steps = read_steps(&dir.join(STEPS_DIR))?;
    steps.sort_by_key(|s| s.order);
    Ok(StageReview { meta, steps })
}

/// Read and parse every `steps/<order>_<slug>.md`. An absent directory yields no
/// steps; a malformed filename or frontmatter fails loud.
fn read_steps(steps_dir: &Path) -> Result<Vec<ReviewStep>, StageError> {
    let entries = match std::fs::read_dir(steps_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            tracing::error!(err = %e, path = %steps_dir.display(), "steps_dir_read_failed");
            return Err(StageError::Io(e));
        }
    };

    let mut steps = Vec::new();
    for entry in entries {
        let entry = entry.map_err(StageError::Io)?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        // Only `*.md` step files; ignore anything else (e.g. a stray `.DS_Store`).
        if !name.ends_with(".md") {
            continue;
        }
        let (order, slug) = parse_step_filename(name)?;
        let raw = std::fs::read_to_string(&path).map_err(StageError::Io)?;
        let (anchor, title, intro) = parse_step_body(&raw, name)?;
        steps.push(ReviewStep {
            order,
            slug,
            anchor,
            title,
            intro,
        });
    }
    Ok(steps)
}

/// `010_rename-foo.md` -> `(10, "rename-foo")`. The prefix before the first `_`
/// must be all ASCII digits; the slug may itself contain `_`. Fails loud on a
/// filename that doesn't match.
fn parse_step_filename(name: &str) -> Result<(u32, String), StageError> {
    let stem = name
        .strip_suffix(".md")
        .ok_or_else(|| StageError::Invalid(format!("step file {name:?} is not a .md file")))?;
    let (prefix, slug) = stem.split_once('_').ok_or_else(|| {
        StageError::Invalid(format!(
            "step file {name:?} must be <order>_<slug>.md (missing '_')"
        ))
    })?;
    let order: u32 = prefix.parse().map_err(|_| {
        StageError::Invalid(format!(
            "step file {name:?}: order prefix {prefix:?} is not a number"
        ))
    })?;
    Ok((order, slug.to_string()))
}

/// Split a step file into `(anchor, title, intro)`. Format:
/// ```text
/// +++
/// anchor = "..."
/// title = "..."   # optional
/// +++
/// markdown intro body
/// ```
/// The closing `+++` must be on its own line. [`write_review`] appends exactly
/// one trailing newline after the intro, which is stripped here, so the intro
/// round-trips faithfully.
fn parse_step_body(raw: &str, name: &str) -> Result<(String, Option<String>, String), StageError> {
    let rest = raw
        .strip_prefix("+++\n")
        .ok_or_else(|| StageError::Invalid(format!("step {name:?}: missing opening +++ fence")))?;

    // Walk lines (preserving byte offsets) to the closing `+++` line so the
    // frontmatter and body are sliced exactly, never reflowed.
    let mut offset = 0usize;
    let mut fence: Option<usize> = None;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.strip_suffix('\n').unwrap_or(line);
        if trimmed == "+++" {
            fence = Some(offset);
            break;
        }
        offset += line.len();
    }
    let fence = fence.ok_or_else(|| {
        tracing::error!(name = %name, "step_missing_closing_fence");
        StageError::Invalid(format!("step {name:?}: missing closing +++ fence"))
    })?;

    let frontmatter = &rest[..fence];
    // Body starts after the fence line and its newline.
    let after_fence = &rest[fence..];
    let body = after_fence.split_once('\n').map(|(_, b)| b).unwrap_or("");
    let intro = body.strip_suffix('\n').unwrap_or(body).to_string();

    let front: StepFrontmatter = toml::from_str(frontmatter).map_err(|e| {
        tracing::error!(err = %e, name = %name, "step_frontmatter_parse_failed");
        StageError::Invalid(format!("step {name:?} frontmatter: {e}"))
    })?;
    Ok((front.anchor, front.title, intro))
}

/// Discover the Review for `branch` (WS-1, #59): the `head_ref` field is
/// authoritative and the folder name is a fast path.
///
/// 1. Try `.stage/<branch>/` and accept it only if its `head_ref` matches.
/// 2. Otherwise scan every folder under `.stage/` for a `head_ref` match (the
///    post-rename / pre-resync case).
/// 3. No match -> `None` (no Review yet for this branch).
///
/// Returns the folder path alongside the parsed Review.
pub fn find_review(
    repo_root: &Path,
    branch: &str,
) -> Result<Option<(PathBuf, StageReview)>, StageError> {
    // Fast path: the folder named for this branch, but only if its authoritative
    // head_ref agrees (a sanitized-name collision must fall through to the scan).
    let fast = review_dir(repo_root, branch)?;
    if fast.join(REVIEW_TOML).is_file() {
        let review = read_review_at(&fast)?;
        if review.meta.head_ref == branch {
            return Ok(Some((fast, review)));
        }
    }

    // Scan: head_ref is the source of truth, so a stale/renamed folder name is
    // still found here.
    let root = stage_root(repo_root);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            tracing::error!(err = %e, path = %root.display(), "stage_root_read_failed");
            return Err(StageError::Io(e));
        }
    };
    for entry in entries {
        let entry = entry.map_err(StageError::Io)?;
        let dir = entry.path();
        if !dir.join(REVIEW_TOML).is_file() {
            continue;
        }
        let review = read_review_at(&dir)?;
        if review.meta.head_ref == branch {
            return Ok(Some((dir, review)));
        }
    }
    Ok(None)
}

/// Read the committed Review for `branch` straight from a git `root_tree` — the
/// reviewer-entry read path (ADR-0022 §6, milestone F). The reviewer fetches the
/// PR head and reads its `.stage/<branch>/` **from the committed tree, never the
/// working dir**, so the storyline renders with **no checkout and no
/// working-tree mutation** (the read-only invariant). Mirrors [`find_review`]'s
/// fast-path-then-`head_ref`-scan discovery, but over a `git2::Tree`.
///
/// Returns `None` when the head carries no `.stage` (a plain PR) or no folder's
/// authoritative `head_ref` matches `branch`. A malformed `review.toml`/step file
/// fails loud, exactly as the on-disk [`read_review_at`] does — never a silent
/// empty Review.
pub fn read_review_from_tree(
    repo: &git2::Repository,
    root_tree: &git2::Tree,
    branch: &str,
) -> Result<Option<StageReview>, StageError> {
    // The `.stage` subtree; absent → no committed Review (a plain PR).
    let Some(stage_tree) = child_tree(repo, root_tree, STAGE_DIR)? else {
        return Ok(None);
    };

    // Fast path: the folder named for this branch, accepted only if its
    // authoritative head_ref agrees (a sanitized-name collision falls through).
    let fast_name = folder_name_for_branch(branch)?;
    if let Some(review) = read_review_folder_from_tree(repo, &stage_tree, &fast_name)? {
        if review.meta.head_ref == branch {
            return Ok(Some(review));
        }
    }

    // Scan: head_ref is the source of truth, so a stale/renamed folder name is
    // still found here.
    for entry in stage_tree.iter() {
        if entry.kind() != Some(git2::ObjectType::Tree) {
            continue; // only review folders are subtrees
        }
        let Some(name) = entry.name() else {
            continue;
        };
        if name == fast_name {
            continue; // already tried on the fast path
        }
        if let Some(review) = read_review_folder_from_tree(repo, &stage_tree, name)? {
            if review.meta.head_ref == branch {
                return Ok(Some(review));
            }
        }
    }
    Ok(None)
}

/// Read one `.stage/<folder>/` Review folder from a git tree. `None` when the
/// named folder is absent or has no `review.toml` (not a Review folder).
fn read_review_folder_from_tree(
    repo: &git2::Repository,
    stage_tree: &git2::Tree,
    folder_name: &str,
) -> Result<Option<StageReview>, StageError> {
    let Some(folder_tree) = child_tree(repo, stage_tree, folder_name)? else {
        return Ok(None);
    };
    let Some(meta_raw) = blob_string(repo, &folder_tree, REVIEW_TOML)? else {
        return Ok(None);
    };
    let meta: ReviewMeta = toml::from_str(&meta_raw).map_err(|e| {
        tracing::error!(err = %e, folder = %folder_name, "review_toml_tree_parse_failed");
        StageError::Invalid(format!(".stage/{folder_name}/{REVIEW_TOML}: {e}"))
    })?;

    let mut steps = Vec::new();
    if let Some(steps_tree) = child_tree(repo, &folder_tree, STEPS_DIR)? {
        for entry in steps_tree.iter() {
            let Some(name) = entry.name() else {
                continue;
            };
            if !name.ends_with(".md") {
                continue;
            }
            let (order, slug) = parse_step_filename(name)?;
            let raw = blob_string(repo, &steps_tree, name)?.ok_or_else(|| {
                StageError::Invalid(format!(
                    ".stage/{folder_name}/{STEPS_DIR}/{name} is not a file"
                ))
            })?;
            let (anchor, title, intro) = parse_step_body(&raw, name)?;
            steps.push(ReviewStep {
                order,
                slug,
                anchor,
                title,
                intro,
            });
        }
    }
    steps.sort_by_key(|s| s.order);
    Ok(Some(StageReview { meta, steps }))
}

/// The child subtree named `name` under `tree`, or `None` if absent or not a
/// tree (a blob with that name). Read-only tree navigation for the reviewer
/// entry.
fn child_tree<'r>(
    repo: &'r git2::Repository,
    tree: &git2::Tree,
    name: &str,
) -> Result<Option<git2::Tree<'r>>, StageError> {
    let Some(entry) = tree.get_name(name) else {
        return Ok(None);
    };
    if entry.kind() != Some(git2::ObjectType::Tree) {
        return Ok(None);
    }
    let obj = entry.to_object(repo)?;
    let tree = obj
        .into_tree()
        .map_err(|_| StageError::Invalid(format!("{name} is not a tree")))?;
    Ok(Some(tree))
}

/// The UTF-8 contents of the blob named `name` under `tree`, or `None` if absent.
/// `None` is also returned for a non-blob entry (a subtree with that name).
fn blob_string(
    repo: &git2::Repository,
    tree: &git2::Tree,
    name: &str,
) -> Result<Option<String>, StageError> {
    let Some(entry) = tree.get_name(name) else {
        return Ok(None);
    };
    let obj = entry.to_object(repo)?;
    let Some(blob) = obj.as_blob() else {
        return Ok(None);
    };
    Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
}

/// Is the PR on `branch` **Stage-guided** (DB-2 #85)? `true` when a committed
/// `.stage/<branch>/review.toml` exists in the git *tree* at the branch's head.
///
/// Reads the committed tree, never the working dir, so it answers for any
/// fetched ref without a checkout — the dashboard's checkout-free "Stage vs.
/// plain PR" probe. Candidate refs are tried in order: the local branch, then
/// its `origin/<branch>` remote-tracking copy.
///
/// If neither resolves in this clone (e.g. an un-fetched reviewer branch) the
/// answer is `Ok(false)`: from local data we simply cannot see a Review, which
/// is the honest "plain as far as we can tell" result and respects the user's
/// real local access (DB-4 #87) — it is a derived signal over available refs,
/// not a swallowed error. A genuine tree-read failure on a *resolved* ref
/// propagates (fail loud).
pub fn review_committed_for_branch(repo_root: &Path, branch: &str) -> Result<bool, StageError> {
    let repo = git2::Repository::discover(repo_root)?;
    let rel = format!(
        "{STAGE_DIR}/{}/{REVIEW_TOML}",
        folder_name_for_branch(branch)?
    );
    let rel_path = Path::new(&rel);
    for candidate in [branch.to_string(), format!("origin/{branch}")] {
        // A ref absent from this clone isn't an error — try the next candidate.
        let Ok(obj) = repo.revparse_single(&candidate) else {
            continue;
        };
        let tree = obj.peel_to_tree()?;
        match tree.get_path(rel_path) {
            Ok(_) => return Ok(true),
            Err(e) if e.code() == git2::ErrorCode::NotFound => continue,
            Err(e) => return Err(StageError::Git(e)),
        }
    }
    Ok(false)
}

/// Write `review` to `.stage/<head_ref>/` (folder derived from the authoritative
/// `head_ref`). Creates the folder, writes `review.toml`, and rewrites `steps/`
/// wholesale so a removed step drops its file. Returns the folder path.
///
/// Fails loud if the target folder already holds a Review for a **different**
/// `head_ref` (two branches sanitized to the same folder name) — a silent
/// clobber would lose the other branch's material.
pub fn write_review(repo_root: &Path, review: &StageReview) -> Result<PathBuf, StageError> {
    let dir = review_dir(repo_root, &review.meta.head_ref)?;

    if dir.join(REVIEW_TOML).is_file() {
        let existing = read_review_at(&dir)?;
        if existing.meta.head_ref != review.meta.head_ref {
            tracing::error!(
                target_dir = %dir.display(),
                existing_head_ref = %existing.meta.head_ref,
                new_head_ref = %review.meta.head_ref,
                "review_folder_collision"
            );
            return Err(StageError::Invalid(format!(
                "{} already holds the Review for {:?}; refusing to overwrite with {:?}",
                dir.display(),
                existing.meta.head_ref,
                review.meta.head_ref
            )));
        }
    }

    std::fs::create_dir_all(&dir).map_err(StageError::Io)?;

    let meta_toml = toml::to_string(&review.meta)
        .map_err(|e| StageError::Invalid(format!("encoding review.toml: {e}")))?;
    std::fs::write(dir.join(REVIEW_TOML), meta_toml).map_err(StageError::Io)?;

    // Rewrite steps/ from scratch so removed steps drop their files.
    let steps_dir = dir.join(STEPS_DIR);
    match std::fs::remove_dir_all(&steps_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(StageError::Io(e)),
    }
    if !review.steps.is_empty() {
        std::fs::create_dir_all(&steps_dir).map_err(StageError::Io)?;
        for step in &review.steps {
            let front = StepFrontmatter {
                anchor: step.anchor.clone(),
                title: step.title.clone(),
            };
            let fm = toml::to_string(&front)
                .map_err(|e| StageError::Invalid(format!("encoding step frontmatter: {e}")))?;
            // `fm` already ends in a newline; one trailing newline after the
            // intro is stripped on read (see `parse_step_body`).
            let contents = format!("+++\n{fm}+++\n{}\n", step.intro);
            let filename = format!("{:03}_{}.md", step.order, step.slug);
            std::fs::write(steps_dir.join(filename), contents).map_err(StageError::Io)?;
        }
    }

    Ok(dir)
}

/// Re-sync a Review to a renamed branch (WS-1, #59): find the Review currently
/// stored for `old_branch`, move its folder to `.stage/<new_branch>/`, and set
/// its authoritative `head_ref` to `new_branch`. Returns the new folder, or
/// `None` if no Review exists for `old_branch`.
///
/// Fails loud if a *different* Review already occupies the new folder.
pub fn resync_folder(
    repo_root: &Path,
    old_branch: &str,
    new_branch: &str,
) -> Result<Option<PathBuf>, StageError> {
    let Some((old_dir, mut review)) = find_review(repo_root, old_branch)? else {
        return Ok(None);
    };
    review.meta.head_ref = new_branch.to_string();
    // write_review targets the folder for new_branch and guards against
    // clobbering a different Review there.
    let new_dir = write_review(repo_root, &review)?;
    if old_dir != new_dir {
        std::fs::remove_dir_all(&old_dir).map_err(StageError::Io)?;
    }
    Ok(Some(new_dir))
}

/// Commit **only** `.stage/<branch>/…` and nothing else (ADR-0019 §1, the scoped
/// auto-commit guarantee). Stages just that pathspec, then makes a partial commit
/// of just that pathspec; the user's code changes and the rest of their index
/// are left exactly as they were. Returns the new commit's full SHA.
///
/// The commit is attributed to the repo's configured git identity (ADR-0019 §5);
/// a missing identity surfaces as git's own loud error.
pub fn scoped_commit(repo_root: &Path, branch: &str, message: &str) -> Result<String, StageError> {
    let folder = format!("{STAGE_DIR}/{}", folder_name_for_branch(branch)?);
    // Stage exactly the Review folder: new, modified, and deleted files within
    // it — and nothing outside it.
    run_git(repo_root, &["add", "--", &folder])?;
    // Partial commit: a pathspec on `git commit` implies `--only`, so any other
    // staged changes are excluded from the commit and left staged.
    run_git(repo_root, &["commit", "-m", message, "--", &folder])?;
    let head = run_git(repo_root, &["rev-parse", "HEAD"])?;
    Ok(head.trim().to_string())
}

/// Run `git -C <repo_root> <args>`; fail loud (log + surface git's stderr) on a
/// non-zero exit. Returns stdout.
fn run_git(repo_root: &Path, args: &[&str]) -> Result<String, StageError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(args)
        .output()
        .map_err(StageError::Io)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        tracing::error!(args = ?args, stderr = %msg, "git_cli_failed");
        return Err(StageError::GitCli(if msg.is_empty() {
            format!("git {args:?} failed")
        } else {
            msg.to_string()
        }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    /// A repo with one commit and a configured identity, ready for scoped commits.
    fn repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "t@e.com"]);
        git(dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("code.rs"), "orig\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }

    fn sample(head_ref: &str) -> StageReview {
        StageReview {
            meta: ReviewMeta {
                title: "Rename Workspace to Review".into(),
                base_ref: "origin/main".into(),
                head_ref: head_ref.into(),
                pr_number: None,
            },
            steps: vec![
                ReviewStep {
                    order: 10,
                    slug: "rename-domain".into(),
                    anchor: "src/domain.rs".into(),
                    title: Some("Rename the type".into()),
                    intro: "Renamed `Workspace` to `Review`.\n\nCascaded fields.".into(),
                },
                ReviewStep {
                    order: 20,
                    slug: "update-store".into(),
                    anchor: "src/store.rs".into(),
                    title: None,
                    intro: "Added the draft table.".into(),
                },
            ],
        }
    }

    #[test]
    fn review_toml_and_steps_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let review = sample("feat/x");

        let dir = write_review(root, &review).unwrap();
        assert_eq!(dir, root.join(".stage").join("feat-x"));
        // Pre-publish: no PR number, so review.toml omits the key entirely.
        let raw = std::fs::read_to_string(dir.join("review.toml")).unwrap();
        assert!(
            !raw.contains("pr_number"),
            "pre-publish toml must omit pr_number"
        );

        let back = read_review_at(&dir).unwrap();
        assert_eq!(back, review, "Review must round-trip exactly");
        // Filenames are zero-padded numeric prefixes.
        assert!(dir.join("steps/010_rename-domain.md").is_file());
        assert!(dir.join("steps/020_update-store.md").is_file());
    }

    #[test]
    fn steps_are_returned_in_order_regardless_of_read_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut review = sample("feat/x");
        // Reverse the in-memory order; read must re-sort by the numeric prefix.
        review.steps.reverse();
        let dir = write_review(root, &review).unwrap();

        let back = read_review_at(&dir).unwrap();
        assert_eq!(
            back.steps.iter().map(|s| s.order).collect::<Vec<_>>(),
            vec![10, 20]
        );
    }

    #[test]
    fn pr_number_persists_when_set() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut review = sample("feat/x");
        review.meta.pr_number = Some(42);
        let dir = write_review(root, &review).unwrap();
        let raw = std::fs::read_to_string(dir.join("review.toml")).unwrap();
        assert!(raw.contains("pr_number = 42"));
        assert_eq!(read_review_at(&dir).unwrap().meta.pr_number, Some(42));
    }

    #[test]
    fn rewrite_drops_removed_step_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let review = sample("feat/x");
        let dir = write_review(root, &review).unwrap();
        assert!(dir.join("steps/020_update-store.md").is_file());

        // Re-write with only the first step: the second file must be gone.
        let mut trimmed = review.clone();
        trimmed.steps.truncate(1);
        write_review(root, &trimmed).unwrap();
        assert!(dir.join("steps/010_rename-domain.md").is_file());
        assert!(!dir.join("steps/020_update-store.md").is_file());
        assert_eq!(read_review_at(&dir).unwrap().steps.len(), 1);
    }

    #[test]
    fn find_review_fast_path_then_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_review(root, &sample("feat/x")).unwrap();

        // Fast path: folder named for the branch.
        let (dir, review) = find_review(root, "feat/x")
            .unwrap()
            .expect("found by fast path");
        assert_eq!(dir, root.join(".stage").join("feat-x"));
        assert_eq!(review.meta.head_ref, "feat/x");

        // A branch with no Review -> None.
        assert!(find_review(root, "other").unwrap().is_none());
    }

    #[test]
    fn find_review_by_head_ref_when_folder_name_mismatches() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Hand-place a Review under a folder whose name does NOT match its branch,
        // simulating a stale/renamed folder. head_ref is authoritative.
        let dir = stage_root(root).join("legacy-folder");
        std::fs::create_dir_all(dir.join("steps")).unwrap();
        std::fs::write(
            dir.join("review.toml"),
            "title = \"X\"\nbase_ref = \"origin/main\"\nhead_ref = \"feat/real\"\n",
        )
        .unwrap();

        let (found, review) = find_review(root, "feat/real")
            .unwrap()
            .expect("found by head_ref scan");
        assert_eq!(found, dir);
        assert_eq!(review.meta.head_ref, "feat/real");
    }

    #[test]
    fn resync_folder_moves_folder_and_updates_head_ref() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_review(root, &sample("feat/x")).unwrap();

        // Rename feat/x -> feat/y.
        let new_dir = resync_folder(root, "feat/x", "feat/y")
            .unwrap()
            .expect("resynced");
        assert_eq!(new_dir, root.join(".stage").join("feat-y"));

        // Old folder is gone; the change is not lost or detached (WS-1).
        assert!(!root.join(".stage").join("feat-x").exists());
        // Reopening under the new branch surfaces the same material.
        let (_, review) = find_review(root, "feat/y")
            .unwrap()
            .expect("found under new name");
        assert_eq!(review.meta.head_ref, "feat/y");
        assert_eq!(review.meta.title, "Rename Workspace to Review");
        assert_eq!(review.steps.len(), 2);
        // The old branch no longer resolves.
        assert!(find_review(root, "feat/x").unwrap().is_none());

        // Re-syncing a branch with no Review is a no-op None, not an error.
        assert!(resync_folder(root, "ghost", "whatever").unwrap().is_none());
    }

    #[test]
    fn scoped_commit_touches_only_the_stage_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        repo(root);

        // The user has an unrelated, *staged* code change in flight.
        std::fs::write(root.join("code.rs"), "USER EDIT\n").unwrap();
        git(root, &["add", "code.rs"]);

        // Write the Review and commit ONLY it.
        write_review(root, &sample("feat/x")).unwrap();
        let sha = scoped_commit(root, "feat/x", "stage: publish review").unwrap();
        assert_eq!(sha.len(), 40, "rev-parse HEAD returns a full SHA");

        // The commit contains only .stage/ paths — never code.rs.
        let files = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["show", "--name-only", "--format=", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert!(files.contains(".stage/feat-x/review.toml"), "got: {files}");
        assert!(
            !files.contains("code.rs"),
            "scoped commit must not include the user's code: {files}"
        );

        // The user's staged code change is still staged and intact.
        let staged = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["diff", "--cached", "--name-only"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert_eq!(staged.trim(), "code.rs");
        assert_eq!(
            std::fs::read_to_string(root.join("code.rs")).unwrap(),
            "USER EDIT\n"
        );
    }

    #[test]
    fn write_review_refuses_to_clobber_a_different_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // `feat/x` and `feat-x` sanitize to the same folder name.
        write_review(root, &sample("feat/x")).unwrap();
        let mut other = sample("feat-x");
        other.meta.head_ref = "feat-x".into();
        let err = write_review(root, &other).unwrap_err();
        assert!(err.to_string().contains("refusing to overwrite"), "{err}");
    }

    #[test]
    fn malformed_step_files_fail_loud() {
        assert!(parse_step_filename("nodigits_x.md").is_err());
        assert!(parse_step_filename("010-no-underscore.md").is_err());
        assert!(parse_step_body("no fence here\n", "010_x.md").is_err());
        assert!(parse_step_body("+++\nanchor = \"a\"\nno closing fence\n", "010_x.md").is_err());
        // Missing required `anchor` key in frontmatter.
        assert!(parse_step_body("+++\ntitle = \"t\"\n+++\nbody\n", "010_x.md").is_err());
    }

    #[test]
    fn review_committed_for_branch_detects_stage_guided_head() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        repo(root); // one commit on `main`, identity configured

        // A branch whose committed tree carries `.stage/feat-x/review.toml`.
        git(root, &["checkout", "-q", "-b", "feat/x"]);
        write_review(root, &sample("feat/x")).unwrap();
        scoped_commit(root, "feat/x", "stage: publish review").unwrap();
        assert!(
            review_committed_for_branch(root, "feat/x").unwrap(),
            "a committed .stage/<branch>/ makes the head Stage-guided"
        );

        // A plain branch — code change, no `.stage` in its tree → not guided.
        git(root, &["checkout", "-q", "main"]);
        git(root, &["checkout", "-q", "-b", "feat/plain"]);
        std::fs::write(root.join("code.rs"), "plain change\n").unwrap();
        git(root, &["add", "code.rs"]);
        git(root, &["commit", "-q", "-m", "plain change"]);
        assert!(!review_committed_for_branch(root, "feat/plain").unwrap());

        // A branch absent from this clone → not detectable, `Ok(false)` (no error).
        assert!(!review_committed_for_branch(root, "feat/never-fetched").unwrap());
    }

    #[test]
    fn read_review_from_tree_reads_committed_stage_without_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        repo(root); // one commit on `main`, identity configured

        // Commit a Review on feat/x.
        git(root, &["checkout", "-q", "-b", "feat/x"]);
        write_review(root, &sample("feat/x")).unwrap();
        scoped_commit(root, "feat/x", "stage: publish review").unwrap();

        // Move back to main: the working tree no longer holds `.stage/feat-x/`.
        git(root, &["checkout", "-q", "main"]);
        assert!(
            !root.join(".stage").join("feat-x").exists(),
            "precondition: feat/x's .stage is not in the working tree"
        );

        // Read the Review straight from feat/x's committed tree — no checkout.
        let repo = git2::Repository::open(root).unwrap();
        let tree = repo
            .revparse_single("feat/x")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        let review = read_review_from_tree(&repo, &tree, "feat/x")
            .unwrap()
            .expect("committed .stage read from the tree");
        assert_eq!(review.meta.head_ref, "feat/x");
        assert_eq!(review.meta.title, "Rename Workspace to Review");
        // Steps come back in order, fully parsed (frontmatter + intro body).
        assert_eq!(review.steps.len(), 2);
        assert_eq!(review.steps[0].order, 10);
        assert_eq!(review.steps[0].anchor, "src/domain.rs");
        assert_eq!(review.steps[0].title.as_deref(), Some("Rename the type"));
        assert!(review.steps[0].intro.contains("Renamed `Workspace`"));
        assert_eq!(review.steps[1].order, 20);
        assert_eq!(review.steps[1].anchor, "src/store.rs");

        // A plain head (no `.stage` in its tree) → None, not an error.
        git(root, &["checkout", "-q", "-b", "feat/plain"]);
        std::fs::write(root.join("plain.rs"), "fn p() {}\n").unwrap();
        git(root, &["add", "plain.rs"]);
        git(root, &["commit", "-q", "-m", "plain"]);
        let plain_tree = repo
            .revparse_single("feat/plain")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        assert!(read_review_from_tree(&repo, &plain_tree, "feat/plain")
            .unwrap()
            .is_none());

        // A head that carries a `.stage` but not for the asked branch → None
        // (head_ref is authoritative). feat/x's tree has only feat-x's folder.
        assert!(read_review_from_tree(&repo, &tree, "feat/other")
            .unwrap()
            .is_none());
    }
}
