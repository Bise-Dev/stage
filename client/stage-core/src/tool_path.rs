//! Locating the external CLIs Stage shells out to (`gh`, `git`).
//!
//! Stage holds no credential of its own — every GitHub action runs through the
//! user's local `gh` (ADR-0022 §5). That makes finding `gh` a hard requirement,
//! and `Command::new("gh")` alone is not enough to meet it: a macOS app
//! launched from the Dock, Finder or Spotlight inherits launchd's environment,
//! whose `PATH` is the bare `/usr/bin:/bin:/usr/sbin:/sbin`. A Homebrew `gh`
//! (`/opt/homebrew/bin/gh`) is therefore invisible to the installed bundle even
//! though it is on `PATH` in every terminal — the app reported "GitHub CLI not
//! found" while `which gh` answered fine. `git` masked the same gap only
//! because `/usr/bin/git` exists.
//!
//! So resolve the binary to an absolute path ourselves, cheapest source first:
//!
//! 1. the explicit override env var (`STAGE_GH_BIN` / `STAGE_GIT_BIN`) — the
//!    escape hatch for an install in a place we don't know about;
//! 2. the inherited `PATH` — correct whenever Stage was started from a shell
//!    (`st open`, `just dev`, the CLI);
//! 3. the well-known install dirs below — the GUI-launch case, no subprocess;
//! 4. the user's login shell's `PATH` — the last resort that covers version
//!    managers and hand-rolled layouts, one `$SHELL -lc` spawn, cached.
//!
//! If none of them has it, the bare name is returned unchanged so the spawn
//! fails with `NotFound` and the caller raises its loud, actionable "install
//! `gh`" error (CLAUDE.md fail-loud) — resolution never invents a fallback and
//! never silently degrades.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Override for the `gh` binary Stage invokes. An absolute path.
pub const GH_BIN_ENV: &str = "STAGE_GH_BIN";

/// Override for the `git` binary Stage invokes. An absolute path.
pub const GIT_BIN_ENV: &str = "STAGE_GIT_BIN";

/// Install dirs to search when the inherited `PATH` is launchd's minimal one.
/// Ordered by how likely they are on a developer's machine: Homebrew (Apple
/// silicon, then Intel/Linuxbrew), MacPorts, Nix, then the system dirs.
const WELL_KNOWN_ABS_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/run/current-system/sw/bin",
    "/nix/var/nix/profiles/default/bin",
    "/usr/bin",
    "/bin",
];

/// `$HOME`-relative install dirs, searched after the absolute ones above.
const WELL_KNOWN_HOME_DIRS: &[&str] = &[
    ".local/bin",
    "bin",
    ".nix-profile/bin",
    ".local/share/mise/shims",
    ".asdf/shims",
];

/// Resolve `name` to the binary Stage should spawn, per the module's ladder.
///
/// A `name` that already contains a path separator is returned untouched —
/// callers (and tests) that point at a specific binary mean it. A bare name
/// that can't be found anywhere comes back unchanged, so the spawn fails loud.
pub fn resolve_tool(name: &str, override_env: &str) -> OsString {
    if let Some(explicit) = std::env::var_os(override_env).filter(|v| !v.is_empty()) {
        tracing::debug!(name, env = override_env, bin = ?explicit, "tool_path_override");
        return explicit;
    }
    if name.contains(std::path::MAIN_SEPARATOR) {
        return OsString::from(name);
    }

    if let Some(found) = std::env::var_os("PATH").and_then(|p| search_env_path(&p, name)) {
        tracing::debug!(name, bin = %found.display(), source = "path", "tool_path_resolved");
        return found.into_os_string();
    }
    if let Some(found) = search_dirs(well_known_dirs(), name) {
        tracing::debug!(name, bin = %found.display(), source = "well_known", "tool_path_resolved");
        return found.into_os_string();
    }
    if let Some(found) = login_shell_path().and_then(|p| search_env_path(&p, name)) {
        tracing::debug!(name, bin = %found.display(), source = "login_shell", "tool_path_resolved");
        return found.into_os_string();
    }

    // Not an error yet: the spawn is what fails, with a message naming the
    // remedy. Warn so the log records that we looked and came up empty.
    tracing::warn!(name, "tool_path_unresolved");
    OsString::from(name)
}

/// The well-known install dirs, `$HOME` expanded, in search order.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = WELL_KNOWN_ABS_DIRS.iter().map(PathBuf::from).collect();
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        let home = PathBuf::from(home);
        dirs.extend(WELL_KNOWN_HOME_DIRS.iter().map(|d| home.join(d)));
    }
    dirs
}

/// Search a `PATH`-shaped value (colon-separated on unix) for `name`.
fn search_env_path(path: &OsStr, name: &str) -> Option<PathBuf> {
    search_dirs(std::env::split_paths(path).collect::<Vec<_>>(), name)
}

/// The first `dir/name` that is an executable file.
fn search_dirs(dirs: Vec<PathBuf>, name: &str) -> Option<PathBuf> {
    dirs.into_iter()
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(name))
        .find(|c| is_executable_file(c))
}

