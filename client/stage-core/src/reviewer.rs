//! Reviewer entry — open a PR's review **fully local and read-only by default**
//! (ADR-0022 §6, milestone F: GAP-3 #93, SL-4 reviewer side, GAP-5 #105).
//!
//! The guaranteed discovery path is the copy-paste `stage open <pr-url>` command
//! from the auto-posted PR comment (milestone D). From there the flow is:
//!
//! 1. [`parse_pr_ref`] — turn the PR URL (or `owner/name#n` shorthand) into a
//!    [`PrRef`].
//! 2. [`resolve_clone`] — find a local clone whose **`origin` matches** the PR's
//!    `owner/name`. No match → a loud, actionable error (no silent fallback).
//! 3. [`open_review`] — resolve the PR via `gh`, `git fetch` its head
//!    ([`GitHub::fetch_pr_head`]), and render the **tree-to-tree** committed diff
//!    (ADR-0018) plus the author's storyline read straight from the committed
//!    `.stage/<branch>/` ([`read_review_from_tree`]). **No working-tree
//!    mutation**: nothing is checked out, the diff and storyline come from git
//!    trees, and the storyline is presented as a guided overlay over the full
//!    diff (un-anchored files stay reachable, mirroring the author preview).
//!
//! The one exception to read-only is [`checkout_pr_branch`] — a **user-confirmed
//! "Check out this branch"** action for a reviewer who wants to build/run. It
//! narrowly amends ADR-0016's observe-only stance and must only be reached on
//! explicit confirmation in the UI.
//!
//! **Fail loud (CLAUDE.md):** an unparseable ref, no matching clone, a `gh`
//! failure, or a missing PR head all surface a complete, user-facing message
//! (logged with context). Nothing defaults to an empty render.
//!
//! **Rust computes, TS renders (ADR-0022 §7):** [`open_review`] returns a
//! view-ready [`ReviewerEntry`] (the storyline already ordered + stale-flagged,
//! the residue already computed); the webview only renders it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::diff::{committed_diff, CommittedDiff};
use crate::error::StageError;
use crate::github::GitHub;
use crate::repo_key::origin_slug;
use crate::review_folder::{read_review_from_tree, StageReview};

/// A GitHub pull request identity — `owner/name#number`. The reviewer-entry key
/// (and the `OpenMode::Review` open-intent payload, ADR-0022 §6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrRef {
    /// The repository owner (org or user login).
    pub owner: String,
    /// The repository name.
    pub name: String,
    /// The pull request number.
    pub number: u32,
}

/// One storyline step as the reviewer sees it (SL-4 reviewer side): the author's
/// intro + optional title, anchored to a file in the PR's committed diff, with a
/// computed `stale` flag. Sourced from the committed `.stage/<branch>/`, so —
/// unlike the author's [`crate::storyline::StorylineStep`] — there is no
/// store-minted id or timestamps; presentation order is the file's numeric
/// prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewerStep {
    /// Presentation order, ascending (the `NNN_` filename prefix).
    pub order: u32,
    /// Repo-relative path of the file this step walks through. Look its diff up
    /// in [`ReviewerEntry::diff`] by this path.
    pub anchor: String,
    /// Optional step heading, distinct from the anchor path and the intro.
    pub title: Option<String>,
    /// The author-written markdown intro for this step.
    pub intro: String,
    /// `true` when `anchor` is **no longer** a file in the PR diff (the file left
    /// the change since the step was written) — shown but flagged, never a silent
    /// empty diff. Mirrors the author-side **Stale step** (ADR-0012).
    pub stale: bool,
}

/// The PR context the reviewer header renders (resolved once via `gh`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewerPr {
    /// The PR number.
    pub number: u32,
    /// The PR title.
    pub title: String,
    /// The PR's URL on github.com.
    pub url: String,
    /// `OPEN` / `CLOSED` / `MERGED`, verbatim from `gh`.
    pub state: String,
    /// Whether the PR is a draft.
    pub is_draft: bool,
    /// The base branch the PR merges into (e.g. `main`).
    pub base_ref: String,
    /// The PR head branch — the storyline's authoritative identity and the
    /// branch [`checkout_pr_branch`] would check out.
    pub head_ref: String,
    /// The PR author's GitHub login.
    pub author_login: String,
}

