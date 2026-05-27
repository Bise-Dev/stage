//! HTTP SDK that talks to the Stage Backend's REST API. Covers /api/v1/auth/*
//! (web exchange + auth_me + logout) and /api/v1/github/prs/.

mod auth;
mod client;
mod error;
mod github;
mod overview;
mod types;

pub use client::Client;
pub use error::Error;
pub use types::{GithubPrSearchItem, SessionData, User};
