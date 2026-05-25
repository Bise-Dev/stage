use super::client::Client;
use super::error::Error;
use super::types::GithubPrSearchItem;

impl Client {
    /// `GET /api/v1/github/prs/?role=<role>` — list authed user's open PRs
    /// (the backend cross-filters out PRs that already have a Stage workspace).
    /// Returns the raw github search-issue items unchanged.
    pub async fn github_prs(
        &self,
        token: &str,
        role: &str,
    ) -> Result<Vec<GithubPrSearchItem>, Error> {
        let mut url = self.base_url.join("api/v1/github/prs/").unwrap();
        url.query_pairs_mut().append_pair("role", role);
        tracing::debug!(url = %url, "GET github/prs");
        let resp = self.http.get(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let err = Self::map_error(resp).await;
            tracing::warn!(err = %err, "github_prs non-2xx");
            return Err(err);
        }
        #[derive(serde::Deserialize)]
        struct Envelope {
            items: Vec<GithubPrSearchItem>,
        }
        let body: Envelope = resp.json().await.map_err(|e| Self::json_err(status, e))?;
        Ok(body.items)
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{header, header_exists, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::client::Client;
    use super::super::error::Error;

    #[tokio::test]
    async fn github_prs_ok_returns_items() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .and(query_param("role", "author"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "number": 482,
                    "title": "Replace legacy checkout",
                    "html_url": "https://github.com/acme/payments/pull/482",
                    "repository_url": "https://api.github.com/repos/acme/payments",
                    "updated_at": "2026-05-23T07:00:00Z",
                    "user": { "login": "octocat", "avatar_url": null }
                }],
                "count": 1
            })))
            .mount(&server)
            .await;

        let client = Client::new(server.uri()).unwrap();
        let prs = client.github_prs("stg_abc", "author").await.unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 482);
        assert_eq!(prs[0].title, "Replace legacy checkout");
        assert_eq!(prs[0].user.login, "octocat");
    }

    #[tokio::test]
    async fn github_prs_empty_list() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [],
                "count": 0
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let prs = client.github_prs("stg_abc", "author").await.unwrap();
        assert!(prs.is_empty());
    }

    #[tokio::test]
    async fn github_prs_401_maps_to_unauthenticated() {
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
        assert!(matches!(err, Error::Unauthenticated), "got {err:?}");
    }

    #[tokio::test]
    async fn github_prs_500_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(500).set_body_string("internal"))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.github_prs("stg_abc", "author").await.unwrap_err();
        match err {
            Error::Unexpected { status, .. } => assert_eq!(status.as_u16(), 500),
            other => panic!("expected Unexpected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn github_prs_200_with_bad_body_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json at all"))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.github_prs("stg_abc", "author").await.unwrap_err();
        assert!(
            matches!(&err, Error::Unexpected { status, .. } if status.as_u16() == 200),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn github_prs_bearer_header_value_exact() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .and(header("authorization", "Bearer stg_abc123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [],
                "count": 0
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client.github_prs("stg_abc123", "author").await.unwrap();
    }

    #[tokio::test]
    async fn github_prs_role_query_param_honored() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/github/prs/"))
            .and(query_param("role", "reviewer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [],
                "count": 0
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client.github_prs("stg_abc", "reviewer").await.unwrap();
    }
}
