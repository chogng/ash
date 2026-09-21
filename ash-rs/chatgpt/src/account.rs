use crate::ChatGptApiTarget;
use crate::ChatGptOAuth;
use crate::credential::AccountIdentity;
use ash_async_utils::CancellationToken;
use backend_client::BackendClient;
use backend_client::CHATGPT_BACKEND_BASE_URL;
use backend_client::RateLimits;
use backend_client::RequestError;
use backend_client::RouteStyle;
use std::fmt;
use std::sync::Arc;

/// Account-scoped failures safe to expose through the product protocol.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatGptUsageError {
    InvalidAccount,
    AccountUnavailable,
    AccountChanged,
    AuthenticationRequired,
    Cancelled,
    RequestFailed,
}

impl fmt::Display for ChatGptUsageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAccount => "invalid ChatGPT account identity",
            Self::AccountUnavailable => "ChatGPT account is unavailable",
            Self::AccountChanged => "ChatGPT account changed during the usage query",
            Self::AuthenticationRequired => "ChatGPT authentication is required",
            Self::Cancelled => "ChatGPT usage query cancelled",
            Self::RequestFailed => "ChatGPT usage query failed",
        })
    }
}

impl std::error::Error for ChatGptUsageError {}

/// Queries the signed-in ChatGPT account while OAuth retains credential ownership.
pub struct ChatGptAccount {
    auth: Arc<ChatGptOAuth>,
}

impl ChatGptAccount {
    pub fn new(auth: Arc<ChatGptOAuth>) -> Self {
        Self { auth }
    }

    /// Reads usage for exactly this account, recovering authentication at most once.
    /// Credential management follows the same ownership rules as model requests.
    pub fn read_rate_limits(
        &self,
        account_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<RateLimits, ChatGptUsageError> {
        if account_id.trim().is_empty() {
            return Err(ChatGptUsageError::InvalidAccount);
        }
        check_cancelled(cancellation)?;
        let identity = self.account_identity(account_id)?;
        // A started credential refresh must commit rotated tokens even if this query is cancelled.
        let target = self.auth.api_target_for(CHATGPT_BACKEND_BASE_URL);
        check_cancelled(cancellation)?;
        self.check_usage_account(&identity)?;
        let target = target.map_err(|_| ChatGptUsageError::AccountUnavailable)?;
        // The target must still identify the requested account after a concurrent refresh.
        check_target_account(&target, &identity)?;
        let read = |target: &ChatGptApiTarget| {
            BackendClient::new(
                self.auth.client.as_ref(),
                target.api_target(),
                RouteStyle::ChatGpt,
            )?
            .read_rate_limit_status(cancellation)
        };
        let result = match read(&target) {
            Err(RequestError::HttpStatus(401)) => {
                check_cancelled(cancellation)?;
                self.check_usage_account(&identity)?;
                let recovered = self
                    .auth
                    .recover_unauthorized_for(&target, CHATGPT_BACKEND_BASE_URL);
                check_cancelled(cancellation)?;
                self.check_usage_account(&identity)?;
                let recovered = recovered.map_err(|_| ChatGptUsageError::AccountUnavailable)?;
                let Some(recovered) = recovered else {
                    self.auth.note_rejected(&target);
                    return Err(ChatGptUsageError::AuthenticationRequired);
                };
                check_target_account(&recovered, &identity)?;
                let result = read(&recovered);
                if matches!(result, Err(RequestError::HttpStatus(401))) {
                    self.auth.note_rejected(&recovered);
                }
                result
            }
            result => result,
        };
        check_cancelled(cancellation)?;
        self.check_usage_account(&identity)?;
        let result = result.map_err(|error| match error {
            RequestError::Cancelled => ChatGptUsageError::Cancelled,
            RequestError::HttpStatus(401) => ChatGptUsageError::AuthenticationRequired,
            _ => ChatGptUsageError::RequestFailed,
        })?;
        if result
            .usage
            .account_id
            .as_deref()
            .is_some_and(|id| id != identity.account_id)
            || result
                .user_id
                .as_deref()
                .is_some_and(|id| id != identity.user_id)
        {
            return Err(ChatGptUsageError::AccountChanged);
        }
        Ok(result.usage)
    }

    fn account_identity(&self, account_id: &str) -> Result<AccountIdentity, ChatGptUsageError> {
        let credential = self
            .auth
            .load_credential()
            .map_err(|_| ChatGptUsageError::AccountUnavailable)?
            .ok_or(ChatGptUsageError::AccountUnavailable)?;
        if credential.account_id.as_deref() != Some(account_id) {
            return Err(ChatGptUsageError::AccountChanged);
        }
        credential
            .identity()
            .map_err(|_| ChatGptUsageError::AccountUnavailable)
    }

    fn check_usage_account(&self, identity: &AccountIdentity) -> Result<(), ChatGptUsageError> {
        if self.account_identity(&identity.account_id)? != *identity {
            return Err(ChatGptUsageError::AccountChanged);
        }
        Ok(())
    }
}

fn check_target_account(
    target: &ChatGptApiTarget,
    identity: &AccountIdentity,
) -> Result<(), ChatGptUsageError> {
    if target.identity == *identity {
        Ok(())
    } else {
        Err(ChatGptUsageError::AccountChanged)
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), ChatGptUsageError> {
    if cancellation.is_cancelled() {
        Err(ChatGptUsageError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
