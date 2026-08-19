//! The background sync engine — one long-lived task per active repo that owns
//! the **snapshot**: the assembled [`stage_core::OverviewView`] plus the watched
//! PR's activity, kept continuously fresh from three inputs:
//!
//! 1. **Local git / store changes** — the filesystem watchers ([`crate::watcher`])
//!    nudge the engine, which re-assembles the overview off the UI thread. Diff
//!    signals are memoized per `(head, base)` OID pair ([`stage_core::SignalCache`])
//!    so a recompute only pays for branches whose tips moved.
//! 2. **GitHub** — an adaptive poll of the two `gh pr list` searches (~30s when
//!    the window is focused, backed off to minutes when not, immediately after a
//!    write action or on focus regain). The last successful fetch is cached, so
//!    local recomputes never wait on the network.
//! 3. **The watched PR** — while a PR is open in Local Review its activity is
//!    deep-polled on the same cadence and pushed to the screen on change.
//!
//! Commands serve reads **from the snapshot** (microseconds, never a `gh`
//! round-trip); the engine emits a versioned `sync-updated` event and the webview
//! re-invokes. All state derivation stays in Rust (ADR-0022 §7); all blocking
//! work runs in `spawn_blocking` (ADR-0023).
//!
//! **Fail loud, but not spammy (CLAUDE.md):** a failing background tick logs the
//! real cause and surfaces it in [`SyncStatus`] (`github_state: Degraded` +
//! the verbatim message) which the UI renders as a persistent chip — instead of
//! silently serving stale data, and instead of a red banner every 30 seconds.
//! An unavailable/unauthenticated `gh` pauses polling until a nudge (focus,
//! write action, manual sync) so we never hot-loop on a logged-out CLI.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use stage_core::{
    assemble_overview_with, fetch_overview_github, repo_key_from_cwd, repo_root_from_cwd,
    OverviewGithubData, OverviewView, PrActivity, SignalCache, StageError, Store,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};
use ts_rs::TS;

use crate::errors::AppError;

/// GitHub poll cadence while the window is focused.
const GITHUB_POLL_FOCUSED: Duration = Duration::from_secs(30);
/// GitHub poll cadence while the window is unfocused (background app).
const GITHUB_POLL_UNFOCUSED: Duration = Duration::from_secs(300);
/// Ceiling for the failure backoff (doubles per consecutive failure).
const GITHUB_BACKOFF_MAX: Duration = Duration::from_secs(600);

/// Nudges into the engine loop. Senders never block (unbounded) — the loop
/// drains and coalesces, so a burst of watcher events costs one recompute.
pub enum SyncMsg {
    /// Local git / store state may have changed — re-assemble the overview.
    LocalChanged,
    /// Poll GitHub as soon as possible (focus regain, write action, manual sync).
    PollGithubNow,
    /// A PR was opened in Local Review — deep-poll its activity on the cadence.
    WatchPr(u32),
    /// The Local Review screen closed.
    UnwatchPr,
    /// `pr_activity` fetched this itself — adopt it (fresher than our cache)
    /// without emitting (the caller already has the data).
    PrFetched(u32, Box<PrActivity>),
    /// The auto-`git fetch` interval changed (seconds; 0 = off).
    SetAutoFetch(u32),
    /// The window gained/lost focus — adapt the poll cadence.
    WindowFocus(bool),
}

/// Where the GitHub side of the sync stands. `Pending` = no poll has completed
/// yet this session; `Degraded` = the last poll failed (the overview still
/// serves the last good data, and `github_error` carries the real cause).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GithubSyncState {
    Pending,
    Ok,
    Degraded,
}

/// The sync engine's user-visible state — rendered as the freshness/degraded
/// chips. Every failure field carries a complete, verbatim message (fail loud);
/// timestamps are epoch **milliseconds**.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncStatus {
    /// Monotonic snapshot version — bumps whenever served data changes.
    #[ts(type = "number")]
    pub generation: u64,
    /// When the local overview last assembled successfully.
    #[ts(type = "number | null")]
    pub local_synced_at: Option<u64>,
    /// The last local assembly failure, verbatim. The overview command fails
    /// with this when there is no snapshot to serve at all.
    pub local_error: Option<String>,
    pub github_state: GithubSyncState,
    /// The last GitHub poll failure, verbatim (`gh`'s own message).
    pub github_error: Option<String>,
    /// When GitHub was last polled successfully.
    #[ts(type = "number | null")]
    pub github_synced_at: Option<u64>,
    /// The last background `git fetch` failure, verbatim.
    pub auto_fetch_error: Option<String>,
    /// The PR currently deep-polled for Local Review, if any.
    pub watched_pr: Option<u32>,
}

