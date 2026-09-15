use std::sync::Arc;
use std::time::Duration;

use crate::ConnectorAccountId;
use crate::ConnectorDefinition;
use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_secrets::SecretValue;
use serde::Deserialize;
use serde::Serialize;
use zeroize::Zeroize;

use crate::ConnectorDeviceOAuthGrant;
use crate::ConnectorDeviceOAuthPoll;
use crate::ConnectorDeviceOAuthPollRequest;
use crate::ConnectorDeviceOAuthProvider;
use crate::ConnectorOAuthCredential;
use crate::ConnectorOAuthCredentialReplacement;
use crate::ConnectorOAuthError;
use crate::ConnectorOAuthErrorKind;
use crate::ConnectorOAuthRefreshRequest;
use crate::ConnectorOAuthRevokeRequest;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const API_VERSION: &str = "2022-11-28";

/// Public GitHub client configuration for an OAuth device flow.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubDeviceOAuthConfig {
    pub client_id: String,
    pub scopes: Vec<String>,
}

/// GitHub's public-client device flow adapter. It never owns a client secret.
pub struct GitHubDeviceOAuthProvider {
    config: GitHubDeviceOAuthConfig,
    http: Arc<dyn HttpClient>,
}

impl GitHubDeviceOAuthProvider {
    pub fn new(
        config: GitHubDeviceOAuthConfig,
        http: Arc<dyn HttpClient>,
    ) -> Result<Self, ConnectorOAuthError> {
        validate_client(&config.client_id, &config.scopes)?;
        Ok(Self { config, http })
    }

    fn post_form(
        &self,
        url: &str,
        fields: &[(&str, &str)],
    ) -> Result<ash_http_client::HttpResponse, ConnectorOAuthError> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish()
            .into_bytes();
        let request = HttpRequest::post(
            url,
            vec![
                HttpHeader::new("Accept", "application/json"),
                HttpHeader::new("Content-Type", "application/x-www-form-urlencoded"),
                HttpHeader::new("User-Agent", "ash-connector-oauth"),
            ],
            body,
        )
        .map_err(|_| provider_failure())?;
        self.http.execute(&request).map_err(|_| provider_failure())
    }

    fn account(&self, token: &str) -> Result<GitHubUser, ConnectorOAuthError> {
        let request = HttpRequest::new(
            HttpMethod::Get,
            USER_URL,
            vec![
                HttpHeader::new("Accept", "application/vnd.github+json"),
                HttpHeader::new("Authorization", format!("Bearer {token}")),
                HttpHeader::new("X-GitHub-Api-Version", API_VERSION),
                HttpHeader::new("User-Agent", "ash-connector-oauth"),
            ],
            Vec::new(),
        )
        .map_err(|_| provider_failure())?;
        let response = self
            .http
            .execute(&request)
            .map_err(|_| provider_failure())?;
        if !response.is_success() {
            return Err(provider_failure());
        }
        serde_json::from_slice(response.body()).map_err(|_| provider_failure())
    }
}

impl ConnectorDeviceOAuthProvider for GitHubDeviceOAuthProvider {
    fn start(
        &self,
        _: &ConnectorDefinition,
    ) -> Result<ConnectorDeviceOAuthGrant, ConnectorOAuthError> {
        let scopes = self.config.scopes.join(" ");
        let response = self.post_form(
            DEVICE_CODE_URL,
            &[("client_id", &self.config.client_id), ("scope", &scopes)],
        )?;
        if !response.is_success() {
            return Err(provider_failure());
        }
        let response: GitHubDeviceCodeResponse =
            serde_json::from_slice(response.body()).map_err(|_| provider_failure())?;
        Ok(ConnectorDeviceOAuthGrant {
            device_code: SecretValue::new(response.device_code.into_bytes()),
            user_code: response.user_code,
            verification_uri: response.verification_uri,
            expires_in: Duration::from_secs(response.expires_in),
            poll_interval: Duration::from_secs(response.interval),
        })
    }

