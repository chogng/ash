use std::sync::Arc;

use crate::ConnectorAccountId;
use crate::ConnectorDefinition;
use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_secrets::SecretValue;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde::Serialize;
use url::Url;
use zeroize::Zeroize;

use crate::ConnectorOAuthChallenge;
use crate::ConnectorOAuthCredential;
use crate::ConnectorOAuthCredentialReplacement;
use crate::ConnectorOAuthError;
use crate::ConnectorOAuthErrorKind;
use crate::ConnectorOAuthExchangeRequest;
use crate::ConnectorOAuthProvider;
use crate::ConnectorOAuthRefreshRequest;
use crate::ConnectorOAuthRevokeRequest;

const AUTHORIZE_URL: &str = "https://github.com/login/oauth/authorize";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const API_VERSION: &str = "2022-11-28";

/// Product-owned GitHub OAuth application configuration.
pub struct GitHubOAuthConfig {
    pub client_id: String,
    pub client_secret: SecretValue,
    pub scopes: Vec<String>,
}

/// GitHub OAuth wire adapter with injected transport and secret client identity.
pub struct GitHubOAuthProvider {
    config: GitHubOAuthConfig,
    http: Arc<dyn HttpClient>,
}

impl GitHubOAuthProvider {
    pub fn new(
        config: GitHubOAuthConfig,
        http: Arc<dyn HttpClient>,
    ) -> Result<Self, ConnectorOAuthError> {
        if config.client_id.trim().is_empty()
            || config.client_id.contains(char::is_control)
            || config.client_secret.expose().is_empty()
            || config
                .scopes
                .iter()
                .any(|scope| scope.is_empty() || scope.contains(char::is_whitespace))
        {
            return Err(invalid_config());
        }
        Ok(Self { config, http })
    }

