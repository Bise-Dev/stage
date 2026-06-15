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
/// Per ADR-0008 / ADR-0006 the token is long-lived until user-initiated logout.
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

/// One storyline step as returned by GET/PUT `/workspaces/{id}/storyline/`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct StorylineFileDto {
    pub id: String,
    pub diff_file_path: String,
    pub order_index: i64,
    pub intro_text: String,
    pub stale: bool,
    pub stale_reason: Option<String>,
}

/// The full storyline payload (`storyline_read` shape). `etag` drives optimistic
/// concurrency on PUT; `head_sha` is null pre-publish.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct StorylineDto {
    pub etag: String,
    pub head_sha: Option<String>,
    pub files: Vec<StorylineFileDto>,
}

/// One step as sent from the webview into the `storyline_update` command.
/// camelCase on the wire (webview convention); the SDK maps it to the backend's
/// snake_case body explicitly (see `Client::storyline_update`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorylineFileWrite {
    pub diff_file_path: String,
    pub order_index: i64,
    pub intro_text: String,
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

    #[test]
    fn storyline_dto_deserializes_backend_payload() {
        let json = serde_json::json!({
            "etag": "e1",
            "head_sha": null,
            "files": [
                {
                    "id": "11111111-1111-1111-1111-111111111111",
                    "diff_file_path": "src/a.py",
                    "order_index": 0,
                    "intro_text": "why a",
                    "stale": false,
                    "stale_reason": null
                }
            ]
        });
        let dto: StorylineDto = serde_json::from_value(json).unwrap();
        assert_eq!(dto.etag, "e1");
        assert!(dto.head_sha.is_none());
        assert_eq!(dto.files.len(), 1);
        assert_eq!(dto.files[0].diff_file_path, "src/a.py");
        assert_eq!(dto.files[0].intro_text, "why a");
    }

    #[test]
    fn storyline_file_write_reads_camelcase_from_webview() {
        let json = serde_json::json!({
            "diffFilePath": "src/a.py",
            "orderIndex": 2,
            "introText": "note"
        });
        let w: StorylineFileWrite = serde_json::from_value(json).unwrap();
        assert_eq!(w.diff_file_path, "src/a.py");
        assert_eq!(w.order_index, 2);
        assert_eq!(w.intro_text, "note");
    }
}
