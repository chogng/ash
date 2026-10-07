use std::sync::Arc;

use crate::ConnectorAccountId;
use crate::ConnectorDefinition;
use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpRequest;
use ash_secrets::SecretValue;
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

/// Public product configuration for a Ash-operated GitHub OAuth broker.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHubBrokeredOAuthConfig {
    pub broker_base_url: Url,
    pub client_id: String,
    pub scopes: Vec<String>,
}

/// PKCE browser adapter whose confidential GitHub client secret remains at the broker.
pub struct GitHubBrokeredOAuthProvider {
    authorize_url: Url,
    token_url: Url,
    revoke_url: Url,
    config: GitHubBrokeredOAuthConfig,
    http: Arc<dyn HttpClient>,
}

impl GitHubBrokeredOAuthProvider {
    pub fn new(
        config: GitHubBrokeredOAuthConfig,
        http: Arc<dyn HttpClient>,
    ) -> Result<Self, ConnectorOAuthError> {
        validate_config(&config)?;
        let authorize_url = endpoint(&config.broker_base_url, "v1/oauth/github/authorize")?;
        let token_url = endpoint(&config.broker_base_url, "v1/oauth/github/token")?;
        let revoke_url = endpoint(&config.broker_base_url, "v1/oauth/github/revoke")?;
        Ok(Self {
            authorize_url,
            token_url,
            revoke_url,
            config,
            http,
        })
    }

    fn token_request(
        &self,
        fields: &[(&str, &str)],
    ) -> Result<BrokerTokenResponse, ConnectorOAuthError> {
        let response = self.post_form(self.token_url.as_str(), fields)?;
        if !response.is_success() {
            return Err(provider_failure());
        }
        let response: BrokerTokenResponse =
            serde_json::from_slice(response.body()).map_err(|_| provider_failure())?;
        if response.access_token.is_empty()
            || response.account_id.is_empty()
            || response.account_display_name.trim().is_empty()
        {
            return Err(provider_failure());
        }
        Ok(response)
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

    fn credential(
        &self,
        response: BrokerTokenResponse,
    ) -> Result<ConnectorOAuthCredential, ConnectorOAuthError> {
        let account_id =
            ConnectorAccountId::new(response.account_id).map_err(|_| provider_failure())?;
        let runtime_secret = SecretValue::new(response.access_token.as_bytes().to_vec());
        let bundle = BrokerTokenBundle {
            schema_version: 1,
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            token_type: response.token_type,
            scope: response.scope,
        };
        Ok(ConnectorOAuthCredential {
            account_id,
            account_display_name: response.account_display_name,
            runtime_secret,
            secret: encode_bundle(&bundle)?,
        })
    }
}

impl ConnectorOAuthProvider for GitHubBrokeredOAuthProvider {
    fn authorization_url(
        &self,
        _: &ConnectorDefinition,
        challenge: ConnectorOAuthChallenge<'_>,
    ) -> Result<String, ConnectorOAuthError> {
        let mut url = self.authorize_url.clone();
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
        let response = self.token_request(&[
            ("client_id", &self.config.client_id),
            ("code", &code),
            ("redirect_uri", request.redirect_uri),
            ("code_verifier", request.pkce_verifier),
            ("grant_type", "authorization_code"),
        ]);
        code.zeroize();
        self.credential(response?)
    }

    fn refresh(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorOAuthRefreshRequest,
    ) -> Result<ConnectorOAuthCredentialReplacement, ConnectorOAuthError> {
        let mut current = decode_bundle(request.credential)?;
        let mut refresh_token = current.refresh_token.take().ok_or_else(|| {
            ConnectorOAuthError::new(
                ConnectorOAuthErrorKind::InvalidRequest,
                "GitHub broker credential does not contain a refresh token",
            )
        })?;
        let response = self.token_request(&[
            ("client_id", &self.config.client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
        ]);
        refresh_token.zeroize();
        let response = response?;
        let runtime_secret = SecretValue::new(response.access_token.as_bytes().to_vec());
        let bundle = BrokerTokenBundle {
            schema_version: 1,
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            token_type: response.token_type,
            scope: response.scope,
        };
        Ok(ConnectorOAuthCredentialReplacement {
            runtime_secret,
            secret: encode_bundle(&bundle)?,
        })
    }

    fn revoke(
        &self,
        _: &ConnectorDefinition,
        request: ConnectorOAuthRevokeRequest,
    ) -> Result<(), ConnectorOAuthError> {
        let mut bundle = decode_bundle(request.credential)?;
        let response = self.post_form(
            self.revoke_url.as_str(),
            &[
                ("client_id", &self.config.client_id),
                ("access_token", &bundle.access_token),
            ],
        );
        bundle.zeroize();
        let response = response?;
        if response.is_success() || response.status() == 404 {
            Ok(())
        } else {
            Err(provider_failure())
        }
    }
}

#[derive(Deserialize)]
struct BrokerTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    account_id: String,
    account_display_name: String,
}

#[derive(Deserialize, Serialize)]
struct BrokerTokenBundle {
    schema_version: u32,
    access_token: String,
    refresh_token: Option<String>,
    token_type: Option<String>,
    scope: Option<String>,
}

impl Zeroize for BrokerTokenBundle {
    fn zeroize(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.token_type.zeroize();
        self.scope.zeroize();
    }
}

impl Drop for BrokerTokenBundle {
    fn drop(&mut self) {
        self.zeroize();
    }
}

fn encode_bundle(bundle: &BrokerTokenBundle) -> Result<SecretValue, ConnectorOAuthError> {
    serde_json::to_vec(bundle)
        .map(SecretValue::new)
        .map_err(|_| provider_failure())
}

fn decode_bundle(credential: SecretValue) -> Result<BrokerTokenBundle, ConnectorOAuthError> {
    serde_json::from_slice(credential.expose()).map_err(|_| provider_failure())
}

fn validate_config(config: &GitHubBrokeredOAuthConfig) -> Result<(), ConnectorOAuthError> {
    if config.broker_base_url.scheme() != "https"
        || config.broker_base_url.cannot_be_a_base()
        || !config.broker_base_url.username().is_empty()
        || config.broker_base_url.password().is_some()
        || config.broker_base_url.query().is_some()
        || config.broker_base_url.fragment().is_some()
        || !config.broker_base_url.path().ends_with('/')
        || config.client_id.trim().is_empty()
        || config.client_id.contains(char::is_control)
        || config
            .scopes
            .iter()
            .any(|scope| scope.is_empty() || scope.contains(char::is_whitespace))
    {
        return Err(ConnectorOAuthError::new(
            ConnectorOAuthErrorKind::InvalidRequest,
            "GitHub brokered OAuth configuration is invalid",
        ));
    }
    Ok(())
}

fn endpoint(base: &Url, path: &str) -> Result<Url, ConnectorOAuthError> {
    base.join(path).map_err(|_| provider_failure())
}

fn provider_failure() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::ProviderFailure,
        "GitHub brokered OAuth operation failed",
    )
}

#[cfg(test)]
#[path = "github_broker_tests.rs"]
mod tests;