/// The view-ready reviewer entry (ADR-0022 §6/§7): the PR context, the full
/// tree-to-tree committed diff, the author's storyline as a guided overlay, and
/// the residue of un-anchored diff files still reachable. Assembled entirely in
/// Rust; the webview only renders it.
// `CommittedDiff` derives only `Serialize`/`TS`, so this output-only DTO can't
// derive `Debug`/`Clone`/`PartialEq` without propagating them to the diff type.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewerEntry {
    /// The PR context (header).
    pub pr: ReviewerPr,
    /// The full committed diff (`merge_base(base, head) → head`) — exactly what
    /// the PR contains, and the overlay base every step/file renders from.
    pub diff: CommittedDiff,
    /// The author's storyline in their order, each step `stale`-flagged. Empty
    /// for a plain (non-Stage-guided) PR.
    pub steps: Vec<ReviewerStep>,
    /// Repo-relative diff paths **no** step anchors — the changes outside the
    /// guided storyline, still browsable (GAP-4). The whole diff when there is no
    /// storyline.
    pub unstoried: Vec<String>,
    /// `true` when the PR head carries a committed `.stage/<branch>/` Review — a
    /// Stage-guided PR — vs. a plain PR rendered as a read-only diff (DB-2 #85).
    pub stage_guided: bool,
}

/// Parse a GitHub pull-request reference: a PR **URL**
/// (`https://github.com/owner/repo/pull/123`, with optional trailing path,
/// query, or fragment) or the `owner/repo#123` **shorthand**. Fail loud
/// (CLAUDE.md) on anything else — the discovery path hands the user a real PR
/// URL, so an unparseable input is a clear, actionable error, never a guess.
pub fn parse_pr_ref(input: &str) -> Result<PrRef, StageError> {
    let s = input.trim();
    if let Some(pr) = parse_pr_url(s) {
        return Ok(pr);
    }
    if let Some(pr) = parse_pr_shorthand(s) {
        return Ok(pr);
    }
    tracing::error!(input = %s, "reviewer_unparseable_pr_ref");
    Err(StageError::Invalid(format!(
        "{s:?} is not a GitHub pull request reference. Expected a PR URL like \
         https://github.com/owner/repo/pull/123 — copy it from the PR's \
         \u{201c}Open in Stage\u{201d} comment."
    )))
}

/// `.../<host>/<owner>/<name>/pull/<number>[/...]` → [`PrRef`]. Tolerates a
/// missing scheme, a trailing segment (`/files`), and a query/fragment.
fn parse_pr_url(s: &str) -> Option<PrRef> {
    // Drop any query/fragment so `/pull/123#discussion` and `?w=1` still parse.
    let s = s.split(['?', '#']).next().unwrap_or(s);
    // Strip the scheme if present; the first remaining segment is the host.
    let after_scheme = s.split_once("://").map(|(_, rest)| rest).unwrap_or(s);
    let mut segs = after_scheme.split('/').filter(|x| !x.is_empty());
    let _host = segs.next()?; // github.com (or an enterprise host)
    let owner = segs.next()?.to_string();
    let name = segs.next()?.to_string();
    if segs.next()? != "pull" {
        return None;
    }
    let number: u32 = segs.next()?.parse().ok()?;
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(PrRef {
        owner,
        name,
        number,
    })
}

/// `owner/name#number` → [`PrRef`].
fn parse_pr_shorthand(s: &str) -> Option<PrRef> {
    let (repo, num) = s.split_once('#')?;
    let number: u32 = num.parse().ok()?;
    let (owner, name) = repo.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(PrRef {
        owner: owner.to_string(),
        name: name.to_string(),
        number,
    })
}

/// Resolve the PR to a local clone by **`origin` match** (ADR-0022 §6): the first
/// `candidates` entry whose `origin` remote points at `pr.owner/pr.name`. GitHub
/// slugs are case-insensitive, so the match is too.
///
/// No match → a loud, actionable [`StageError::Invalid`] (no silent fallback,
/// per the ADR): Stage reviews are fully local, so the remedy is to clone the
/// repo (or `cd` into an existing clone) and re-run.
pub fn resolve_clone(candidates: &[PathBuf], pr: &PrRef) -> Result<PathBuf, StageError> {
    for root in candidates {
        if let Some((owner, name)) = origin_slug(root)? {
            if owner.eq_ignore_ascii_case(&pr.owner) && name.eq_ignore_ascii_case(&pr.name) {
                return Ok(root.clone());
            }
        }
    }
    tracing::error!(
        owner = %pr.owner,
        name = %pr.name,
        number = pr.number,
        "reviewer_no_local_clone"
    );
    Err(StageError::Invalid(format!(
        "No local clone of {}/{} found to open PR #{}. Stage reviews are fully \
         local: clone the repository (or `cd` into your existing clone of it) \
         and run `stage open` from there.",
        pr.owner, pr.name, pr.number
    )))
}

