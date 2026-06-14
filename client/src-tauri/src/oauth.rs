use base64ct::{Base64UrlUnpadded, Encoding};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::timeout;

#[derive(Error, Debug)]
pub enum OauthError {
    #[error("could not bind loopback listener: {0}")]
    BindFailed(std::io::Error),
    #[error("timeout waiting for callback")]
    Timeout,
    #[error("state mismatch on callback")]
    StateMismatch,
    #[error("user denied authorization")]
    UserDenied,
    #[error("github oauth error: {0}")]
    GithubError(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("sign-in cancelled")]
    Cancelled,
}

pub fn pkce_pair() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let verifier = Base64UrlUnpadded::encode_string(&buf);
    let challenge = Base64UrlUnpadded::encode_string(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn gen_state() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    Base64UrlUnpadded::encode_string(&buf)
}

pub fn authorize_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    code_challenge: &str,
) -> String {
    // Build manually — only 4 params, all URL-safe.
    format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        client_id,
        urlencoding_encode(redirect_uri),
        state,
        code_challenge,
    )
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

pub struct LoopbackListener {
    listener: TcpListener,
    redirect_uri: String,
}

impl LoopbackListener {
    pub async fn bind() -> Result<Self, OauthError> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(OauthError::BindFailed)?;
        let port = listener
            .local_addr()
            .map_err(OauthError::BindFailed)?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{}/cb", port);
        Ok(Self {
            listener,
            redirect_uri,
        })
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    pub async fn recv(
        self,
        deadline: Duration,
        expected_state: &str,
    ) -> Result<CallbackParams, OauthError> {
        let listener = self.listener;
        let expected_state = expected_state.to_string();
        let result = timeout(deadline, async move {
            loop {
                let (mut socket, _peer) = listener.accept().await.map_err(OauthError::BindFailed)?;

                let mut reader = BufReader::new(&mut socket);
                let mut request_line = String::new();

                // Empty / broken connection (e.g. Chrome preconnect): ignore and keep listening.
                if reader.read_line(&mut request_line).await.is_err() || request_line.is_empty() {
                    drop(socket);
                    continue;
                }

                // Parse "GET /cb?... HTTP/1.1" → query string
                let path = request_line.split_whitespace().nth(1).unwrap_or("");
                let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");

                let mut code: Option<String> = None;
                let mut state: Option<String> = None;
                let mut err: Option<String> = None;
                for pair in query.split('&') {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    let v_decoded = urldecode_safe(v);
                    match k {
                        "code" => code = Some(v_decoded),
                        "state" => state = Some(v_decoded),
                        "error" => err = Some(v_decoded),
                        _ => {}
                    }
                }

                // Probe with no auth-relevant params: ignore and keep listening.
                if code.is_none() && state.is_none() && err.is_none() {
                    drop(socket);
                    continue;
                }

                // Send the friendly HTML response, then close write side. We respond
                // BEFORE returning so the browser tab shows the message even if the
                // exchange later fails.
                let body = "<!doctype html><html><head><title>Stage — Signed in</title></head><body><p>You can close this tab.</p></body></html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;

                if let Some(e) = err {
                    if e == "access_denied" {
                        return Err::<CallbackParams, OauthError>(OauthError::UserDenied);
                    }
                    return Err(OauthError::GithubError(e));
                }
                let code = code.ok_or_else(|| OauthError::GithubError("missing code".into()))?;
                let state = state.ok_or_else(|| OauthError::GithubError("missing state".into()))?;
                if state != expected_state {
                    return Err(OauthError::StateMismatch);
                }
                return Ok::<CallbackParams, OauthError>(CallbackParams { code, state });
            }
        })
        .await;

        match result {
            Ok(inner) => inner,
            Err(_) => Err(OauthError::Timeout),
        }
    }
}

