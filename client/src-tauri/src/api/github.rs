use super::client::Client;
use super::error::Error;
use super::types::GithubPrSearchItem;

impl Client {
    pub async fn github_prs(
        &self,
        token: &str,
        role: &str,
    ) -> Result<Vec<GithubPrSearchItem>, Error> {
        let mut url = self.base_url.join("api/v1/github/prs/").unwrap();
        url.query_pairs_mut().append_pair("role", role);
        let resp = self.send(self.http.get(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        #[derive(serde::Deserialize)]
        struct Envelope {
            items: Vec<GithubPrSearchItem>,
        }
        let body: Envelope = resp.json().await.map_err(|e| Self::json_err(status, e))?;
        Ok(body.items)
    }

    /// The GitHub file object for one path in a PR — patch text + status +
    /// additions/deletions (raw, as the backend proxies it from GitHub). Powers
    /// the reviewer storyline viewer, which never had the branch locally and so
    /// reads each step's diff from the PR on GitHub (ADR-0001: via the backend).
    /// A path no longer in the PR (a stale step) surfaces as the backend's 404,
    /// mapped verbatim through `map_error` — the caller decides how to render it.
    pub async fn pr_file_diff(
        &self,
        token: &str,
        o: &str,
        r: &str,
        n: i64,
        file_path: &str,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!(
                "api/v1/repos/{o}/{r}/pulls/{n}/files/{file_path}/diff/"
            ))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let resp = self.send(self.http.get(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{header_exists, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::client::Client;
    use super::super::error::Error;

    #[tokio::test]
    async fn github_prs_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .and(query_param("role", "author"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    {
                        "number": 42,
                        "title": "My PR",
                        "html_url": "https://github.com/org/repo/pull/42",
                        "repository_url": "https://api.github.com/repos/org/repo",
                        "updated_at": "2026-05-26T12:00:00Z",
                        "user": { "login": "alice", "avatar_url": "https://a.example/alice.png" }
                    }
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let items = client.github_prs("stg_abc", "author").await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].number, 42);
        assert_eq!(items[0].title, "My PR");
        assert_eq!(
            items[0].repository_url,
            "https://api.github.com/repos/org/repo"
        );
        assert_eq!(items[0].user.login, "alice");
    }

    #[tokio::test]
    async fn github_prs_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.github_prs("stg_bad", "author").await.unwrap_err();
        assert!(matches!(err, Error::Unauthenticated));
    }

    #[tokio::test]
    async fn github_prs_empty_list() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": []
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let items = client.github_prs("stg_abc", "reviewer").await.unwrap();
        assert!(items.is_empty());
    }

    #[tokio::test]
    async fn pr_file_diff_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(
                "/api/v1/repos/org/repo/pulls/42/files/src/main.rs/diff/",
            ))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "filename": "src/main.rs",
                "status": "modified",
                "additions": 3,
                "deletions": 1,
                "patch": "@@ -1,1 +1,3 @@\n-old\n+new\n+more"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let diff = client
            .pr_file_diff("stg_abc", "org", "repo", 42, "src/main.rs")
            .await
            .unwrap();
        assert_eq!(diff["filename"], "src/main.rs");
        assert_eq!(diff["status"], "modified");
        assert_eq!(diff["additions"], 3);
    }

    #[tokio::test]
    async fn pr_file_diff_404_unexpected() {
        // A path no longer in the PR (stale step): the backend answers 404. We
        // surface it rather than masking it as an empty diff (fail-loud).
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/org/repo/pulls/42/files/gone.rs/diff/"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .pr_file_diff("stg_abc", "org", "repo", 42, "gone.rs")
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Unexpected { status, .. } if status == 404));
    }

    #[tokio::test]
    async fn pr_file_diff_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/org/repo/pulls/42/files/src/x.rs/diff/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .pr_file_diff("stg_bad", "org", "repo", 42, "src/x.rs")
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Unauthenticated));
    }
}
