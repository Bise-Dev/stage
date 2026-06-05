use super::client::Client;
use super::error::Error;

impl Client {
    /// Repo-scoped unified Workspace + Open-PR overview (see docs/adr/0009).
    /// Returned as raw JSON — the row shape is a tagged union the webview maps;
    /// the client doesn't need to interpret it.
    pub async fn repo_overview(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
    ) -> Result<serde_json::Value, Error> {
        let url = self
            .base_url
            .join(&format!("api/v1/repos/{owner}/{repo}/overview/"))
            .unwrap();
        let resp = self.send(self.http.get(url).bearer_auth(token)).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(Self::map_error(resp).await);
        }
        resp.json().await.map_err(|e| Self::json_err(status, e))
    }
}
