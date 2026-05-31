use super::client::Client;
use super::error::Error;
use super::types::{StorylineDto, StorylineFileWrite};

impl Client {
    /// Create a Stage workspace (pure backend DB record; no GitHub call).
    /// POST /api/v1/workspaces/. Returns the created workspace as raw JSON —
    /// the webview re-fetches the overview rather than mapping this body.
    pub async fn workspace_create(
        &self,
        token: &str,
        repo_owner: &str,
        repo_name: &str,
        head_ref: &str,
        base_ref: &str,
        title: &str,
    ) -> Result<serde_json::Value, Error> {
        let url = self.base_url.join("api/v1/workspaces/").unwrap();
        let body = serde_json::json!({
            "repo_owner": repo_owner,
            "repo_name": repo_name,
            "head_ref": head_ref,
            "base_ref": base_ref,
            "title": title,
        });
        let resp = self
            .http
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Read a workspace's storyline. GET /api/v1/workspaces/{id}/storyline/.
    /// `etag` in the returned body drives optimistic concurrency on update.
    pub async fn storyline_get(
        &self,
        token: &str,
        workspace_id: &str,
    ) -> Result<StorylineDto, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/workspaces/{workspace_id}/storyline/"))
            .unwrap();
        let resp = self.http.get(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Replace a workspace's storyline. PUT /api/v1/workspaces/{id}/storyline/
    /// with `If-Match: <etag>` (optimistic concurrency; 409 etag_mismatch on
    /// stale etag, 412 if the header is missing). Returns the re-read payload
    /// with the freshly minted etag.
    pub async fn storyline_update(
        &self,
        token: &str,
        workspace_id: &str,
        etag: &str,
        files: &[StorylineFileWrite],
    ) -> Result<StorylineDto, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/workspaces/{workspace_id}/storyline/"))
            .unwrap();
        let body = serde_json::json!({
            "files": files
                .iter()
                .map(|f| serde_json::json!({
                    "diff_file_path": f.diff_file_path,
                    "order_index": f.order_index,
                    "intro_text": f.intro_text,
                }))
                .collect::<Vec<_>>(),
        });
        let resp = self
            .http
            .put(url)
            .bearer_auth(token)
            .header("If-Match", etag)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Delete a pre-publish Stage workspace. DELETE /api/v1/workspaces/{id}/.
    /// Returns () — the backend replies 204 with no body, so nothing is parsed.
    pub async fn workspace_delete(&self, token: &str, workspace_id: &str) -> Result<(), Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/workspaces/{workspace_id}/"))
            .unwrap();
        let resp = self.http.delete(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{body_partial_json, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::client::Client;
    use super::super::error::Error;

    #[tokio::test]
    async fn workspace_create_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/"))
            .and(header_exists("authorization"))
            .and(body_partial_json(serde_json::json!({
                "repo_owner": "o",
                "repo_name": "r",
                "head_ref": "feat/x",
                "base_ref": "main",
                "title": "T"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "11111111-1111-1111-1111-111111111111",
                "head_ref": "feat/x"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let v = client
            .workspace_create("stg_abc", "o", "r", "feat/x", "main", "T")
            .await
            .unwrap();
        assert_eq!(v["head_ref"], "feat/x");
    }

    #[tokio::test]
    async fn workspace_create_duplicate_409() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/workspaces/"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "message": "A workspace already exists for that branch in this repo.",
                "extra": { "code": "workspace_exists", "head_ref": "feat/x" }
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .workspace_create("stg_abc", "o", "r", "feat/x", "main", "")
            .await
            .unwrap_err();
        match err {
            Error::Unexpected {
                status, message, ..
            } => {
                assert_eq!(status.as_u16(), 409);
                assert!(message.contains("already exists"), "message was: {message}");
            }
            other => panic!("expected Unexpected 409, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn workspace_delete_ok() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(
                "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/",
            ))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client
            .workspace_delete("stg_abc", "11111111-1111-1111-1111-111111111111")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn storyline_get_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(
                "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/storyline/",
            ))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "etag": "e1",
                "head_sha": null,
                "files": [{
                    "id": "22222222-2222-2222-2222-222222222222",
                    "diff_file_path": "src/a.py",
                    "order_index": 0,
                    "intro_text": "why",
                    "stale": false,
                    "stale_reason": null
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let dto = client
            .storyline_get("stg_abc", "11111111-1111-1111-1111-111111111111")
            .await
            .unwrap();
        assert_eq!(dto.etag, "e1");
        assert_eq!(dto.files.len(), 1);
        assert_eq!(dto.files[0].diff_file_path, "src/a.py");
    }

    #[tokio::test]
    async fn storyline_update_sends_if_match_and_snake_case_body() {
        use crate::api::types::StorylineFileWrite;
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path(
                "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/storyline/",
            ))
            .and(header_exists("authorization"))
            .and(header_exists("if-match"))
            .and(body_partial_json(serde_json::json!({
                "files": [{ "diff_file_path": "src/a.py", "order_index": 0, "intro_text": "why" }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "etag": "e2",
                "head_sha": null,
                "files": [{
                    "id": "22222222-2222-2222-2222-222222222222",
                    "diff_file_path": "src/a.py",
                    "order_index": 0,
                    "intro_text": "why",
                    "stale": false,
                    "stale_reason": null
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let files = vec![StorylineFileWrite {
            diff_file_path: "src/a.py".into(),
            order_index: 0,
            intro_text: "why".into(),
        }];
        let dto = client
            .storyline_update(
                "stg_abc",
                "11111111-1111-1111-1111-111111111111",
                "e1",
                &files,
            )
            .await
            .unwrap();
        assert_eq!(dto.etag, "e2");
    }

    #[tokio::test]
    async fn workspace_delete_published_409() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(
                "/api/v1/workspaces/22222222-2222-2222-2222-222222222222/",
            ))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "message": "Can't discard a published workspace; close its PR on GitHub instead",
                "extra": { "pr_number": 42 }
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .workspace_delete("stg_abc", "22222222-2222-2222-2222-222222222222")
            .await
            .unwrap_err();
        match err {
            Error::Unexpected {
                status, message, ..
            } => {
                assert_eq!(status.as_u16(), 409);
                assert!(message.contains("published"), "message was: {message}");
            }
            other => panic!("expected Unexpected 409, got {other:?}"),
        }
    }
}
