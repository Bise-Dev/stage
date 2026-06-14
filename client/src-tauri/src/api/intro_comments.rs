use super::client::Client;
use super::error::Error;

/// SDK for IntroComments — Stage-native threaded discussion on a storyline
/// step's intro. Unlike the PR-anchored comment methods in `github.rs`, these
/// never touch GitHub (ADR-0001 — IntroComments have no GitHub counterpart);
/// they read/write the Stage backend's own thread. The backend enforces the
/// rules (pre-publish → creator-only; post-publish → anyone; depth ≤ 2;
/// resolve = workspace creator on roots only; frozen workspace → 409
/// `workspace_frozen`); the client surfaces any rejection verbatim.
impl Client {
    /// List the intro-comment thread for one storyline step (roots, each with a
    /// nested `replies` array). `include_resolved=false` (default) hides
    /// resolved roots. GET
    /// /api/v1/workspaces/{id}/storyline/files/{file_id}/intro-comments/.
    pub async fn intro_comments_list(
        &self,
        token: &str,
        workspace_id: &str,
        file_id: &str,
        include_resolved: bool,
    ) -> Result<serde_json::Value, Error> {
        let mut url = self
            .base_url
            .join(&format!(
                "api/v1/workspaces/{workspace_id}/storyline/files/{file_id}/intro-comments/"
            ))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        if include_resolved {
            url.query_pairs_mut()
                .append_pair("include_resolved", "true");
        }
        let resp = self.send(self.http.get(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Post an intro-comment (a root, or a reply when `parent_id` is set). POST
    /// .../intro-comments/ with `{ body, parent_id? }`. Returns the created
    /// comment. A reply to a reply (depth > 2) or a frozen workspace comes back
    /// as the backend's `400` / `409`, surfaced verbatim.
    pub async fn intro_comment_create(
        &self,
        token: &str,
        workspace_id: &str,
        file_id: &str,
        body: &str,
        parent_id: Option<&str>,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!(
                "api/v1/workspaces/{workspace_id}/storyline/files/{file_id}/intro-comments/"
            ))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let mut payload = serde_json::json!({ "body": body });
        if let Some(pid) = parent_id {
            payload["parent_id"] = serde_json::Value::String(pid.to_string());
        }
        let resp = self
            .send(self.http.post(url).bearer_auth(token).json(&payload))
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Edit an intro-comment's body (author only — backend 403s otherwise).
    /// PATCH /api/v1/intro-comments/{comment_id}/ with `{ body }`.
    pub async fn intro_comment_update(
        &self,
        token: &str,
        comment_id: &str,
        body: &str,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/intro-comments/{comment_id}/"))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let payload = serde_json::json!({ "body": body });
        let resp = self
            .send(self.http.patch(url).bearer_auth(token).json(&payload))
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Soft-delete an intro-comment (author only). POST
    /// /api/v1/intro-comments/{comment_id}/delete/. Returns () — the backend
    /// replies 204 with no body.
    pub async fn intro_comment_delete(&self, token: &str, comment_id: &str) -> Result<(), Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/intro-comments/{comment_id}/delete/"))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let resp = self.send(self.http.post(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        Ok(())
    }

    /// Resolve a root intro-comment (workspace creator only; roots only). POST
    /// /api/v1/intro-comments/{comment_id}/resolve/. Returns the updated comment.
    pub async fn intro_comment_resolve(
        &self,
        token: &str,
        comment_id: &str,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/intro-comments/{comment_id}/resolve/"))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let resp = self.send(self.http.post(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Unresolve a previously-resolved root intro-comment (workspace creator
    /// only). POST /api/v1/intro-comments/{comment_id}/unresolve/.
    pub async fn intro_comment_unresolve(
        &self,
        token: &str,
        comment_id: &str,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/intro-comments/{comment_id}/unresolve/"))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let resp = self.send(self.http.post(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{body_partial_json, header_exists, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::client::Client;
    use super::super::error::Error;

    const WS: &str = "11111111-1111-1111-1111-111111111111";
    const FILE: &str = "22222222-2222-2222-2222-222222222222";
    const CID: &str = "33333333-3333-3333-3333-333333333333";

    #[tokio::test]
    async fn intro_comments_list_default_omits_query() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/api/v1/workspaces/{WS}/storyline/files/{FILE}/intro-comments/"
            )))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "id": CID, "user": { "id": 1, "github_login": "a" }, "body": "why 60s?",
                  "parent_id": null, "created_at": "2026-06-14T00:00:00Z",
                  "resolved_at": null, "resolved_by": null, "replies": [] }
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client
            .intro_comments_list("stg_abc", WS, FILE, false)
            .await
            .unwrap();
        assert_eq!(v[0]["body"], "why 60s?");
    }