impl SyncStatus {
    fn initial() -> Self {
        Self {
            generation: 0,
            local_synced_at: None,
            local_error: None,
            github_state: GithubSyncState::Pending,
            github_error: None,
            github_synced_at: None,
            auto_fetch_error: None,
            watched_pr: None,
        }
    }
}

/// What changed, for the `sync-updated` event — screens ignore scopes they
/// don't render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SyncScope {
    /// The overview rows changed (local recompute and/or merged GitHub data).
    Overview,
    /// Only sync status changed (a poll finished, degraded/recovered, …).
    Status,
    /// The watched PR's activity changed (`pr_number` says which).
    Pr,
}

/// Payload of the `sync-updated` event: the scope of the change plus the full
/// current status, so listeners never need a follow-up status invoke.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncUpdate {
    pub scope: SyncScope,
    pub pr_number: Option<u32>,
    pub status: SyncStatus,
}

/// The watched PR's last-known activity (engine- or command-fetched).
#[derive(Clone)]
pub struct PrCacheEntry {
    pub number: u32,
    pub activity: PrActivity,
    pub fetched_at: Instant,
}

/// The engine's owned state, published through a `watch` channel so commands
/// read the latest without locking the engine. `overview` always carries the
/// **unfiltered** view (archived included; DB-5 is applied per read).
#[derive(Clone)]
pub struct Snapshot {
    pub overview: Option<OverviewView>,
    pub status: SyncStatus,
    pub pr: Option<PrCacheEntry>,
}

impl Snapshot {
    fn initial() -> Self {
        Self {
            overview: None,
            status: SyncStatus::initial(),
            pr: None,
        }
    }
}