/// Whether `path` is a file we could actually exec.
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The `PATH` the user's login shell exports, queried once per process.
///
/// `-lc` is a *login, non-interactive* shell: it reads the profile files where
/// `PATH` is set up (`.zprofile`, `.bash_profile`, and whatever a version
/// manager hooks into them) without paying for interactive rc files. Cached
/// because the spawn costs real milliseconds and the answer can't change under
/// us.
fn login_shell_path() -> Option<OsString> {
    static CACHE: OnceLock<Option<OsString>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty())?;
            shell_path_via(&shell)
        })
        .clone()
}

/// Ask one shell for its `PATH`. Split out from [`login_shell_path`] so tests
/// can drive it with a fake shell instead of mutating the process environment.
fn shell_path_via(shell: &OsStr) -> Option<OsString> {
    let out = std::process::Command::new(shell)
        .arg("-lc")
        .arg("printf %s \"$PATH\"")
        .output();
    let out = match out {
        Ok(out) => out,
        Err(e) => {
            // Best-effort by design — step 4 of a ladder whose failure is
            // reported by the spawn that follows, not swallowed here.
            tracing::warn!(err = %e, shell = ?shell, "login_shell_path_spawn_failed");
            return None;
        }
    };
    if !out.status.success() {
        tracing::warn!(status = ?out.status.code(), shell = ?shell, "login_shell_path_failed");
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then(|| OsString::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write an executable fake binary and return its path.
    #[cfg(unix)]
    fn write_exe(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[test]
    fn a_path_like_name_is_left_alone() {
        // Callers pointing at a specific binary (the test fakes in github.rs)
        // must not be re-resolved.
        let sep = std::path::MAIN_SEPARATOR;
        let explicit = format!("{sep}opt{sep}gh");
        assert_eq!(
            resolve_tool(&explicit, "STAGE_UNSET_BIN_ENV"),
            OsString::from(&explicit)
        );
    }

    #[test]
    fn an_unfindable_name_comes_back_bare_so_the_spawn_fails_loud() {
        let name = "stage-nonexistent-tool-xyz";
        assert_eq!(
            resolve_tool(name, "STAGE_UNSET_BIN_ENV"),
            OsString::from(name)
        );
    }

    #[test]
    fn gh_resolves_to_an_absolute_path_in_a_dev_environment() {
        // The regression this module exists for: the name Stage spawns must
        // come back as a real path, not the bare "gh" that launchd's PATH
        // couldn't find. Skipped where the dev tool genuinely isn't installed.
        let resolved = resolve_tool("git", GIT_BIN_ENV);
        assert!(
            Path::new(&resolved).is_absolute(),
            "git should resolve to an absolute path, got {resolved:?}"
        );
    }

    #[test]
    fn the_well_known_dirs_find_gh_without_consulting_path() {
        // The regression itself: a Dock-launched bundle has no Homebrew on its
        // inherited PATH, so step 3 of the ladder is the one that has to find
        // `gh`. Only asserted where `gh` is installed at all — nothing to find
        // is a legitimate machine state, and the missing-`gh` banner covers it.
        let on_path = std::env::var_os("PATH").and_then(|p| search_env_path(&p, "gh"));
        if on_path.is_none() {
            return;
        }
        assert!(
            search_dirs(well_known_dirs(), "gh").is_some(),
            "gh is on PATH but not in any dir a GUI-launched Stage searches; \
             the install dir may need adding to WELL_KNOWN_*_DIRS"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_well_known_dir_is_searched_when_path_misses() {
        let dir = tempfile::tempdir().unwrap();
        write_exe(dir.path(), "gh", "#!/usr/bin/env bash\nexit 0\n");
        let found = search_dirs(
            vec![
                PathBuf::from("/stage-nonexistent-dir"),
                dir.path().to_path_buf(),
            ],
            "gh",
        );
        assert_eq!(found.as_deref(), Some(dir.path().join("gh").as_path()));
    }

    #[cfg(unix)]
    #[test]
    fn a_non_executable_file_is_not_a_match() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("gh"), "not executable").unwrap();
        assert_eq!(search_dirs(vec![dir.path().to_path_buf()], "gh"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_named_like_the_binary_is_not_a_match() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("gh")).unwrap();
        assert_eq!(search_dirs(vec![dir.path().to_path_buf()], "gh"), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_login_shell_supplies_a_path_when_the_inherited_one_lacks_the_tool() {
        let dir = tempfile::tempdir().unwrap();
        let bin_dir = dir.path().join("bin");
        std::fs::create_dir(&bin_dir).unwrap();
        write_exe(&bin_dir, "gh", "#!/usr/bin/env bash\nexit 0\n");
        // A fake login shell that exports exactly that dir.
        let shell = write_exe(
            dir.path(),
            "fake-shell",
            &format!(
                "#!/usr/bin/env bash\nPATH={}\nprintf %s \"$PATH\"\n",
                bin_dir.display()
            ),
        );
        let path = shell_path_via(shell.as_os_str()).expect("fake shell reports a PATH");
        assert_eq!(
            search_env_path(&path, "gh").as_deref(),
            Some(bin_dir.join("gh").as_path())
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_fails_yields_no_path_rather_than_a_guess() {
        let dir = tempfile::tempdir().unwrap();
        let shell = write_exe(dir.path(), "broken-shell", "#!/usr/bin/env bash\nexit 3\n");
        assert_eq!(shell_path_via(shell.as_os_str()), None);
    }

    #[test]
    fn a_missing_shell_yields_no_path() {
        assert_eq!(shell_path_via(OsStr::new("/stage-nonexistent-shell")), None);
    }
}
