//! HTTP SDK that talks to the Stage Backend's REST API. Covers /api/v1/auth/*
//! (device flow + auth_me + logout); workspaces / github_proxy / github_search
//! endpoints are future slices.

mod auth;
mod client;
mod error;
mod github;
mod types;

pub use client::Client;
pub use error::Error;
pub use types::{
    DeviceCode, DevicePollOutcome, GithubPrSearchItem, GithubUserRef, SessionData, User,
};
