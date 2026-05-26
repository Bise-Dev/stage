use base64ct::{Base64UrlUnpadded, Encoding};
use rand::RngCore;
use sha2::{Digest, Sha256};
use thiserror::Error;

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
}
