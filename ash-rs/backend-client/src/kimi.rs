//! Kimi Code account and quota APIs with caller-owned authentication.

use crate::RequestError;
use crate::client::Client as HttpClient;
use async_utils::CancellationToken;
use chrono::DateTime;
use chrono::FixedOffset;
use client::OperationClient;
use client::ResolvedApiTarget;
use http_client::HttpHeader;
use serde::Deserialize;

/// The account fields displayed by the official Kimi Code client.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct Account {
    pub user_id: String,
    pub nickname: Option<String>,
    pub email: Option<String>,
    pub user_level_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct QuotaWindow {
    pub used_ratio: f64,
    pub reset_time: Option<DateTime<FixedOffset>>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct QuotaWindows {
    pub limit_5h: Option<QuotaWindow>,
    pub limit_7d: Option<QuotaWindow>,
    pub limit_month_total: Option<QuotaWindow>,
    pub limit_month_code: Option<QuotaWindow>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Usage {
    pub usages: QuotaWindows,
}

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