    #[tokio::test]
    async fn intro_comments_list_include_resolved_sets_query() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/api/v1/workspaces/{WS}/storyline/files/{FILE}/intro-comments/"
            )))
            .and(query_param("include_resolved", "true"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client
            .intro_comments_list("stg_abc", WS, FILE, true)
            .await
            .unwrap();
        assert!(v.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn intro_comment_create_root_omits_parent() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!(
                "/api/v1/workspaces/{WS}/storyline/files/{FILE}/intro-comments/"
            )))
            .and(body_partial_json(serde_json::json!({ "body": "hi" })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": CID, "body": "hi", "parent_id": null
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client
            .intro_comment_create("stg_abc", WS, FILE, "hi", None)
            .await
            .unwrap();
        assert_eq!(v["id"], CID);
    }

    #[tokio::test]
    async fn intro_comment_create_reply_sends_parent_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!(
                "/api/v1/workspaces/{WS}/storyline/files/{FILE}/intro-comments/"
            )))
            .and(body_partial_json(
                serde_json::json!({ "body": "re", "parent_id": CID }),
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "44444444-4444-4444-4444-444444444444", "parent_id": CID
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client
            .intro_comment_create("stg_abc", WS, FILE, "re", Some(CID))
            .await
            .unwrap();
        assert_eq!(v["parent_id"], CID);
    }

    #[tokio::test]
    async fn intro_comment_create_frozen_409() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!(
                "/api/v1/workspaces/{WS}/storyline/files/{FILE}/intro-comments/"
            )))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "message": "This workspace is frozen — its GitHub PR is closed or merged.",
                "extra": { "code": "workspace_frozen" }
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .intro_comment_create("stg_abc", WS, FILE, "x", None)
            .await
            .unwrap_err();
        match err {
            Error::Unexpected {
                status, message, ..
            } => {
                assert_eq!(status.as_u16(), 409);
                assert!(message.contains("frozen"), "message was: {message}");
            }
            other => panic!("expected Unexpected 409, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn intro_comment_update_patches_body() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path(format!("/api/v1/intro-comments/{CID}/")))
            .and(body_partial_json(serde_json::json!({ "body": "edited" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": CID, "body": "edited"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client
            .intro_comment_update("stg_abc", CID, "edited")
            .await
            .unwrap();
        assert_eq!(v["body"], "edited");
    }

    #[tokio::test]
    async fn intro_comment_delete_204() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/api/v1/intro-comments/{CID}/delete/")))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client.intro_comment_delete("stg_abc", CID).await.unwrap();
    }

    #[tokio::test]
    async fn intro_comment_resolve_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/api/v1/intro-comments/{CID}/resolve/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": CID, "resolved_at": "2026-06-14T01:00:00Z"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client.intro_comment_resolve("stg_abc", CID).await.unwrap();
        assert_eq!(v["id"], CID);
    }

    #[tokio::test]
    async fn intro_comment_unresolve_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/api/v1/intro-comments/{CID}/unresolve/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": CID, "resolved_at": null
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client
            .intro_comment_unresolve("stg_abc", CID)
            .await
            .unwrap();
        assert!(v["resolved_at"].is_null());
    }
}