fn urldecode_safe(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(b);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pair_verifier_has_expected_length() {
        let (verifier, challenge) = pkce_pair();
        // 32 bytes → base64url-no-pad → 43 chars
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge.len(), 43);
    }

    #[test]
    fn pkce_pair_uses_b64url_alphabet() {
        let (verifier, challenge) = pkce_pair();
        let allowed = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
        assert!(verifier.chars().all(allowed));
        assert!(challenge.chars().all(allowed));
    }

    #[test]
    fn pkce_challenge_is_sha256_of_verifier() {
        let (verifier, challenge) = pkce_pair();
        let expected = Base64UrlUnpadded::encode_string(&Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
    }

    #[test]
    fn gen_state_produces_unique_values() {
        assert_ne!(gen_state(), gen_state());
    }

    #[test]
    fn authorize_url_contains_required_params() {
        let url = authorize_url("Iv1.abc", "http://127.0.0.1:1234/cb", "ST", "CC");
        assert!(url.starts_with("https://github.com/login/oauth/authorize?"));
        assert!(url.contains("client_id=Iv1.abc"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcb"));
        assert!(url.contains("state=ST"));
        assert!(url.contains("code_challenge=CC"));
        assert!(url.contains("code_challenge_method=S256"));
    }

    async fn send_raw_get(addr: &str, path_and_query: &str) {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpStream;
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        let req = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            path_and_query, addr
        );
        let _ = stream.write_all(req.as_bytes()).await;
    }

    #[tokio::test]
    async fn listener_receives_callback_and_returns_parsed() {
        let listener = LoopbackListener::bind().await.expect("bind");
        let addr = listener
            .redirect_uri()
            .trim_start_matches("http://")
            .trim_end_matches("/cb")
            .to_string();

        let recv_handle =
            tokio::spawn(async move { listener.recv(Duration::from_secs(5), "STATE_OK").await });

        send_raw_get(&addr, "/cb?code=ABC&state=STATE_OK&installation_id=42").await;

        let result = recv_handle.await.expect("join");
        let params = result.expect("ok");
        assert_eq!(params.code, "ABC");
        assert_eq!(params.state, "STATE_OK");
    }

    #[tokio::test]
    async fn listener_returns_state_mismatch_when_state_differs() {
        let listener = LoopbackListener::bind().await.expect("bind");
        let addr = listener
            .redirect_uri()
            .trim_start_matches("http://")
            .trim_end_matches("/cb")
            .to_string();
        let recv_handle =
            tokio::spawn(async move { listener.recv(Duration::from_secs(5), "EXPECTED").await });
        send_raw_get(&addr, "/cb?code=ABC&state=DIFFERENT").await;
        let result = recv_handle.await.expect("join");
        assert!(matches!(result, Err(OauthError::StateMismatch)));
    }

    #[tokio::test]
    async fn listener_returns_user_denied_on_access_denied_error() {
        let listener = LoopbackListener::bind().await.expect("bind");
        let addr = listener
            .redirect_uri()
            .trim_start_matches("http://")
            .trim_end_matches("/cb")
            .to_string();
        let recv_handle =
            tokio::spawn(async move { listener.recv(Duration::from_secs(5), "STATE").await });
        send_raw_get(&addr, "/cb?error=access_denied").await;
        let result = recv_handle.await.expect("join");
        assert!(matches!(result, Err(OauthError::UserDenied)));
    }

    #[tokio::test]
    async fn listener_times_out_when_no_callback() {
        let listener = LoopbackListener::bind().await.expect("bind");
        let result = listener.recv(Duration::from_millis(100), "STATE").await;
        assert!(matches!(result, Err(OauthError::Timeout)));
    }

    #[tokio::test]
    async fn listener_ignores_probe_then_accepts_real_callback() {
        use tokio::net::TcpStream;

        let listener = LoopbackListener::bind().await.expect("bind");
        let addr = listener
            .redirect_uri()
            .trim_start_matches("http://")
            .trim_end_matches("/cb")
            .to_string();

        let recv_handle =
            tokio::spawn(async move { listener.recv(Duration::from_secs(5), "STATE_OK").await });

        // First: a probe — open + close write side immediately, no data.
        {
            let mut probe = TcpStream::connect(&*addr).await.expect("probe connect");
            let _ = probe.shutdown().await;
        }

        // Second: real callback.
        tokio::time::sleep(Duration::from_millis(50)).await;
        send_raw_get(&addr, "/cb?code=REAL&state=STATE_OK").await;

        let result = recv_handle.await.expect("join");
        let params = result.expect("ok");
        assert_eq!(params.code, "REAL");
        assert_eq!(params.state, "STATE_OK");
    }
}