/// Open `pr` against the resolved local clone at `repo_root`, **read-only**
/// (ADR-0022 §6). Resolves the PR via `gh`, fetches its head + base read-only,
/// computes the tree-to-tree committed diff (ADR-0018), reads the author's
/// storyline from the committed `.stage/<branch>/`, and assembles a view-ready
/// [`ReviewerEntry`]. Performs **no working-tree mutation** — see the module
/// docs; [`checkout_pr_branch`] is the lone, opt-in exception.
///
/// Fail loud: a `gh`/`git` failure or a PR with no resolvable head/base surfaces
/// its real cause; a plain PR (no committed `.stage`) renders as a read-only diff
/// with `stage_guided = false`, which is a real result, not a swallowed error.
pub fn open_review(
    github: &GitHub,
    repo_root: &Path,
    pr: &PrRef,
) -> Result<ReviewerEntry, StageError> {
    let slug = format!("{}/{}", pr.owner, pr.name);
    let number = pr.number.to_string();

    // 1. Resolve PR metadata via gh (the gh auth gate runs lazily here).
    let raw: RawPr = github.run_gh_json(
        &[
            "pr",
            "view",
            &number,
            "--repo",
            &slug,
            "--json",
            "number,title,url,state,isDraft,baseRefName,headRefName,author",
        ],
        None,
    )?;
    if raw.head_ref_name.trim().is_empty() || raw.base_ref_name.trim().is_empty() {
        tracing::error!(slug = %slug, number = pr.number, "reviewer_pr_missing_refs");
        return Err(StageError::GhFailed(format!(
            "GitHub returned no base/head branch for {slug}#{}.",
            pr.number
        )));
    }

    // 2. Fetch the PR head (+ refresh the base) read-only — no working-tree
    //    mutation. The PR's repo is the matched `origin` by construction.
    let head_local_ref =
        github.fetch_pr_head(repo_root, "origin", pr.number, &raw.base_ref_name)?;

    // 3. The tree-to-tree committed diff (ADR-0018): merge_base(base, head) → head.
    let diff = committed_diff(repo_root, &raw.base_ref_name, &head_local_ref)?;

    // 4. Read the author's storyline straight from the fetched head's committed
    //    tree — never a checkout, never the working dir.
    let repo = git2::Repository::open(repo_root)?;
    let head_tree = repo
        .revparse_single(&head_local_ref)?
        .peel_to_commit()?
        .tree()?;
    let review = read_review_from_tree(&repo, &head_tree, &raw.head_ref_name)?;

    // 5. Overlay the storyline on the full diff (mirrors the author preview):
    //    order the steps, flag stale anchors, and compute the un-anchored residue.
    let (steps, unstoried) = assemble_overlay(&diff, review.as_ref());

    Ok(ReviewerEntry {
        pr: ReviewerPr {
            number: raw.number,
            title: raw.title,
            url: raw.url,
            state: raw.state,
            is_draft: raw.is_draft,
            base_ref: raw.base_ref_name,
            head_ref: raw.head_ref_name,
            author_login: raw
                .author
                .map(|a| a.login)
                .unwrap_or_else(|| "ghost".into()),
        },
        diff,
        steps,
        unstoried,
        stage_guided: review.is_some(),
    })
}

/// Order the committed steps, flag each `stale` when its anchor is absent from
/// the diff, and compute the un-anchored diff paths (`unstoried`) preserving diff
/// order — the same overlay semantics as the author preview
/// ([`crate::storyline::assemble_preview`]): a stale step never consumes a diff
/// file, so the residue is exactly the un-anchored changes.
fn assemble_overlay(
    diff: &CommittedDiff,
    review: Option<&StageReview>,
) -> (Vec<ReviewerStep>, Vec<String>) {
    let steps_src = review.map(|r| r.steps.as_slice()).unwrap_or(&[]);

    let diff_paths: HashSet<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
    let anchored: HashSet<&str> = steps_src.iter().map(|s| s.anchor.as_str()).collect();

    let unstoried: Vec<String> = diff
        .files
        .iter()
        .filter(|f| !anchored.contains(f.path.as_str()))
        .map(|f| f.path.clone())
        .collect();

    let steps: Vec<ReviewerStep> = steps_src
        .iter()
        .map(|s| ReviewerStep {
            order: s.order,
            anchor: s.anchor.clone(),
            title: s.title.clone(),
            intro: s.intro.clone(),
            stale: !diff_paths.contains(s.anchor.as_str()),
        })
        .collect();

    (steps, unstoried)
}

