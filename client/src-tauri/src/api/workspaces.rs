use super::client::Client;
use super::error::Error;

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
                "message": "Workspace already exists for that repo + head_ref",
                "extra": { "head_ref": "feat/x" }
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
}
