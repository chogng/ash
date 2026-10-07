//! Kimi Code account and quota APIs with caller-owned authentication.

pub use backend_models::kimi::Account;
pub use backend_models::kimi::QuotaWindow;
pub use backend_models::kimi::QuotaWindows;
pub use backend_models::kimi::Usage;

use crate::RequestError;
use crate::client::Client as HttpClient;
use async_utils::CancellationToken;
use client::OperationClient;
use client::ResolvedApiTarget;
use http_client::HttpHeader;

pub struct Client<'a> {
    http: HttpClient<'a>,
}

impl<'a> Client<'a> {
    pub fn new(
        client: &'a dyn OperationClient,
        target: &'a ResolvedApiTarget,
    ) -> Result<Self, RequestError> {
        Ok(Self {
            http: HttpClient::new(client, target)?,
        })
    }

    pub fn read_account(&self, cancellation: &CancellationToken) -> Result<Account, RequestError> {
        let account: Account = self.http.get(
            self.http.endpoint(["me"])?,
            &[HttpHeader::new("Accept", "application/json")],
            cancellation,
        )?;
        if account.user_id.trim().is_empty() {
            return Err(RequestError::InvalidResponse);
        }
        Ok(account)
    }

    pub fn read_usage(&self, cancellation: &CancellationToken) -> Result<Usage, RequestError> {
        let usage: Usage = self.http.get(
            self.http.endpoint(["usages"])?,
            &[HttpHeader::new("Accept", "application/json")],
            cancellation,
        )?;
        for window in [
            &usage.usages.limit_5h,
            &usage.usages.limit_7d,
            &usage.usages.limit_month_total,
            &usage.usages.limit_month_code,
        ]
        .into_iter()
        .flatten()
        {
            if !window.used_ratio.is_finite() || window.used_ratio < 0.0 {
                return Err(RequestError::InvalidResponse);
            }
        }
        Ok(usage)
    }
}

#[cfg(test)]
#[path = "kimi_tests.rs"]
mod tests;