/// **The lone working-tree mutation the reviewer flow performs** (ADR-0022 §6,
/// narrowly amending ADR-0016's observe-only stance): check out the PR head as a
/// local branch so the reviewer can build/run. Must only be called on explicit
/// user confirmation ("Check out this branch") — everything else stays
/// read-only. The PR head must already have been fetched by [`open_review`];
/// fail loud (git's stderr verbatim) otherwise or if the working tree is dirty.
pub fn checkout_pr_branch(
    github: &GitHub,
    repo_root: &Path,
    pr: &PrRef,
    branch: &str,
) -> Result<(), StageError> {
    let source = GitHub::pr_head_local_ref(pr.number);
    github.checkout_local_branch(repo_root, branch, &source)
}

/// `gh pr view --json …` projection — only what the reviewer entry renders +
/// needs to fetch/diff. Unknown fields are ignored (serde default).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    number: u32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    author: Option<RawActor>,
}

/// A `{ "login": … }` author object; `null` for a deleted account.
#[derive(Deserialize)]
struct RawActor {
    #[serde(default)]
    login: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    // ---- parse_pr_ref ------------------------------------------------------

    #[test]
    fn parses_pr_urls_and_shorthand() {
        let cases = [
            "https://github.com/octo/Stage/pull/42",
            "https://github.com/octo/Stage/pull/42/files",
            "https://github.com/octo/Stage/pull/42#issuecomment-9",
            "https://github.com/octo/Stage/pull/42?w=1",
            "github.com/octo/Stage/pull/42",
            "octo/Stage#42",
        ];
        for c in cases {
            let pr = parse_pr_ref(c).unwrap_or_else(|e| panic!("parse {c:?}: {e}"));
            assert_eq!(
                pr,
                PrRef {
                    owner: "octo".into(),
                    name: "Stage".into(),
                    number: 42,
                },
                "input={c}"
            );
        }
    }

    #[test]
    fn rejects_non_pr_references_loudly() {
        for bad in [
            "",
            "not a url",
            "https://github.com/octo/Stage", // a repo, no /pull/<n>
            "https://github.com/octo/Stage/pull/abc",
            "octo/Stage", // no #number
            "octo#42",    // no name
            "/Stage#42",  // no owner
            "a/b/c#42",   // name with a slash
        ] {
            assert!(parse_pr_ref(bad).is_err(), "should reject {bad:?}");
        }
    }

    // ---- resolve_clone -----------------------------------------------------

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

