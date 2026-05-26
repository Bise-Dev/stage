use super::client::Client;
use super::error::Error;
use super::types::{SessionData, User};

impl Client {
    pub async fn web_exchange(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
    ) -> Result<SessionData, Error> {
        let url = self.base_url.join("api/v1/auth/web/exchange/").unwrap();
        let resp = self
            .http
            .post(url)
            .json(&serde_json::json!({
                "code": code,
                "code_verifier": code_verifier,
                "redirect_uri": redirect_uri,
            }))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json::<SessionData>()
            .await
            .map_err(|e| Self::json_err(status, e))
    }

    /// `GET /api/v1/auth/me/` — returns the user currently bound to `token`.
    pub async fn auth_me(&self, token: &str) -> Result<User, Error> {
        let url = self.base_url.join("api/v1/auth/me/").unwrap();
        tracing::debug!(url = %url, "GET auth/me");
        let resp = self.http.get(url).bearer_auth(token).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let err = Self::map_error(resp).await;
            tracing::warn!(err = %err, "auth_me non-2xx");
            return Err(err);
        }
        resp.json::<User>().await.map_err(|e| Self::json_err(status, e))
    }

    /// `POST /api/v1/auth/logout/` — revokes the session server-side.
    ///
    /// **Caller responsibility:** clear the local copy of `token` (memory,
    /// keychain) after this returns `Ok(())`. The SDK is stateless and has
    /// no local copy to clear; the server sets `revoked_at` on the session
    /// but the raw token string still lives in caller memory.
    pub async fn logout(&self, token: &str) -> Result<(), Error> {
        let url = self.base_url.join("api/v1/auth/logout/").unwrap();
        tracing::debug!(url = %url, "POST auth/logout");
        let resp = self.http.post(url).bearer_auth(token).send().await?;
        if !resp.status().is_success() {
            let err = Self::map_error(resp).await;
            tracing::warn!(err = %err, "logout non-2xx");
            return Err(err);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use wiremock::matchers::{header, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::client::Client;
    use super::super::error::Error;

    #[tokio::test]
    async fn web_exchange_returns_session_data_on_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/web/exchange/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "ok",
                "session_token": "stg_AAAA",
                "user": {
                    "id": 7,
                    "github_login": "alice",
                    "github_user_id": 12345,
                    "display_name": "Alice",
                    "avatar_url": "https://a.example/alice.png"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let result = client
            .web_exchange("code_abc", &"v".repeat(43), "http://127.0.0.1:1234/cb")
            .await
            .expect("ok");
        assert_eq!(result.session_token, "stg_AAAA");
        assert_eq!(result.user.github_login, "alice");
    }

    #[tokio::test]
    async fn web_exchange_maps_400_github_code_invalid_to_domain_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/web/exchange/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "message": "github_code_invalid",
                "extra": {"error": "bad_verification_code"}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let result = client
            .web_exchange("bad", &"v".repeat(43), "http://127.0.0.1:1234/cb")
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn web_exchange_maps_502_to_backend_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/web/exchange/"))
            .respond_with(ResponseTemplate::new(502))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let result = client
            .web_exchange("c", &"v".repeat(43), "http://127.0.0.1:1234/cb")
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn auth_me_ok() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "github_login": "octocat",
                "github_user_id": 583231,
                "display_name": "Octo",
                "avatar_url": null
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let u = client.auth_me("stg_abc").await.unwrap();
        assert_eq!(u.github_login, "octocat");
    }

    #[tokio::test]
    async fn auth_me_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.auth_me("stg_bad").await.unwrap_err();
        assert!(matches!(err, Error::Unauthenticated));
    }

    #[tokio::test]
    async fn auth_me_bearer_header_value_exact() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .and(header("authorization", "Bearer stg_abc123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 1,
                "github_login": "u",
                "github_user_id": 1,
                "display_name": null,
                "avatar_url": null
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client.auth_me("stg_abc123").await.unwrap();
    }

    #[tokio::test]
    async fn auth_me_401_bare_no_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.auth_me("stg_bad").await.unwrap_err();
        assert!(matches!(err, Error::Unauthenticated), "got {err:?}");
    }

    #[tokio::test]
    async fn auth_me_200_with_bad_body_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json at all"))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.auth_me("stg_abc").await.unwrap_err();
        assert!(
            matches!(&err, Error::Unexpected { status, .. } if status.as_u16() == 200),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn logout_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/logout/"))
            .and(header_exists("authorization"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client.logout("stg_abc").await.unwrap();
    }

    #[tokio::test]
    async fn logout_401_unauthenticated() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/logout/"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "unauthenticated",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.logout("stg_bad").await.unwrap_err();
        assert!(matches!(err, Error::Unauthenticated));
    }

    #[tokio::test]
    async fn logout_bearer_header_value_exact() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/logout/"))
            .and(header("authorization", "Bearer stg_abc123"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        client.logout("stg_abc123").await.unwrap();
    }

    #[tokio::test]
    async fn logout_401_bare_no_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/logout/"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.logout("stg_bad").await.unwrap_err();
        assert!(matches!(err, Error::Unauthenticated), "got {err:?}");
    }

    // #7 — Validation branch in map_error
    #[tokio::test]
    async fn auth_me_400_validation_error_maps_to_validation() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/auth/me/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "message": "validation_error",
                "extra": {"field": "x"}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.auth_me("stg_tok").await.unwrap_err();
        match err {
            Error::Validation { extra } => {
                assert_eq!(extra.get("field").and_then(|v| v.as_str()), Some("x"));
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    // #8 — valid JSON with no `message` key falls back to raw body (using web_exchange)
    #[tokio::test]
    async fn web_exchange_400_no_message_key_falls_back_to_raw_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/web/exchange/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "foo": "bar"
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        match client
            .web_exchange("c", &"v".repeat(43), "http://127.0.0.1:1234/cb")
            .await
        {
            Err(Error::Unexpected { message, extra, .. }) => {
                assert!(message.contains("foo"), "expected raw body, got {message:?}");
                assert!(extra.is_null());
            }
            Err(other) => panic!("expected Unexpected, got {other:?}"),
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[tokio::test]
    async fn with_timeout_honored_on_slow_server() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/web/exchange/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(2_000)),
            )
            .mount(&server)
            .await;

        let client =
            Client::with_timeout(server.uri(), Duration::from_millis(50)).unwrap();
        match client
            .web_exchange("c", &"v".repeat(43), "http://127.0.0.1:1234/cb")
            .await
        {
            Err(Error::Transport(_)) => {}
            Err(other) => panic!("expected Transport, got {other:?}"),
            Ok(_) => panic!("expected error, got Ok"),
        }
    }
}
