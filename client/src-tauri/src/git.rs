use std::path::Path;

use git2::Repository;

use crate::errors::AppError;

pub fn current_branch(repo_path: &Path) -> Result<String, AppError> {
    let repo = Repository::open(repo_path)?;
    let head = repo.head()?;
    Ok(head.shorthand().unwrap_or("HEAD").to_string())
}
