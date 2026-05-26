use super::client::Client;
use super::error::Error;
use super::types::GithubPrSearchItem;

impl Client {
    pub async fn github_prs(&self, token: &str, role: &str) -> Result<Vec<GithubPrSearchItem>, Error> {
        let mut url = self.base_url.join("api/v1/github/prs/").unwrap();
        url.query_pairs_mut().append_pair("role", role);
        let resp = self.http.get(url).bearer_auth(token).send().await?;
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
        assert_eq!(items[0].repository_url, "https://api.github.com/repos/org/repo");
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
}
