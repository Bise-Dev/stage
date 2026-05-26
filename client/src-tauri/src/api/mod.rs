//! HTTP SDK that talks to the Stage Backend's REST API. Covers /api/v1/auth/*
//! (web exchange + auth_me + logout); workspaces / github_proxy / github_search
//! endpoints are future slices.

mod auth;
mod client;
mod error;
mod types;

pub use client::Client;
pub use error::Error;
pub use types::{SessionData, User};
