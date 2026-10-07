//! ChatGPT usage and reset-credit HTTP contracts; windows are in seconds.

use serde::Deserialize;
use serde::Serialize;

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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ResetCreditsSummary {
    pub available_count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ResetCredits {
    pub credits: Vec<ResetCredit>,
    pub available_count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ResetCredit {
    pub id: String,
    pub reset_type: String,
    pub status: String,
    pub granted_at: String,
    pub expires_at: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ResetCreditCode {
    Reset,
    NothingToReset,
    NoCredit,
    AlreadyRedeemed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ResetCreditResult {
    pub code: ResetCreditCode,
    #[serde(default)]
    pub windows_reset: u64,
}

#[derive(Deserialize)]
pub struct UsageResponse {
    pub account_id: Option<String>,
    pub plan_type: String,
    pub rate_limit: Option<LimitDetails>,
    pub additional_rate_limits: Option<Vec<AdditionalLimit>>,
    pub credits: Option<Credits>,
    pub user_id: Option<String>,
    pub rate_limit_reset_credits: Option<ResetCreditsSummary>,
    pub spend_control: Option<SpendControl>,
    pub rate_limit_reached_type: Option<RateLimitReached>,
}

#[derive(Deserialize)]
pub struct LimitDetails {
    pub allowed: bool,
    pub limit_reached: bool,
    pub primary_window: Option<Window>,
    pub secondary_window: Option<Window>,
}

#[derive(Deserialize)]
pub struct Window {
    pub used_percent: u32,
    pub limit_window_seconds: u32,
    pub reset_at: u64,
}

#[derive(Deserialize)]
pub struct AdditionalLimit {
    pub metered_feature: String,
    pub limit_name: String,
    pub normal_model_slug: Option<String>,
    pub rate_limit: Option<LimitDetails>,
}

#[derive(Deserialize)]
pub struct Credits {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

#[derive(Serialize)]
pub struct RedeemRequest<'a> {
    pub redeem_request_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit_id: Option<&'a str>,
}