/// Owner handle for one repo's engine. Dropping it (repo switch / focus change)
/// aborts the task; the watchers' senders then fail silently, which is fine —
/// a new engine is spawned right after.
pub struct SyncHandle {
    tx: mpsc::UnboundedSender<SyncMsg>,
    snapshot: watch::Receiver<Snapshot>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl SyncHandle {
    /// Nudge the engine. Infallible by design: a closed channel only happens
    /// mid-teardown, when the nudge is moot.
    pub fn send(&self, msg: SyncMsg) {
        if self.tx.send(msg).is_err() {
            tracing::debug!("sync_engine_nudge_after_teardown");
        }
    }

    /// A fresh receiver on the snapshot channel (await-able for first data).
    pub fn snapshot_rx(&self) -> watch::Receiver<Snapshot> {
        self.snapshot.clone()
    }

    /// A sender clone for other producers (the filesystem watchers).
    pub fn sender(&self) -> mpsc::UnboundedSender<SyncMsg> {
        self.tx.clone()
    }
}

impl Drop for SyncHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Spawn the engine for `repo_path` (the focused worktree). `auto_fetch_secs`
/// seeds the background `git fetch` cadence (0 = off).
pub fn spawn(
    app: AppHandle,
    github: Arc<stage_core::GitHub>,
    repo_path: PathBuf,
    auto_fetch_secs: u32,
) -> SyncHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let (snap_tx, snap_rx) = watch::channel(Snapshot::initial());
    let engine = Engine {
        app,
        github,
        repo_path,
        snap: snap_tx,
        rx,
        cache: SignalCache::default(),
        github_data: None,
        focused: true,
        auto_fetch_secs,
        consecutive_failures: 0,
    };
    let task = tauri::async_runtime::spawn(engine.run());
    SyncHandle {
        tx,
        snapshot: snap_rx,
        task,
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct Engine {
    app: AppHandle,
    github: Arc<stage_core::GitHub>,
    repo_path: PathBuf,
    snap: watch::Sender<Snapshot>,
    rx: mpsc::UnboundedReceiver<SyncMsg>,
    /// Diff-signal memo, kept across recomputes (the whole point of owning one).
    cache: SignalCache,
    /// The last successful GitHub fetch — merged into every local recompute so
    /// PR rows survive between polls and never block on the network.
    github_data: Option<OverviewGithubData>,
    focused: bool,
    auto_fetch_secs: u32,
    consecutive_failures: u32,
}

impl Engine {
    async fn run(mut self) {
        let start = Instant::now();
        let mut local_dirty = true;
        // First GitHub poll immediately; `None` = paused (gh unavailable).
        let mut next_github: Option<Instant> = Some(start);
        let mut next_fetch: Option<Instant> = next_fetch_from(self.auto_fetch_secs, start);
        let mut watched_pr: Option<u32> = None;
        let mut poll_pr_now = false;

        loop {
            // Sleep until the earliest due timer, unless already dirty.
            if !local_dirty && !poll_pr_now {
                let deadline = [next_github, next_fetch].into_iter().flatten().min();
                let recv = self.rx.recv();
                let msg = match deadline {
                    Some(d) => tokio::select! {
                        m = recv => Some(m),
                        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(d)) => None,
                    },
                    None => Some(recv.await),
                };
                match msg {
                    Some(None) => return, // handle dropped — engine torn down
                    Some(Some(m)) => self.apply(
                        m,
                        &mut local_dirty,
                        &mut next_github,
                        &mut next_fetch,
                        &mut watched_pr,
                        &mut poll_pr_now,
                    ),
                    None => {} // a timer fired
                }
            }
            // Coalesce whatever else queued up while we slept/worked.
            while let Ok(m) = self.rx.try_recv() {
                self.apply(
                    m,
                    &mut local_dirty,
                    &mut next_github,
                    &mut next_fetch,
                    &mut watched_pr,
                    &mut poll_pr_now,
                );
            }

            let now = Instant::now();

            if next_fetch.is_some_and(|t| t <= now) {
                next_fetch = next_fetch_from(self.auto_fetch_secs, now);
                self.auto_fetch().await;
                // The fetch's ref updates land via the watcher → LocalChanged;
                // no need to force a recompute here.
            }

            // Local first: the fast, network-free assembly publishes before any
            // `gh` round-trip, so the first snapshot (and every git-driven
            // refresh) never waits on GitHub.
            if local_dirty {
                local_dirty = false;
                self.recompute_local().await;
            }

            if next_github.is_some_and(|t| t <= now) {
                next_github = match self.poll_github().await {
                    PollOutcome::Ok => Some(Instant::now() + self.github_interval(true)),
                    PollOutcome::Failed => Some(Instant::now() + self.github_interval(false)),
                    // `gh` missing/unauthenticated: pause — a nudge (focus,
                    // write action, manual sync) re-arms the poll.
                    PollOutcome::Pause => None,
                };
                local_dirty = true; // merge the fresh data on the next pass
                if watched_pr.is_some() {
                    poll_pr_now = true;
                }
                continue; // recompute (top of loop) before the PR deep-poll
            }

            if poll_pr_now {
                poll_pr_now = false;
                if let Some(number) = watched_pr {
                    self.poll_pr(number).await;
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply(
        &mut self,
        msg: SyncMsg,
        local_dirty: &mut bool,
        next_github: &mut Option<Instant>,
        next_fetch: &mut Option<Instant>,
        watched_pr: &mut Option<u32>,
        poll_pr_now: &mut bool,
    ) {
        match msg {
            SyncMsg::LocalChanged => *local_dirty = true,
            SyncMsg::PollGithubNow => *next_github = Some(Instant::now()),
            SyncMsg::WatchPr(n) => {
                let changed = *watched_pr != Some(n);
                *watched_pr = Some(n);
                self.mutate(|s| s.status.watched_pr = Some(n));
                // Fresh data was usually just fetched by the opening screen
                // (`pr_activity` feeds us via PrFetched) — only poll now if we
                // hold nothing for this PR.
                if changed
                    && !self
                        .snap
                        .borrow()
                        .pr
                        .as_ref()
                        .is_some_and(|p| p.number == n)
                {
                    *poll_pr_now = true;
                }
            }
            SyncMsg::UnwatchPr => {
                *watched_pr = None;
                self.mutate(|s| {
                    s.status.watched_pr = None;
                    s.pr = None;
                });
            }
            SyncMsg::PrFetched(n, activity) => {
                self.mutate(|s| {
                    s.pr = Some(PrCacheEntry {
                        number: n,
                        activity: *activity,
                        fetched_at: Instant::now(),
                    });
                });
            }
            SyncMsg::SetAutoFetch(secs) => {
                self.auto_fetch_secs = secs;
                *next_fetch = next_fetch_from(secs, Instant::now());
            }
            SyncMsg::WindowFocus(f) => {
                self.focused = f;
                if f {
                    // Regaining focus: if the next poll is further out than the
                    // focused cadence allows, pull it in to "now".
                    let due = Instant::now();
                    // (`is_none_or` needs Rust 1.82; MSRV is 1.77.)
                    if !next_github.is_some_and(|t| t <= due + GITHUB_POLL_FOCUSED) {
                        *next_github = Some(due);
                    }
                }
            }
        }
    }

    /// Update the snapshot in place without emitting (status-only bookkeeping;
    /// emission is decided by the callers that changed served data).
    fn mutate(&self, f: impl FnOnce(&mut Snapshot)) {
        self.snap.send_modify(f);
    }

    fn emit(&self, scope: SyncScope, pr_number: Option<u32>) {
        let status = self.snap.borrow().status.clone();
        let update = SyncUpdate {
            scope,
            pr_number,
            status,
        };
        if let Err(e) = self.app.emit("sync-updated", update) {
            tracing::error!(err = %e, "sync_updated_emit_failed");
        }
    }

    fn github_interval(&self, last_ok: bool) -> Duration {
        let base = if self.focused {
            GITHUB_POLL_FOCUSED
        } else {
            GITHUB_POLL_UNFOCUSED
        };
        if last_ok {
            return base;
        }
        // Backoff: double per consecutive failure, capped.
        let shift = self.consecutive_failures.min(5);
        (base * 2u32.pow(shift)).min(GITHUB_BACKOFF_MAX)
    }

    /// Re-assemble the overview from local state + the cached GitHub data, off
    /// the UI thread. Emits `Overview` when the rows changed, `Status` when only
    /// the sync metadata did (so freshness chips still tick over).
    async fn recompute_local(&mut self) {
        let path = self.repo_path.clone();
        let data = self.github_data.clone();
        let cache = std::mem::take(&mut self.cache);
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut cache = cache;
            let view = (|| -> Result<OverviewView, StageError> {
                let key = repo_key_from_cwd(&path)?;
                let repo_root = repo_root_from_cwd(&path)?;
                let store = Store::open_default()?;
                // Unfiltered: archived rows stay in; DB-5 filters per read.
                assemble_overview_with(&store, &repo_root, &key, data.as_ref(), true, &mut cache)
            })();
            (view, cache)
        })
        .await;

        let (view, cache) = match result {
            Ok(pair) => pair,
            Err(e) => {
                tracing::error!(err = %e, "sync_local_recompute_join_error");
                self.mutate(|s| {
                    s.status.local_error = Some(format!("overview recompute failed: {e}"));
                });
                self.emit(SyncScope::Status, None);
                return;
            }
        };
        self.cache = cache;

        match view {
            Ok(view) => {
                let changed = self.snap.borrow().overview.as_ref() != Some(&view);
                self.mutate(|s| {
                    if changed {
                        s.status.generation += 1;
                    }
                    s.status.local_synced_at = Some(epoch_ms());
                    s.status.local_error = None;
                    s.overview = Some(view);
                });
                if changed {
                    self.emit(SyncScope::Overview, None);
                }
            }
            Err(e) => {
                // Fail loud: log with the cause and surface it on the status —
                // the last good overview keeps serving, visibly stale.
                tracing::error!(err = %e, "sync_local_recompute_failed");
                self.mutate(|s| s.status.local_error = Some(e.to_string()));
                self.emit(SyncScope::Status, None);
            }
        }
    }

    /// One GitHub poll: the two `gh pr list` searches + identity. On success the
    /// result becomes the cached GitHub half for every following local recompute.
    /// The outcome drives the backoff / pause.
    async fn poll_github(&mut self) -> PollOutcome {
        let github = Arc::clone(&self.github);
        let path = self.repo_path.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let key = repo_key_from_cwd(&path)?;
            fetch_overview_github(&github, &key)
        })
        .await
        .unwrap_or_else(|e| Err(StageError::Invalid(format!("github poll task failed: {e}"))));

        match result {
            Ok(data) => {
                self.github_data = Some(data);
                self.consecutive_failures = 0;
                let was_degraded = {
                    let s = self.snap.borrow();
                    s.status.github_state != GithubSyncState::Ok
                };
                self.mutate(|s| {
                    s.status.github_state = GithubSyncState::Ok;
                    s.status.github_error = None;
                    s.status.github_synced_at = Some(epoch_ms());
                });
                // Row changes are detected (and emitted) by the recompute that
                // follows; only a state transition warrants its own event.
                if was_degraded {
                    self.emit(SyncScope::Status, None);
                }
                PollOutcome::Ok
            }
            Err(e) => {
                self.consecutive_failures += 1;
                // Fail loud without spamming: log + degraded chip with the
                // verbatim cause; the last good GitHub data keeps serving.
                tracing::error!(err = %e, failures = self.consecutive_failures, "sync_github_poll_failed");
                let pause = matches!(e, StageError::GhUnavailable(_));
                self.mutate(|s| {
                    s.status.github_state = GithubSyncState::Degraded;
                    s.status.github_error = Some(e.to_string());
                });
                self.emit(SyncScope::Status, None);
                if pause {
                    PollOutcome::Pause
                } else {
                    PollOutcome::Failed
                }
            }
        }
    }

    /// Deep-poll the watched PR's activity; emit `Pr` only when it changed.
    async fn poll_pr(&mut self, number: u32) {
        let github = Arc::clone(&self.github);
        let path = self.repo_path.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let repo_root = repo_root_from_cwd(&path)?;
            github.read_pr_activity(&repo_root, number)
        })
        .await;

