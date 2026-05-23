//! Reserved for the future `BackendClient` seam.
//!
//! See `docs/ROADMAP.md` — phase 2 introduces a separate Stage backend that
//! brokers GitHub access and hosts shared Workspace/Storyline state. The UI
//! talks to that seam through Tauri commands; today the seam is unbuilt and
//! Stage operates against local-only state.
//!
//! When the backend grilling (`backend/TODO.md`) resolves the data model and
//! API surface, this module will hold the `BackendClient` trait + a
//! `LocalBackend` impl (disk-backed) that the UI invokes via Tauri commands.
