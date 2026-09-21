use crate::LoginError;
use crate::LoginErrorKind;

/// Stable identity for one interactive login attempt within a service incarnation.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct LoginId(String);

impl LoginId {
    pub fn new(value: impl Into<String>) -> Result<Self, LoginError> {
        let value = value.into();
        if value.trim().is_empty() || value.chars().any(char::is_whitespace) {
            return Err(LoginError::new(
                LoginErrorKind::InvalidInput,
                "login ID must be non-empty and contain no whitespace",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for LoginId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

use std::fmt;

/// Provider-owned account identity without credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountRef {
    pub provider: String,
    pub account_id: String,
}

/// User-visible status of one redacted account.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccountStatus {
    Ready,
    ReauthenticationRequired,
    Unavailable,
}

/// Redacted account metadata safe for product UI and RPC projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSnapshot {
    pub account: AccountRef,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub organization: Option<String>,
    pub plan: Option<String>,
    pub status: AccountStatus,
    pub credential_revision: u64,
}

/// Revisioned redacted account state owned by the login control plane.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AccountState {
    pub revision: u64,
    pub accounts: Vec<AccountSnapshot>,
}

/// Interactive login flow selected by a product client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoginMethod {
    OpenAiChatGptBrowser,
    OpenAiChatGptDeviceCode,
    KimiDeviceCode,
    XaiDeviceCode,
}

impl LoginMethod {
    pub fn provider_id(self) -> &'static str {
        match self {
            Self::OpenAiChatGptBrowser | Self::OpenAiChatGptDeviceCode => "openai-chatgpt",
            Self::KimiDeviceCode => "kimi",
            Self::XaiDeviceCode => "xai-subscription",
        }
    }
}

/// Provider-driver request carrying the service-owned login identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BeginLoginRequest {
    pub login_id: LoginId,
    pub method: LoginMethod,
}

/// Redacted UI instruction returned when a login starts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BeginLogin {
    Connected {
        login_id: LoginId,
        account: AccountSnapshot,
    },
    Browser {
        login_id: LoginId,
        authorization_url: String,
    },
    DeviceCode {
        login_id: LoginId,
        verification_url: String,
        user_code: String,
    },
}

impl BeginLogin {
    pub fn login_id(&self) -> &LoginId {
        match self {
            Self::Connected { login_id, .. }
            | Self::Browser { login_id, .. }
            | Self::DeviceCode { login_id, .. } => login_id,
        }
    }
}

/// Result of cancelling one exact login identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancelLoginOutcome {
    Cancelled,
    NotFound,
}

/// Redacted provider failure delivered when an asynchronous login ends.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginFailure {
    pub code: String,
    pub message: String,
}

/// Terminal result of an interactive login attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoginCompletionOutcome {
    Succeeded { account: AccountSnapshot },
    Failed { failure: LoginFailure },
}

/// Provider-to-control-plane completion for one exact login attempt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompleteLogin {
    pub login_id: LoginId,
    pub outcome: LoginCompletionOutcome,
}

/// Revision-bound completion event emitted to product hosts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginCompletion {
    pub login_id: LoginId,
    pub outcome: LoginCompletionOutcome,
    pub account_state: AccountState,
}

/// Result of a logout request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogoutOutcome {
    LoggedOut,
    AlreadyLoggedOut,
}
