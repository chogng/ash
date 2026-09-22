use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use http_client::HttpHeader;
use serde::Deserialize;

/// Usage response with account identity and subscription limits.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateLimitStatus {
    pub usage: RateLimits,
    pub user_id: Option<String>,
    pub spend_control: Option<SpendControl>,
    pub reached_type: Option<RateLimitReached>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SpendControl {
    pub reached: bool,
    pub individual_limit: Option<SpendLimit>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SpendLimit {
    pub source: Option<String>,
    pub limit: String,
    pub used: String,
    pub remaining: String,
    pub used_percent: i32,
    pub remaining_percent: i32,
    pub reset_after_seconds: i64,
    pub reset_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct RateLimitReached {
    #[serde(rename = "type")]
    pub kind: String,
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

#[derive(Deserialize)]
struct UsageResponse {
    account_id: Option<String>,
    plan_type: String,
    rate_limit: Option<LimitDetails>,
    additional_rate_limits: Option<Vec<AdditionalLimit>>,
    credits: Option<Credits>,
    user_id: Option<String>,
    spend_control: Option<SpendControl>,
    rate_limit_reached_type: Option<RateLimitReached>,
}

#[derive(Deserialize)]
struct LimitDetails {
    allowed: bool,
    limit_reached: bool,
    primary_window: Option<Window>,
    secondary_window: Option<Window>,
}

#[derive(Deserialize)]
struct Window {
    used_percent: u32,
    limit_window_seconds: u32,
    reset_at: u64,
}

#[derive(Deserialize)]
struct AdditionalLimit {
    metered_feature: String,
    limit_name: String,
    normal_model_slug: Option<String>,
    rate_limit: Option<LimitDetails>,
}

#[derive(Deserialize)]
struct Credits {
    has_credits: bool,
    unlimited: bool,
    balance: Option<String>,
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
