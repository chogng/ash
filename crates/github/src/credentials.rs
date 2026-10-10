//! Backend consumer contracts; OAuth implementations live in extensions.
use ash_async_utils::CancellationToken;
use ash_login::AccountStatus;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_secrets::SecretValue;
use url::Url;
pub const GITHUB_PROVIDER_ID: &str = "github";

/// Identifies the exact grant captured by a repository operation, without credential material.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GitHubAuthorization {
    pub host: String,
    pub account_id: String,
    pub grant_id: String,
}

/// Supplies credentials only while the captured authorization remains current.
pub trait GitHubCredentialProvider: Send + Sync {
    fn authorization(&self) -> Result<GitHubAuthorization, LoginError>;
    fn token(&self, authorization: &GitHubAuthorization) -> Result<SecretValue, LoginError>;

    /// Selects an exact account, without changing another window's default account.
    fn authorization_for(&self, account_id: &str) -> Result<GitHubAuthorization, LoginError> {
        let grant = self.authorization()?;
        if grant.account_id != account_id {
            return Err(LoginError::new(
                LoginErrorKind::ExternalLoginRequired,
                "GitHub account is not connected",
            ));
        }
        Ok(grant)
    }
}

/// Redacted GitHub account metadata; host is part of the credential authority.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GitHubAccount {
    pub id: String,
    pub host: String,
    pub login: String,
    pub status: AccountStatus,
    pub credential_revision: u64,
}

/// Manages the provider-owned catalog and connects host-bound user tokens.
pub trait GitHubAccountManager: Send + Sync {
    /// The primary grant is first; remaining accounts have stable identity order.
    fn accounts(&self) -> Result<Vec<GitHubAccount>, LoginError>;
    fn connect_token(
        &self,
        host: &str,
        token: SecretValue,
        cancellation: &CancellationToken,
    ) -> Result<GitHubAccount, LoginError>;
}

/// Public OAuth settings for one GitHub host. The broker owns its app secret.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GitHubBrowserConfig {
    pub host: String,
    pub client_id: String,
    pub broker_base_url: Url,
}

/// GitHub's backend-only capability. Tokens never appear in App Server account DTOs.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "operation",
    content = "params",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum GitHubAuthenticationRequest {
    Authentication(ash_login::extension::AuthenticationRequest),
    Accounts,
    ConnectToken { host: String, token: Vec<u8> },
    Authorization { account_id: Option<String> },
    Token(GitHubAuthorization),
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "operation",
    content = "result",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum GitHubAuthenticationResponse {
    Authentication(ash_login::extension::AuthenticationResponse),
    Accounts(Vec<GitHubAccount>),
    Connected(GitHubAccount),
    Authorization(GitHubAuthorization),
    Token(Vec<u8>),
}
