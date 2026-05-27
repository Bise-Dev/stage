use std::path::Path;

use git2::{BranchType, Repository};
use serde::Serialize;

use crate::errors::AppError;

pub fn current_branch(repo_path: &Path) -> Result<String, AppError> {
    let repo = Repository::open(repo_path)?;
    let head = repo.head()?;
    Ok(head.shorthand().unwrap_or("HEAD").to_string())
}

#[derive(Serialize)]
pub struct RepoSummary {
    #[serde(rename = "defaultBranch")]
    pub default_branch: Option<String>,
    #[serde(rename = "branchesCount")]
    pub branches_count: u32,
    #[serde(rename = "remoteUrl")]
    pub remote_url: Option<String>,
}

pub fn summary(repo_path: &Path) -> Result<RepoSummary, AppError> {
    let repo = Repository::open(repo_path)?;

    let branches_count = repo
        .branches(Some(BranchType::Local))
        .map(|iter| iter.filter(|b| b.is_ok()).count() as u32)
        .unwrap_or(0);

    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(str::to_string))
        .or_else(|| {
            // Fall back to first available remote if origin isn't present.
            repo.remotes()
                .ok()
                .and_then(|names| names.iter().flatten().next().map(str::to_string))
                .and_then(|name| {
                    repo.find_remote(&name)
                        .ok()
                        .and_then(|r| r.url().map(str::to_string))
                })
        });

    let default_branch = default_branch_for(&repo);

    Ok(RepoSummary {
        default_branch,
        branches_count,
        remote_url,
    })
}

fn default_branch_for(repo: &Repository) -> Option<String> {
    // Prefer the remote HEAD if present (e.g. refs/remotes/origin/HEAD → main).
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            if let Some(name) = target.rsplit('/').next() {
                return Some(name.to_string());
            }
        }
    }
    // Fall back to whatever the local HEAD points at.
    if let Ok(head) = repo.head() {
        if let Some(name) = head.shorthand() {
            return Some(name.to_string());
        }
    }
    None
}
