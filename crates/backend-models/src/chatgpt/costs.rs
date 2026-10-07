//! ChatGPT costs HTTP contracts, retaining exact monetary representations.

use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ThreadUsage {
    pub thread_id: String,
    pub estimated_usage_credits_micros: Option<i64>,
    pub estimated_usage_usd_micros: Option<i64>,
    pub groups: Option<Vec<ThreadUsageGroup>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ThreadUsageGroup {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub speed: Option<String>,
    pub estimated_usage_credits_micros: i64,
    pub net_new_input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskUsageThread {
    pub thread_id: String,
    pub created_at: Option<String>,
    pub descendant_thread_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskUsageResponse {
    pub data_as_of: Option<String>,
    pub threads: Vec<TaskUsage>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskUsageStatus {
    Available,
    Partial,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskUsage {
    pub thread_id: String,
    pub data_status: TaskUsageStatus,
    pub usage_source: String,
    #[serde(flatten)]
    pub amounts: TaskUsageAmounts,
    pub groups: Vec<TaskUsageGroup>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskUsageAmounts {
    #[serde(default, deserialize_with = "percentage")]
    pub five_hour_limit_percent: Option<f64>,
    #[serde(default, deserialize_with = "percentage")]
    pub weekly_limit_percent: Option<f64>,
    /// Decimal text is preserved exactly; no floating-point conversion of balance debits.
    #[serde(default, deserialize_with = "credit_amount")]
    pub balance_usage_credits: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct TaskUsageGroup {
    pub product_experience: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub speed: Option<String>,
    #[serde(flatten)]
    pub amounts: TaskUsageAmounts,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ChatGptTurnCost {
    pub turn_id: String,
    pub model: Option<String>,
    pub estimated_usage_usd_micros: Option<i64>,
    pub settled_response_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ChatGptThreadCosts {
    pub thread_id: String,
    pub turns: Vec<ChatGptTurnCost>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyTurnCostStatus {
    Pending,
    Priced,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ApiKeyResponseCost {
    pub response_id: String,
    pub total_usd: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ApiKeyTurnCost {
    pub turn_id: String,
    pub status: ApiKeyTurnCostStatus,
    pub total_usd: Option<String>,
    pub event_count: Option<u64>,
    pub responses: Option<Vec<ApiKeyResponseCost>>,
    pub model: Option<String>,
    pub speed: Option<String>,
    pub reasoning_effort: Option<String>,
}

// Serde buffers flattened fields. With serde_json/arbitrary_precision, decimals in
// that buffer are represented as maps, so deserialize through Number before f64.
fn percentage<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    Option::<serde_json::Number>::deserialize(deserializer)?
        .map(|number| {
            number
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| serde::de::Error::custom("invalid usage percentage"))
        })
        .transpose()
}

fn credit_amount<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    if let Some(amount) = &value {
        let unsigned = if amount.starts_with('-') || amount.starts_with('+') {
            &amount[1..]
        } else {
            amount
        };
        let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
            Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().is_ok()),
            None => (unsigned, true),
        };
        if amount.len() > 128
            || !exponent
            || !mantissa.bytes().any(|byte| byte.is_ascii_digit())
            || !mantissa
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
            || mantissa.bytes().filter(|byte| *byte == b'.').count() > 1
        {
            return Err(serde::de::Error::custom("invalid credit amount"));
        }
    }
    Ok(value)
}

#[derive(Serialize)]
pub struct ThreadUsageRequest<'a> {
    pub thread_ids: &'a [&'a str],
}

#[derive(Deserialize)]
pub struct ThreadUsageResponse {
    pub threads: Vec<ThreadUsage>,
}

#[derive(Serialize)]
pub struct TaskUsageRequest<'a> {
    pub threads: &'a [TaskUsageThread],
}

#[derive(Serialize)]
pub struct TurnCostThread<'a> {
    pub thread_id: &'a str,
    pub turn_ids: &'a [String],
}

#[derive(Serialize)]
pub struct ChatGptTurnCostsRequest<'a> {
    pub threads: Vec<TurnCostThread<'a>>,
    pub include_settled_response_ids: bool,
}

#[derive(Deserialize)]
pub struct ChatGptTurnCostsResponse {
    pub threads: Vec<ChatGptThreadCosts>,
}

#[derive(Serialize)]
pub struct ApiKeyTurnCostsRequest<'a> {
    pub turn_ids: &'a [String],
}

#[derive(Deserialize)]
pub struct ApiKeyTurnCostsResponse {
    pub turns: Vec<ApiKeyTurnCost>,
}
