/// Returned by `device_start`. Carries the device code, the user-facing code,
/// the URL where the user types it, and the polling/expiry hints (seconds).
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// Stage user identity returned by `device_poll` (on success) and `auth_me`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct User {
    pub id: i64,
    pub github_login: String,
    pub github_user_id: i64,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Returned inside `DevicePollOutcome::Authorized` on successful login.
///
/// `session_token` is the raw `stg_…` opaque Bearer string. **Do not log it.**
/// `SessionData` deliberately does NOT derive `Debug` to block `{:?}` formatting.
/// `SessionData` is intentionally move-only (no `Clone`): callers destructure once
/// into `session_token: String` + `user: User` and own each piece — one heap copy
/// of the token at a time.
/// Per `docs/design.md` (see "Authentication" section) the token is long-lived until user-initiated logout.
#[derive(serde::Deserialize)]
pub struct SessionData {
    pub session_token: String,
    pub user: User,
}

/// Caller-facing outcome of one `device_poll` call. The caller's loop picks
/// the next action based on which variant matches.
#[non_exhaustive]
pub enum DevicePollOutcome {
    /// GitHub returned `authorization_pending` — keep polling at the same cadence.
    Pending,
    /// GitHub returned `slow_down` — caller must add 5 s to its polling interval (RFC 8628 § 3.5).
    SlowDown,
    /// User completed the device-flow — caller persists the session_token.
    Authorized(SessionData),
    /// `device_code` expired — the deadline set by `device_start`'s `expires_in` has passed.
    Expired,
    /// User clicked deny on the GitHub authorize page.
    Denied,
}

// Manual Debug: redact the Authorized payload so session_token never appears in logs.
impl std::fmt::Debug for DevicePollOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "Pending"),
            Self::SlowDown => write!(f, "SlowDown"),
            Self::Authorized(_) => write!(f, "Authorized(<redacted>)"),
            Self::Expired => write!(f, "Expired"),
            Self::Denied => write!(f, "Denied"),
        }
    }
}

// Internal wire shape: backend returns `{"status": "pending"}` or
// `{"status": "ok", "session_token": ..., "user": ...}` on 200.
#[derive(serde::Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(super) enum DevicePollSuccess {
    Pending,
    Ok { session_token: String, user: User },
}

/// Raw github search-issues item, forwarded unchanged by the backend's
/// thin github proxy at `GET /api/v1/github/prs/`. Only the fields the
/// client renders are deserialized; unknown keys are tolerated.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct GithubPrSearchItem {
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub repository_url: String,
    pub updated_at: String,
    pub user: GithubUserRef,
}

/// Nested github user reference (just `login` + optional `avatar_url`).
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct GithubUserRef {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devicecode_deserializes_from_api_md_shape() {
        let json = serde_json::json!({
            "device_code": "abc123",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900
        });
        let dc: DeviceCode = serde_json::from_value(json).unwrap();
        assert_eq!(dc.device_code, "abc123");
        assert_eq!(dc.user_code, "ABCD-1234");
        assert_eq!(dc.verification_uri, "https://github.com/login/device");
        assert_eq!(dc.interval, 5);
        assert_eq!(dc.expires_in, 900);
    }

    #[test]
    fn user_deserializes_with_optional_fields_present() {
        let json = serde_json::json!({
            "id": 42,
            "github_login": "octocat",
            "github_user_id": 583231,
            "display_name": "The Octocat",
            "avatar_url": "https://avatars.example/o"
        });
        let u: User = serde_json::from_value(json).unwrap();
        assert_eq!(u.github_login, "octocat");
        assert_eq!(u.display_name.as_deref(), Some("The Octocat"));
    }

    #[test]
    fn user_deserializes_with_optional_fields_null() {
        let json = serde_json::json!({
            "id": 42,
            "github_login": "octocat",
            "github_user_id": 583231,
            "display_name": null,
            "avatar_url": null
        });
        let u: User = serde_json::from_value(json).unwrap();
        assert!(u.display_name.is_none());
        assert!(u.avatar_url.is_none());
    }

    #[test]
    fn session_data_deserializes() {
        let json = serde_json::json!({
            "session_token": "stg_eyJhbG_opaque",
            "user": {
                "id": 42,
                "github_login": "octocat",
                "github_user_id": 583231,
                "display_name": null,
                "avatar_url": null
            }
        });
        let s: SessionData = serde_json::from_value(json).unwrap();
        assert_eq!(s.session_token, "stg_eyJhbG_opaque");
        assert_eq!(s.user.github_login, "octocat");
        assert_eq!(s.user.id, 42);
    }

    #[test]
    fn devicepollsuccess_pending() {
        let json = serde_json::json!({"status": "pending"});
        let s: DevicePollSuccess = serde_json::from_value(json).unwrap();
        assert!(matches!(s, DevicePollSuccess::Pending));
    }

    #[test]
    fn devicepollsuccess_ok() {
        let json = serde_json::json!({
            "status": "ok",
            "session_token": "stg_abc",
            "user": {
                "id": 1, "github_login": "u", "github_user_id": 1,
                "display_name": null, "avatar_url": null
            }
        });
        let s: DevicePollSuccess = serde_json::from_value(json).unwrap();
        match s {
            DevicePollSuccess::Ok {
                session_token,
                user,
            } => {
                assert_eq!(session_token, "stg_abc");
                assert_eq!(user.id, 1);
                assert_eq!(user.github_login, "u");
            }
            _ => panic!("expected Ok variant"),
        }
    }

    #[test]
    fn github_pr_search_item_deserializes_from_raw_github_shape() {
        // Mirrors the actual github search-issues response items the backend
        // forwards unchanged at GET /api/v1/github/prs/.
        let json = serde_json::json!({
            "number": 483,
            "title": "Rewrite README onboarding section",
            "html_url": "https://github.com/acme/payments/pull/483",
            "repository_url": "https://api.github.com/repos/acme/payments",
            "updated_at": "2026-05-23T07:00:00Z",
            "user": {
                "login": "octocat",
                "avatar_url": "https://avatars.example/o"
            },
            // Extra github-search keys we don't care about; the deserializer
            // must ignore them.
            "state": "open",
            "labels": []
        });
        let item: GithubPrSearchItem = serde_json::from_value(json).unwrap();
        assert_eq!(item.number, 483);
        assert_eq!(item.title, "Rewrite README onboarding section");
        assert_eq!(
            item.repository_url,
            "https://api.github.com/repos/acme/payments"
        );
        assert_eq!(item.user.login, "octocat");
        assert_eq!(
            item.user.avatar_url.as_deref(),
            Some("https://avatars.example/o")
        );
    }

    #[test]
    fn github_user_ref_deserializes_with_null_avatar() {
        let json = serde_json::json!({ "login": "ghost", "avatar_url": null });
        let u: GithubUserRef = serde_json::from_value(json).unwrap();
        assert_eq!(u.login, "ghost");
        assert!(u.avatar_url.is_none());
    }
}
