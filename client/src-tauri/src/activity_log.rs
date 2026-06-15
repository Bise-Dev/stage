//! Dev-only Activity log: an in-memory ring buffer of structured runtime events
//! (HTTP calls, git ops, command invocations, webview console output, raw Rust
//! events) plus the `tracing_subscriber::Layer` that feeds it.
//!
//! The entire module is compiled only under `#[cfg(debug_assertions)]` (it's
//! wired up that way in `lib.rs`): a release build has no ring, no layer, and no
//! IPC surface. See `client/STACK.md` → "Activity log (dev-only debug panel)".
//!
//! Source-of-truth lives here, not in the webview: the ring fills from app start
//! (even before any panel is opened) and survives webview reloads. The webview
//! pulls a snapshot when its drawer opens and then tails the `activity_log:event`
//! stream.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::field::{Field, Visit};
use tracing::Subscriber;
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;
use ts_rs::TS;

/// Max retained entries. Oldest is dropped once full (decision #6).
const CAPACITY: usize = 2000;

/// Event channel the Rust side emits each new entry on while a panel is open.
pub const EVENT_NAME: &str = "activity_log:event";

/// Severity of an [`ActivityLogEntry`]. Serializes lowercase (`"info"`, …) and
/// is the source of the webview's `ActivityLogLevel` union. `Deserialize` is
/// needed because webview-pushed rows carry their level over the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ActivityLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

/// Source classification pill for an [`ActivityLogEntry`]. Serializes lowercase
/// and is the source of the webview's `ActivityLogPill` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ActivityLogPill {
    Http,
    Git,
    Cmd,
    Webview,
    Rust,
}

/// One structured row. Serialized to the webview verbatim; the TS type is
/// generated from this struct (`client/src/generated/ActivityLogEntry.ts`).
#[derive(Clone, Debug, Serialize, TS)]
#[ts(export)]
pub struct ActivityLogEntry {
    /// Monotonic, assigned in [`ActivityLog::record`]. The webview uses it to
    /// de-dup between a snapshot and the live stream.
    #[ts(type = "number")]
    pub id: u64,
    /// Unix epoch milliseconds.
    #[ts(type = "number")]
    pub ts_ms: u64,
    pub level: ActivityLogLevel,
    pub pill: ActivityLogPill,
    /// Rust module path (the tracing target), or `"console"` for webview rows.
    pub target: String,
    /// The tracing event name / short message.
    pub message: String,
    /// Remaining structured fields, stringified.
    pub fields: BTreeMap<String, String>,
    /// Elapsed time for the operation, when the event/span carries one.
    #[ts(type = "number | null")]
    pub duration_ms: Option<u64>,
    /// Error detail, when the event carries an `error` / `err` field.
    pub error: Option<String>,
}

/// The ring buffer plus the handle used to stream new rows to the webview.
pub struct ActivityLog {
    buf: Mutex<VecDeque<ActivityLogEntry>>,
    next_id: AtomicU64,
    /// Set once during Tauri `setup`; before that, records still land in the ring
    /// (the buffer is always-on) — they just aren't streamed live.
    app: Mutex<Option<AppHandle>>,
}

impl ActivityLog {
    pub fn new() -> Self {
        Self {
            buf: Mutex::new(VecDeque::with_capacity(CAPACITY)),
            next_id: AtomicU64::new(0),
            app: Mutex::new(None),
        }
    }

    /// Attach the app handle so subsequent records stream over `activity_log:event`.
    pub fn set_app(&self, app: AppHandle) {
        *self.app.lock() = Some(app);
    }

    /// Assign an id + timestamp, push into the ring (dropping the oldest when
    /// full), and stream the row to the webview.
    pub fn record(&self, mut entry: ActivityLogEntry) {
        entry.id = self.next_id.fetch_add(1, Ordering::Relaxed);
        entry.ts_ms = now_ms();
        redact_fields(&mut entry.fields);

        {
            let mut buf = self.buf.lock();
            if buf.len() >= CAPACITY {
                buf.pop_front();
            }
            buf.push_back(entry.clone());
        }

        // Fire-and-forget stream to the webview. This is the one documented
        // place we deliberately swallow a failure (CLAUDE.md "Error handling"):
        // emitting from *inside* the activity-log path must never log — the
        // logger feeds this very layer, so a `tracing::*` call here would
        // recurse. A failed emit only means the dev drawer misses a live row;
        // the entry is already in the ring and a re-open re-snapshots it.
        if let Some(app) = self.app.lock().as_ref() {
            let _ = app.emit(EVENT_NAME, &entry);
        }
    }

    /// The full ring, oldest first.
    pub fn snapshot(&self) -> Vec<ActivityLogEntry> {
        self.buf.lock().iter().cloned().collect()
    }