        match result {
            Ok(Ok(activity)) => {
                let changed = {
                    let s = self.snap.borrow();
                    s.pr.as_ref()
                        .map(|p| p.number != number || p.activity != activity)
                        .unwrap_or(true)
                };
                self.mutate(|s| {
                    s.pr = Some(PrCacheEntry {
                        number,
                        activity,
                        fetched_at: Instant::now(),
                    });
                });
                if changed {
                    self.emit(SyncScope::Pr, Some(number));
                }
            }
            Ok(Err(e)) => {
                // Same degraded surface as the list poll — it's the same `gh`.
                tracing::error!(err = %e, pr = number, "sync_pr_poll_failed");
                self.mutate(|s| {
                    s.status.github_state = GithubSyncState::Degraded;
                    s.status.github_error = Some(e.to_string());
                });
                self.emit(SyncScope::Status, None);
            }
            Err(e) => {
                tracing::error!(err = %e, pr = number, "sync_pr_poll_join_error");
            }
        }
    }

    /// Background `git fetch --prune` (the folded-in auto-fetch). Its ref
    /// updates flow back through the `.git` watcher as `LocalChanged`.
    async fn auto_fetch(&mut self) {
        let path = self.repo_path.clone();
        let result = tauri::async_runtime::spawn_blocking(move || crate::git::fetch(&path)).await;
        let outcome: Result<_, AppError> = match result {
            Ok(r) => r,
            Err(e) => Err(AppError::Backend(format!("auto_fetch_join_error: {e}"))),
        };
        match outcome {
            Ok(_) => {
                let had_error = self.snap.borrow().status.auto_fetch_error.is_some();
                if had_error {
                    self.mutate(|s| s.status.auto_fetch_error = None);
                    self.emit(SyncScope::Status, None);
                }
            }
            Err(e) => {
                // Fail loud: log + persistent chip (not a banner per tick).
                tracing::error!(err = %e, "sync_auto_fetch_failed");
                self.mutate(|s| s.status.auto_fetch_error = Some(e.to_string()));
                self.emit(SyncScope::Status, None);
            }
        }
    }
}

/// How a GitHub poll ended, for the loop's scheduling decision.
enum PollOutcome {
    Ok,
    /// A transient failure — retry on the backed-off cadence.
    Failed,
    /// `gh` unavailable/unauthenticated — stop polling until a nudge.
    Pause,
}

fn next_fetch_from(secs: u32, now: Instant) -> Option<Instant> {
    (secs > 0).then(|| now + Duration::from_secs(u64::from(secs)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_fetch_zero_means_off() {
        let now = Instant::now();
        assert!(next_fetch_from(0, now).is_none());
        assert_eq!(
            next_fetch_from(10, now),
            Some(now + Duration::from_secs(10))
        );
    }
}
