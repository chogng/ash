use crate::RequestError;
use serde::Deserialize;

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

pub(crate) fn decode(body: &[u8]) -> Result<RateLimits, RequestError> {
    let payload: UsageResponse =
        serde_json::from_slice(body).map_err(|_| RequestError::InvalidResponse)?;
    let mut limits = vec![limit("codex".into(), None, None, payload.rate_limit)];
    for additional in payload.additional_rate_limits.into_iter().flatten() {
        limits.push(limit(
            additional.metered_feature,
            Some(additional.limit_name),
            additional.normal_model_slug,
            additional.rate_limit,
        ));
    }
    Ok(RateLimits {
        account_id: payload.account_id,
        plan: payload.plan_type,
        limits,
        credits: payload.credits.map(|credits| CreditBalance {
            has_credits: credits.has_credits,
            unlimited: credits.unlimited,
            balance: credits.balance,
        }),
    })
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
