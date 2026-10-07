use std::collections::BTreeMap;

use ash_config::McpServerId;
use ash_secrets::SecretKey;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::Digest;
use sha2::Sha256;
use url::Url;

use super::McpOAuthError;
use super::McpOAuthErrorKind;
use super::internal_error;
use super::oauth_error;

pub(super) fn target_digest(server_id: &McpServerId, endpoint: &Url, key: &SecretKey) -> String {
    let mut digest = Sha256::new();
    digest.update(b"ash-mcp-oauth-target-v1\0");
    digest.update(server_id.as_str().as_bytes());
    digest.update([0]);
    digest.update(endpoint.as_str().as_bytes());
    digest.update([0]);
    digest.update(key.as_str().as_bytes());
    format!("sha256:{:x}", digest.finalize())
}

pub(super) fn random_base64url() -> Result<String, McpOAuthError> {
    let mut random = [0_u8; 32];
    getrandom::getrandom(&mut random).map_err(|_| internal_error())?;
    Ok(URL_SAFE_NO_PAD.encode(random))
}

pub(super) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub(super) fn validate_redirect_uri(value: &str) -> Result<(), McpOAuthError> {
    let url = Url::parse(value).map_err(|_| invalid_redirect())?;
    let local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    if (url.scheme() != "https" && !local_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_redirect());
    }
    Ok(())
}

pub(super) fn validate_authorization_url(
    value: &str,
    state: &str,
    challenge: &str,
    redirect_uri: &str,
    resource: &Url,
) -> Result<(), McpOAuthError> {
    let url = Url::parse(value).map_err(|_| invalid_authorization())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_authorization());
    }
    let mut values = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if values.insert(key, value).is_some() {
            return Err(invalid_authorization());
        }
    }
    if values.get("state").map(|value| value.as_ref()) != Some(state)
        || values.get("code_challenge").map(|value| value.as_ref()) != Some(challenge)
        || values
            .get("code_challenge_method")
            .map(|value| value.as_ref())
            != Some("S256")
        || values.get("redirect_uri").map(|value| value.as_ref()) != Some(redirect_uri)
        || values.get("resource").map(|value| value.as_ref()) != Some(resource.as_str())
    {
        return Err(invalid_authorization());
    }
    Ok(())
}

pub(super) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(left.get(index).copied().unwrap_or_default())
            ^ usize::from(right.get(index).copied().unwrap_or_default());
    }
    difference == 0
}

fn invalid_redirect() -> McpOAuthError {
    oauth_error(
        McpOAuthErrorKind::InvalidRequest,
        "MCP OAuth redirect URI is invalid",
    )
}

fn invalid_authorization() -> McpOAuthError {
    oauth_error(
        McpOAuthErrorKind::ProviderFailure,
        "MCP OAuth provider returned an invalid authorization URL",
    )
}
