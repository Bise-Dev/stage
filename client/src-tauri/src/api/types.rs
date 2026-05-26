/// Stage user identity returned by `auth_me`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct User {
    pub id: i64,
    pub github_login: String,
    pub github_user_id: i64,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Returned by `web_exchange` on successful login.
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

/// GitHub user reference embedded in search result items.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct GithubUserRef {
    pub login: String,
    pub avatar_url: Option<String>,
}

/// A single PR item returned by `GET /api/v1/github/prs/`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct GithubPrSearchItem {
    pub number: i64,
    pub title: String,
    pub html_url: String,
    pub repository_url: String,
    pub updated_at: String,
    pub user: GithubUserRef,
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