    fn poll(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorDeviceOAuthPollRequest<'_>,
    ) -> Result<ConnectorDeviceOAuthPoll, ConnectorOAuthError> {
        let mut device_code = std::str::from_utf8(request.device_code.expose())
            .map_err(|_| provider_failure())?
            .to_owned();
        let response = self.post_form(
            TOKEN_URL,
            &[
                ("client_id", &self.config.client_id),
                ("device_code", &device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        );
        device_code.zeroize();
        let response = response?;
        if !response.is_success() {
            return Err(provider_failure());
        }
        let response: GitHubDeviceTokenResponse =
            serde_json::from_slice(response.body()).map_err(|_| provider_failure())?;
        if let Some(error) = response.error.as_deref() {
            return match error {
                "authorization_pending" => Ok(ConnectorDeviceOAuthPoll::Pending),
                "slow_down" => Ok(ConnectorDeviceOAuthPoll::SlowDown),
                "expired_token" => Ok(ConnectorDeviceOAuthPoll::Expired),
                "access_denied" => Ok(ConnectorDeviceOAuthPoll::Denied),
                _ => Err(provider_failure()),
            };
        }
        let access_token = response.access_token.ok_or_else(provider_failure)?;
        if access_token.is_empty() {
            return Err(provider_failure());
        }
        let user = self.account(&access_token)?;
        let account_id =
            ConnectorAccountId::new(user.id.to_string()).map_err(|_| provider_failure())?;
        let display_name = user
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(user.login);
        let runtime_secret = SecretValue::new(access_token.as_bytes().to_vec());
        let bundle = GitHubDeviceTokenBundle {
            schema_version: 1,
            access_token,
            token_type: response.token_type,
            scope: response.scope,
        };
        let secret = serde_json::to_vec(&bundle)
            .map(SecretValue::new)
            .map_err(|_| provider_failure())?;
        Ok(ConnectorDeviceOAuthPoll::Complete(
            ConnectorOAuthCredential {
                account_id,
                account_display_name: display_name,
                runtime_secret,
                secret,
            },
        ))
    }

    fn refresh(
        &self,
        _: &ConnectorDefinition,
        _: ConnectorOAuthRefreshRequest,
    ) -> Result<ConnectorOAuthCredentialReplacement, ConnectorOAuthError> {
        Err(ConnectorOAuthError::new(
            ConnectorOAuthErrorKind::ProviderUnavailable,
            "GitHub device credential refresh is unavailable",
        ))
    }

    fn revoke(
        &self,
        _: &ConnectorDefinition,
        _: ConnectorOAuthRevokeRequest,
    ) -> Result<(), ConnectorOAuthError> {
        Err(ConnectorOAuthError::new(
            ConnectorOAuthErrorKind::ProviderUnavailable,
            "GitHub device credential remote revocation is unavailable",
        ))
    }

    fn supports_remote_revoke(&self) -> bool {
        false
    }
}

#[derive(Deserialize)]
struct GitHubDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct GitHubDeviceTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize)]
struct GitHubDeviceTokenBundle {
    schema_version: u32,
    access_token: String,
    token_type: Option<String>,
    scope: Option<String>,
}

impl Zeroize for GitHubDeviceTokenBundle {
    fn zeroize(&mut self) {
        self.access_token.zeroize();
        self.token_type.zeroize();
        self.scope.zeroize();
    }
}

impl Drop for GitHubDeviceTokenBundle {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Deserialize)]
struct GitHubUser {
    id: u64,
    login: String,
    name: Option<String>,
}

fn validate_client(client_id: &str, scopes: &[String]) -> Result<(), ConnectorOAuthError> {
    if client_id.trim().is_empty()
        || client_id.contains(char::is_control)
        || scopes
            .iter()
            .any(|scope| scope.is_empty() || scope.contains(char::is_whitespace))
    {
        return Err(ConnectorOAuthError::new(
            ConnectorOAuthErrorKind::InvalidRequest,
            "GitHub device OAuth configuration is invalid",
        ));
    }
    Ok(())
}

fn provider_failure() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::ProviderFailure,
        "GitHub device OAuth operation failed",
    )
}

#[cfg(test)]
#[path = "github_device_tests.rs"]
mod tests;