    /// An initialized repo at `dir` with `origin` pointing at `url`.
    fn clone_with_origin(dir: &Path, url: &str) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["remote", "add", "origin", url]);
    }

    #[test]
    fn resolve_clone_matches_origin_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let other = tmp.path().join("other");
        let match_ = tmp.path().join("match");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::create_dir_all(&match_).unwrap();
        clone_with_origin(&other, "git@github.com:someone/else.git");
        clone_with_origin(&match_, "https://github.com/Octo/Stage.git");

        let pr = PrRef {
            owner: "octo".into(), // lowercase — must still match `Octo`
            name: "stage".into(),
            number: 7,
        };
        let got = resolve_clone(&[other.clone(), match_.clone()], &pr).unwrap();
        assert_eq!(got, match_);
    }

    #[test]
    fn resolve_clone_no_match_is_a_loud_actionable_error() {
        let tmp = tempfile::tempdir().unwrap();
        let other = tmp.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        clone_with_origin(&other, "git@github.com:someone/else.git");

        let pr = PrRef {
            owner: "octo".into(),
            name: "stage".into(),
            number: 9,
        };
        // Includes a non-repo candidate too — it's skipped, not fatal.
        let bogus = tmp.path().join("not-a-repo");
        std::fs::create_dir_all(&bogus).unwrap();
        let err = resolve_clone(&[bogus, other], &pr).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("octo/stage"), "names the repo: {msg}");
        assert!(msg.contains("#9"), "names the PR: {msg}");
        assert!(msg.contains("clone"), "actionable remedy: {msg}");
    }

    // ---- open_review: end-to-end against a fake gh + real git --------------

    #[cfg(unix)]
    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    /// A fake `gh` that passes the auth gate and answers `pr view … --json …`
    /// with a fixture for PR #1 (base `main`, head `feat/x`).
    #[cfg(unix)]
    fn fake_gh(dir: &Path) -> PathBuf {
        let body = "#!/usr/bin/env bash\n\
             if [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 0; fi\n\
             if [ \"$1\" = pr ] && [ \"$2\" = view ]; then\n\
               echo '{\"number\":1,\"title\":\"Add the thing\",\"url\":\"https://github.com/octo/stage/pull/1\",\"state\":\"OPEN\",\"isDraft\":false,\"baseRefName\":\"main\",\"headRefName\":\"feat/x\",\"author\":{\"login\":\"author\",\"id\":7}}'\n\
               exit 0\n\
             fi\n\
             echo \"fake gh: unhandled: $*\" >&2; exit 1\n";
        write_script(dir, "gh", body)
    }

    /// A bare "origin" carrying `main`, plus a `feat/x` head (committing a code
    /// change **and** a `.stage/feat-x/` storyline) exposed as `refs/pull/1/head`.
    /// Returns a fresh reviewer clone checked out on `main`.
    #[cfg(unix)]
    fn pr_with_stage_remote(base: &Path) -> PathBuf {
        let remote = base.join("remote.git");
        git(base, &["init", "-q", "--bare", remote.to_str().unwrap()]);

        let pubrepo = base.join("publisher");
        std::fs::create_dir_all(&pubrepo).unwrap();
        git(&pubrepo, &["init", "-q", "-b", "main"]);
        git(&pubrepo, &["config", "user.email", "t@e.com"]);
        git(&pubrepo, &["config", "user.name", "t"]);
        std::fs::write(pubrepo.join("base.rs"), "fn base() {}\n").unwrap();
        git(&pubrepo, &["add", "-A"]);
        git(&pubrepo, &["commit", "-q", "-m", "base"]);
        git(
            &pubrepo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&pubrepo, &["push", "-q", "origin", "main"]);

        // The PR head: a code change on `src/foo.rs` + a committed storyline that
        // anchors a step to it (and a stale step anchoring a dropped file).
        git(&pubrepo, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::create_dir_all(pubrepo.join("src")).unwrap();
        std::fs::write(pubrepo.join("src/foo.rs"), "fn foo() {}\n").unwrap();
        let stage = pubrepo.join(".stage/feat-x");
        std::fs::create_dir_all(stage.join("steps")).unwrap();
        std::fs::write(
            stage.join("review.toml"),
            "title = \"Add the thing\"\nbase_ref = \"main\"\nhead_ref = \"feat/x\"\n",
        )
        .unwrap();
        std::fs::write(
            stage.join("steps/010_foo.md"),
            "+++\nanchor = \"src/foo.rs\"\ntitle = \"The foo\"\n+++\nWalks through foo.\n",
        )
        .unwrap();
        std::fs::write(
            stage.join("steps/020_gone.md"),
            "+++\nanchor = \"src/gone.rs\"\n+++\nThis file left the diff.\n",
        )
        .unwrap();
        git(&pubrepo, &["add", "-A"]);
        git(&pubrepo, &["commit", "-q", "-m", "feat + storyline"]);
        git(
            &pubrepo,
            &["push", "-q", "origin", "feat/x:refs/pull/1/head"],
        );

        let reviewer = base.join("reviewer");
        git(
            base,
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                reviewer.to_str().unwrap(),
            ],
        );
        reviewer
    }

    #[cfg(unix)]
    #[test]
    fn open_review_renders_storyline_and_diff_read_only() {
        let tmp = tempfile::tempdir().unwrap();
        let reviewer = pr_with_stage_remote(tmp.path());
        let gh = GitHub::with_bins(fake_gh(tmp.path()), "git");

        let pr = PrRef {
            owner: "octo".into(),
            name: "stage".into(),
            number: 1,
        };

        // Snapshot the working tree before opening, to assert read-only after.
        let head_before = Command::new("git")
            .arg("-C")
            .arg(&reviewer)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let head_before = String::from_utf8(head_before.stdout).unwrap();

        let entry = open_review(&gh, &reviewer, &pr).expect("open review");

        // PR context resolved from gh.
        assert_eq!(entry.pr.number, 1);
        assert_eq!(entry.pr.base_ref, "main");
        assert_eq!(entry.pr.head_ref, "feat/x");
        assert_eq!(entry.pr.author_login, "author");
        assert!(entry.stage_guided, "the head carries a committed .stage");

        // The tree-to-tree diff is the PR's code change.
        assert!(
            entry.diff.files.iter().any(|f| f.path == "src/foo.rs"),
            "diff contains the PR's code change: {:?}",
            entry.diff.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );

        // The storyline, in order, with the dropped-file step flagged stale.
        assert_eq!(entry.steps.len(), 2);
        assert_eq!(entry.steps[0].anchor, "src/foo.rs");
        assert_eq!(entry.steps[0].title.as_deref(), Some("The foo"));
        assert!(!entry.steps[0].stale, "anchored file is in the diff");
        assert_eq!(entry.steps[1].anchor, "src/gone.rs");
        assert!(entry.steps[1].stale, "dropped-file anchor is flagged stale");

        // The storyline is an overlay, not a filter: a stale step doesn't consume
        // a diff file, and `src/foo.rs` (anchored) is not in the residue.
        assert!(
            !entry.unstoried.contains(&"src/foo.rs".to_string()),
            "anchored file is storied: {:?}",
            entry.unstoried
        );

        // READ-ONLY INVARIANT: HEAD unchanged, still on `main`, and the PR's
        // files/.stage were never written into the working tree.
        let head_after = Command::new("git")
            .arg("-C")
            .arg(&reviewer)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(
            head_before,
            String::from_utf8(head_after.stdout).unwrap(),
            "open_review must not move HEAD"
        );
        let repo = git2::Repository::open(&reviewer).unwrap();
        assert_eq!(repo.head().unwrap().shorthand(), Some("main"));
        assert!(
            !reviewer.join("src/foo.rs").exists(),
            "the PR's code must not be checked out"
        );
        assert!(
            !reviewer.join(".stage").exists(),
            "the PR's .stage must not be written to the working tree"
        );

        // The opt-in exception: a confirmed checkout brings the branch in.
        checkout_pr_branch(&gh, &reviewer, &pr, &entry.pr.head_ref).expect("checkout");
        assert!(reviewer.join("src/foo.rs").exists());
        assert_eq!(
            git2::Repository::open(&reviewer)
                .unwrap()
                .head()
                .unwrap()
                .shorthand(),
            Some("feat/x")
        );
    }

    #[cfg(unix)]
    #[test]
    fn open_review_renders_a_plain_pr_as_a_read_only_diff() {
        let tmp = tempfile::tempdir().unwrap();
        // Reuse the fixture but ignore its `.stage` by asking gh for a head that
        // has none. Simplest: build a separate plain remote.
        let remote = tmp.path().join("remote.git");
        git(
            tmp.path(),
            &["init", "-q", "--bare", remote.to_str().unwrap()],
        );
        let pubrepo = tmp.path().join("publisher");
        std::fs::create_dir_all(&pubrepo).unwrap();
        git(&pubrepo, &["init", "-q", "-b", "main"]);
        git(&pubrepo, &["config", "user.email", "t@e.com"]);
        git(&pubrepo, &["config", "user.name", "t"]);
        std::fs::write(pubrepo.join("base.rs"), "fn base() {}\n").unwrap();
        git(&pubrepo, &["add", "-A"]);
        git(&pubrepo, &["commit", "-q", "-m", "base"]);
        git(
            &pubrepo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&pubrepo, &["push", "-q", "origin", "main"]);
        git(&pubrepo, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::write(pubrepo.join("plain.rs"), "fn plain() {}\n").unwrap();
        git(&pubrepo, &["add", "-A"]);
        git(&pubrepo, &["commit", "-q", "-m", "plain change"]);
        git(
            &pubrepo,
            &["push", "-q", "origin", "feat/x:refs/pull/1/head"],
        );
        let reviewer = tmp.path().join("reviewer");
        git(
            tmp.path(),
            &[
                "clone",
                "-q",
                remote.to_str().unwrap(),
                reviewer.to_str().unwrap(),
            ],
        );

        let gh = GitHub::with_bins(fake_gh(tmp.path()), "git");
        let pr = PrRef {
            owner: "octo".into(),
            name: "stage".into(),
            number: 1,
        };
        let entry = open_review(&gh, &reviewer, &pr).expect("open plain review");

        // No committed storyline → not Stage-guided, no steps, the whole diff is
        // browsable (a real result, not a swallowed error).
        assert!(!entry.stage_guided);
        assert!(entry.steps.is_empty());
        assert_eq!(entry.unstoried, vec!["plain.rs".to_string()]);
        assert!(entry.diff.files.iter().any(|f| f.path == "plain.rs"));
    }
}
