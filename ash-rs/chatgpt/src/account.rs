use crate::ChatGptOAuth;
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
        self.check_usage_account(account_id)?;
        // A started credential refresh must commit rotated tokens even if this query is cancelled.
        let target = self.auth.api_target_for(CHATGPT_BACKEND_BASE_URL);
        check_cancelled(cancellation)?;
        self.check_usage_account(account_id)?;
        let target = target.map_err(|_| ChatGptUsageError::AccountUnavailable)?;
        // The target must still identify the requested account after a concurrent refresh.
        check_target_account(&target, account_id)?;
        let read = |target: &ash_client::ResolvedApiTarget| {
            BackendClient::new(self.auth.client.as_ref(), target, RouteStyle::ChatGpt)?
                .read_rate_limits(cancellation)
        };
        let result = match read(&target) {
            Err(RequestError::HttpStatus(401)) => {
                check_cancelled(cancellation)?;
                self.check_usage_account(account_id)?;
                let recovered = self
                    .auth
                    .recover_unauthorized_for(&target, CHATGPT_BACKEND_BASE_URL);
                check_cancelled(cancellation)?;
                self.check_usage_account(account_id)?;
                let recovered = recovered.map_err(|_| ChatGptUsageError::AccountUnavailable)?;
                let Some(recovered) = recovered else {
                    self.auth.note_rejected(&target);
                    return Err(ChatGptUsageError::AuthenticationRequired);
                };
                check_target_account(&recovered, account_id)?;
                let result = read(&recovered);
                if matches!(result, Err(RequestError::HttpStatus(401))) {
                    self.auth.note_rejected(&recovered);
                }
                result
            }
            result => result,
        };
        check_cancelled(cancellation)?;
        self.check_usage_account(account_id)?;
        let result = result.map_err(|error| match error {
            RequestError::Cancelled => ChatGptUsageError::Cancelled,
            RequestError::HttpStatus(401) => ChatGptUsageError::AuthenticationRequired,
            _ => ChatGptUsageError::RequestFailed,
        })?;
        if result
            .account_id
            .as_deref()
            .is_some_and(|id| id != account_id)
        {
            return Err(ChatGptUsageError::AccountChanged);
        }
        Ok(result)
    }

    fn check_usage_account(&self, account_id: &str) -> Result<(), ChatGptUsageError> {
        let credential = self
            .auth
            .load_credential()
            .map_err(|_| ChatGptUsageError::AccountUnavailable)?
            .ok_or(ChatGptUsageError::AccountUnavailable)?;
        if credential.account_id.as_deref() != Some(account_id) {
            return Err(ChatGptUsageError::AccountChanged);
        }
        Ok(())
    }
}

fn check_target_account(
    target: &ash_client::ResolvedApiTarget,
    account_id: &str,
) -> Result<(), ChatGptUsageError> {
    if target.headers.iter().any(|header| {
        header.name().eq_ignore_ascii_case("ChatGPT-Account-ID") && header.value() == account_id
    }) {
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