    /// Empty the ring. The id counter keeps climbing so webview de-dup stays sound.
    pub fn clear(&self) {
        self.buf.lock().clear();
    }
}

impl Default for ActivityLog {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Hard-redact secret-bearing fields in place (the **a-narrow** policy, decision
/// #9). We replace only values whose key is `authorization` (case-insensitive) —
/// that's the single header that could carry the Stage session token. The token
/// is never logged as a field today (the HTTP wrapper logs method/url/status,
/// not headers), so this is a defensive backstop; **everything else** — URLs,
/// request/response bodies, git stdout/stderr, error strings — is shown raw on
/// purpose, because the value of this panel is seeing exactly what happened.
fn redact_fields(fields: &mut BTreeMap<String, String>) {
    for (key, value) in fields.iter_mut() {
        if key.eq_ignore_ascii_case("authorization") {
            *value = "[redacted]".to_string();
        }
    }
}

/// Collects an event's (or span's) fields into a string map, pulling out the
/// well-known `message`, `error`/`err`, and `duration_ms` slots.
#[derive(Default)]
struct FieldCollector {
    fields: BTreeMap<String, String>,
    message: Option<String>,
    error: Option<String>,
    duration_ms: Option<u64>,
    /// Explicit `pill` field, when present (used for `cmd` spans).
    pill: Option<String>,
}

impl FieldCollector {
    fn put(&mut self, name: &str, value: String) {
        match name {
            "message" => self.message = Some(value),
            "error" | "err" => self.error = Some(value),
            "pill" => self.pill = Some(value),
            "duration_ms" => {
                self.duration_ms = value.parse().ok();
                // Keep it out of `fields`; it has its own column.
            }
            _ => {
                self.fields.insert(name.to_string(), value);
            }
        }
    }
}

impl Visit for FieldCollector {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field.name(), value.to_string());
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field.name(), value.to_string());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field.name(), value.to_string());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field.name(), value.to_string());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field.name(), value.to_string());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        // Catches `?x` (Debug) and `%x` (Display) values, plus the format-args
        // message. `{:?}` of a Display/Arguments wrapper is already unquoted.
        self.put(field.name(), format!("{value:?}"));
    }
}

/// Stashed on a `cmd`-tagged span so [`ActivityLogLayer::on_close`] can emit one
/// row per command invocation with its duration.
struct CmdSpan {
    started: Instant,
    fields: BTreeMap<String, String>,
}

/// Classify the source pill (decision #10) from the explicit `pill` field, then
/// the target module path, falling back to the `rust` catch-all.
fn classify_pill(explicit: Option<&str>, target: &str) -> ActivityLogPill {
    match explicit {
        Some("http") => return ActivityLogPill::Http,
        Some("git") => return ActivityLogPill::Git,
        Some("cmd") => return ActivityLogPill::Cmd,
        Some("webview") => return ActivityLogPill::Webview,
        Some("rust") => return ActivityLogPill::Rust,
        _ => {}
    }
    if target.starts_with("stage_client_lib::api") {
        ActivityLogPill::Http
    } else if target.starts_with("stage_client_lib::git") {
        ActivityLogPill::Git
    } else {
        ActivityLogPill::Rust
    }
}

fn level_of(level: &tracing::Level) -> ActivityLogLevel {
    match *level {
        tracing::Level::TRACE => ActivityLogLevel::Trace,
        tracing::Level::DEBUG => ActivityLogLevel::Debug,
        tracing::Level::INFO => ActivityLogLevel::Info,
        tracing::Level::WARN => ActivityLogLevel::Warn,
        tracing::Level::ERROR => ActivityLogLevel::Error,
    }
}

/// The `tracing` layer that turns events (and `cmd`-tagged spans) into ring
/// entries. Attached alongside the `fmt` layer in `lib.rs`, behind a filter that
/// scopes it to `stage_client_lib`.
pub struct ActivityLogLayer {
    log: Arc<ActivityLog>,
}

impl ActivityLogLayer {
    pub fn new(log: Arc<ActivityLog>) -> Self {
        Self { log }
    }
}

