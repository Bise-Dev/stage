use super::client::Client;
use super::error::Error;
use super::types::{DeviceCode, DevicePollOutcome, DevicePollSuccess, SessionData, User};

impl Client {
    /// `POST /api/v1/auth/device/start/` — kicks off the device flow.
    pub async fn device_start(&self) -> Result<DeviceCode, Error> {
        let url = self.base_url.join("api/v1/auth/device/start/").unwrap();
        tracing::debug!(url = %url, "POST device/start");
        let resp = self.http.post(url).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let err = Self::map_error(resp).await;
            tracing::warn!(err = %err, "device_start non-2xx");
            return Err(err);
        }
        resp.json::<DeviceCode>().await.map_err(|e| Self::json_err(status, e))
    }

    /// `POST /api/v1/auth/device/poll/` — one poll attempt.
    ///
    /// The caller drives the loop. Returns a `DevicePollOutcome` describing
    /// the terminal-or-non-terminal state of the device flow.
    pub async fn device_poll(
        &self,
        device_code: &str,
    ) -> Result<DevicePollOutcome, Error> {
        let url = self.base_url.join("api/v1/auth/device/poll/").unwrap();
        tracing::debug!(url = %url, "POST device/poll");
        let resp = self
            .http
            .post(url)
            .json(&serde_json::json!({ "device_code": device_code }))
            .send()
            .await?;
        let status = resp.status();
        if status.is_success() {
            let parsed: DevicePollSuccess = resp.json().await.map_err(|e| Self::json_err(status, e))?;
            let outcome = match parsed {
                DevicePollSuccess::Pending => DevicePollOutcome::Pending,
                DevicePollSuccess::Ok {
                    session_token,
                    user,
                } => {
                    tracing::info!(github_login = %user.github_login, "device-flow authorized");
                    DevicePollOutcome::Authorized(SessionData {
                        session_token,
                        user,
                    })
                }
            };
            return Ok(outcome);
        }
        // Non-2xx. Interpret the envelope. github_error with a known device-flow
        // slug maps to its DevicePollOutcome variant; otherwise propagate as
        // Error.
        let err = Self::map_error(resp).await;
        if let Error::Github { ref extra, .. } = err {
            if let Some(slug) = extra.get("error").and_then(|v| v.as_str()) {
                match slug {
                    "authorization_pending" => return Ok(DevicePollOutcome::Pending),
                    "slow_down" => return Ok(DevicePollOutcome::SlowDown),
                    "access_denied" => {
                        tracing::info!("device-flow denied");
                        return Ok(DevicePollOutcome::Denied);
                    }
                    "expired_token" => {
                        tracing::info!("device-flow expired");
                        return Ok(DevicePollOutcome::Expired);
                    }
                    _ => {}
                }
            }
        }
        tracing::warn!(err = %err, "device_poll non-2xx (no known slug)");
        Err(err)
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
    use super::super::types::DevicePollOutcome;

    async fn arrange_poll_pending(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "pending"
            })))
            .mount(server)
            .await;
    }

    async fn arrange_poll_github_error(server: &MockServer, slug: &str) {
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "message": "github_error",
                "extra": {"error": slug}
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn device_start_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "device_code": "abc",
                "user_code": "ABCD-1234",
                "verification_uri": "https://github.com/login/device",
                "interval": 5,
                "expires_in": 900,
            })))
            .mount(&server)
            .await;

        let client = Client::new(server.uri()).unwrap();
        let dc = client.device_start().await.unwrap();
        assert_eq!(dc.user_code, "ABCD-1234");
        assert_eq!(dc.expires_in, 900);
    }

    #[tokio::test]
    async fn device_start_500_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(ResponseTemplate::new(500).set_body_string("internal err"))
            .mount(&server)
            .await;

        let client = Client::new(server.uri()).unwrap();
        let err = client.device_start().await.unwrap_err();
        match &err {
            Error::Unexpected { status, message, .. } if status.as_u16() == 500 => {
                assert_eq!(message, "internal err");
            }
            _ => panic!("got {err:?}"),
        }
    }

    #[tokio::test]
    async fn device_start_200_with_bad_body_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json at all"))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.device_start().await.unwrap_err();
        assert!(
            matches!(&err, Error::Unexpected { status, .. } if status.as_u16() == 200),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn device_start_transport_error_when_server_down() {
        // Bind a port and immediately drop it — the backend client will get
        // connection refused.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let url = format!("http://127.0.0.1:{port}");
        let client = Client::with_timeout(&url, Duration::from_millis(500)).unwrap();
        let err = client.device_start().await.unwrap_err();
        assert!(matches!(err, Error::Transport(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn device_poll_pending() {
        let server = MockServer::start().await;
        arrange_poll_pending(&server).await;
        let client = Client::new(server.uri()).unwrap();
        let out = client.device_poll("dc").await.unwrap();
        assert!(matches!(out, DevicePollOutcome::Pending));
    }

    #[tokio::test]
    async fn device_poll_authorized() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "ok",
                "session_token": "stg_abc",
                "user": {
                    "id": 42,
                    "github_login": "octocat",
                    "github_user_id": 583231,
                    "display_name": null,
                    "avatar_url": null
                }
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let out = client.device_poll("dc").await.unwrap();
        match out {
            DevicePollOutcome::Authorized(s) => {
                assert_eq!(s.session_token, "stg_abc");
                assert_eq!(s.user.github_login, "octocat");
            }
            other => panic!("expected Authorized, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn device_poll_authorization_pending_maps_to_pending() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "authorization_pending").await;
        let client = Client::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Pending));
    }

    #[tokio::test]
    async fn device_poll_slow_down() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "slow_down").await;
        let client = Client::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::SlowDown));
    }

    #[tokio::test]
    async fn device_poll_expired() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "expired_token").await;
        let client = Client::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Expired));
    }

    #[tokio::test]
    async fn device_poll_denied() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "access_denied").await;
        let client = Client::new(server.uri()).unwrap();
        assert!(matches!(client.device_poll("dc").await.unwrap(), DevicePollOutcome::Denied));
    }

    #[tokio::test]
    async fn device_poll_unknown_slug_propagates_as_backend_error() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "nonsense_error").await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.device_poll("dc").await.unwrap_err();
        assert!(
            matches!(err, Error::Github { .. }),
            "expected Github error, got {err:?}"
        );
    }

    #[tokio::test]
    async fn device_poll_200_with_bad_body_maps_to_unexpected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json at all"))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.device_poll("dc").await.unwrap_err();
        assert!(
            matches!(&err, Error::Unexpected { status, .. } if status.as_u16() == 200),
            "got {err:?}"
        );
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

    // #8 — valid JSON with no `message` key falls back to raw body
    #[tokio::test]
    async fn device_start_400_no_message_key_falls_back_to_raw_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "foo": "bar"
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.device_start().await.unwrap_err();
        match &err {
            Error::Unexpected { message, extra, .. } => {
                assert!(message.contains("foo"), "expected raw body, got {message:?}");
                assert!(extra.is_null());
            }
            other => panic!("expected Unexpected, got {other:?}"),
        }
    }

    // #9a — github_error envelope with missing `error` key
    #[tokio::test]
    async fn device_poll_github_error_missing_error_key_propagates() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "message": "github_error",
                "extra": {}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.device_poll("dc").await.unwrap_err();
        match err {
            Error::Github { extra, .. } => {
                assert!(extra.is_object());
                assert!(extra.as_object().unwrap().is_empty());
            }
            other => panic!("expected Github, got {other:?}"),
        }
    }

    // #9b — github_error envelope where `error` is non-string (e.g. integer)
    #[tokio::test]
    async fn device_poll_github_error_non_string_slug_propagates() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/poll/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "message": "github_error",
                "extra": {"error": 42}
            })))
            .mount(&server)
            .await;
        let client = Client::new(server.uri()).unwrap();
        let err = client.device_poll("dc").await.unwrap_err();
        assert!(matches!(err, Error::Github { .. }), "expected Github, got {err:?}");
    }

    // #10 — device_poll issues exactly one HTTP request per call (ADR-0006 pin)
    #[tokio::test]
    async fn device_poll_slow_down_issues_exactly_one_request() {
        let server = MockServer::start().await;
        arrange_poll_github_error(&server, "slow_down").await;
        let client = Client::new(server.uri()).unwrap();
        let out = client.device_poll("dc").await.unwrap();
        assert!(matches!(out, DevicePollOutcome::SlowDown));
        let received = server.received_requests().await.unwrap();
        assert_eq!(received.len(), 1, "expected exactly 1 request, got {}", received.len());
    }

    #[tokio::test]
    async fn with_timeout_honored_on_slow_server() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/auth/device/start/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(2_000)),
            )
            .mount(&server)
            .await;

        let client =
            Client::with_timeout(server.uri(), Duration::from_millis(50)).unwrap();
        // Timeout fires before any response byte arrives; reqwest propagates it
        // via `?` → `Error::Transport`. Neither map_error nor json_err runs.
        let err = client.device_start().await.unwrap_err();
        assert!(matches!(err, Error::Transport(_)), "got {err:?}");
    }
}
