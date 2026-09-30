use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use backend_models::chatgpt::LimitDetails;
use backend_models::chatgpt::RateLimitReached;
use backend_models::chatgpt::RedeemRequest;
use backend_models::chatgpt::ResetCreditResult;
use backend_models::chatgpt::ResetCredits;
use backend_models::chatgpt::ResetCreditsSummary;
use backend_models::chatgpt::SpendControl;
use backend_models::chatgpt::UsageResponse;
use backend_models::chatgpt::Window;
use http_client::HttpHeader;

/// Usage response with account identity and subscription limits.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateLimitStatus {
    pub usage: RateLimits,
    pub user_id: Option<String>,
    pub reset_credits: Option<ResetCreditsSummary>,
    pub spend_control: Option<SpendControl>,
    pub reached_type: Option<RateLimitReached>,
}

/// Select a credit explicitly or let the backend select an available credit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResetCreditSelection<'a> {
    Available,
    Id(&'a str),
}

impl Client<'_> {
    pub fn read_rate_limits(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<RateLimits, RequestError> {
        Ok(self.read_rate_limit_status(cancellation)?.usage)
    }

    pub fn read_rate_limit_status(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<RateLimitStatus, RequestError> {
        let response = self
            .http
            .get(self.endpoint(&["usage"])?, &[], cancellation)?;
        Ok(status(response))
    }

    /// Only clients that implement Reserve may opt in; passive readers use the ordinary method.
    pub fn read_rate_limits_with_reserve(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<RateLimitStatus, RequestError> {
        let response = self.http.get(
            self.endpoint(&["usage"])?,
            &[HttpHeader::new("x-openai-codex-luna-reserve", "1")],
            cancellation,
        )?;
        Ok(status(response))
    }

    pub fn list_reset_credits(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<ResetCredits, RequestError> {
        self.http.get(
            self.endpoint(&["rate-limit-reset-credits"])?,
            &[],
            cancellation,
        )
    }

    /// Uses an existing reset credit without purchasing credits.
    /// The caller owns approval and retains the same request ID for retries.
    /// Cancellation after dispatch does not establish whether the server consumed the credit.
    pub fn consume_reset_credit(
        &self,
        request_id: &str,
        credit: ResetCreditSelection<'_>,
        cancellation: &CancellationToken,
    ) -> Result<ResetCreditResult, RequestError> {
        let credit_id = match credit {
            ResetCreditSelection::Available => None,
            ResetCreditSelection::Id(id) => Some(id),
        };
        if request_id.trim().is_empty() || credit_id.is_some_and(|id| id.trim().is_empty()) {
            return Err(RequestError::InvalidRequest);
        }
        self.http.post(
            self.endpoint(&["rate-limit-reset-credits", "consume"])?,
            &RedeemRequest {
                redeem_request_id: request_id,
                credit_id,
            },
            cancellation,
        )
    }
}

/// Account-wide usage with independent limits for metered model families.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateLimits {
    pub account_id: Option<String>,
    pub plan: String,
    pub limits: Vec<RateLimit>,
    pub credits: Option<CreditBalance>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateLimit {
    pub id: String,
    pub name: Option<String>,
    pub model: Option<String>,
    pub allowed: Option<bool>,
    pub limit_reached: Option<bool>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
}

/// Percent consumed, exact window duration, and absolute reset time in Unix seconds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateLimitWindow {
    pub used_percent: u32,
    pub window_seconds: u32,
    pub resets_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreditBalance {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

fn status(payload: UsageResponse) -> RateLimitStatus {
    let mut limits = vec![limit("codex".into(), None, None, payload.rate_limit)];
    for additional in payload.additional_rate_limits.into_iter().flatten() {
        limits.push(limit(
            additional.metered_feature,
            Some(additional.limit_name),
            additional.normal_model_slug,
            additional.rate_limit,
        ));
    }
    let usage = RateLimits {
        account_id: payload.account_id,
        plan: payload.plan_type,
        limits,
        credits: payload.credits.map(|credits| CreditBalance {
            has_credits: credits.has_credits,
            unlimited: credits.unlimited,
            balance: credits.balance,
        }),
    };
    RateLimitStatus {
        usage,
        user_id: payload.user_id,
        reset_credits: payload.rate_limit_reset_credits,
        spend_control: payload.spend_control,
        reached_type: payload.rate_limit_reached_type,
    }
}

fn limit(
    id: String,
    name: Option<String>,
    model: Option<String>,
    details: Option<LimitDetails>,
) -> RateLimit {
    let (allowed, limit_reached, primary, secondary) = match details {
        Some(details) => (
            Some(details.allowed),
            Some(details.limit_reached),
            details.primary_window.map(window),
            details.secondary_window.map(window),
        ),
        None => (None, None, None, None),
    };
    RateLimit {
        id,
        name,
        model,
        allowed,
        limit_reached,
        primary,
        secondary,
    }
}

fn window(value: Window) -> RateLimitWindow {
    RateLimitWindow {
        used_percent: value.used_percent,
        window_seconds: value.limit_window_seconds,
        resets_at: value.reset_at,
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