impl<S> Layer<S> for ActivityLogLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        id: &tracing::span::Id,
        ctx: Context<'_, S>,
    ) {
        let mut collector = FieldCollector::default();
        attrs.record(&mut collector);
        // Only spans explicitly tagged `pill = "cmd"` become command rows; every
        // other span (there are few) is ignored to keep the ring focused.
        if collector.pill.as_deref() == Some("cmd") {
            if let Some(span) = ctx.span(id) {
                span.extensions_mut().insert(CmdSpan {
                    started: Instant::now(),
                    fields: collector.fields,
                });
            }
        }
    }

    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let mut collector = FieldCollector::default();
        event.record(&mut collector);

        let pill = classify_pill(collector.pill.as_deref(), meta.target());
        self.log.record(ActivityLogEntry {
            id: 0,
            ts_ms: 0,
            level: level_of(meta.level()),
            pill,
            target: meta.target().to_string(),
            message: collector.message.unwrap_or_else(|| meta.name().to_string()),
            fields: collector.fields,
            duration_ms: collector.duration_ms,
            error: collector.error,
        });
    }

    fn on_close(&self, id: tracing::span::Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else { return };
        let mut ext = span.extensions_mut();
        let Some(cmd) = ext.remove::<CmdSpan>() else {
            return;
        };
        let meta = span.metadata();
        self.log.record(ActivityLogEntry {
            id: 0,
            ts_ms: 0,
            level: level_of(meta.level()),
            pill: ActivityLogPill::Cmd,
            target: meta.target().to_string(),
            // Span name is the `#[instrument]`ed function name (e.g. `git_fetch`).
            message: meta.name().to_string(),
            fields: cmd.fields,
            duration_ms: Some(cmd.started.elapsed().as_millis() as u64),
            error: None,
        });
    }
}

// --- Tauri commands (webview → Rust). Registered only in debug builds. ---

/// Input shape for [`activity_log_push`]: a webview-sourced row (a forwarded
/// `console.*` call or an `ErrorBoundary` catch).
#[derive(Deserialize)]
pub struct WebviewEntry {
    pub level: ActivityLogLevel,
    pub message: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// The full ring, oldest first — pulled by the drawer when it opens.
#[tauri::command]
pub fn activity_log_snapshot(
    state: tauri::State<'_, crate::state::AppState>,
) -> Vec<ActivityLogEntry> {
    state.activity_log.snapshot()
}

/// Push a webview-sourced row (pill `webview`, target `console`).
#[tauri::command]
pub fn activity_log_push(state: tauri::State<'_, crate::state::AppState>, entry: WebviewEntry) {
    state.activity_log.record(ActivityLogEntry {
        id: 0,
        ts_ms: 0,
        level: entry.level,
        pill: ActivityLogPill::Webview,
        target: "console".to_string(),
        message: entry.message,
        fields: entry.fields,
        duration_ms: None,
        error: entry.error,
    });
}

/// Empty the ring (the drawer's Clear button).
#[tauri::command]
pub fn activity_log_clear(state: tauri::State<'_, crate::state::AppState>) {
    state.activity_log.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_drops_oldest_past_capacity() {
        let log = ActivityLog::new();
        for _ in 0..(CAPACITY + 5) {
            log.record(make_entry(ActivityLogPill::Rust, "evt"));
        }
        let snap = log.snapshot();
        assert_eq!(snap.len(), CAPACITY);
        // Ids are monotonic; the first 5 were dropped.
        assert_eq!(snap.first().unwrap().id, 5);
        assert_eq!(snap.last().unwrap().id, (CAPACITY + 4) as u64);
    }

    #[test]
    fn clear_empties_but_keeps_id_monotonic() {
        let log = ActivityLog::new();
        log.record(make_entry(ActivityLogPill::Rust, "a"));
        log.record(make_entry(ActivityLogPill::Rust, "b"));
        log.clear();
        assert!(log.snapshot().is_empty());
        log.record(make_entry(ActivityLogPill::Rust, "c"));
        // Next id continues from where it left off (2), never reused.
        assert_eq!(log.snapshot()[0].id, 2);
    }

    #[test]
    fn redaction_hits_only_authorization() {
        let mut fields = BTreeMap::new();
        fields.insert("Authorization".to_string(), "Bearer stg_secret".to_string());
        fields.insert("url".to_string(), "https://api/x?token=abc".to_string());
        redact_fields(&mut fields);
        assert_eq!(fields["Authorization"], "[redacted]");
        // Everything else stays raw — the panel's whole point.
        assert_eq!(fields["url"], "https://api/x?token=abc");
    }

    #[test]
    fn classify_prefers_explicit_then_target() {
        assert_eq!(
            classify_pill(Some("cmd"), "stage_client_lib::git"),
            ActivityLogPill::Cmd
        );
        assert_eq!(
            classify_pill(None, "stage_client_lib::api::client"),
            ActivityLogPill::Http
        );
        assert_eq!(
            classify_pill(None, "stage_client_lib::git"),
            ActivityLogPill::Git
        );
        assert_eq!(
            classify_pill(None, "wgpu_core::device"),
            ActivityLogPill::Rust
        );
    }

    fn make_entry(pill: ActivityLogPill, msg: &str) -> ActivityLogEntry {
        ActivityLogEntry {
            id: 0,
            ts_ms: 0,
            level: ActivityLogLevel::Info,
            pill,
            target: "stage_client_lib".to_string(),
            message: msg.to_string(),
            fields: BTreeMap::new(),
            duration_ms: None,
            error: None,
        }
    }
}
