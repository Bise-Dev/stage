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

    /// The PR's comments, as the backend proxies them from GitHub:
    /// `{ "issue": [...], "review": [...] }` — issue (PR-level) comments and
    /// review (line-anchored) comments, **including those left by non-Stage
    /// participants on github.com** (ADR-0003: GitHub is the source of truth for
    /// review state). Raw GitHub shapes flow through untyped; the reviewer viewer
    /// anchors review comments inline by their `path`/`line`/`side` and threads
    /// replies via `in_reply_to_id`.
    pub async fn pr_comments(
        &self,
        token: &str,
        o: &str,
        r: &str,
        n: i64,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/repos/{o}/{r}/pulls/{n}/comments/"))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let resp = self.send(self.http.get(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// The PR's reviews (each carrying `state`: APPROVED / CHANGES_REQUESTED /
    /// COMMENTED / DISMISSED / PENDING, plus `user`, `body`, `submitted_at`), as
    /// the backend proxies them from GitHub. Powers the reviewer viewer's review-
    /// decision banner — the latest non-pending state per reviewer, **non-Stage
    /// reviewers included** (ADR-0003).
    pub async fn pr_reviews(
        &self,
        token: &str,
        o: &str,
        r: &str,
        n: i64,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/repos/{o}/{r}/pulls/{n}/reviews/"))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let resp = self.send(self.http.get(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Post a comment on a PR, write-through to GitHub as the signed-in user
    /// (ADR-0003) — so non-Stage participants on the same PR see it. The caller
    /// builds the full body: `{ kind, body, path?, line?, side?, commit_id?,
    /// in_reply_to? }` (a fresh review line comment needs `path`+`line`+`side`+
    /// `commit_id`; a reply needs `in_reply_to`+`body`; an issue comment just
    /// `kind:"issue"`+`body`). The backend validates the shape and surfaces a
    /// frozen workspace as `409` / GitHub's own error verbatim through
    /// `map_error`.
    pub async fn pr_comment_create(
        &self,
        token: &str,
        o: &str,
        r: &str,
        n: i64,
        body_json: serde_json::Value,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/repos/{o}/{r}/pulls/{n}/comments/create/"))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let resp = self
            .send(self.http.post(url).bearer_auth(token).json(&body_json))
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }

    /// Submit a review verdict on a PR, write-through to GitHub as the signed-in
    /// user (ADR-0003). `event` is `APPROVE | REQUEST_CHANGES | COMMENT`; `body`
    /// is the summary (the backend requires it non-empty); `comments` is an
    /// optional array of line comments submitted with the review. The workspace
    /// state (overview) reflects the new verdict on its next load.
    // Positional `token, o, r, n` (the PR-anchored convention every SDK method
    // here follows) plus the three review-payload fields tips this one past
    // clippy's 7-arg guidance; bundling them would only obscure the call site.
    #[allow(clippy::too_many_arguments)]
    pub async fn pr_review_create(
        &self,
        token: &str,
        o: &str,
        r: &str,
        n: i64,
        body: &str,
        event: &str,
        comments: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/repos/{o}/{r}/pulls/{n}/review/create/"))
            .map_err(|e| Error::InvalidBaseUrl(e.to_string()))?;
        let mut payload = serde_json::json!({ "body": body, "event": event });
        if let Some(comments) = comments {
            payload["comments"] = comments;
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
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{body_json, header_exists, method, path, query_param};
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

    #[tokio::test]
    async fn pr_comments_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/org/repo/pulls/42/comments/"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "issue": [
                    { "id": 1, "body": "looks good overall", "user": { "login": "bob" } }
                ],
                "review": [
                    {
                        "id": 10,
                        "path": "src/main.rs",
                        "line": 2,
                        "side": "RIGHT",
                        "body": "rename this",
                        "in_reply_to_id": null,
                        "user": { "login": "bob" }
                    }
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let body = client
            .pr_comments("stg_abc", "org", "repo", 42)
            .await
            .unwrap();
        assert_eq!(body["issue"][0]["body"], "looks good overall");
        assert_eq!(body["review"][0]["path"], "src/main.rs");
        assert_eq!(body["review"][0]["line"], 2);
    }

    #[tokio::test]
    async fn pr_comments_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/org/repo/pulls/42/comments/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .pr_comments("stg_bad", "org", "repo", 42)
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Unauthenticated));
    }

    #[tokio::test]
    async fn pr_reviews_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/org/repo/pulls/42/reviews/"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "id": 100,
                    "state": "CHANGES_REQUESTED",
                    "body": "needs work",
                    "submitted_at": "2026-05-26T12:00:00Z",
                    "user": { "login": "carol" }
                }
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let body = client
            .pr_reviews("stg_abc", "org", "repo", 42)
            .await
            .unwrap();
        assert_eq!(body[0]["state"], "CHANGES_REQUESTED");
        assert_eq!(body[0]["user"]["login"], "carol");
    }

    #[tokio::test]
    async fn pr_reviews_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/repos/org/repo/pulls/42/reviews/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .pr_reviews("stg_bad", "org", "repo", 42)
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Unauthenticated));
    }

    #[tokio::test]
    async fn pr_comment_create_review_line_ok() {
        let server = MockServer::start().await;
        // A fresh review (line) comment: the full body is forwarded verbatim and
        // GitHub answers 201 with the created comment.
        Mock::given(method("POST"))
            .and(path("/api/v1/repos/org/repo/pulls/42/comments/create/"))
            .and(header_exists("authorization"))
            .and(body_json(serde_json::json!({
                "kind": "review",
                "body": "rename this",
                "path": "src/main.rs",
                "line": 2,
                "side": "RIGHT",
                "commit_id": "deadbeef"
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 10,
                "path": "src/main.rs",
                "line": 2,
                "side": "RIGHT",
                "body": "rename this",
                "in_reply_to_id": null,
                "user": { "login": "me" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let created = client
            .pr_comment_create(
                "stg_abc",
                "org",
                "repo",
                42,
                serde_json::json!({
                    "kind": "review",
                    "body": "rename this",
                    "path": "src/main.rs",
                    "line": 2,
                    "side": "RIGHT",
                    "commit_id": "deadbeef"
                }),
            )
            .await
            .unwrap();
        assert_eq!(created["id"], 10);
        assert_eq!(created["user"]["login"], "me");
    }

    #[tokio::test]
    async fn pr_comment_create_reply_ok() {
        let server = MockServer::start().await;
        // A reply carries `in_reply_to` + `body` only.
        Mock::given(method("POST"))
            .and(path("/api/v1/repos/org/repo/pulls/42/comments/create/"))
            .and(body_json(serde_json::json!({
                "kind": "review",
                "body": "good call",
                "in_reply_to": 10
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 11,
                "in_reply_to_id": 10,
                "body": "good call",
                "user": { "login": "me" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let created = client
            .pr_comment_create(
                "stg_abc",
                "org",
                "repo",
                42,
                serde_json::json!({ "kind": "review", "body": "good call", "in_reply_to": 10 }),
            )
            .await
            .unwrap();
        assert_eq!(created["in_reply_to_id"], 10);
    }

    #[tokio::test]
    async fn pr_comment_create_409_frozen() {
        // Frozen workspace: the backend rejects the write 409. We surface it
        // rather than pretending the comment posted (fail-loud).
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/repos/org/repo/pulls/42/comments/create/"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "message": "This PR is closed — reopen on GitHub to review.",
                "extra": { "code": "workspace_frozen" }
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .pr_comment_create(
                "stg_abc",
                "org",
                "repo",
                42,
                serde_json::json!({ "kind": "issue", "body": "hi" }),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Unexpected { status, .. } if status == 409));
    }

    #[tokio::test]
    async fn pr_review_create_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/repos/org/repo/pulls/42/review/create/"))
            .and(header_exists("authorization"))
            .and(body_json(serde_json::json!({
                "body": "needs a timeout",
                "event": "REQUEST_CHANGES"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 100,
                "state": "CHANGES_REQUESTED",
                "body": "needs a timeout",
                "user": { "login": "me" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let review = client
            .pr_review_create(
                "stg_abc",
                "org",
                "repo",
                42,
                "needs a timeout",
                "REQUEST_CHANGES",
                None,
            )
            .await
            .unwrap();
        assert_eq!(review["state"], "CHANGES_REQUESTED");
    }

    #[tokio::test]
    async fn pr_review_create_with_comments_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/repos/org/repo/pulls/42/review/create/"))
            .and(body_json(serde_json::json!({
                "body": "see inline",
                "event": "COMMENT",
                "comments": [{ "path": "a.rs", "line": 3, "side": "RIGHT", "body": "nit" }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 101,
                "state": "COMMENTED"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let review = client
            .pr_review_create(
                "stg_abc",
                "org",
                "repo",
                42,
                "see inline",
                "COMMENT",
                Some(serde_json::json!([
                    { "path": "a.rs", "line": 3, "side": "RIGHT", "body": "nit" }
                ])),
            )
            .await
            .unwrap();
        assert_eq!(review["state"], "COMMENTED");
    }

    #[tokio::test]
    async fn pr_review_create_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/repos/org/repo/pulls/42/review/create/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client
            .pr_review_create("stg_bad", "org", "repo", 42, "x", "APPROVE", None)
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Unauthenticated));
    }
}