    fn exchange_tokens(
        &self,
        fields: &[(&str, &str)],
    ) -> Result<GitHubTokenBundle, ConnectorOAuthError> {
        let response = self.post_form(TOKEN_URL, fields)?;
        if !response.is_success() {
            return Err(provider_failure());
        }
        let response: GitHubTokenResponse =
            serde_json::from_slice(response.body()).map_err(|_| provider_failure())?;
        if response.access_token.is_empty() {
            return Err(provider_failure());
        }
        Ok(GitHubTokenBundle {
            schema_version: 1,
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_in: response.expires_in,
            refresh_token_expires_in: response.refresh_token_expires_in,
            token_type: response.token_type,
            scope: response.scope,
        })
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

    fn encode_bundle(
        &self,
        bundle: &GitHubTokenBundle,
    ) -> Result<SecretValue, ConnectorOAuthError> {
        serde_json::to_vec(bundle)
            .map(SecretValue::new)
            .map_err(|_| provider_failure())
    }

    fn decode_bundle(
        &self,
        credential: SecretValue,
    ) -> Result<GitHubTokenBundle, ConnectorOAuthError> {
        serde_json::from_slice(credential.expose()).map_err(|_| provider_failure())
    }
}

impl ConnectorOAuthProvider for GitHubOAuthProvider {
    fn authorization_url(
        &self,
        _: &ConnectorDefinition,
        challenge: ConnectorOAuthChallenge<'_>,
    ) -> Result<String, ConnectorOAuthError> {
        let mut url = Url::parse(AUTHORIZE_URL).expect("GitHub authorization URL is valid");
        let scopes = self.config.scopes.join(" ");
        url.query_pairs_mut()
            .append_pair("client_id", &self.config.client_id)
            .append_pair("redirect_uri", challenge.redirect_uri)
            .append_pair("scope", &scopes)
            .append_pair("state", challenge.state)
            .append_pair("code_challenge", challenge.code_challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(url.into())
    }

    fn exchange(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorOAuthExchangeRequest<'_>,
    ) -> Result<ConnectorOAuthCredential, ConnectorOAuthError> {
        let mut code = std::str::from_utf8(request.authorization_code.expose())
            .map_err(|_| provider_failure())?
            .to_owned();
        let mut client_secret = std::str::from_utf8(self.config.client_secret.expose())
            .map_err(|_| invalid_config())?
            .to_owned();
        let bundle = self.exchange_tokens(&[
            ("client_id", &self.config.client_id),
            ("client_secret", &client_secret),
            ("code", &code),
            ("redirect_uri", request.redirect_uri),
            ("code_verifier", request.pkce_verifier),
        ]);
        code.zeroize();
        client_secret.zeroize();
        let bundle = bundle?;
        let user = self.account(&bundle.access_token)?;
        let account_id =
            ConnectorAccountId::new(user.id.to_string()).map_err(|_| provider_failure())?;
        let display_name = user
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(user.login);
        Ok(ConnectorOAuthCredential {
            account_id,
            account_display_name: display_name,
            runtime_secret: SecretValue::new(bundle.access_token.as_bytes().to_vec()),
            secret: self.encode_bundle(&bundle)?,
        })
    }

    fn refresh(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorOAuthRefreshRequest,
    ) -> Result<ConnectorOAuthCredentialReplacement, ConnectorOAuthError> {
        let mut current = self.decode_bundle(request.credential)?;
        let mut refresh_token = current.refresh_token.take().ok_or_else(|| {
            ConnectorOAuthError::new(
                ConnectorOAuthErrorKind::InvalidRequest,
                "GitHub credential does not contain a refresh token",
            )
        })?;
        let mut client_secret = std::str::from_utf8(self.config.client_secret.expose())
            .map_err(|_| invalid_config())?
            .to_owned();
        let replacement = self.exchange_tokens(&[
            ("client_id", &self.config.client_id),
            ("client_secret", &client_secret),
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
        ]);
        refresh_token.zeroize();
        client_secret.zeroize();
        let replacement = replacement?;
        Ok(ConnectorOAuthCredentialReplacement {
            runtime_secret: SecretValue::new(replacement.access_token.as_bytes().to_vec()),
            secret: self.encode_bundle(&replacement)?,
        })
    }

    fn revoke(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorOAuthRevokeRequest,
    ) -> Result<(), ConnectorOAuthError> {
        let mut bundle = self.decode_bundle(request.credential)?;
        let mut basic = self.config.client_id.clone();
        basic.push(':');
        basic.push_str(
            std::str::from_utf8(self.config.client_secret.expose())
                .map_err(|_| invalid_config())?,
        );
        let authorization = format!("Basic {}", STANDARD.encode(basic.as_bytes()));
        basic.zeroize();
        let body = serde_json::to_vec(&serde_json::json!({
            "access_token": bundle.access_token,
        }))
        .map_err(|_| provider_failure())?;
        let request = HttpRequest::new(
            HttpMethod::Delete,
            format!(
                "https://api.github.com/applications/{}/token",
                self.config.client_id
            ),
            vec![
                HttpHeader::new("Accept", "application/vnd.github+json"),
                HttpHeader::new("Authorization", authorization),
                HttpHeader::new("Content-Type", "application/json"),
                HttpHeader::new("X-GitHub-Api-Version", API_VERSION),
                HttpHeader::new("User-Agent", "ash-connector-oauth"),
            ],
            body,
        )
        .map_err(|_| provider_failure())?;
        let response = self
            .http
            .execute(&request)
            .map_err(|_| provider_failure())?;
        bundle.zeroize();
        if response.status() == 204 || response.status() == 404 {
            Ok(())
        } else {
            Err(provider_failure())
        }
    }
}

#[derive(Deserialize)]
struct GitHubTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token_expires_in: Option<u64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct GitHubTokenBundle {
    schema_version: u32,
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token_expires_in: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
}

impl Zeroize for GitHubTokenBundle {
    fn zeroize(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.token_type.zeroize();
        self.scope.zeroize();
    }
}

impl Drop for GitHubTokenBundle {
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

fn invalid_config() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::InvalidRequest,
        "GitHub OAuth configuration is invalid",
    )
}

fn provider_failure() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::ProviderFailure,
        "GitHub OAuth operation failed",
    )
}

#[cfg(test)]
#[path = "github_tests.rs"]
mod tests;
