//! Grok subscription HTTP contracts. Money is integer USD cents.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de::Error;
use serde_json::Value;

/// Account metadata from `/user?include=subscription`, including live subscription state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub user_id: String,
    pub email: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub profile_image_asset_id: Option<String>,
    pub principal_type: Option<String>,
    pub principal_id: Option<String>,
    pub team_id: Option<String>,
    pub team_name: Option<String>,
    pub team_role: Option<String>,
    pub organization_id: Option<String>,
    pub organization_name: Option<String>,
    pub organization_role: Option<String>,
    pub user_blocked_reason: Option<String>,
    pub team_blocked_reasons: Option<Vec<String>>,
    pub coding_data_retention_opt_out: Option<bool>,
    pub subscription_tier: Option<String>,
}

/// Account access and billing settings, without Grok application feature switches.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct Settings {
    pub subscription_tier: Option<String>,
    pub subscription_tier_display: Option<String>,
    pub allow_access: Option<bool>,
    pub gate_message: Option<String>,
    pub on_demand_enabled: Option<bool>,
}

/// USD cents. The upstream proto3 JSON contract omits `val` for zero.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct Cent {
    #[serde(default, deserialize_with = "cent_value")]
    pub val: i64,
}

fn cent_value<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(string) => string.parse().ok(),
        _ => None,
    }
    .ok_or_else(|| D::Error::custom("invalid cent value"))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsagePeriod {
    #[serde(rename = "type")]
    pub period_type: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct BillingCycle {
    pub year: i32,
    pub month: i32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BillingPeriodUsage {
    pub billing_cycle: Option<BillingCycle>,
    pub included_used: Option<Cent>,
    pub on_demand_used: Option<Cent>,
    pub total_used: Option<Cent>,
}

/// Current credits contract, queried explicitly with `format=credits`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Billing {
    pub credit_usage_percent: Option<f64>,
    pub current_period: Option<UsagePeriod>,
    pub on_demand_cap: Option<Cent>,
    pub on_demand_used: Option<Cent>,
    pub prepaid_balance: Option<Cent>,
    pub is_unified_billing_user: Option<bool>,
    #[serde(default)]
    pub history: Vec<BillingPeriodUsage>,
}

#[derive(Deserialize)]
pub struct BillingResponse {
    pub config: Option<Billing>,
}

/// Model entries retain the provider's top-level and `_meta` field locations.
/// Selection and catalog normalization belong to the backend client.
#[derive(Deserialize)]
pub struct ModelsResponse {
    pub data: Vec<serde_json::Map<String, Value>>,
}
