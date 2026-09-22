use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use http_client::HttpHeader;
use serde::Deserialize;
use serde::Deserializer;
use serde::de::Error;
use serde_json::Value;

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
struct BillingResponse {
    config: Option<Billing>,
}
impl Client<'_> {
    pub fn read_billing(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<Billing>, RequestError> {
        let mut url = self.http.endpoint(["billing"])?;
        url.query_pairs_mut().append_pair("format", "credits");
        let response: BillingResponse = self.http.get(
            url,
            &[
                HttpHeader::new("Accept", "application/json"),
                HttpHeader::new("Cache-Control", "no-store"),
            ],
            cancellation,
        )?;
        let billing = response.config;
        if let Some(billing) = &billing {
            if billing
                .credit_usage_percent
                .is_some_and(|value| !value.is_finite() || value < 0.0)
                || billing
                    .history
                    .iter()
                    .filter_map(|entry| entry.billing_cycle.as_ref())
                    .any(|cycle| !(1..=12).contains(&cycle.month))
            {
                return Err(RequestError::InvalidResponse);
            }
        }
        Ok(billing)
    }
}
